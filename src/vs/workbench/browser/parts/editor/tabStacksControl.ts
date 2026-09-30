/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isFirefox } from '../../../../base/browser/browser.js';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { $, addDisposableListener, DragAndDropObserver, EventHelper, EventType, getWindow, isMouseEvent } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { EventType as TouchEventType, Gesture, GestureEvent } from '../../../../base/browser/touch.js';
import { applyDragImage } from '../../../../base/browser/ui/dnd/dnd.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ActionRunner, IAction } from '../../../../base/common/actions.js';
import { Color } from '../../../../base/common/color.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorsOrder, GroupIdentifier } from '../../../common/editor.js';
import { IReadonlyEditorGroupModel, ITabStack, isTabStackPresetColor, TabStackColor, TabStackId } from '../../../common/editor/editorGroupModel.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EDITOR_GROUP_HEADER_TABS_BACKGROUND, TAB_STACK_COLOR_IDS } from '../../../common/theme.js';
import { EditorTabStackContextMenuId, IEditorGroupsView, IEditorGroupView, isTabStacksEnabled, TabStackEditorFocus } from './editor.js';
import { getTabStackColorCssValue, TabStackEditor, TabStackEditorGroup } from './tabStackEditor.js';
import { IDraggedTabStack, ITabsDropHandlerTabStacks, TabsDropSlot } from './tabsDropHandler.js';

interface ITabStackHeader extends IDisposable {

	/**
	 * The header element in the tabs container, placed before the first tab
	 * of its tab stack.
	 */
	readonly element: HTMLElement;

	/**
	 * The element showing the name of the tab stack.
	 */
	readonly label: HTMLElement;

	/**
	 * The name and color bubble of the tab stack under the header, which
	 * closes with the header.
	 */
	readonly bubble: MutableDisposable<TabStackEditor>;
}

/**
 * A tab stack header that is dragged to move its tab stack within the tabs
 * of its group.
 */
class DraggedTabStackIdentifier implements IDraggedTabStack {
	constructor(readonly groupId: GroupIdentifier, readonly tabStackId: TabStackId) { }
}

/**
 * The tab bar that shows tab stacks, as its tab stack headers use it.
 */
interface ITabStacksControlDelegate {

	/**
	 * The tab of each editor by index, including the tabs of collapsed tab
	 * stacks, which are detached from the tabs container.
	 */
	readonly tabs: readonly HTMLElement[];

	/**
	 * Returns the container of the tabs and tab stack headers, once created.
	 */
	getTabsContainer(): HTMLElement | undefined;

	/**
	 * Returns the Add Tab control, which stays the last child of the tabs
	 * container, if the tab bar has one.
	 */
	getAddTabContainer(): HTMLElement | undefined;

	/**
	 * Returns the scrollbar that scrolls the tabs, once created.
	 */
	getTabsScrollbar(): ScrollableElement | undefined;

	/**
	 * Scrolls the tabs so that the tab stack header is within their visible
	 * part.
	 */
	revealTabStackHeader(header: HTMLElement): void;

	/**
	 * Blocks the next reveal of the active tab.
	 */
	blockRevealActiveTabOnce(): void;

	/**
	 * Lifts the block of the next reveal of the active tab unless a layout,
	 * which takes the block, is pending.
	 */
	unblockRevealActiveTabUnlessLayoutPending(): void;

	/**
	 * Returns the keybinding of the action for menus of the tab bar.
	 */
	getKeybinding(action: IAction): ResolvedKeybinding | undefined;

	/**
	 * Handles a drag that enters a tab stack header.
	 */
	onTabsDragEnter(e: DragEvent, slot: TabsDropSlot): void;

	/**
	 * Handles a drag over a tab stack header.
	 */
	onTabsDragOver(e: DragEvent, slot: TabsDropSlot): void;

	/**
	 * Handles the end of the drag of a tab stack header.
	 */
	onTabsDragEnd(): void;

	/**
	 * Handles a drop on a tab stack header.
	 */
	onTabsDrop(e: DragEvent, slot: TabsDropSlot): void;
}

