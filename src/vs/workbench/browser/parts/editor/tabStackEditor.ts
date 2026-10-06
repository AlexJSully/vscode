/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/tabstackeditor.css';
import { $, addDisposableListener, append, EventHelper, EventType, getActiveElement, getWindow, isAncestor, isAncestorOfActiveElement, isHTMLElement, trackFocus } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { asCssVariable } from '../../../../platform/theme/common/colorRegistry.js';
import { isCustomTabStackColor, ITabStack, ITabStackUpdate, TAB_STACK_COLORS, TabStackColor, TabStackId } from '../../../common/editor/editorGroupModel.js';
import { TAB_STACK_COLOR_IDS } from '../../../common/theme.js';
import { IEditorGroup, TabStackEditorFocus } from '../../../services/editor/common/editorGroupsService.js';
import { getTabStackColorLabel, inputCustomTabStackColor, TAB_STACK_CUSTOM_COLOR_LABEL } from './tabStackPickers.js';

export type TabStackEditorGroup = Pick<IEditorGroup, 'tabStacks' | 'onDidModelChange' | 'updateTabStack'>;

interface ITabStackColorSwatch {
	readonly color: TabStackColor;
	readonly element: HTMLElement;
}

/**
 * Returns the CSS value of a tab stack color: its theme color variable, or the custom hex color.
 */
export function getTabStackColorCssValue(color: TabStackColor): string {
	return isCustomTabStackColor(color) ? color : asCssVariable(TAB_STACK_COLOR_IDS[color]);
}

/**
 * The name and color bubble of a tab stack under its header, like the editor bubble of a tab group in
 * Chromium. Changes apply as they are made.
 */
export class TabStackEditor extends Disposable {

