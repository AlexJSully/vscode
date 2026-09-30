/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, EventType, getActiveElement } from '../../../../../base/browser/dom.js';
import type { IManagedHoverContentOrFactory } from '../../../../../base/browser/ui/hover/hover.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { IInputOptions, IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TabStackEditorFocus } from '../../../../browser/parts/editor/editor.js';
import { TabStackEditor } from '../../../../browser/parts/editor/tabStackEditor.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { EditorGroupModel, TabStackColor, TabStackId } from '../../../../common/editor/editorGroupModel.js';
import { getShownTabStackEditor, TestFileEditorInput, workbenchInstantiationService } from '../../workbenchTestServices.js';

suite('TabStackEditor', () => {

	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;
	let model: EditorGroupModel;
	let anchor: HTMLElement;
	let focusBefore: HTMLElement;

	setup(() => {
		disposables = new DisposableStore();
		instantiationService = workbenchInstantiationService(undefined, disposables);
		(instantiationService.get(IConfigurationService) as TestConfigurationService).setUserConfiguration('workbench', { editor: { enableTabStacks: true } });

		model = disposables.add(instantiationService.createInstance(EditorGroupModel, undefined));
		for (const name of ['a', 'b', 'c']) {
			model.openEditor(disposables.add(new TestFileEditorInput(URI.file(`/path/${name}`), 'testEditorInput')), { pinned: true, active: true, index: model.count });
		}

		anchor = $('.anchor');
		focusBefore = $('input.focus-before');
		mainWindow.document.body.append(anchor, focusBefore);
		focusBefore.focus();
	});

	teardown(() => {
		disposables.dispose();
		anchor.remove();
		focusBefore.remove();
	});

	/**
	 * Gathers the first two editors into a tab stack with the name and color,
	 * and shows its editor under the anchor with `focus` focused.
	 */
	function showEditor(label: string, color: TabStackColor, focus?: TabStackEditorFocus): TabStackId {
		const tabStack = model.addEditorsToTabStack(model.getEditors(EditorsOrder.SEQUENTIAL).slice(0, 2)).tabStack!.id;
		model.updateTabStack(tabStack, { label, color });
		disposables.add(instantiationService.createInstance(TabStackEditor, anchor, model, tabStack)).show(focus);

		return tabStack;
	}

	/**
	 * Returns the shown editor of a tab stack, or `undefined` when none is
	 * shown.
	 */
	function shownEditor(): HTMLElement | undefined {
		return getShownTabStackEditor(instantiationService.get(IContextViewService));
	}

	function nameInput(): HTMLInputElement {
		return shownEditor()!.querySelector<HTMLInputElement>('input')!;
	}

	function swatches(): HTMLElement[] {
		return Array.from(shownEditor()!.querySelectorAll<HTMLElement>('.tab-stack-editor-color'));
	}

	function customColorButton(): HTMLElement {
		return shownEditor()!.querySelector<HTMLElement>('.monaco-button')!;
	}

	function type(value: string): void {
		const input = nameInput();
		input.value = value;
		input.dispatchEvent(new InputEvent(EventType.INPUT));
	}

	function keyDown(target: Element, keyCode: number, shiftKey = false): void {
		target.dispatchEvent(new KeyboardEvent(EventType.KEY_DOWN, { keyCode, shiftKey, bubbles: true, cancelable: true }));
	}

	/**
	 * Describes the element that has focus: the name input, a swatch by its
	 * label, the Custom Color button, the element focused before the editor
	 * showed, or anything else.
	 */
	function focused(): string {
		const activeElement = getActiveElement();
		if (activeElement === focusBefore) {
			return 'before';
		}

		if (activeElement?.classList.contains('tab-stack-editor-color')) {
			return `swatch ${activeElement.getAttribute('aria-label')}`;
		}

		if (activeElement?.classList.contains('monaco-button')) {
			return 'custom color';
		}

		return activeElement?.tagName === 'INPUT' ? 'name' : 'other';
	}

	/**
	 * Moves focus to the element, and dispatches the blur and focus events
	 * that come with it in a window that has focus, which the window of the
	 * tests need not have.
	 */
	function moveFocus(element: HTMLElement): void {
		const previous = getActiveElement();
		element.focus();
		previous?.dispatchEvent(new FocusEvent(EventType.BLUR, { relatedTarget: element }));
		element.dispatchEvent(new FocusEvent(EventType.FOCUS, { relatedTarget: previous }));
	}

	function checkedSwatches(): string[] {
		return swatches().filter(swatch => swatch.getAttribute('aria-checked') === 'true').map(swatch => swatch.getAttribute('aria-label')!);
	}

	test('opens with the name of the tab stack focused and selected', () => {
		showEditor('Auth', 'blue');
		const input = nameInput();

		assert.deepStrictEqual({ value: input.value, focused: focused(), selection: [input.selectionStart, input.selectionEnd] }, {
			value: 'Auth',
			focused: 'name',
			selection: [0, 4]
		});
	});

	test('opens with the checked swatch focused when it opens to change the color', () => {
		showEditor('Auth', 'blue', 'color');

		assert.strictEqual(focused(), 'swatch Blue');
	});

	test('applies the name as it is typed, without surrounding whitespace, and an empty name leaves the tab stack unnamed', () => {
		showEditor('', 'blue');

		const labels: string[] = [];
		for (const value of ['A', 'Au', '  Auth ', '']) {
			type(value);
			labels.push(model.tabStacks[0].label);
		}

		assert.deepStrictEqual({ labels, shown: !!shownEditor() }, {
			labels: ['A', 'Au', 'Auth', ''],
			shown: true
		});
	});

	test('Enter in the name closes the editor, keeps the name and returns focus to where it was', () => {
		showEditor('', 'blue');
		type('Auth');

		keyDown(nameInput(), 13 /* Enter */);

		assert.deepStrictEqual({ shown: !!shownEditor(), label: model.tabStacks[0].label, focused: focused() }, {
			shown: false,
			label: 'Auth',
			focused: 'before'
		});
	});

	test('Escape closes the editor and keeps what it applied, like Chromium does', () => {
		showEditor('Old', 'blue');
		type('New');
		swatches()[3].click();

		keyDown(nameInput(), 27 /* Escape */);

		assert.deepStrictEqual({ shown: !!shownEditor(), label: model.tabStacks[0].label, color: model.tabStacks[0].color, focused: focused() }, {
			shown: false,
			label: 'New',
			color: 'red',
			focused: 'before'
		});
	});

	test('a mouse down outside of the editor closes it and keeps what it applied', () => {
		showEditor('', 'blue');
		type('Auth');
		nameInput().dispatchEvent(new MouseEvent(EventType.MOUSE_DOWN, { bubbles: true }));
		const shownAfterMouseDownInside = !!shownEditor();

		anchor.dispatchEvent(new MouseEvent(EventType.MOUSE_DOWN, { bubbles: true }));

		assert.deepStrictEqual({ shownAfterMouseDownInside, shown: !!shownEditor(), label: model.tabStacks[0].label }, {
			shownAfterMouseDownInside: true,
			shown: false,
			label: 'Auth'
		});
	});

	test('Escape on the Custom Color button closes the editor and returns focus to where it was', () => {
		showEditor('Auth', 'blue');
		const button = customColorButton();
		button.focus();

		keyDown(button, 27 /* Escape */);

		assert.deepStrictEqual({ shown: !!shownEditor(), focused: focused() }, {
			shown: false,
			focused: 'before'
		});
	});

	test('closes when focus leaves it and keeps what it applied, and stays open while focus moves within it', async () => {
		showEditor('', 'blue');
		type('Auth');
		moveFocus(swatches()[0]);
		await timeout(0);
		const shownAfterFocusWithin = !!shownEditor();

		moveFocus(focusBefore);
		await timeout(0);

		assert.deepStrictEqual({ shownAfterFocusWithin, shown: !!shownEditor(), label: model.tabStacks[0].label }, {
			shownAfterFocusWithin: true,
			shown: false,
			label: 'Auth'
		});
	});

	test('a mouse down on its background keeps focus where it is, so that the editor stays open, and one on a control lets that control take focus', () => {
		showEditor('Auth', 'blue');
		const editor = shownEditor()!;
		const mouseDown = (target: Element) => target.dispatchEvent(new MouseEvent(EventType.MOUSE_DOWN, { bubbles: true, cancelable: true }));

		const focusKept = {
			background: !mouseDown(editor),
			colors: !mouseDown(editor.querySelector('.tab-stack-editor-colors')!),
			nameBorder: !mouseDown(editor.querySelector('.monaco-inputbox')!),
			name: !mouseDown(nameInput()),
			swatch: !mouseDown(swatches()[3]),
			customColor: !mouseDown(customColorButton()),
		};

		assert.deepStrictEqual({ focusKept, shown: !!shownEditor() }, {
			focusKept: { background: true, colors: true, nameBorder: true, name: false, swatch: false, customColor: false },
			shown: true
		});
	});

	test('clicking a swatch applies its color and checks only that swatch, keeping the editor open', () => {
		showEditor('Auth', 'blue');
		const checkedBefore = checkedSwatches();

		swatches()[6].click();

		assert.deepStrictEqual({ checkedBefore, checkedAfter: checkedSwatches(), tabIndexes: swatches().map(swatch => swatch.tabIndex), color: model.tabStacks[0].color, shown: !!shownEditor() }, {
			checkedBefore: ['Blue'],
			checkedAfter: ['Green'],
			tabIndexes: [-1, -1, -1, -1, -1, -1, 0, -1, -1],
			color: 'green',
			shown: true
		});
	});

	test('Right and Down check and focus the next swatch, Left and Up the previous one, wrapping around, and apply its color', () => {
		showEditor('Auth', 'blue');
		swatches()[0].focus();

		const steps: string[] = [];
		for (const keyCode of [37 /* LeftArrow */, 39 /* RightArrow */, 39 /* RightArrow */, 40 /* DownArrow */, 38 /* UpArrow */]) {
			keyDown(getActiveElement()!, keyCode);
			steps.push(`${focused()} ${checkedSwatches().join()} ${model.tabStacks[0].color}`);
		}

		assert.deepStrictEqual(steps, [
			'swatch Gray Gray gray',
			'swatch Blue Blue blue',
			'swatch Purple Purple purple',
			'swatch Pink Pink pink',
			'swatch Purple Purple purple'
		]);
	});

	test('Tab and Shift+Tab cycle through the name, the checked swatch and the Custom Color button', () => {
		showEditor('Auth', 'yellow');

		const stops: string[] = [focused()];
		for (const shiftKey of [false, false, false, true]) {
			keyDown(getActiveElement()!, 9 /* Tab */, shiftKey);
			stops.push(focused());
		}

		assert.deepStrictEqual(stops, ['name', 'swatch Yellow', 'custom color', 'name', 'custom color']);
	});

	test('is a dialog with a named input, a radio group of named color swatches and a Custom Color button, and lists a custom color after the presets', () => {
		const hovers = new Map<HTMLElement, IManagedHoverContentOrFactory>();
		// The hover UI is the boundary: it shows the content the editor gives it
		instantiationService.stub(IHoverService, {
			...NullHoverService,
			setupManagedHover: (hoverDelegate, targetElement, content, options) => {
				hovers.set(targetElement, content);
				return NullHoverService.setupManagedHover(hoverDelegate, targetElement, content, options);
			}
		});
		showEditor('Auth', '#1a2b3c');
		const editor = shownEditor()!;
		const input = nameInput();
		const colors = editor.querySelector<HTMLElement>('.tab-stack-editor-colors')!;

		assert.deepStrictEqual({
			role: editor.getAttribute('role'),
			label: editor.getAttribute('aria-label'),
			input: { label: input.getAttribute('aria-label'), placeholder: input.getAttribute('placeholder') },
			colors: { role: colors.getAttribute('role'), label: colors.getAttribute('aria-label') },
			swatches: swatches().map(swatch => `${swatch.getAttribute('role')} ${swatch.getAttribute('aria-label')} ${hovers.get(swatch)} ${swatch.getAttribute('aria-checked')} ${swatch.style.getPropertyValue('--tab-stack-color')}`),
			customColor: customColorButton().textContent
		}, {
			role: 'dialog',
			label: 'Edit tab stack',
			input: { label: 'Name', placeholder: 'Name this tab stack' },
			colors: { role: 'radiogroup', label: 'Color' },
			swatches: [
				'radio Blue Blue false var(--vscode-tabStack-blue)',
				'radio Purple Purple false var(--vscode-tabStack-purple)',
				'radio Pink Pink false var(--vscode-tabStack-pink)',
				'radio Red Red false var(--vscode-tabStack-red)',
				'radio Orange Orange false var(--vscode-tabStack-orange)',
				'radio Yellow Yellow false var(--vscode-tabStack-yellow)',
				'radio Green Green false var(--vscode-tabStack-green)',
				'radio Cyan Cyan false var(--vscode-tabStack-cyan)',
				'radio Gray Gray false var(--vscode-tabStack-gray)',
				'radio Custom color #1a2b3c Custom color #1a2b3c true #1a2b3c'
			],
			customColor: 'Custom Color...'
		});
	});

	test('the Custom Color button closes the editor, asks for a hex color starting from the custom color and applies it', async () => {
		const inputs: IInputOptions[] = [];
		// The quick input UI is the boundary: it waits for the user to type a color
		instantiationService.stub(IQuickInputService, new class extends mock<IQuickInputService>() {
			override async input(options: IInputOptions): Promise<string> {
				inputs.push(options);

				return ' #ABC ';
			}
		});
		showEditor('Auth', '#1a2b3c');
		const colorChange = Event.toPromise(model.onDidModelChange);

		customColorButton().click();
		const shown = !!shownEditor();
		await colorChange;

		assert.deepStrictEqual({ shown, value: inputs.map(input => input.value), color: model.tabStacks[0].color, focused: focused() }, {
			shown: false,
			value: ['#1a2b3c'],
			color: '#aabbcc',
			focused: 'before'
		});
	});

	test('closes once its tab stack is gone and returns focus to where it was', () => {
		const tabStack = showEditor('Auth', 'blue');
		model.updateTabStack(tabStack, { label: 'Other' });
		const shownAfterChange = !!shownEditor();

		model.removeEditorsFromTabStack(model.tabStacks[0].editors);

		assert.deepStrictEqual({ shownAfterChange, shown: !!shownEditor(), focused: focused() }, {
			shownAfterChange: true,
			shown: false,
			focused: 'before'
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