/**
 * Marks the element with the class name while there is a tab stack, and gives it
 * the color of the tab stack.
 */
export function redrawTabStackColor(element: HTMLElement, className: string, tabStack: ITabStack | undefined): void {
	element.classList.toggle(className, !!tabStack);
	if (tabStack) {
		element.style.setProperty('--tab-stack-color', getTabStackColorCssValue(tabStack.color));
	} else {
		element.style.removeProperty('--tab-stack-color');
	}
}

/**
 * The tab stacks of a tab bar: it keeps the tabs container in the order of
 * the editors, with a header before the tabs of each tab stack and the tabs
 * of collapsed tab stacks detached, creates and redraws the headers with
 * their input, context menu and drag, marks the tabs of tab stacks, and
 * shows the name and color bubble of a tab stack under its header.
 */
export class TabStacksControl extends Disposable implements ITabsDropHandlerTabStacks {

	private readonly tabStackHeaders = this._register(new DisposableMap<TabStackId, ITabStackHeader>());
	private readonly tabStackHeaderMenuActionRunner = this._register(new ActionRunner());
	private readonly tabStackTransfer = LocalSelectionTransfer.getInstance<DraggedTabStackIdentifier>();

	constructor(
		private readonly groupView: IEditorGroupView,
		private readonly groupsView: IEditorGroupsView,
		private readonly tabsModel: IReadonlyEditorGroupModel,
		private readonly delegate: ITabStacksControlDelegate,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();

		// Block the next reveal of the active tab when an action of the menu of a
		// tab stack header runs, so that an action that changes the tab stack
		// keeps the header in view. An action that ends without a layout, such as
		// one whose input was cancelled, lifts the block again
		this._register(this.tabStackHeaderMenuActionRunner.onWillRun(() => this.delegate.blockRevealActiveTabOnce()));
		this._register(this.tabStackHeaderMenuActionRunner.onDidRun(() => this.delegate.unblockRevealActiveTabUnlessLayoutPending()));
	}

	/**
	 * Returns the tab stack of the editor when tab stacks are shown.
	 */
	getShownTabStack(editor: EditorInput): ITabStack | undefined {
		return isTabStacksEnabled(this.groupsView.partOptions) ? this.tabsModel.getTabStack(editor) : undefined;
	}

	/**
	 * Returns the tab stack of the group with the id, if any.
	 */
	findTabStack(tabStackId: TabStackId): ITabStack | undefined {
		return this.groupView.tabStacks.find(tabStack => tabStack.id === tabStackId);
	}

	/**
	 * Returns the header of the tab stack, if it has one.
	 */
	findTabStackHeader(tabStackId: TabStackId): HTMLElement | undefined {
		return this.tabStackHeaders.get(tabStackId)?.element;
	}

	/**
	 * Returns the tab stack whose header is dragged, if any.
	 */
	getDraggedTabStack(): IDraggedTabStack | undefined {
		const [draggedTabStack] = this.tabStackTransfer.getData(DraggedTabStackIdentifier.prototype) ?? [];

		return draggedTabStack;
	}

	/**
	 * Ends the drag of a tab stack header, such as once it dropped.
	 */
	clearDraggedTabStack(): void {
		this.tabStackTransfer.clearData(DraggedTabStackIdentifier.prototype);
	}

	/**
	 * Removes and disposes all tab stack headers, such as once no tab is left.
	 */
	clearTabStackHeaders(): void {
		this.tabStackHeaders.clearAndDisposeAll();
	}

	/**
	 * Marks the tab of the editor as a member of the tab stack of the editor,
	 * in its color and with an indicator, while tab stacks are shown.
	 */
	redrawTabStackMembership(editor: EditorInput, tabContainer: HTMLElement): void {
		const tabStack = this.getShownTabStack(editor);

		// Only the tabs of a tab stack have an indicator. It is appended after the
		// children that a tab is created with, so it is the last child of the tab
		const indicator = tabContainer.lastElementChild?.classList.contains('tab-stack-indicator') ? tabContainer.lastElementChild : undefined;

		redrawTabStackColor(tabContainer, 'tab-stack-member', tabStack);
		if (tabStack) {
			if (!indicator) {
				tabContainer.appendChild($('.tab-stack-indicator', { 'aria-hidden': true }));
			}
		} else {
			indicator?.remove();
		}
	}