	private openContextView: IOpenContextView | undefined;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly group: TabStackEditorGroup,
		private readonly tabStackId: TabStackId,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
	}

	/**
	 * Shows the editor under the anchor with the name or the checked color focused. Closing it while
	 * focus is inside returns focus to where it was.
	 */
	show(focus: TabStackEditorFocus = 'name'): void {
		const tabStack = this.findTabStack();
		if (!tabStack) {
			return;
		}

		const focusToReturn = getActiveElement();
		let element: HTMLElement | undefined;
		let input: InputBox | undefined;
		let swatches: ITabStackColorSwatch[] = [];
		const getCheckedSwatch = () => swatches.find(swatch => swatch.element.tabIndex === 0)?.element;
		this.openContextView = this.contextViewService.showContextView({
			getAnchor: () => this.anchor,
			render: container => {
				const disposables = new DisposableStore();
				element = append(container, $('.tab-stack-editor', { role: 'dialog', 'aria-label': localize('tabStackEditorAriaLabel', "Edit tab stack") }));
				const name = this.renderName(element, tabStack, disposables);
				input = name;
				swatches = this.renderColors(element, tabStack, disposables);
				const customColorButton = disposables.add(new Button(element, { ...defaultButtonStyles, secondary: true }));
				customColorButton.label = TAB_STACK_CUSTOM_COLOR_LABEL;
				disposables.add(customColorButton.onDidClick(() => void this.editCustomColor()));

				// The button handles Escape itself, and blurs once it has fired this
				disposables.add(customColorButton.onDidEscape(() => this.hide()));
				this.registerListeners(element, () => coalesce([name.inputElement, getCheckedSwatch(), customColorButton.element]), disposables);

				return disposables;
			},
			focus: () => {
				if (focus === 'color') {
					getCheckedSwatch()?.focus();
				} else {
					input?.focus();
					input?.select();
				}
			},
			onHide: () => {
				this.openContextView = undefined;

				if (element && isAncestorOfActiveElement(element) && isHTMLElement(focusToReturn) && focusToReturn.isConnected) {
					focusToReturn.focus();
				}
			}
		}, this.layoutService.getContainer(getWindow(this.anchor)));
	}

	layout(): void {
		if (this.openContextView) {
			this.contextViewService.layout();
		}
	}

	hide(): void {
		this.openContextView?.close();
	}

	override dispose(): void {
		this.hide();

		super.dispose();
	}

	private findTabStack(): ITabStack | undefined {
		return this.group.tabStacks.find(tabStack => tabStack.id === this.tabStackId);
	}

	private update(update: ITabStackUpdate): void {
		this.group.updateTabStack(this.tabStackId, update);
	}

	private renderName(element: HTMLElement, tabStack: ITabStack, disposables: DisposableStore): InputBox {
		const input = disposables.add(new InputBox(element, undefined, {
			placeholder: localize('tabStackEditorNamePlaceholder', "Name this tab stack"),
			ariaLabel: localize('tabStackEditorNameAriaLabel', "Name"),
			inputBoxStyles: defaultInputBoxStyles
		}));
		input.value = tabStack.label;
		disposables.add(input.onDidChange(value => this.update({ label: value.trim() })));
		disposables.add(addDisposableListener(input.inputElement, EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Enter)) {
				EventHelper.stop(e, true);
				this.hide();
			}
		}));

		return input;
	}

	/**
	 * Renders the colors as a radio group, where only the checked swatch is in the tab order and the
	 * arrow keys check the next or previous one.
	 */
	private renderColors(element: HTMLElement, tabStack: ITabStack, disposables: DisposableStore): ITabStackColorSwatch[] {
		const colorsElement = append(element, $('.tab-stack-editor-colors', { role: 'radiogroup', 'aria-label': localize('tabStackEditorColorsAriaLabel', "Color") }));
		const colors: { readonly color: TabStackColor; readonly label: string }[] = TAB_STACK_COLORS.map(color => ({ color, label: getTabStackColorLabel(color) }));
		if (isCustomTabStackColor(tabStack.color)) {
			colors.push({ color: tabStack.color, label: localize('tabStackEditorCustomColorSwatch', "Custom color {0}", tabStack.color) });
		}

		const swatches = colors.map(({ color, label }) => {
			const swatchElement = append(colorsElement, $('button.tab-stack-editor-color', { type: 'button', role: 'radio', 'aria-label': label }));
			swatchElement.style.setProperty('--tab-stack-color', getTabStackColorCssValue(color));
			disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), swatchElement, label));

			return { color, element: swatchElement };
		});

		const check = (color: TabStackColor) => {
			for (const swatch of swatches) {
				const checked = swatch.color === color;
				swatch.element.classList.toggle('checked', checked);
				swatch.element.setAttribute('aria-checked', String(checked));
				swatch.element.tabIndex = checked ? 0 : -1;
			}
		};
		const apply = (swatch: ITabStackColorSwatch) => {
			check(swatch.color);
			this.update({ color: swatch.color });
		};

		check(tabStack.color);
		for (const swatch of swatches) {
			disposables.add(addDisposableListener(swatch.element, EventType.CLICK, () => apply(swatch)));
		}

		disposables.add(addDisposableListener(colorsElement, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			const step = event.equals(KeyCode.RightArrow) || event.equals(KeyCode.DownArrow) ? 1 : event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.UpArrow) ? -1 : 0;
			const index = swatches.findIndex(swatch => swatch.element === event.target);
			if (step === 0 || index === -1) {
				return;
			}

			EventHelper.stop(e, true);
			const next = swatches[(index + step + swatches.length) % swatches.length];
			apply(next);
			next.element.focus();
		}));

		return swatches;
	}

	/**
	 * Cycles Tab and Shift+Tab through the tab stops of the editor, and keeps a mouse down on its
	 * background, which takes no focus, from moving focus.
	 */
	private registerListeners(element: HTMLElement, getTabStops: () => HTMLElement[], disposables: DisposableStore): void {
		disposables.add(addDisposableListener(element, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Escape)) {
				EventHelper.stop(e, true);
				this.hide();
			} else if (event.equals(KeyCode.Tab) || event.equals(KeyMod.Shift | KeyCode.Tab)) {
				EventHelper.stop(e, true);
				const tabStops = getTabStops();
				const index = tabStops.findIndex(tabStop => isAncestor(event.target, tabStop));
				tabStops[(index + (event.shiftKey ? -1 : 1) + tabStops.length) % tabStops.length].focus();
			}
		}));

		disposables.add(addDisposableListener(element, EventType.MOUSE_DOWN, e => {
			if (!isHTMLElement(e.target) || !e.target.closest('input, button, .monaco-button')) {
				e.preventDefault();
			}
		}));

		const focusTracker = disposables.add(trackFocus(element));
		disposables.add(focusTracker.onDidBlur(() => this.hide()));
		const targetWindow = getWindow(element);
		disposables.add(addDisposableListener(targetWindow, EventType.MOUSE_DOWN, e => {
			if (!isAncestor(new StandardMouseEvent(targetWindow, e).target, element)) {
				this.hide();
			}
		}, true));

		disposables.add(this.group.onDidModelChange(() => {
			if (!this.findTabStack()) {
				this.hide();
			}
		}));
	}

	/**
	 * Asks for a custom color with a quick input and applies it. The editor closes first, since the
	 * quick input takes focus.
	 */
	private async editCustomColor(): Promise<void> {
		const tabStack = this.findTabStack();
		if (!tabStack) {
			return;
		}

		this.hide();

		const color = await inputCustomTabStackColor(this.quickInputService, tabStack.color);
		if (color && this.findTabStack()) {
			this.update({ color });
		}
	}
}