	/**
	 * Returns the accessible name of the tab of the editor, which also names
	 * the tab stack of the editor when tab stacks are shown.
	 */
	getTabAriaLabel(editor: EditorInput, ariaLabel: string): string {

		// The tab stack is looked up by editor because the index of a tab is
		// relative to the tabs of this tab bar, not to the editors of the group
		const tabStack = this.getShownTabStack(editor);
		if (!tabStack) {
			return ariaLabel;
		}

		return tabStack.label
			? localize('tabStackMemberAriaLabel', "{0}, in tab stack {1}", ariaLabel, tabStack.label)
			: localize('unnamedTabStackMemberAriaLabel', "{0}, in unnamed tab stack", ariaLabel);
	}

	/**
	 * Puts the tabs and tab stack headers into the tabs container in the order
	 * of the editors: a header before the first tab of each tab stack, then its
	 * tabs unless the tab stack is collapsed. The tabs of a collapsed tab stack
	 * are detached rather than hidden, so that sibling and position based code
	 * and CSS only see what is shown. When no tab stack is shown, a tabs
	 * container that already holds only the tabs in the order of the editors is
	 * left unchanged; otherwise stale headers are removed and detached tabs are
	 * put back.
	 */
	reconcileTabStackSlots(): void {
		const tabsContainer = this.delegate.getTabsContainer();
		if (!tabsContainer || this.delegate.tabs.length !== this.tabsModel.count) {
			return; // an open or close of a tab is pending, which redraws all tabs once done
		}

		// While editors of a tab stack move one after the other they can be
		// apart, so only the first editor of a tab stack gets its header
		const showTabStacks = isTabStacksEnabled(this.groupsView.partOptions);
		const shownTabStacks = new Set<TabStackId>();
		const slots: HTMLElement[] = [];
		this.tabsModel.getEditors(EditorsOrder.SEQUENTIAL).forEach((editor, tabIndex) => {
			const tabStack = showTabStacks ? this.tabsModel.getTabStack(editor) : undefined;
			if (tabStack && !shownTabStacks.has(tabStack.id)) {
				shownTabStacks.add(tabStack.id);
				slots.push(this.getTabStackHeader(tabStack));
			}

			if (!tabStack?.collapsed) {
				slots.push(this.delegate.tabs[tabIndex]);
			}
		});

		for (const tabStackId of Array.from(this.tabStackHeaders.keys())) {
			if (!shownTabStacks.has(tabStackId)) {
				this.tabStackHeaders.deleteAndDispose(tabStackId);
			}
		}

		// Move children into place, keeping the Add Tab control last
		const shownSlots = new Set<Element>(slots);
		let child = tabsContainer.firstElementChild;
		for (const slot of slots) {
			child = this.detachUnshownSlots(child, shownSlots);
			if (slot === child) {
				child = child.nextElementSibling;
			} else {
				tabsContainer.insertBefore(slot, child);
			}
		}

		this.detachUnshownSlots(child, shownSlots);
	}

	/**
	 * Detaches the children from `child` on that are not shown, up to the
	 * next shown one or the Add Tab control, and returns that child.
	 */
	private detachUnshownSlots(child: Element | null, shownSlots: ReadonlySet<Element>): Element | null {
		while (child && child !== this.delegate.getAddTabContainer() && !shownSlots.has(child)) {
			const nextChild = child.nextElementSibling;

			// The wrapping layout only updates this class on attached tabs
			child.classList.remove('last-in-row');
			child.remove();

			child = nextChild;
		}

		return child;
	}

	private getTabStackHeader(tabStack: ITabStack): HTMLElement {
		let header = this.tabStackHeaders.get(tabStack.id);
		if (!header) {
			header = this.createTabStackHeader(tabStack.id, assertReturnsDefined(this.delegate.getTabsScrollbar()));
			this.tabStackHeaders.set(tabStack.id, header);
		}

		this.redrawTabStackHeader(header, tabStack);

		return header.element;
	}

	private createTabStackHeader(tabStackId: TabStackId, tabsScrollbar: ScrollableElement): ITabStackHeader {
		const label = $('span.tab-stack-header-label');
		const element = $('.tab-stack-header', { role: 'tab', 'aria-selected': 'false', tabindex: '-1', draggable: true }, $('.tab-stack-header-chip', undefined, label));
		const listeners = this.registerTabStackHeaderListeners(element, tabStackId, tabsScrollbar);
		const bubble = new MutableDisposable<TabStackEditor>();

		return {
			element,
			label,
			bubble,
			dispose: () => {
				bubble.dispose();
				listeners.dispose();
				element.remove();

				// Disposing the header also drops its drag end, so the drag of its tab stack ends here
				const draggedTabStack = this.getDraggedTabStack();
				if (draggedTabStack?.groupId === this.groupView.id && draggedTabStack.tabStackId === tabStackId) {
					this.clearDraggedTabStack();
				}
			}
		};
	}

	/**
	 * Registers the hover and the mouse, touch, keyboard and drag and drop
	 * input of a tab stack header, which look up the tab stack by its id
	 * whenever they run.
	 */
	private registerTabStackHeaderListeners(element: HTMLElement, tabStackId: TabStackId, tabsScrollbar: ScrollableElement): IDisposable {
		const disposables = new DisposableStore();

		disposables.add(Gesture.addTarget(element));
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, () => {
			const tabStack = this.findTabStack(tabStackId);

			return tabStack ? this.getTabStackHeaderHover(tabStack) : undefined;
		}));

		// Toggle on click rather than on mouse down, which also starts a drag
		disposables.add(addDisposableListener(element, EventType.CLICK, e => {
			// Right clicks, and Ctrl+click on macOS, open the context menu instead
			if (e.button !== 0 || (isMacintosh && e.ctrlKey)) {
				return;
			}

			EventHelper.stop(e);
			this.toggleTabStack(tabStackId);
		}));
		disposables.add(addDisposableListener(element, TouchEventType.Tap, (e: GestureEvent) => {
			EventHelper.stop(e);
			this.toggleTabStack(tabStackId);
		}));

		// Keep double clicks on a header from reaching the tabs container and the group
		disposables.add(addDisposableListener(element, EventType.DBLCLICK, e => EventHelper.stop(e, true)));

		// Touch Scroll Support
		disposables.add(addDisposableListener(element, TouchEventType.Change, (e: GestureEvent) => {
			tabsScrollbar.setScrollPosition({ scrollLeft: tabsScrollbar.getScrollPosition().scrollLeft - e.translationX });
		}));

		// Keyboard accessibility
		disposables.add(addDisposableListener(element, EventType.KEY_UP, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				EventHelper.stop(e, true);
				this.toggleTabStack(tabStackId);
			}
		}));

		// Context menu on Shift+F10, touch context menu gesture and right click
		disposables.add(addDisposableListener(element, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.shiftKey && event.keyCode === KeyCode.F10) {
				EventHelper.stop(e, true);
				this.onTabStackHeaderContextMenu(tabStackId, e, element);
			}
		}));
		disposables.add(addDisposableListener(element, TouchEventType.Contextmenu, (e: GestureEvent) => {
			EventHelper.stop(e);
			this.onTabStackHeaderContextMenu(tabStackId, e, element);
		}));

		// Stopping propagation keeps the tabs container from showing its context menu too
		disposables.add(addDisposableListener(element, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e, true);
			this.onTabStackHeaderContextMenu(tabStackId, e, element);
		}));

		disposables.add(this.registerTabStackHeaderDragAndDrop(element, tabStackId));

		return disposables;
	}

	/**
	 * Registers dragging a tab stack header to move its tab stack, and
	 * dropping before or after the header.
	 */
	private registerTabStackHeaderDragAndDrop(element: HTMLElement, tabStackId: TabStackId): IDisposable {
		const slot: TabsDropSlot = { kind: 'tabStackHeader', element, tabStack: tabStackId };

		return new DragAndDropObserver(element, {
			onDragStart: e => this.onTabStackHeaderDragStart(e, tabStackId, element),
			onDragEnter: e => this.delegate.onTabsDragEnter(e, slot),
			onDragOver: e => this.delegate.onTabsDragOver(e, slot),
			onDragEnd: () => {
				this.clearDraggedTabStack();
				this.delegate.onTabsDragEnd();
			},
			onDrop: e => this.delegate.onTabsDrop(e, slot)
		});
	}

	/**
	 * Starts to drag the tab stack of a header, which only the tabs of its group
	 * take: it carries no resources for the editor area and other windows, and
	 * only on Firefox a text that text inputs can take.
	 */
	private onTabStackHeaderDragStart(e: DragEvent, tabStackId: TabStackId, header: HTMLElement): void {
		const tabStack = this.findTabStack(tabStackId);
		if (!tabStack) {
			return;
		}

		this.tabStackTransfer.setData([new DraggedTabStackIdentifier(this.groupView.id, tabStackId)], DraggedTabStackIdentifier.prototype);

		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';

			const label = this.getTabStackHeaderHover(tabStack);

			// Firefox: requires to set a text data transfer to get going
			if (isFirefox) {
				e.dataTransfer.setData(DataTransfers.TEXT, label);
			}

			applyDragImage(e, header, label);
		}
	}

	private redrawTabStackHeader(header: ITabStackHeader, tabStack: ITabStack): void {
		const { element, label } = header;

		element.classList.toggle('collapsed', tabStack.collapsed);
		element.classList.toggle('unnamed', !tabStack.label);
		element.setAttribute('aria-expanded', String(!tabStack.collapsed));
		element.setAttribute('aria-label', this.getTabStackHeaderAriaLabel(tabStack));
		label.textContent = tabStack.label;

		element.style.setProperty('--tab-stack-color', getTabStackColorCssValue(tabStack.color));
		const foreground = this.getTabStackForeground(tabStack.color);
		if (foreground) {
			element.style.setProperty('--tab-stack-foreground', foreground);
		} else {
			element.style.removeProperty('--tab-stack-foreground');
		}
	}

	private getTabStackHeaderAriaLabel(tabStack: ITabStack): string {
		const count = tabStack.editors.length;
		if (tabStack.label) {
			return count === 1
				? localize('tabStackHeaderAriaLabelOneEditor', "tab stack {0}, 1 editor", tabStack.label)
				: localize('tabStackHeaderAriaLabel', "tab stack {0}, {1} editors", tabStack.label, count);
		}

		return count === 1
			? localize('unnamedTabStackHeaderAriaLabelOneEditor', "unnamed tab stack, 1 editor")
			: localize('unnamedTabStackHeaderAriaLabel', "unnamed tab stack, {0} editors", count);
	}

	/**
	 * Returns the hover of a tab stack header, which names the tab stack like
	 * its chip does and tells how many editors it has.
	 */
	private getTabStackHeaderHover(tabStack: ITabStack): string {
		const count = tabStack.editors.length;
		if (tabStack.label) {
			return count === 1
				? localize('tabStackHeaderHoverOneEditor', "{0} (1 editor)", tabStack.label)
				: localize('tabStackHeaderHover', "{0} ({1} editors)", tabStack.label, count);
		}

		return count === 1
			? localize('unnamedTabStackHeaderHoverOneEditor', "Unnamed tab stack (1 editor)")
			: localize('unnamedTabStackHeaderHover', "Unnamed tab stack ({0} editors)", count);
	}

	/**
	 * Returns black or white, whichever contrasts more with the tab stack
	 * color shown over the tabs background, or `undefined` when the theme has
	 * no value for a preset color. No single theme color contrasts with every
	 * tab stack color, least of all with custom colors.
	 */
	private getTabStackForeground(color: TabStackColor): string | undefined {
		const tabStackColor = isTabStackPresetColor(color) ? this.themeService.getColorTheme().getColor(TAB_STACK_COLOR_IDS[color]) : Color.fromHex(color);
		if (!tabStackColor) {
			return undefined;
		}

		const tabsBackground = this.themeService.getColorTheme().getColor(EDITOR_GROUP_HEADER_TABS_BACKGROUND);
		const background = tabsBackground ? tabStackColor.makeOpaque(tabsBackground) : tabStackColor;

		return (background.getContrastRatio(Color.black) >= background.getContrastRatio(Color.white) ? Color.black : Color.white).toString();
	}

	private toggleTabStack(tabStackId: TabStackId): void {
		const tabStack = this.findTabStack(tabStackId);
		if (!tabStack) {
			return;
		}

		// Keep the header where it is unless collapsing makes another editor
		// active, which is then revealed
		const collapsesActiveEditor = !tabStack.collapsed && tabStack.editors.some(editor => this.tabsModel.isActive(editor));
		if (!collapsesActiveEditor) {
			this.delegate.blockRevealActiveTabOnce();
		}

		this.groupView.updateTabStack(tabStackId, { collapsed: !tabStack.collapsed });
	}

	/**
	 * Opens the name and color bubble of the tab stack under its header, with
	 * `focus` focused, when the tabs show that header.
	 *
	 * @returns whether the bubble opened.
	 */
	editTabStack(tabStackId: TabStackId, focus?: TabStackEditorFocus): boolean {
		const header = this.tabStackHeaders.get(tabStackId);
		if (!header || !isTabStacksEnabled(this.groupsView.partOptions) || !this.isTabStackHeaderShown(header.element)) {
			return false;
		}

		this.withoutRevealingActiveTab(() => this.delegate.revealTabStackHeader(header.element));

		const groupView = this.groupView;
		const group: TabStackEditorGroup = {
			get tabStacks() { return groupView.tabStacks; },
			onDidModelChange: groupView.onDidModelChange,
			updateTabStack: (tabStack, update) => this.withoutRevealingActiveTab(() => groupView.updateTabStack(tabStack, update))
		};
		header.bubble.value = this.instantiationService.createInstance(TabStackEditor, header.element, group, tabStackId);
		header.bubble.value.show(focus);

		return true;
	}

	/**
	 * Returns whether the header is in the tabs container and takes up space,
	 * which it does not while the editor part is hidden.
	 */
	private isTabStackHeaderShown(header: HTMLElement): boolean {
		return header.parentElement === this.delegate.getTabsContainer() && header.getClientRects().length > 0;
	}

	/**
	 * Runs a change for the name and color bubble of a tab stack, keeping the
	 * tabs scrolled where they are rather than revealing the active tab, so
	 * that the bubble stays under the header.
	 */
	private withoutRevealingActiveTab(change: () => void): void {
		this.delegate.blockRevealActiveTabOnce();
		change();

		// A change that ends without a layout lifts the block again
		this.delegate.unblockRevealActiveTabUnlessLayoutPending();
	}

	private onTabStackHeaderContextMenu(tabStackId: TabStackId, e: Event, header: HTMLElement): void {
		const tabStack = this.findTabStack(tabStackId);
		if (!tabStack) {
			return;
		}

		// Find target anchor
		let anchor: HTMLElement | StandardMouseEvent = header;
		if (isMouseEvent(e)) {
			anchor = new StandardMouseEvent(getWindow(header), e);
		}

		// Commands of the menu find the tab stack by its first editor
		const firstEditor = tabStack.editors[0];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			menuId: EditorTabStackContextMenuId,
			contextKeyService: this.contextKeyService,
			menuActionOptions: { shouldForwardArgs: true },
			getActionsContext: () => ({ groupId: this.groupView.id, editorIndex: this.groupView.getIndexOfEditor(firstEditor) }),
			getKeyBinding: action => this.delegate.getKeybinding(action),
			actionRunner: this.tabStackHeaderMenuActionRunner,
			onHide: () => this.groupsView.activeGroup.focus() // restore focus to active group
		});
	}

	/**
	 * Moves the open name and color bubble of a tab stack under its header
	 * again, after a layout or a scroll of the tabs moved the header.
	 */
	layoutTabStackBubbles(): void {
		for (const header of this.tabStackHeaders.values()) {
			header.bubble.value?.layout();
		}
	}
}
