/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventType as TouchEventType, GestureEvent } from '../../../../../base/browser/touch.js';
import { $, addDisposableListener, Dimension, EventType, ModifierKeyEmitter, reset, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDnd.js';
import { ITreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDndService.js';
import { IMenu, IMenuService, isISubmenuItem, MenuId, MenuItemAction, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandActionTitle } from '../../../../../platform/action/common/action.js';
import { ContextKeyExpression, ContextKeyValue } from '../../../../../platform/contextkey/common/contextkey.js';
import { DEFAULT_EDITOR_PART_OPTIONS, EditorTabStackContextMenuId, IEditorGroupMenuIds, IEditorGroupsView, IEditorGroupView, IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { registerTabStackContextMenuItems } from '../../../../browser/parts/editor/editorCommands.js';
import { ActiveEditorInTabStackContext, ActiveEditorStickyContext, EditorGroupHasTabStacksContext, EditorTabsVisibleContext } from '../../../../common/contextkeys.js';
import { MultiEditorTabsControl } from '../../../../browser/parts/editor/multiEditorTabsControl.js';
import { MultiRowEditorControl } from '../../../../browser/parts/editor/multiRowEditorTabsControl.js';
import { EditorInputCapabilities, EditorsOrder, IEditorPartOptions } from '../../../../common/editor.js';
import { EditorGroupModel, ITabStackUpdate, TabStackId } from '../../../../common/editor/editorGroupModel.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { INotebookDocumentService, NotebookDocumentWorkbenchService } from '../../../../services/notebook/common/notebookDocumentService.js';
import { getShownTabStackEditor, TestFileEditorInput, TestHostService, TestMenuService, workbenchInstantiationService } from '../../workbenchTestServices.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuMenuDelegate, IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestColorTheme, TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { Action, IActionRunner } from '../../../../../base/common/actions.js';
import type { IManagedHoverContentOrFactory } from '../../../../../base/browser/ui/hover/hover.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier } from '../../../../browser/dnd.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { isFirefox } from '../../../../../base/browser/browser.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import '../../../../contrib/modernUI/browser/media/tabs.css';
import '../../../../contrib/modernUI/browser/connectedEditorTabs.js';

/**
 * A data transfer that records the drop effect and the allowed effects that a
 * drag handler sets, which the browser only keeps during a drag that it runs
 * itself. Both start unset, so that a handler that sets no effect is told
 * apart from one that sets `none`.
 */
class EffectsDataTransfer extends DataTransfer {
	readonly recorded: { dropEffect?: DataTransfer['dropEffect']; effectAllowed?: DataTransfer['effectAllowed'] } = {};

	override get dropEffect(): DataTransfer['dropEffect'] { return this.recorded.dropEffect ?? 'none'; }
	override set dropEffect(value: DataTransfer['dropEffect']) { this.recorded.dropEffect = value; }
	override get effectAllowed(): DataTransfer['effectAllowed'] { return this.recorded.effectAllowed ?? 'uninitialized'; }
	override set effectAllowed(value: DataTransfer['effectAllowed']) { this.recorded.effectAllowed = value; }
}

suite('MultiEditorTabsControl', () => {

	let disposables: DisposableStore;

	let container: HTMLElement;
	let hostService: TestHostService;
	let control: MultiEditorTabsControl;
	let partOptions: IEditorPartOptions;
	let model: EditorGroupModel;
	let createControl: (menuIds?: IEditorGroupMenuIds) => MultiEditorTabsControl;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;
	let groupView: IEditorGroupView;
	let groupsView: IEditorGroupsView;
	let editorPartsView: IEditorPartsView;
	let editorGroupCount: number;

	setup(() => {
		disposables = new DisposableStore();
		partOptions = { ...DEFAULT_EDITOR_PART_OPTIONS };
		editorGroupCount = 1;

		// The tabs control resolves the shared modifier key emitter on creation,
		// so dispose it again to keep each test independent of the Alt state that
		// other suites may have left behind
		disposables.add(toDisposable(() => ModifierKeyEmitter.disposeInstance()));

		instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(ITreeViewsDnDService, new TreeViewsDnDService());
		instantiationService.stub(INotebookDocumentService, new NotebookDocumentWorkbenchService());

		hostService = instantiationService.get(IHostService) as TestHostService;

		model = disposables.add(instantiationService.createInstance(EditorGroupModel, undefined));
		for (let i = 0; i < 2; i++) {
			const editor = disposables.add(new class extends TestFileEditorInput {
				override getName(): string { return `file${i}.txt`; }
			}(URI.file(`/path/file${i}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: i === 0 });
		}

		groupView = new class extends mock<IEditorGroupView>() {
			override get id() { return model.id; }
			override get count() { return model.count; }
			override get stickyCount() { return model.stickyCount; }
			override get activeEditor() { return model.activeEditor; }
			override get activeEditorPane() { return undefined; }
			override get selectedEditors() { return model.selectedEditors; }
			override get ariaLabel() { return 'Editor Group 1'; }
			override get groupsView(): IEditorGroupsView { return groupsView; }
			override getEditorByIndex(index: number) { return model.getEditorByIndex(index); }
			override getIndexOfEditor(editor: EditorInput) { return model.indexOf(editor); }
			override getEditors(order: EditorsOrder, options?: { excludeSticky?: boolean }) { return model.getEditors(order, options); }
			override isActive(editor: EditorInput) { return model.isActive(editor); }
			override isPinned(editorOrIndex: EditorInput | number) { return model.isPinned(editorOrIndex); }
			override isSticky(editorOrIndex: EditorInput | number) { return model.isSticky(editorOrIndex); }
			override isSelected(editorOrIndex: EditorInput | number) { return model.isSelected(editorOrIndex); }
			// An editor group view needs a whole editor part, so these forward to the model and redraw the tabs.
			// Opening the editor that a selection or a collapse makes active is left to the EditorGroupsService suite.
			override async setSelection(activeSelectedEditor: EditorInput, inactiveSelectedEditors: EditorInput[]) { model.setSelection(activeSelectedEditor, inactiveSelectedEditors); }
			override get tabStacks() { return model.tabStacks; }
			override get onDidModelChange() { return model.onDidModelChange; }
			override getTabStack(editor: EditorInput) { return model.getTabStack(editor); }
			override updateTabStack(tabStack: TabStackId, update: ITabStackUpdate) {
				model.updateTabStack(tabStack, update);
				control.updateTabStacks();
			}
			override createEditorActions() { return { actions: { primary: [], secondary: [] }, onDidChange: Event.None }; }
			override relayout() { }
			override readonly onDidActiveEditorChange = Event.None;
		};

		groupsView = new class extends mock<IEditorGroupsView>() {
			override get partOptions() { return partOptions; }
			override get activeGroup(): IEditorGroupView { return groupView; }
			override get groups(): IEditorGroupView[] { return [groupView]; }
			override readonly onDidChangeEditorPartOptions = Event.None;
			override readonly onDidVisibilityChange = Event.None;
		};

		editorPartsView = new class extends mock<IEditorPartsView>() {
			override get count() { return editorGroupCount; }
			override getGroup() { return groupView; }
		};

		container = $('.title.tabs');
		mainWindow.document.body.appendChild(container);

		createControl = menuIds => {
			if (menuIds?.tabsBarAddTab) {
				instantiationService.stub(IMenuService, new class extends TestMenuService {
					override createMenu(id: MenuId): IMenu {
						return {
							onDidChange: Event.None,
							dispose: () => { },
							getActions: options => id === menuIds.tabsBarAddTab ? [['navigation', [
								instantiationService.createInstance(MenuItemAction, { id: 'test.connectedTabs.newEditor', title: 'New Editor' }, undefined, options, undefined, undefined),
							]]] : [],
						};
					}
				}());
			}
			const control = disposables.add(instantiationService.createInstance(MultiEditorTabsControl, container, editorPartsView, groupsView, groupView, model, menuIds, false, false));
			control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
			return control;
		};
		control = createControl();
	});

	teardown(() => {
		container.remove();

		// Disposing the tabs also ends the drag of a tab stack header
		disposables.dispose();
		LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().clearData(DraggedEditorIdentifier.prototype);
	});

	function tabActions(): string[] {
		return Array.from(container.querySelectorAll('.tabs-container > .tab')).map(tab => {
			const action = tab.querySelector('.tab-actions .action-label');
			if (action?.classList.contains('codicon-close-all')) {
				return 'closeOthers';
			}

			return action?.classList.contains('codicon-close-small') ? 'close' : 'unknown';
		});
	}

	function hoverTab(tabIndex: number): void {
		container.querySelectorAll('.tabs-container > .tab')[tabIndex].dispatchEvent(new MouseEvent(EventType.MOUSE_ENTER));
	}

	function moveMouseOverTabs(altKey: boolean): void {
		container.querySelector('.tabs-container')!.dispatchEvent(new MouseEvent(EventType.MOUSE_MOVE, { altKey, bubbles: true }));
	}

	function mouseDownOnTabAction(tabIndex: number, altKey: boolean): void {
		container.querySelectorAll('.tabs-container > .tab')[tabIndex].querySelector('.tab-actions .action-label')!.dispatchEvent(new MouseEvent(EventType.MOUSE_DOWN, { altKey, bubbles: true, cancelable: true }));
	}

	function alt(pressed: boolean): void {
		mainWindow.dispatchEvent(new KeyboardEvent(pressed ? EventType.KEY_DOWN : EventType.KEY_UP, { key: 'Alt', altKey: pressed }));
	}

	/**
	 * Creates an editor for the file with the name, named like the editors
	 * that each test starts with.
	 */
	function createNamedEditor(name: string): EditorInput {
		return disposables.add(new class extends TestFileEditorInput {
			override getName(): string { return name; }
		}(URI.file(`/path/${name}`), 'testEditorInput'));
	}

	/**
	 * Returns the accessible names of the tabs in order.
	 */
	function tabAriaLabels(): (string | null)[] {
		return Array.from(container.querySelectorAll('.tabs-container > .tab'), tab => tab.getAttribute('aria-label'));
	}

	function connectedGroup(): HTMLElement {
		const root = $('.monaco-workbench.modern-ui.modern-ui-tabs.modern-ui-connected-editor-tabs');
		root.style.cssText = '--vscode-spacing-size20: 2px; --vscode-spacing-size40: 4px; --vscode-spacing-size60: 6px; --vscode-spacing-size80: 8px; --vscode-spacing-size120: 12px; --vscode-spacing-size160: 16px; --vscode-spacing-size200: 20px; --vscode-spacing-size280: 28px; --vscode-strokeThickness: 1px; --vscode-cornerRadius-small: 4px; --vscode-fontSize-body1: 13px; --vscode-fontWeight-regular: 400;';
		mainWindow.document.body.appendChild(root);
		disposables.add(toDisposable(() => root.remove()));
		const editor = $('.part.editor.editor-tabs-multiple');
		const content = $('.content');
		const group = $('.editor-group-container.active');
		root.appendChild(editor);
		editor.appendChild(content);
		content.appendChild(group);
		group.appendChild(container);
		return group;
	}

	async function layoutConnectedGroup(group: HTMLElement, width: number, tabsControl: MultiEditorTabsControl | MultiRowEditorControl = control): Promise<void> {
		group.style.width = `${width}px`;
		tabsControl.layout({ container: new Dimension(width, 33), available: new Dimension(width, 300) });
		await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));
	}

	/**
	 * Replaces the group with one that has an editor for each name, in order
	 * and the first active, with tab stacks enabled in the model and the tabs.
	 */
	function createTabStacksGroup(names: readonly string[], options?: Partial<IEditorPartOptions>, menuIds?: IEditorGroupMenuIds): EditorInput[] {
		(instantiationService.get(IConfigurationService) as TestConfigurationService).setUserConfiguration('workbench', { editor: { enableTabStacks: true } });
		control.dispose();
		container.replaceChildren();

		partOptions = { ...partOptions, enableTabStacks: true, ...options };
		model = disposables.add(instantiationService.createInstance(EditorGroupModel, undefined));
		model.setTabStacksEnabled(true);
		const editors = names.map(name => disposables.add(new TestFileEditorInput(URI.file(`/path/${name}`), 'testEditorInput')));
		editors.forEach((editor, index) => model.openEditor(editor, { pinned: true, active: index === 0, index }));
		control = createControl(menuIds);

		return editors;
	}

	/**
	 * Gathers the editors into a new tab stack, applies the update to it and
	 * shows it in the tabs, as the editor group does, and returns its id.
	 */
	function addTabStack(editors: readonly EditorInput[], update: ITabStackUpdate = {}): TabStackId {
		const tabStack = model.addEditorsToTabStack(editors).tabStack!;
		model.updateTabStack(tabStack.id, update);
		control.updateTabStacks();

		return tabStack.id;
	}

	/**
	 * Describes the children of the tabs container in order: `H:<label>` for a
	 * tab stack header, with `∅` when it has no name and `(collapsed)` when it
	 * is collapsed, `T:<name>` for a tab, with `*` when it is in a tab stack,
	 * and `+` for the Add Tab control.
	 */
	function strip(tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!): string[] {
		return Array.from(tabsContainer.children, describeTabsChild);
	}

	function describeTabsChild(child: Element): string {
		if (child.classList.contains('tab-stack-header')) {
			return `H:${child.querySelector('.tab-stack-header-label')!.textContent || '∅'}${child.classList.contains('collapsed') ? '(collapsed)' : ''}`;
		}

		if (child.classList.contains('tab')) {
			return `T:${child.getAttribute('data-resource-name')}${child.classList.contains('tab-stack-member') ? '*' : ''}`;
		}

		return '+';
	}

	/**
	 * Returns the child of a tabs container that {@link strip} describes as
	 * `description`, or the first tabs container itself for an empty
	 * description.
	 */
	function tabsChild(description: string): HTMLElement {
		if (!description) {
			return container.querySelector<HTMLElement>('.tabs-container')!;
		}

		return Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > *')).find(child => describeTabsChild(child) === description)!;
	}

	/**
	 * Dispatches a drag event near the left or right edge of a child of a
	 * tabs container, or on the first tabs container itself for an empty
	 * description.
	 */
	function dispatchDrag(type: string, description: string, side: 'left' | 'right', init?: DragEventInit): DragEvent {
		const element = tabsChild(description);
		const rect = element.getBoundingClientRect();
		const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: side === 'left' ? rect.left + 1 : rect.right - 1, clientY: rect.top + rect.height / 2, dataTransfer: new DataTransfer(), ...init });
		element.dispatchEvent(event);

		return event;
	}

	/**
	 * Describes the drop feedback as the children of the tabs containers
	 * before and after the drop position, with `∅` for none, followed by
	 * `in <label>` when it shows a drop inside the tab stack whose header has
	 * that label and the same color, or `in ?` when both children do not show
	 * that alike.
	 */
	function dropFeedback(): string {
		const describe = (element: Element | null) => element ? describeTabsChild(element) : '∅';
		const left = container.querySelector<HTMLElement>('.drop-target-left');
		const right = container.querySelector<HTMLElement>('.drop-target-right');
		const colors = new Set([left, right].filter(element => !!element).map(element => element.classList.contains('drop-target-in-tab-stack') ? element.style.getPropertyValue('--drop-target-tab-stack-color') : ''));
		const [color] = colors;
		const header = colors.size === 1 && color ? tabStackHeaders().find(header => header.style.getPropertyValue('--tab-stack-color') === color) : undefined;
		const tabStack = header ? ` in ${header.querySelector('.tab-stack-header-label')!.textContent || '∅'}` : ` in ?`;

		return `${describe(left)} | ${describe(right)}${colors.size > 1 || color ? tabStack : ''}`;
	}

	/**
	 * Drags over a child of a tabs container, or the first tabs container
	 * itself for an empty description, and returns the drop feedback.
	 */
	function dragOver(description: string, side: 'left' | 'right', init?: DragEventInit): string {
		dispatchDrag(EventType.DRAG_ENTER, description, side, init);
		dispatchDrag(EventType.DRAG_OVER, description, side, init);

		return dropFeedback();
	}

	/**
	 * Starts a drag of editors of the group the way a tab does.
	 */
	function dragEditors(editors: readonly EditorInput[]): void {
		LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().setData(editors.map(editor => new DraggedEditorIdentifier({ editor, groupId: model.id })), DraggedEditorIdentifier.prototype);
	}

	/**
	 * Starts to drag a tab stack header, and returns the drag start event.
	 */
	function dragTabStackHeader(description: string): DragEvent {
		return dispatchDrag(EventType.DRAG_START, description, 'left');
	}

	function tabStackHeaders(): HTMLElement[] {
		return Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab-stack-header'));
	}

	function shownTabs(): HTMLElement[] {
		return Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
	}

	/**
	 * Returns the shown editor of a tab stack, or `undefined` when none is
	 * shown.
	 */
	function shownTabStackEditor(): HTMLElement | undefined {
		return getShownTabStackEditor(instantiationService.get(IContextViewService));
	}

	/**
	 * Like {@link connectedGroup}, but with the classic tab style, which lays
	 * out fixed size tabs at exactly their fixed width.
	 */
	function classicGroup(): HTMLElement {
		const group = connectedGroup();
		group.closest('.monaco-workbench')!.classList.remove('modern-ui', 'modern-ui-tabs', 'modern-ui-connected-editor-tabs');

		return group;
	}

	async function nextAnimationFrame(): Promise<void> {
		await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));
	}

	/**
	 * Counts the reads of the properties of the element, which still return what the element has.
	 */
	function countReads(element: HTMLElement, properties: readonly ('firstElementChild' | 'offsetWidth' | 'scrollWidth')[]): { count: number } {
		const reads = { count: 0 };
		for (const property of properties) {
			Object.defineProperty(element, property, {
				configurable: true,
				get: () => {
					reads.count++;
					return Reflect.get(HTMLElement.prototype, property, element);
				}
			});
		}

		return reads;
	}

	/**
	 * Returns whether the active tab is within the visible part of the tabs.
	 */
	function isActiveTabRevealed(): boolean {
		const activeTab = container.querySelector<HTMLElement>('.tabs-container > .tab.active')!.getBoundingClientRect();
		const viewport = container.querySelector<HTMLElement>('.monaco-scrollable-element')!.getBoundingClientRect();

		return activeTab.left >= viewport.left && activeTab.right <= viewport.right;
	}

	test('keeps connected layout current when an Add Tab toolbar follows the editor tabs', async () => {
		const group = connectedGroup();
		group.closest('.monaco-workbench')!.classList.remove('modern-ui');
		const editors = model.getEditors(EditorsOrder.SEQUENTIAL);
		for (const editor of editors) {
			model.closeEditor(editor);
		}
		control.dispose();
		reset(container);
		const menuId = MenuId.for('test.connectedTabs.addTab');
		control = createControl({ tabsBarAddTab: menuId });
		await layoutConnectedGroup(group, 600);
		const emptyHeight = control.getHeight();
		for (const [index, editor] of editors.entries()) {
			model.openEditor(editor, { pinned: true, active: index === 0 });
		}
		control.openEditors(editors);

		const results = [];
		for (const tabHeight of ['default', 'compact'] as const) {
			const oldOptions = partOptions;
			partOptions = { ...partOptions, tabHeight };
			control.updateOptions(oldOptions, partOptions);
			for (const width of [600, 220, 600]) {
				await layoutConnectedGroup(group, width);
				const row = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
				const addTab = container.querySelector<HTMLElement>('.tabs-bar-add-tab')!;
				const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
				results.push({
					tabHeight,
					width,
					cachedHeight: control.getHeight(),
					renderedHeight: row.offsetHeight,
					measuredEditors: tabs.every(tab => parseFloat(tab.style.getPropertyValue('--connected-tab-min-width')) > 0),
					addTab: {
						visible: !addTab.classList.contains('hidden'),
						isLast: addTab === addTab.parentElement!.lastElementChild,
						measuredWidth: addTab.style.getPropertyValue('--connected-tab-min-width'),
						upperRow: addTab.classList.contains('connected-tab-upper-row'),
					},
				});
			}
		}
		assert.deepStrictEqual({ emptyHeight, results }, {
			emptyHeight: 0,
			results: ['default', 'compact'].flatMap(tabHeight => [600, 220, 600].map(width => ({
				tabHeight,
				width,
				cachedHeight: tabHeight === 'compact' ? 29 : 33,
				renderedHeight: tabHeight === 'compact' ? 29 : 33,
				measuredEditors: true,
				addTab: { visible: true, isLast: true, measuredWidth: '', upperRow: false },
			}))),
		});
	});

	test('connected minimum width preserves basename ellipsis extension badge and action', async () => {
		const group = connectedGroup();
		const badgeStyle = document.createElement('style');
		badgeStyle.textContent = '.connected-tabs-labels .monaco-decoration-badge::after { content: "WM"; margin: 0 5px; }';
		group.appendChild(badgeStyle);
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fixed', tabSizingFixedMinWidth: 20, tabSizingFixedMaxWidth: 20, editorActionsLocation: 'hidden', hasIcons: true, showTabIndex: true };
		control.updateOptions(oldOptions, partOptions);
		const tab = container.querySelector<HTMLElement>('.tab')!;
		const label = tab.querySelector<HTMLElement>('.tab-label')!;
		label.classList.add('monaco-decoration-badge');
		await layoutConnectedGroup(group, 200);
		// Resource labels are redrawn on entry to the connected mode.
		label.classList.add('monaco-decoration-badge');
		await layoutConnectedGroup(group, 200);
		const name = tab.querySelector<HTMLElement>('.label-name')!;
		const nameContainer = name.parentElement!;
		const suffix = tab.querySelector<HTMLElement>('.label-suffix')!;
		const action = tab.querySelector<HTMLElement>('.tab-actions')!;
		const context = document.createElement('canvas').getContext('2d')!;
		const badge = mainWindow.getComputedStyle(label, '::after');
		context.font = badge.font;
		const badgeTextWidth = context.measureText('WM').width;
		context.font = mainWindow.getComputedStyle(name).font;
		assert.deepStrictEqual({
			minimum: tab.offsetWidth >= Math.ceil(context.measureText('1: f….txt').width + badgeTextWidth) + 10 + 34,
			intrinsicBadgeWidth: Math.abs(parseFloat(badge.width) - badgeTextWidth) < 1,
			narrow: tab.classList.contains('connected-tab-narrow'),
			iconHidden: mainWindow.getComputedStyle(label, '::before').display,
			basename: name.textContent,
			extension: suffix.textContent,
			ellipsis: mainWindow.getComputedStyle(nameContainer).textOverflow,
			basenameVisible: nameContainer.clientWidth >= context.measureText('1: f…').width,
			extensionBeforeAction: suffix.getBoundingClientRect().right <= action.getBoundingClientRect().left,
			fullAriaLabel: tab.getAttribute('aria-label')?.includes('file0.txt'),
		}, {
			minimum: true, intrinsicBadgeWidth: true, narrow: true, iconHidden: 'none', basename: '1: file0', extension: '.txt',
			ellipsis: 'ellipsis', basenameVisible: true, extensionBeforeAction: true, fullAriaLabel: true,
		});
		name.style.fontSize = '13px';
		nameContainer.style.fontSize = '20px';
		await layoutConnectedGroup(group, 200);
		context.font = mainWindow.getComputedStyle(name).font;
		const firstCharacterWidth = context.measureText('1: f').width;
		context.font = mainWindow.getComputedStyle(nameContainer).font;
		assert.ok(nameContainer.clientWidth >= firstCharacterWidth + context.measureText('…').width, JSON.stringify({
			message: 'reserve the ellipsis using its container font',
			actual: nameContainer.clientWidth,
			required: firstCharacterWidth + context.measureText('…').width,
			minimum: tab.style.getPropertyValue('--connected-tab-min-width'),
			tabWidth: tab.offsetWidth,
		}));
		group.closest('.monaco-workbench')!.classList.remove('modern-ui-connected-editor-tabs');
		await layoutConnectedGroup(group, 200);
		assert.deepStrictEqual([name.textContent, suffix.textContent, tab.style.getPropertyValue('--connected-tab-min-width')], ['1: file0.txt', '', '']);
	});

	for (const showTabIndex of [false, true]) {
		test(`connected compression preserves initial graphemes and dotfile prefixes (index: ${showTabIndex})`, async () => {
			const group = connectedGroup();
			const cases = [
				{ name: 'e\u0301xample.txt', initial: 'e\u0301' },
				{ name: '\u0915\u093fname.txt', initial: '\u0915\u093f' },
				{ name: '😀example.txt', initial: '😀' },
				{ name: '👍🏽example.txt', initial: '👍🏽' },
				{ name: '👩🏽‍💻example.txt', initial: '👩🏽‍💻' },
				{ name: '🇫🇷example.txt', initial: '🇫🇷' },
				{ name: '.env', initial: '.e' },
				{ name: '.gitignore', initial: '.g' },
				{ name: '.👩🏽‍💻example.txt', initial: '.👩🏽‍💻' },
			];
			for (const { name } of cases) {
				const editor = disposables.add(new class extends TestFileEditorInput {
					override getName(): string { return name; }
				}(URI.file(`/path/${name}`), 'testEditorInput'));
				model.openEditor(editor, { pinned: true, active: false, index: model.count });
			}
			control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
			const oldOptions = partOptions;
			partOptions = { ...partOptions, showTabIndex, tabSizing: 'fixed', tabSizingFixedMinWidth: 20, tabSizingFixedMaxWidth: 20, editorActionsLocation: 'hidden', hasIcons: false };
			control.updateOptions(oldOptions, partOptions);
			await layoutConnectedGroup(group, 260);
			const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab')).slice(2);
			const context = $<HTMLCanvasElement>('canvas').getContext('2d')!;
			const results = cases.map(({ name, initial }, index) => {
				const tab = tabs[index];
				const labelName = tab.querySelector<HTMLElement>('.label-name')!;
				const nameContainer = labelName.parentElement!;
				const prefix = showTabIndex ? `${index + 3}: ` : '';
				context.font = mainWindow.getComputedStyle(labelName).font;
				const initialWidth = context.measureText(`${prefix}${initial}`).width;
				context.font = mainWindow.getComputedStyle(nameContainer).font;
				const minimumNameWidth = Math.ceil(initialWidth + context.measureText('…').width);
				return {
					name,
					measuredInitial: parseFloat(tab.style.getPropertyValue('--connected-tab-min-name-width')) === minimumNameWidth,
					initialVisible: nameContainer.clientWidth >= minimumNameWidth,
				};
			});
			assert.deepStrictEqual(results, cases.map(({ name }) => ({ name, measuredInitial: true, initialVisible: true })));
		});
	}

	test('connected shrink tabs collapse and restore icons as the editor width changes', async () => {
		const group = connectedGroup();
		const iconStyle = document.createElement('style');
		iconStyle.textContent = '.connected-tabs-labels .tab-label::before { content: ""; }';
		group.appendChild(iconStyle);
		for (let i = 2; i < 10; i++) {
			const editor = disposables.add(new class extends TestFileEditorInput {
				override getName(): string { return `file${i}.txt`; }
			}(URI.file(`/path/file${i}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: false });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'shrink', hasIcons: true, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		const states = [];
		for (const width of [1200, 420, 1200, 420]) {
			await layoutConnectedGroup(group, width);
			const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
			states.push({
				collapsedIcons: tabs.filter(tab => tab.classList.contains('connected-tab-narrow')).length,
				trimmedNames: tabs.filter(tab => {
					const name = tab.querySelector<HTMLElement>('.monaco-icon-name-container')!;
					return name.scrollWidth > name.clientWidth;
				}).length,
				preservedExtensions: tabs.every(tab => {
					const suffix = tab.querySelector<HTMLElement>('.label-suffix')!;
					const action = tab.querySelector<HTMLElement>('.tab-actions')!;
					return suffix.textContent === '.txt' && suffix.getBoundingClientRect().right <= action.getBoundingClientRect().left;
				}),
			});
		}
		assert.deepStrictEqual(states, [
			{ collapsedIcons: 0, trimmedNames: 0, preservedExtensions: true },
			{ collapsedIcons: 10, trimmedNames: 10, preservedExtensions: true },
			{ collapsedIcons: 0, trimmedNames: 0, preservedExtensions: true },
			{ collapsedIcons: 10, trimmedNames: 10, preservedExtensions: true },
		]);
	});

	test('protects extensions only when the tab title matches the resource filename', async () => {
		const group = connectedGroup();
		const cases = [
			{ resource: URI.file('/path/archive.tar.gz'), name: 'archive.tar.gz' },
			{ resource: URI.file('/path/.env'), name: '.env' },
			{ resource: URI.file('/path/file.'), name: 'file.' },
			{ resource: URI.file('/path/notes.md'), name: 'Release 1.2 notes and announcements' },
			{ resource: URI.from({ scheme: 'test', path: '/views/123' }), name: 'Example.org documentation' },
			{ resource: undefined, name: 'Release 1.2 notes and announcements' },
		];
		const results = [];
		for (const { resource, name } of cases) {
			const editor = disposables.add(new class extends EditorInput {
				override get typeId(): string { return 'testEditorTitle'; }
				override get resource(): URI | undefined { return resource; }
				override getName(): string { return name; }
			}());
			model.openEditor(editor, { pinned: true, active: true });
			control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
			await layoutConnectedGroup(group, 240);
			const tab = container.querySelector<HTMLElement>('.tab.active')!;
			results.push({
				name: tab.querySelector('.label-name')?.textContent,
				suffix: tab.querySelector('.label-suffix')?.textContent ?? '',
				accessibleName: tab.getAttribute('aria-label')?.includes(name),
			});
		}
		assert.deepStrictEqual(results, [
			{ name: 'archive.tar', suffix: '.gz', accessibleName: true },
			{ name: '.env', suffix: '', accessibleName: true },
			{ name: 'file.', suffix: '', accessibleName: true },
			{ name: 'Release 1.2 notes and announcements', suffix: '', accessibleName: true },
			{ name: 'Example.org documentation', suffix: '', accessibleName: true },
			{ name: 'Release 1.2 notes and announcements', suffix: '', accessibleName: true },
		]);
	});

	test('connected actions keep active and dirty visible but inactive clean quiet', async () => {
		const group = connectedGroup();
		container.classList.add('tab-actions-reserve-space');
		await layoutConnectedGroup(group, 400);
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tab'));
		const opacity = () => tabs.map(tab => mainWindow.getComputedStyle(tab.querySelector('.action-label')!).opacity);
		const clean = opacity();
		tabs[1].classList.add('dirty');
		const dirty = opacity();
		tabs[1].classList.remove('dirty');
		const action = tabs[1].querySelector<HTMLElement>('.action-label')!;
		action.tabIndex = 0;
		action.focus();
		const focused = opacity();
		action.blur();
		assert.deepStrictEqual({ clean, dirty, focused }, { clean: ['1', '0'], dirty: ['1', '1'], focused: ['1', '1'] });
	});

	test('connected close actions keep consistent spacing across terminal and wrapped tabs', async () => {
		const group = connectedGroup();
		group.style.setProperty('--vscode-editorGroupHeader-tabsBorder', '#333333');
		const measure = () => {
			const tab = container.querySelector<HTMLElement>('.tab.active')!;
			const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
			const action = tab.querySelector<HTMLElement>('.action-label')!;
			const actions = tab.querySelector<HTMLElement>('.tab-actions')!;
			const label = tab.querySelector<HTMLElement>('.monaco-icon-label-container')!;
			const fillBounds = fill.getBoundingClientRect();
			const actionBounds = action.getBoundingClientRect();
			const actionsBounds = actions.getBoundingClientRect();
			const actionStyle = mainWindow.getComputedStyle(action);
			const actionsStyle = mainWindow.getComputedStyle(actions);
			const fillStyle = mainWindow.getComputedStyle(fill);
			return {
				top: actionBounds.top - fillBounds.top - (fillStyle.borderTopColor === 'rgba(0, 0, 0, 0)' ? 0 : Number.parseFloat(fillStyle.borderTopWidth)),
				bottom: Math.min(fillBounds.bottom, tab.getBoundingClientRect().bottom) - actionBounds.bottom - (!tab.classList.contains('connected-tab-upper-row') && !tab.classList.contains('connected-tab-top-row') ? Number.parseFloat(fillStyle.borderBottomWidth) : 0),
				right: fillBounds.right - actionBounds.right - (fillStyle.borderRightColor === 'rgba(0, 0, 0, 0)' ? 0 : Number.parseFloat(fillStyle.borderRightWidth)),
				left: actionBounds.left - label.getBoundingClientRect().right,
				width: fillBounds.width,
				actionInsets: [
					actionBounds.left - actionsBounds.left - Number.parseFloat(actionsStyle.borderLeftWidth),
					actionsBounds.right - Number.parseFloat(actionsStyle.borderRightWidth) - actionBounds.right,
				],
				padding: [actionStyle.paddingTop, actionStyle.paddingRight, actionStyle.paddingBottom, actionStyle.paddingLeft],
			};
		};

		await layoutConnectedGroup(group, 400);
		const multiple = measure();
		const stroke = Number.parseFloat(mainWindow.getComputedStyle(container.querySelector<HTMLElement>('.tab.active')!).getPropertyValue('--vscode-strokeThickness'));

		const secondEditor = model.getEditorByIndex(1)!;
		model.closeEditor(secondEditor);
		control.closeEditor(secondEditor);
		await layoutConnectedGroup(group, 400);
		const single = measure();

		model.openEditor(secondEditor, { pinned: true, active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		await layoutConnectedGroup(group, 150);
		const wrappedBottom = measure();

		model.openEditor(model.getEditorByIndex(0)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layoutConnectedGroup(group, 150);
		const wrappedUpper = measure();
		const measurements = [multiple, single, wrappedBottom, wrappedUpper];

		const oldWrappedOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: false, tabSizing: 'fit', tabActionLocation: 'left' };
		control.updateOptions(oldWrappedOptions, partOptions);
		await layoutConnectedGroup(group, 400);
		const leftMultiple = measure();

		model.closeEditor(secondEditor);
		control.closeEditor(secondEditor);
		await layoutConnectedGroup(group, 400);
		const leftSingle = measure();

		assert.deepStrictEqual({
			single: {
				top: single.top === multiple.top,
				right: single.right === multiple.right,
				left: single.left === multiple.left,
				width: single.width === multiple.width,
			},
			horizontal: {
				clearance: measurements.map(measurement => [measurement.top, measurement.right, measurement.bottom, measurement.left]),
			},
			leftAction: {
				top: leftSingle.top === leftMultiple.top,
				right: leftSingle.right === leftMultiple.right,
				left: leftSingle.left === leftMultiple.left,
				width: leftSingle.width === leftMultiple.width,
			},
			balancedActionSurface: [...measurements, leftMultiple, leftSingle].every(measurement => Math.abs(measurement.actionInsets[0] - measurement.actionInsets[1]) <= stroke),
			balancedActionInsets: measurements.every(measurement => Math.abs(measurement.right - measurement.left) <= stroke),
			actionPadding: measurements.every(measurement => new Set(measurement.padding).size === 1 && measurement.padding[0] === multiple.padding[0]),
		}, {
			single: { top: true, right: true, left: true, width: true },
			horizontal: { clearance: [[6, 6, 6, 6], [6, 6, 6, 6], [3, 3, 3, 4], [4, 4, 4, 4]] },
			leftAction: { top: true, right: true, left: true, width: true },
			balancedActionSurface: true,
			balancedActionInsets: true,
			actionPadding: true,
		});
	});

	test('close hover targets have equal vertical and trailing clearance at both tab densities', async () => {
		const group = connectedGroup();
		group.style.setProperty('--vscode-editorGroupHeader-tabsBorder', '#333333');
		const measurements = [];
		const expected = [];
		for (const tabHeight of ['default', 'compact'] as const) {
			for (const tabActionLocation of ['right', 'left'] as const) {
				for (const wrapTabs of [false, true]) {
					const oldOptions = partOptions;
					partOptions = { ...partOptions, tabHeight, tabActionLocation, wrapTabs, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
					control.updateOptions(oldOptions, partOptions);
					for (const activeIndex of [0, 1]) {
						model.openEditor(model.getEditorByIndex(activeIndex)!, { active: true });
						control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
						await layoutConnectedGroup(group, wrapTabs ? 150 : 400);
						const tab = container.querySelector<HTMLElement>('.tab.active')!;
						const fillElement = tab.querySelector<HTMLElement>('.tab-fill')!;
						const fill = fillElement.getBoundingClientRect();
						const fillStyle = mainWindow.getComputedStyle(fillElement);
						const action = tab.querySelector<HTMLElement>('.action-label')!.getBoundingClientRect();
						const rowStart = activeIndex === 0 || wrapTabs;
						const upperRow = wrapTabs && activeIndex === 0;
						measurements.push({
							tabHeight, tabActionLocation, wrapTabs, activeIndex,
							top: action.top - fill.top - (fillStyle.borderTopColor === 'rgba(0, 0, 0, 0)' ? 0 : Number.parseFloat(fillStyle.borderTopWidth)),
							bottom: Math.min(fill.bottom, tab.getBoundingClientRect().bottom) - action.bottom - (wrapTabs && !upperRow ? Number.parseFloat(fillStyle.borderBottomWidth) : 0),
							trailing: tabActionLocation === 'left'
								? action.left - fill.left - (fillStyle.borderLeftColor === 'rgba(0, 0, 0, 0)' ? 0 : Number.parseFloat(fillStyle.borderLeftWidth))
								: fill.right - action.right - (fillStyle.borderRightColor === 'rgba(0, 0, 0, 0)' ? 0 : Number.parseFloat(fillStyle.borderRightWidth)),
							leftBorder: rowStart && !upperRow ? mainWindow.getComputedStyle(tab.querySelector<HTMLElement>('.tab-fill')!).borderLeftColor : undefined,
						});
						const clearance = (tabHeight === 'compact' ? 4 : 6) - (wrapTabs ? 2 : 0) - (wrapTabs && activeIndex === 1 ? 1 : 0);
						expected.push({
							tabHeight, tabActionLocation, wrapTabs, activeIndex,
							top: clearance, bottom: clearance, trailing: clearance,
							leftBorder: rowStart && !upperRow ? 'rgba(0, 0, 0, 0)' : undefined,
						});
					}
				}
			}
		}
		assert.deepStrictEqual(measurements, expected);
	});

	test('reveals the active tab with its right shoulder outside the label and action', async () => {
		const group = connectedGroup();
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fixed', tabSizingFixedMinWidth: 160.25, tabSizingFixedMaxWidth: 160.25, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		const thirdEditor = disposables.add(new TestFileEditorInput(URI.file('/path/file2.txt'), 'testEditorInput'));
		model.openEditor(thirdEditor, { pinned: true, active: false });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layoutConnectedGroup(group, 240);
		model.openEditor(model.getEditorByIndex(1)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		control.layout({ container: new Dimension(240, 33), available: new Dimension(240, 300) }, { forceRevealActiveTab: true });
		await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));
		const tab = container.querySelectorAll<HTMLElement>('.tabs-container > .tab')[1];
		const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
		const action = tab.querySelector<HTMLElement>('.tab-actions')!;
		const viewport = container.querySelector<HTMLElement>('.monaco-scrollable-element')!;
		const shoulderWidth = Number.parseFloat(mainWindow.getComputedStyle(fill, '::after').width);
		assert.deepStrictEqual({
			labelBeforeAction: tab.querySelector<HTMLElement>('.monaco-icon-label-container')!.getBoundingClientRect().right <= action.getBoundingClientRect().left,
			shoulderVisible: fill.getBoundingClientRect().right + shoulderWidth <= viewport.getBoundingClientRect().right,
			clipped: tab.classList.contains('connected-tab-right-edge'),
		}, {
			labelBeforeAction: true,
			shoulderVisible: true,
			clipped: false,
		});
	});

	test('reveals the left shoulder of non-first tabs and keeps the first tab flush', async () => {
		const group = connectedGroup();
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fixed', tabSizingFixedMinWidth: 160.25, tabSizingFixedMaxWidth: 160.25, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		for (let i = 2; i < 4; i++) {
			const editor = disposables.add(new TestFileEditorInput(URI.file(`/path/file${i}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: false });
		}
		const reveal = async (index: number, width: number) => {
			model.openEditor(model.getEditorByIndex(index)!, { active: true });
			control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
			group.style.width = `${width}px`;
			control.layout({ container: new Dimension(width, 33), available: new Dimension(width, 300) }, { forceRevealActiveTab: true });
			await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));
		};
		const results = [];
		for (const { width, from } of [{ width: 240, from: 3 }, { width: 172, from: 0 }, { width: 120, from: 0 }]) {
			await reveal(from, width);
			await reveal(1, width);
			const tab = container.querySelector<HTMLElement>('.tab.active')!;
			const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
			const viewport = container.querySelector<HTMLElement>('.monaco-scrollable-element')!.getBoundingClientRect();
			const shoulder = mainWindow.getComputedStyle(fill, '::before');
			const shoulderWidth = Number.parseFloat(shoulder.width);
			results.push({
				width,
				leftShoulderVisible: shoulder.content !== 'none' && fill.getBoundingClientRect().left - shoulderWidth >= viewport.left,
				rightShoulderVisible: fill.getBoundingClientRect().right + shoulderWidth <= viewport.right,
			});
		}
		await reveal(0, 240);
		const firstFill = container.querySelector<HTMLElement>('.tab.active > .tab-fill')!;
		const firstFillStyle = mainWindow.getComputedStyle(firstFill);
		assert.deepStrictEqual({
			results,
			firstBorderInset: firstFillStyle.left,
			firstBorderColor: firstFillStyle.borderLeftColor,
			firstShoulder: mainWindow.getComputedStyle(firstFill, '::before').content,
		}, {
			results: [
				{ width: 240, leftShoulderVisible: true, rightShoulderVisible: true },
				{ width: 172, leftShoulderVisible: true, rightShoulderVisible: true },
				{ width: 120, leftShoulderVisible: true, rightShoulderVisible: false },
			],
			firstBorderInset: '0px',
			firstBorderColor: 'rgba(0, 0, 0, 0)',
			firstShoulder: 'none',
		});
	});

	test('keeps replacement connected tabs visible after closing rightmost scrolled tabs', async () => {
		const group = connectedGroup();
		const root = group.closest<HTMLElement>('.monaco-workbench')!;
		root.classList.add('hc-black');
		root.style.setProperty('--vscode-focusBorder', '#ffaa00');
		root.style.setProperty('--modern-ui-connected-tab-surface', '#333333');
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fixed', tabSizingFixedMinWidth: 160, tabSizingFixedMaxWidth: 160, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		for (let i = 2; i < 5; i++) {
			const editor = disposables.add(new TestFileEditorInput(URI.file(`/path/file${i}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: true });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layoutConnectedGroup(group, 200);
		const tabs = container.querySelector<HTMLElement>('.tabs-container')!;
		const results = [];
		for (let count = 5; count > 2; count--) {
			tabs.classList.add('scroll');
			tabs.scrollLeft = tabs.scrollWidth - tabs.clientWidth;
			tabs.dispatchEvent(new UIEvent(EventType.SCROLL));
			tabs.classList.remove('scroll');
			const oldScrollLeft = tabs.scrollLeft;
			const closedEditor = model.getEditorByIndex(count - 1)!;
			model.closeEditor(closedEditor);
			control.closeEditor(closedEditor);
			const clampedBeforeLayout = tabs.scrollLeft < oldScrollLeft;
			await layoutConnectedGroup(group, 200);
			const activeTab = tabs.querySelector<HTMLElement>('.tab.active')!;
			const fill = activeTab.querySelector<HTMLElement>('.tab-fill')!;
			const fillStyle = mainWindow.getComputedStyle(fill);
			const edge = activeTab.querySelector<HTMLElement>('.tab-connected-edge')!;
			results.push({
				clampedBeforeLayout,
				activeIndex: model.indexOf(model.activeEditor!),
				scrollLeft: tabs.scrollLeft,
				fillLeft: fill.getBoundingClientRect().left - tabs.getBoundingClientRect().left + tabs.scrollLeft,
				hidden: activeTab.classList.contains('connected-tab-hidden'),
				fillDisplay: fillStyle.display,
				outlineDisplay: mainWindow.getComputedStyle(edge).display,
				outlineColor: fillStyle.borderRightColor,
				frameColor: mainWindow.getComputedStyle(group, '::after').borderTopColor,
			});
		}
		assert.deepStrictEqual(results, [4, 3, 2].map(count => ({
			clampedBeforeLayout: true,
			activeIndex: count - 1,
			scrollLeft: count * 160 - 200 + 5,
			fillLeft: (count - 1) * 160,
			hidden: false,
			fillDisplay: 'block',
			outlineDisplay: 'block',
			outlineColor: 'rgb(255, 170, 0)',
			frameColor: 'rgb(255, 170, 0)',
		})));
	});

	test('connected sticky offsets respect content minimums instead of the classic fixed width', async () => {
		const group = connectedGroup();
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fixed', tabSizingFixedMinWidth: 20, tabSizingFixedMaxWidth: 20, pinnedTabSizing: 'shrink', editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		const longExtension = disposables.add(new class extends TestFileEditorInput {
			override getName(): string { return 'example.dockerignore'; }
		}(URI.file('/path/example.dockerignore'), 'testEditorInput'));
		model.openEditor(longExtension, { index: 0, pinned: true, sticky: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		for (const editor of model.getEditors(EditorsOrder.SEQUENTIAL)) {
			model.stick(editor);
			control.stickEditor(editor);
		}
		await layoutConnectedGroup(group, 400);
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
		assert.deepStrictEqual({
			contentMinimum: tabs[0].offsetWidth > 80,
			offsets: tabs.map(tab => tab.style.left),
		}, { contentMinimum: true, offsets: ['0px', `${tabs[0].offsetWidth}px`, `${tabs[0].offsetWidth + tabs[1].offsetWidth}px`] });
	});

	test('only the bottom wrapped row joins the document and upper row resets when unwrapped', async () => {
		const group = connectedGroup();
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		await layoutConnectedGroup(group, 150);
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tab'));
		const wrapped = tabs.map(tab => tab.classList.contains('connected-tab-upper-row'));
		const wrappedTop = tabs.map(tab => tab.classList.contains('connected-tab-top-row'));
		const fill = tabs[0].querySelector<HTMLElement>('.tab-fill')!;
		const upper = { inset: mainWindow.getComputedStyle(fill).top, shoulder: mainWindow.getComputedStyle(fill, '::after').content };
		await layoutConnectedGroup(group, 400);
		const unwrapped = tabs.map(tab => tab.classList.contains('connected-tab-upper-row'));
		const unwrappedTop = tabs.map(tab => tab.classList.contains('connected-tab-top-row'));
		assert.deepStrictEqual(
			{ wrapped, wrappedTop, upper, unwrapped, unwrappedTop },
			{ wrapped: [true, false], wrappedTop: [true, false], upper: { inset: '-2px', shoulder: 'none' }, unwrapped: [false, false], unwrappedTop: [true, true] }
		);
	});

	test('connected minimum widths settle wrapping on the first scheduled layout', async () => {
		const group = connectedGroup();
		for (const editor of model.getEditors(EditorsOrder.SEQUENTIAL)) {
			model.closeEditor(editor);
			control.closeEditor(editor);
		}
		for (let index = 0; index < 6; index++) {
			const editor = disposables.add(new class extends TestFileEditorInput {
				override getName(): string { return '.markdown'; }
			}(URI.file(`/path/file${index}.markdown`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: index === 0 });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 50, tabSizingFixedMaxWidth: 160, editorActionsLocation: 'hidden', hasIcons: false };
		control.updateOptions(oldOptions, partOptions);

		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
		const unstableLayouts = [];
		for (const width of [230, 360, 400, 420, 440, 460, 480]) {
			await layoutConnectedGroup(group, width);
			const firstPass = {
				offsets: tabs.map(tab => tab.offsetTop),
				wrapping: container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping'),
			};
			await layoutConnectedGroup(group, width);
			const secondPass = {
				offsets: tabs.map(tab => tab.offsetTop),
				wrapping: container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping'),
			};
			if (firstPass.wrapping !== secondPass.wrapping || firstPass.offsets.some((top, index) => top !== secondPass.offsets[index])) {
				unstableLayouts.push({ width, firstPass, secondPass });
			}
		}

		assert.deepStrictEqual({
			unstableLayouts,
			minimumConstrained: tabs.every(tab => tab.style.getPropertyValue('--connected-tab-min-width') !== ''),
		}, {
			unstableLayouts: [],
			minimumConstrained: true,
		});
	});

	test('wrapped tabs stop wrapping once they fit on one row again, also as Modern UI tabs', async () => {
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
		const states = [];
		for (const tabStyle of ['connected', 'modern', 'classic'] as const) {
			const group = connectedGroup();
			const workbench = group.closest('.monaco-workbench')!;
			if (tabStyle !== 'connected') {
				workbench.classList.remove('modern-ui-connected-editor-tabs');
			}
			if (tabStyle === 'classic') {
				workbench.classList.remove('modern-ui', 'modern-ui-tabs');
			}
			control.dispose();
			container.replaceChildren();
			control = createControl();
			const tabsAndActionsContainer = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;

			await layoutConnectedGroup(group, 150);
			const wrappedWhenNarrow = tabsAndActionsContainer.classList.contains('wrapping');
			await layoutConnectedGroup(group, 900);

			states.push({ tabStyle, wrappedWhenNarrow, wrappedWhenWide: tabsAndActionsContainer.classList.contains('wrapping'), heightWhenWide: control.getHeight() });
		}

		assert.deepStrictEqual(states, [
			{ tabStyle: 'connected', wrappedWhenNarrow: true, wrappedWhenWide: false, heightWhenWide: 33 },
			{ tabStyle: 'modern', wrappedWhenNarrow: true, wrappedWhenWide: false, heightWhenWide: 32 },
			{ tabStyle: 'classic', wrappedWhenNarrow: true, wrappedWhenWide: false, heightWhenWide: 35 },
		]);
	});

	test('fit-sized connected tabs settle wrapping on the first layout while the width grows and shrinks', async () => {
		const group = connectedGroup();
		for (let i = 2; i < 8; i++) {
			model.openEditor(createNamedEditor(`file${i}.txt`), { pinned: true, index: i });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true };
		control.updateOptions(oldOptions, partOptions);
		const tabsAndActionsContainer = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
		const describeLayout = () => ({ wrapping: tabsAndActionsContainer.classList.contains('wrapping'), rows: new Set(tabs.map(tab => tab.offsetTop)).size });

		const widths = Array.from({ length: 41 }, (_, index) => 500 + index * 15);
		const unstableLayouts = [];
		for (const width of [...widths, ...widths.reverse()]) {
			await layoutConnectedGroup(group, width);
			const firstLayout = describeLayout();
			await layoutConnectedGroup(group, width);
			const secondLayout = describeLayout();
			if (firstLayout.wrapping !== secondLayout.wrapping || firstLayout.rows !== secondLayout.rows) {
				unstableLayouts.push({ width, firstLayout, secondLayout });
			}
		}

		assert.deepStrictEqual(unstableLayouts, []);
	});

	test('the first nonempty connected tab bar owns the top row after the pinned row empties', async () => {
		const group = connectedGroup();
		control.dispose();
		container.replaceChildren();
		const multiRowControl = disposables.add(instantiationService.createInstance(MultiRowEditorControl, container, editorPartsView, groupsView, groupView, model, undefined, false, false));
		multiRowControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layoutConnectedGroup(group, 400, multiRowControl);
		const tabBars = Array.from(container.querySelectorAll<HTMLElement>('.tabs-and-actions-container'));
		const unstickyTopRows = () => Array.from(tabBars[1].querySelectorAll<HTMLElement>('.tabs-container > .tab'), tab => tab.classList.contains('connected-tab-top-row'));
		const initiallyEmpty = {
			pinnedRowEmpty: tabBars[0].classList.contains('empty'),
			top: unstickyTopRows(),
		};

		const stickyEditor = model.getEditorByIndex(0)!;
		model.stick(stickyEditor);
		multiRowControl.stickEditor(stickyEditor);
		await layoutConnectedGroup(group, 400, multiRowControl);
		const withPinnedRow = unstickyTopRows();

		model.unstick(stickyEditor);
		multiRowControl.unstickEditor(stickyEditor);
		await layoutConnectedGroup(group, 400, multiRowControl);

		assert.deepStrictEqual({
			initiallyEmpty,
			withPinnedRow,
			pinnedRowEmptyAfterFinalUnpin: tabBars[0].classList.contains('empty'),
			afterFinalUnpin: unstickyTopRows(),
		}, {
			initiallyEmpty: { pinnedRowEmpty: true, top: [true, true] },
			withPinnedRow: [false],
			pinnedRowEmptyAfterFinalUnpin: true,
			afterFinalUnpin: [true, true],
		});
	});

	test('connected wrapped last tab adds its shoulder to the editor actions margin', async () => {
		const group = connectedGroup();
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);

		await layoutConnectedGroup(group, 150);
		const tabsAndActionsContainer = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		tabsContainer.style.setProperty('--last-tab-margin-right', '17px');
		tabsContainer.style.setProperty('--modern-ui-connected-tab-shoulder-radius', '5px');
		const lastTab = tabsContainer.querySelector<HTMLElement>('.tab:last-child')!;

		assert.deepStrictEqual({
			wrapping: tabsAndActionsContainer.classList.contains('wrapping'),
			active: lastTab.classList.contains('active'),
			margin: mainWindow.getComputedStyle(lastTab).marginRight,
		}, {
			wrapping: true,
			active: false,
			margin: '22px',
		});
	});

	test('connected tab positions and spacing stay fixed when changing selection', async () => {
		const group = connectedGroup();
		for (let index = 2; index < 6; index++) {
			const editor = disposables.add(new TestFileEditorInput(URI.file(`/path/file${index}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: false });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
		const measure = () => tabs.map(tab => ({
			left: tab.offsetLeft,
			top: tab.offsetTop,
			width: tab.getBoundingClientRect().width,
			margin: mainWindow.getComputedStyle(tab).marginRight,
		}));
		const mismatches = [];
		for (const { tabSizing, highContrast } of (['fit', 'fixed'] as const).flatMap(tabSizing => [false, true].map(highContrast => ({ tabSizing, highContrast })))) {
			group.closest<HTMLElement>('.monaco-workbench')!.classList.toggle('hc-black', highContrast);
			for (const wrapTabs of [false, true]) {
				const oldOptions = partOptions;
				partOptions = { ...partOptions, tabSizing, wrapTabs, tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
				control.updateOptions(oldOptions, partOptions);
				for (const width of wrapTabs ? [245, 365] : [1000]) {
					await layoutConnectedGroup(group, width);
					const baseline = measure();
					for (let activeIndex = 0; activeIndex < tabs.length; activeIndex++) {
						model.openEditor(model.getEditorByIndex(activeIndex)!, { active: true });
						control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
						await layoutConnectedGroup(group, width);
						const actual = measure();
						if (JSON.stringify(actual) !== JSON.stringify(baseline)) {
							mismatches.push({ tabSizing, highContrast, wrapTabs, width, activeIndex, baseline, actual });
						}
						for (let index = 1; index < tabs.length; index++) {
							const previous = tabs[index - 1].getBoundingClientRect();
							const current = tabs[index].getBoundingClientRect();
							if (previous.top === current.top && Math.abs(current.left - previous.right) > 0.01) {
								mismatches.push({ tabSizing, highContrast, wrapTabs, width, activeIndex, gapAfter: index - 1, gap: current.left - previous.right });
							}
						}
					}
				}
			}
		}
		assert.deepStrictEqual(mismatches, []);
	});

	test('connected close action bounds stay fixed across selection and focus changes', async () => {
		const group = connectedGroup();
		for (let index = 2; index < 6; index++) {
			const editor = disposables.add(new TestFileEditorInput(URI.file(`/path/file${index}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: false });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const actions = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab .action-label'));
		const bounds = (action: HTMLElement) => {
			const { x, y, width, height } = action.getBoundingClientRect();
			return { x, y, width, height };
		};
		const measure = () => actions.map(action => {
			const resting = bounds(action);
			action.focus();
			const focused = bounds(action);
			action.blur();
			return { resting, focused };
		});
		const mismatches = [];
		const root = group.closest<HTMLElement>('.monaco-workbench')!;
		root.style.setProperty('--vscode-contrastActiveBorder', '#f38518');
		root.style.setProperty('--vscode-focusBorder', '#f38518');
		for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
			root.classList.add(theme);
			for (const tabHeight of ['default', 'compact'] as const) {
				for (const tabActionLocation of ['right', 'left'] as const) {
					for (const wrapTabs of [false, true]) {
						const oldOptions = partOptions;
						partOptions = { ...partOptions, tabHeight, tabActionLocation, wrapTabs, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
						control.updateOptions(oldOptions, partOptions);
						await layoutConnectedGroup(group, wrapTabs ? 245 : 1000);
						const baseline = measure().map(({ resting }) => ({ resting, focused: resting }));
						for (let activeIndex = 0; activeIndex < actions.length; activeIndex++) {
							model.openEditor(model.getEditorByIndex(activeIndex)!, { active: true });
							control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
							await layoutConnectedGroup(group, wrapTabs ? 245 : 1000);
							const actual = measure();
							if (JSON.stringify(actual) !== JSON.stringify(baseline)) {
								mismatches.push({ theme, tabHeight, tabActionLocation, wrapTabs, activeIndex, baseline, actual });
							}
						}
					}
				}
			}
			root.classList.remove(theme);
		}
		assert.deepStrictEqual({ actionCount: actions.length, mismatches }, { actionCount: model.count, mismatches: [] });
	});

	test('connected fills meet without gutters and round corners away from the frame', async () => {
		const group = connectedGroup();
		for (let index = 2; index < 6; index++) {
			const editor = disposables.add(new TestFileEditorInput(URI.file(`/path/file${index}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: false });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
		const actual = [];
		const expected = [];
		for (const compact of [false, true]) {
			group.closest<HTMLElement>('.monaco-workbench')!.classList.toggle('modern-ui-compact', compact);
			for (const wrapTabs of [false, true]) {
				const oldOptions = partOptions;
				partOptions = { ...partOptions, wrapTabs, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
				control.updateOptions(oldOptions, partOptions);
				for (const activeIndex of [0, 1, 4, 5]) {
					model.openEditor(model.getEditorByIndex(activeIndex)!, { active: true });
					control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
					await layoutConnectedGroup(group, wrapTabs ? 245 : 1000);
					for (const [index, tab] of tabs.entries()) {
						const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
						const bounds = tab.getBoundingClientRect();
						const surface = fill.getBoundingClientRect();
						const style = mainWindow.getComputedStyle(fill);
						const rowStart = index === 0 || tabs[index - 1].offsetTop !== tab.offsetTop;
						const upper = tab.classList.contains('connected-tab-upper-row');
						const active = index === activeIndex;
						const radius = active && !upper ? '5px' : '4px';
						const context = { compact, wrapTabs, activeIndex, index };
						actual.push({
							...context,
							insets: [surface.left - bounds.left, bounds.right - surface.right, surface.top - bounds.top],
							corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
							leftBorder: rowStart ? style.borderLeftColor : undefined,
						});
						expected.push({
							...context,
							insets: [0, 0, 0],
							corners: [rowStart ? '0px' : radius, radius, active && !upper ? '0px' : '4px', rowStart || active && !upper ? '0px' : '4px'],
							leftBorder: rowStart ? 'rgba(0, 0, 0, 0)' : undefined,
						});
					}
				}
			}
		}
		assert.deepStrictEqual(actual, expected);
	});

	test('fit-sized connected row markers stay consistent at wrapping boundaries', async () => {
		const group = connectedGroup();
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fit', editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		for (let index = 2; index < 4; index++) {
			const editor = disposables.add(new TestFileEditorInput(URI.file(`/path/file${index}.txt`), 'testEditorInput'));
			model.openEditor(editor, { pinned: true, active: false });
		}
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layoutConnectedGroup(group, 300);
		const tabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container > .tab'));
		const boundary = tabs[0].offsetWidth + tabs[1].offsetWidth;
		const widths = Array.from({ length: 21 }, (_, index) => boundary - 10 + index);
		const mismatches = [];
		for (const width of [...widths, ...widths.reverse()]) {
			for (const activeIndex of [0, 1, 3]) {
				model.openEditor(model.getEditorByIndex(activeIndex)!, { active: true });
				control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
				await layoutConnectedGroup(group, width);
				const wrapping = container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping');
				for (const [index, tab] of tabs.entries()) {
					const expected = {
						top: tab.offsetTop === tabs[0].offsetTop,
						upper: tab.offsetTop !== tabs.at(-1)!.offsetTop,
						last: wrapping && (index === tabs.length - 1 || tab.offsetTop !== tabs[index + 1].offsetTop),
					};
					const actual = {
						top: tab.classList.contains('connected-tab-top-row'),
						upper: tab.classList.contains('connected-tab-upper-row'),
						last: tab.classList.contains('last-in-row'),
					};
					if (actual.top !== expected.top || actual.upper !== expected.upper || actual.last !== expected.last) {
						mismatches.push({ width, activeIndex, index, expected, actual });
					}
				}
			}
		}
		assert.deepStrictEqual(mismatches, []);
	});

	test('selected wrapped tabs and focused actions use the document surface on every row', async () => {
		const group = connectedGroup();
		const root = group.closest('.monaco-workbench')!;
		group.style.setProperty('--vscode-focusBorder', '#ffaa00');
		group.style.setProperty('--modern-ui-connected-tab-surface', '#123456');
		group.style.setProperty('--vscode-editorGroupHeader-tabsBackground', '#654321');
		group.style.setProperty('--modern-ui-editor-tab-active-background', '#654321');
		group.style.setProperty('--vscode-modernEditorTab-activeActionBackground', '#654321');
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		const measurements = [];
		const expected = [];
		for (const activeIndex of [0, 1]) {
			model.openEditor(model.getEditorByIndex(activeIndex)!, { active: true });
			control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
			await layoutConnectedGroup(group, 150);
			const tab = container.querySelector<HTMLElement>('.tab.active')!;
			const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
			const actions = tab.querySelector<HTMLElement>('.tab-actions')!;
			const action = actions.querySelector<HTMLElement>('.action-label')!;
			action.tabIndex = 0;
			for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
				root.classList.add(theme);
				for (const activeGroup of [true, false]) {
					group.classList.toggle('active', activeGroup);
					action.focus();
					const focusStyle = mainWindow.getComputedStyle(action);
					const windowFocused = mainWindow.document.hasFocus();
					measurements.push({
						activeIndex, theme, activeGroup,
						actionFocused: mainWindow.document.activeElement === action,
						cssFocused: action.matches(':focus'),
						upperRow: tab.classList.contains('connected-tab-upper-row'),
						fill: mainWindow.getComputedStyle(fill).backgroundColor,
						actions: mainWindow.getComputedStyle(actions).backgroundColor,
						focusOutline: theme.startsWith('hc-') && windowFocused ? [focusStyle.outlineWidth, focusStyle.outlineStyle, focusStyle.outlineColor] : undefined,
					});
					expected.push({ activeIndex, theme, activeGroup, actionFocused: true, cssFocused: windowFocused, upperRow: activeIndex === 0, fill: 'rgb(18, 52, 86)', actions: 'rgba(0, 0, 0, 0)', focusOutline: theme.startsWith('hc-') && windowFocused ? ['1px', 'solid', 'rgb(255, 170, 0)'] : undefined });
				}
				root.classList.remove(theme);
			}
			action.blur();
		}
		assert.deepStrictEqual(measurements, expected);
	});

	test('wrapped fills have equal visible heights and the bottom tab reaches the document', async () => {
		const group = connectedGroup();
		group.style.setProperty('--modern-ui-connected-tab-surface', '#ffffff');
		model.openEditor(model.getEditorByIndex(1)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const measurements = [];
		for (const tabHeight of ['default', 'compact'] as const) {
			const oldOptions = partOptions;
			partOptions = { ...partOptions, wrapTabs: true, tabHeight, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
			control.updateOptions(oldOptions, partOptions);
			container.classList.toggle('compact-height', tabHeight === 'compact');
			await layoutConnectedGroup(group, 150);
			const strip = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
			const tab = strip.querySelector<HTMLElement>('.tab.active')!;
			const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
			const fillStyle = mainWindow.getComputedStyle(fill);
			const clippingBottom = Math.min(...Array.from(strip.querySelectorAll<HTMLElement>('.tabs-container, .monaco-scrollable-element'), element => element.getBoundingClientRect().bottom));
			const fills = Array.from(strip.querySelectorAll<HTMLElement>('.tab-fill'), element => element.getBoundingClientRect());
			measurements.push({
				tabHeight,
				stripHeight: strip.getBoundingClientRect().height,
				wrapping: strip.classList.contains('wrapping'),
				upperRow: tab.classList.contains('connected-tab-upper-row'),
				gap: strip.getBoundingClientRect().bottom - (fill.getBoundingClientRect().bottom - parseFloat(fillStyle.borderBottomWidth)),
				clippingGap: strip.getBoundingClientRect().bottom - clippingBottom,
				bottomRadius: fillStyle.borderBottomRightRadius,
				shoulder: mainWindow.getComputedStyle(fill, '::after').content,
				visibleHeights: fills.map(rect => Math.min(rect.bottom, clippingBottom) - rect.top),
				rowGap: fills[1].top - fills[0].bottom,
			});
		}
		assert.deepStrictEqual(measurements, [
			{ tabHeight: 'default', stripHeight: 58, wrapping: true, upperRow: false, gap: -1, clippingGap: 0, bottomRadius: '0px', shoulder: '""', visibleHeights: [28, 28], rowGap: 2 },
			{ tabHeight: 'compact', stripHeight: 50, wrapping: true, upperRow: false, gap: -1, clippingGap: 0, bottomRadius: '0px', shoulder: '""', visibleHeights: [24, 24], rowGap: 2 },
		]);
	});

	test('three wrapped rows retain equal tab heights without a fixed strip height', async () => {
		const group = connectedGroup();
		group.style.setProperty('--modern-ui-connected-tab-surface', '#ffffff');
		const editor = disposables.add(new TestFileEditorInput(URI.file('/path/third.ts'), 'testEditorInput'));
		model.openEditor(editor, { pinned: true, active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const measurements = [];
		for (const tabHeight of ['default', 'compact'] as const) {
			const oldOptions = partOptions;
			partOptions = { ...partOptions, wrapTabs: true, tabHeight, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' };
			control.updateOptions(oldOptions, partOptions);
			container.classList.toggle('compact-height', tabHeight === 'compact');
			await layoutConnectedGroup(group, 150);
			const strip = container.querySelector<HTMLElement>('.tabs-and-actions-container')!.getBoundingClientRect();
			const fills = Array.from(container.querySelectorAll<HTMLElement>('.tab-fill'), fill => fill.getBoundingClientRect());
			measurements.push({
				tabHeight,
				stripHeight: strip.height,
				visibleHeights: fills.map(fill => Math.min(fill.bottom, strip.bottom) - fill.top),
				rowGaps: fills.slice(1).map((fill, index) => fill.top - fills[index].bottom),
			});
		}
		assert.deepStrictEqual(measurements, [
			{ tabHeight: 'default', stripHeight: 88, visibleHeights: [28, 28, 28], rowGaps: [2, 2] },
			{ tabHeight: 'compact', stripHeight: 76, visibleHeights: [24, 24, 24], rowGaps: [2, 2] },
		]);
	});

	test('connected tabs reserve separator height without changing classic or shared modern tabs', async () => {
		const readHeight = async () => {
			control.layout({ container: Dimension.None, available: Dimension.None });
			await new Promise<void>(resolve => {
				disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve()));
			});
			return control.getHeight();
		};
		const heights = [];
		for (const tabHeight of ['default', 'compact'] as const) {
			const oldOptions = partOptions;
			partOptions = { ...partOptions, tabHeight };
			control.updateOptions(oldOptions, partOptions);
			container.classList.remove('modern-ui', 'modern-ui-tabs', 'modern-ui-connected-editor-tabs');
			const classic = await readHeight();
			container.classList.add('modern-ui-tabs');
			const sharedModern = await readHeight();
			container.classList.add('modern-ui');
			const pill = await readHeight();
			container.classList.add('modern-ui-connected-editor-tabs');
			heights.push({ tabHeight, classic, sharedModern, pill, connected: await readHeight() });
		}
		assert.deepStrictEqual(heights, [
			{ tabHeight: 'default', classic: 35, sharedModern: 32, pill: 32, connected: 33 },
			{ tabHeight: 'compact', classic: 22, sharedModern: 28, pill: 28, connected: 29 },
		]);
	});

	test('connected tabs fill row edges without inter-tab gutters', () => {
		const root = $('.monaco-workbench.modern-ui.modern-ui-tabs.modern-ui-connected-editor-tabs');
		root.style.cssText = '--vscode-spacing-size40: 4px; --vscode-spacing-size80: 8px; --vscode-strokeThickness: 1px;';
		mainWindow.document.body.appendChild(root);
		disposables.add(toDisposable(() => root.remove()));
		const editor = $('.part.editor');
		const content = $('.content');
		const group = $('.editor-group-container.active');
		root.appendChild(editor);
		editor.appendChild(content);
		content.appendChild(group);
		group.appendChild(container);

		const [activeTab, inactiveTab] = container.querySelectorAll<HTMLElement>('.tabs-container > .tab');
		const activeFillStyle = mainWindow.getComputedStyle(activeTab.querySelector<HTMLElement>('.tab-fill')!);
		const inactiveFillStyle = mainWindow.getComputedStyle(inactiveTab.querySelector<HTMLElement>('.tab-fill')!);
		const row = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
		const rowStyle = mainWindow.getComputedStyle(row);
		const editorActions = row.querySelector<HTMLElement>('.editor-actions')!;
		editorActions.classList.remove('hidden');
		const editorActionsStyle = mainWindow.getComputedStyle(editorActions);

		assert.deepStrictEqual({
			active: { top: activeFillStyle.top, left: activeFillStyle.left, right: activeFillStyle.right, bottom: activeFillStyle.bottom },
			inactive: { top: inactiveFillStyle.top, left: inactiveFillStyle.left, right: inactiveFillStyle.right, bottom: inactiveFillStyle.bottom },
			alignItems: rowStyle.alignItems,
			editorActionsHeight: editorActionsStyle.height,
			rowPaddingLeft: rowStyle.paddingLeft,
			rowPaddingTop: rowStyle.paddingTop,
		}, {
			active: { top: '0px', left: '0px', right: '0px', bottom: '-2px' },
			inactive: { top: '0px', left: '0px', right: '0px', bottom: '-1px' },
			alignItems: 'flex-start',
			editorActionsHeight: '32px',
			rowPaddingLeft: '0px',
			rowPaddingTop: '0px',
		});
	});

	test('keeps the connected outline inside the visible scroll area', async () => {
		const root = $('.monaco-workbench.modern-ui.modern-ui-tabs.modern-ui-connected-editor-tabs');
		root.style.cssText = '--vscode-spacing-size20: 2px; --vscode-spacing-size40: 4px; --vscode-spacing-size60: 6px; --vscode-spacing-size80: 8px; --vscode-strokeThickness: 1px; --vscode-cornerRadius-small: 4px; --vscode-editor-background: #ffffff; --modern-ui-connected-tab-surface: #333333;';
		mainWindow.document.body.appendChild(root);
		disposables.add(toDisposable(() => root.remove()));
		const editor = $('.part.editor');
		const content = $('.content');
		const group = $('.editor-group-container.active');
		root.appendChild(editor);
		editor.appendChild(content);
		content.appendChild(group);
		group.appendChild(container);
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fixed', tabSizingFixedMinWidth: 160, tabSizingFixedMaxWidth: 160, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		const layout = async (width: number) => {
			group.style.width = `${width}px`;
			control.layout({ container: new Dimension(width, 33), available: new Dimension(width, 200) });
			await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));
		};
		const tabs = container.querySelector<HTMLElement>('.tabs-container')!;
		const scroll = (left: number) => {
			tabs.classList.add('scroll');
			tabs.scrollLeft = left;
			tabs.dispatchEvent(new UIEvent(EventType.SCROLL));
		};
		const [firstTab, secondTab] = tabs.querySelectorAll<HTMLElement>('.tab');
		const firstFill = firstTab.querySelector<HTMLElement>('.tab-fill')!;
		const secondFill = secondTab.querySelector<HTMLElement>('.tab-fill')!;
		const firstEdge = firstTab.querySelector<HTMLElement>('.tab-connected-edge')!;
		const secondEdge = secondTab.querySelector<HTMLElement>('.tab-connected-edge')!;
		const overflowEdge = container.querySelector<HTMLElement>('.tab-connected-overflow-edge')!;
		await layout(240);
		scroll(40);
		const clippedLeft = {
			edge: firstTab.classList.contains('connected-tab-left-edge'),
			clipped: firstTab.classList.contains('connected-tab-left-clipped'),
			fillOffset: firstFill.style.left,
			edgeOffset: [overflowEdge.style.left, overflowEdge.style.right],
			inset: overflowEdge.getBoundingClientRect().left - tabs.getBoundingClientRect().left,
			stationaryParent: overflowEdge.parentElement === tabs.parentElement,
			edgeOverlay: [
				mainWindow.getComputedStyle(firstFill, '::before').content,
				mainWindow.getComputedStyle(overflowEdge).display,
				mainWindow.getComputedStyle(overflowEdge).zIndex,
				mainWindow.getComputedStyle(overflowEdge, '::before').width,
				mainWindow.getComputedStyle(overflowEdge, '::before').borderTopLeftRadius,
				mainWindow.getComputedStyle(overflowEdge, '::before').boxSizing,
				mainWindow.getComputedStyle(overflowEdge, '::before').borderLeftWidth,
				mainWindow.getComputedStyle(overflowEdge, '::before').borderTopWidth,
				mainWindow.getComputedStyle(overflowEdge, '::before').backgroundColor,
			],
		};
		model.setSelection(model.activeEditor!, [model.getEditorByIndex(1)!]);
		control.updateEditorSelections();
		await layout(240);
		scroll(40);
		const multiSelected = {
			clipping: overflowEdge.style.left,
			edge: mainWindow.getComputedStyle(overflowEdge).display,
			radius: mainWindow.getComputedStyle(firstFill).borderRadius,
			connectedClass: firstTab.classList.contains('connected-tab-left-clipped'),
		};
		model.setSelection(model.activeEditor!, []);
		control.updateEditorSelections();
		await layout(240);
		const singleSelected = {
			clipping: overflowEdge.style.left,
			connectedClass: firstTab.classList.contains('connected-tab-left-clipped'),
		};
		model.openEditor(model.getEditorByIndex(1)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layout(400);
		scroll(0);
		const terminalOutline = {
			right: mainWindow.getComputedStyle(secondFill).borderRightWidth,
			rightShoulder: mainWindow.getComputedStyle(secondFill, '::after').content,
			rightMask: mainWindow.getComputedStyle(secondEdge, '::after').content,
		};
		const thirdEditor = disposables.add(new TestFileEditorInput(URI.file('/path/file2.txt'), 'testEditorInput'));
		model.openEditor(thirdEditor, { pinned: true, active: false });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layout(400);
		const normalOutline = {
			left: mainWindow.getComputedStyle(secondFill).borderLeftWidth,
			right: mainWindow.getComputedStyle(secondFill).borderRightWidth,
			leftShoulder: mainWindow.getComputedStyle(secondFill, '::before').content,
			rightShoulder: mainWindow.getComputedStyle(secondFill, '::after').content,
			edge: mainWindow.getComputedStyle(secondEdge).display,
			overflowEdge: mainWindow.getComputedStyle(overflowEdge).display,
			leftMaskHeight: mainWindow.getComputedStyle(secondEdge, '::before').height,
			leftMaskTop: mainWindow.getComputedStyle(secondEdge, '::before').borderTopWidth,
			rightMaskHeight: mainWindow.getComputedStyle(secondEdge, '::after').height,
			rightMaskTop: mainWindow.getComputedStyle(secondEdge, '::after').borderTopWidth,
		};
		await layout(324);
		scroll(0);
		const rightShoulderAtViewport = {
			edge: secondTab.classList.contains('connected-tab-right-edge'),
			clipped: secondTab.classList.contains('connected-tab-right-clipped'),
			right: mainWindow.getComputedStyle(secondFill).borderRightWidth,
			rightShoulder: mainWindow.getComputedStyle(secondFill, '::after').content,
			rightMask: mainWindow.getComputedStyle(secondEdge, '::after').content,
			overflowEdge: mainWindow.getComputedStyle(overflowEdge).display,
		};
		scroll(8);
		const rightShoulderRevealed = {
			edge: secondTab.classList.contains('connected-tab-right-edge'),
			clipped: secondTab.classList.contains('connected-tab-right-clipped'),
			rightShoulder: mainWindow.getComputedStyle(secondFill, '::after').content,
			rightMask: mainWindow.getComputedStyle(secondEdge, '::after').content,
		};
		scroll(156);
		const leftShoulderAtViewport = {
			edge: secondTab.classList.contains('connected-tab-left-edge'),
			clipped: secondTab.classList.contains('connected-tab-left-clipped'),
			left: mainWindow.getComputedStyle(secondFill).borderLeftWidth,
			leftShoulder: mainWindow.getComputedStyle(secondFill, '::before').content,
			leftMask: mainWindow.getComputedStyle(secondEdge, '::before').content,
			overflowEdge: mainWindow.getComputedStyle(overflowEdge).display,
		};
		scroll(152);
		const leftShoulderRevealed = {
			edge: secondTab.classList.contains('connected-tab-left-edge'),
			clipped: secondTab.classList.contains('connected-tab-left-clipped'),
			leftShoulder: mainWindow.getComputedStyle(secondFill, '::before').content,
			leftMask: mainWindow.getComputedStyle(secondEdge, '::before').content,
		};
		await layout(240);
		scroll(0);
		const overflowRightOffsets = [];
		for (const position of [0, 1, 2, 3]) {
			scroll(position);
			overflowRightOffsets.push({
				right: overflowEdge.style.right,
				inset: tabs.getBoundingClientRect().right - overflowEdge.getBoundingClientRect().right,
			});
		}
		const clippedRight = {
			edge: secondTab.classList.contains('connected-tab-right-edge'),
			clipped: secondTab.classList.contains('connected-tab-right-clipped'),
			fillOffset: secondFill.style.right,
			edgeOffset: [overflowEdge.style.left, overflowEdge.style.right],
			overflowRightOffsets,
			edgeOverlay: [
				mainWindow.getComputedStyle(secondFill, '::after').content,
				mainWindow.getComputedStyle(overflowEdge).display,
				mainWindow.getComputedStyle(overflowEdge).zIndex,
				mainWindow.getComputedStyle(overflowEdge, '::after').width,
				mainWindow.getComputedStyle(overflowEdge, '::after').borderTopRightRadius,
				mainWindow.getComputedStyle(overflowEdge, '::after').boxSizing,
				mainWindow.getComputedStyle(overflowEdge, '::after').borderRightWidth,
				mainWindow.getComputedStyle(overflowEdge, '::after').borderTopWidth,
				mainWindow.getComputedStyle(overflowEdge, '::after').backgroundColor,
			],
			previousTabOverflow: firstEdge.style.left,
		};
		model.openEditor(model.getEditorByIndex(0)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layout(100);
		scroll(firstTab.offsetWidth - 5);
		const hiddenAtFillEdge = [mainWindow.getComputedStyle(firstFill).display, mainWindow.getComputedStyle(overflowEdge).display];
		root.classList.add('hc-black');
		await layout(240);
		scroll(40);
		const highContrast = {
			clipping: overflowEdge.style.left,
			edge: mainWindow.getComputedStyle(overflowEdge).display,
			connectedClass: firstTab.classList.contains('connected-tab-left-clipped'),
		};
		model.openEditor(model.getEditorByIndex(1)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const highContrastRight = [];
		root.style.setProperty('--vscode-focusBorder', '#f38518');
		for (const theme of ['hc-black', 'hc-light']) {
			root.classList.remove('hc-black', 'hc-light');
			root.classList.add(theme);
			root.style.setProperty('--vscode-editor-background', theme === 'hc-black' ? '#000000' : '#ffffff');
			for (const width of [240, 324]) {
				await layout(width);
				scroll(0);
				const outline = overflowEdge.querySelector<HTMLElement>('.tab-connected-overflow-right')!;
				const cap = mainWindow.getComputedStyle(outline, '::before');
				const shoulder = mainWindow.getComputedStyle(outline, '::after');
				const capRight = outline.getBoundingClientRect().right - parseFloat(cap.right);
				const shoulderLeft = outline.getBoundingClientRect().right - parseFloat(shoulder.right) - parseFloat(shoulder.width);
				highContrastRight.push({
					theme, width,
					mask: mainWindow.getComputedStyle(overflowEdge, '::after').backgroundColor,
					capReachesBottom: parseFloat(cap.bottom) === 0,
					strokesAlign: capRight - parseFloat(cap.borderRightWidth) === shoulderLeft,
					baselineAligns: outline.getBoundingClientRect().bottom === tabs.getBoundingClientRect().bottom,
				});
			}
		}
		root.classList.remove('modern-ui-connected-editor-tabs');
		await layout(100);
		assert.deepStrictEqual({
			clippedLeft, multiSelected, singleSelected, terminalOutline, normalOutline, rightShoulderAtViewport, rightShoulderRevealed, leftShoulderAtViewport, leftShoulderRevealed, clippedRight, hiddenAtFillEdge, highContrast, highContrastRight,
			reset: overflowEdge.style.left,
		}, {
			clippedLeft: { edge: true, clipped: true, fillOffset: '', edgeOffset: ['0px', '0px'], inset: 0, stationaryParent: true, edgeOverlay: ['none', 'block', '8', '5px', '0px', 'border-box', '1px', '1px', 'rgb(51, 51, 51)'] },
			multiSelected: { clipping: '0px', edge: 'block', radius: '0px 5px 0px 0px', connectedClass: true },
			singleSelected: { clipping: '0px', connectedClass: true },
			terminalOutline: { right: '1px', rightShoulder: '""', rightMask: '""' },
			normalOutline: { left: '1px', right: '1px', leftShoulder: '""', rightShoulder: '""', edge: 'block', overflowEdge: 'none', leftMaskHeight: '3px', leftMaskTop: '0px', rightMaskHeight: '3px', rightMaskTop: '0px' },
			rightShoulderAtViewport: { edge: true, clipped: false, right: '1px', rightShoulder: '""', rightMask: '""', overflowEdge: 'block' },
			rightShoulderRevealed: { edge: false, clipped: false, rightShoulder: '""', rightMask: '""' },
			leftShoulderAtViewport: { edge: true, clipped: false, left: '1px', leftShoulder: 'none', leftMask: 'none', overflowEdge: 'none' },
			leftShoulderRevealed: { edge: false, clipped: false, leftShoulder: '""', leftMask: '""' },
			clippedRight: {
				edge: true,
				clipped: true,
				fillOffset: '',
				edgeOffset: ['0px', '0px'],
				overflowRightOffsets: [
					{ right: '0px', inset: 0 },
					{ right: '0px', inset: 0 },
					{ right: '0px', inset: 0 },
					{ right: '0px', inset: 0 },
				],
				edgeOverlay: ['""', 'block', '8', '10px', '0px', 'border-box', '0px', '0px', 'rgb(255, 255, 255)'],
				previousTabOverflow: '',
			},
			hiddenAtFillEdge: ['none', 'none'],
			highContrast: { clipping: '0px', edge: 'block', connectedClass: true },
			highContrastRight: [
				{ theme: 'hc-black', width: 240, mask: 'rgb(0, 0, 0)', capReachesBottom: true, strokesAlign: true, baselineAligns: true },
				{ theme: 'hc-black', width: 324, mask: 'rgb(0, 0, 0)', capReachesBottom: true, strokesAlign: true, baselineAligns: true },
				{ theme: 'hc-light', width: 240, mask: 'rgb(255, 255, 255)', capReachesBottom: true, strokesAlign: true, baselineAligns: true },
				{ theme: 'hc-light', width: 324, mask: 'rgb(255, 255, 255)', capReachesBottom: true, strokesAlign: true, baselineAligns: true },
			],
			reset: '',
		});
	});

	test('invalidates connected clipping geometry after dirty and capability changes', async () => {
		const root = $('.monaco-workbench.modern-ui.modern-ui-tabs.modern-ui-connected-editor-tabs');
		root.style.cssText = '--vscode-spacing-size20: 2px; --vscode-spacing-size40: 4px; --vscode-spacing-size60: 6px; --vscode-spacing-size80: 8px; --vscode-spacing-size280: 28px; --vscode-strokeThickness: 1px; --vscode-cornerRadius-small: 4px; --vscode-editor-background: #ffffff; --modern-ui-connected-tab-surface: #333333;';
		mainWindow.document.body.appendChild(root);
		disposables.add(toDisposable(() => root.remove()));
		const editor = $('.part.editor');
		const content = $('.content');
		const group = $('.editor-group-container.active');
		root.appendChild(editor);
		editor.appendChild(content);
		content.appendChild(group);
		group.appendChild(container);
		const oldOptions = partOptions;
		partOptions = { ...partOptions, tabSizing: 'fit', tabActionReserveSpace: false, editorActionsLocation: 'hidden' };
		control.updateOptions(oldOptions, partOptions);
		const thirdEditor = disposables.add(new TestFileEditorInput(URI.file('/path/file2.txt'), 'testEditorInput'));
		model.openEditor(thirdEditor, { pinned: true });
		model.openEditor(model.getEditorByIndex(1)!, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		group.style.width = '180px';
		control.layout({ container: new Dimension(180, 33), available: new Dimension(180, 200) });
		await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));

		const tabs = container.querySelector<HTMLElement>('.tabs-container')!;
		const [firstTab, activeTab] = tabs.querySelectorAll<HTMLElement>('.tab');
		const overflowEdge = container.querySelector<HTMLElement>('.tab-connected-overflow-edge')!;
		const scroll = (left: number) => {
			tabs.classList.add('scroll');
			tabs.scrollLeft = left;
			tabs.dispatchEvent(new UIEvent(EventType.SCROLL));
		};
		scroll(0);
		const firstEditor = model.getEditorByIndex(0) as TestFileEditorInput;
		firstEditor.setDirty();
		control.updateEditorDirty(firstEditor);
		const invalidatedBeforeLayout = overflowEdge.style.left === '' && !activeTab.classList.contains('connected-tab-right-edge');
		await new Promise<void>(resolve => disposables.add(scheduleAtNextAnimationFrame(mainWindow, () => resolve())));

		const rebuiltAfterLayout = overflowEdge.style.left !== '';
		firstEditor.capabilities = EditorInputCapabilities.CannotClose;
		control.updateEditorCapabilities(firstEditor);
		const capabilityUpdateInvalidated = overflowEdge.style.left === '' && !activeTab.classList.contains('connected-tab-right-edge');

		assert.deepStrictEqual({
			firstTabDirty: firstTab.classList.contains('dirty'),
			invalidatedBeforeLayout,
			rebuiltAfterLayout,
			capabilityUpdateInvalidated,
		}, {
			firstTabDirty: true,
			invalidatedBeforeLayout: true,
			rebuiltAfterLayout: true,
			capabilityUpdateInvalidated: true,
		});
	});

	test('Alt swaps the close action of the hovered tab only', () => {
		const actions = [tabActions()];

		hoverTab(0);
		alt(true);
		actions.push(tabActions());

		alt(false);
		actions.push(tabActions());

		assert.deepStrictEqual(actions, [
			['close', 'close'],
			['closeOthers', 'close'],
			['close', 'close']
		]);
	});

	test('Alt does not stay armed when the window loses focus (#331979)', () => {
		hoverTab(0);
		alt(true);

		const actions = [tabActions()];

		// Alt+Tab to another application: the `keyup` for Alt is
		// delivered to that application and never seen here
		hostService.setFocus(false);
		ModifierKeyEmitter.getInstance().resetKeyStatus();
		actions.push(tabActions());

		// Alt being reported as pressed again when focus returns must not
		// swap the action of a tab that is still hovered from before
		hostService.setFocus(true);
		alt(true);
		actions.push(tabActions());

		// Hovering a tab again arms the swap as usual
		hoverTab(0);
		actions.push(tabActions());

		assert.deepStrictEqual(actions, [
			['closeOthers', 'close'],
			['close', 'close'],
			['close', 'close'],
			['closeOthers', 'close']
		]);
	});

	test('Alt is revalidated from mouse events over the tabs (#331979)', () => {
		hoverTab(0);
		alt(true);

		const actions = [tabActions()];

		// The `keyup` for Alt went to another application, so only the
		// next mouse event reveals that Alt is no longer pressed
		moveMouseOverTabs(false);
		actions.push(tabActions());

		assert.deepStrictEqual(actions, [
			['closeOthers', 'close'],
			['close', 'close']
		]);
	});

	test('Alt is revalidated when pressing the tab action without moving the mouse (#331979)', () => {
		hoverTab(0);
		alt(true);

		const actions = [tabActions()];

		mouseDownOnTabAction(0, false);
		actions.push(tabActions());

		assert.deepStrictEqual(actions, [
			['closeOthers', 'close'],
			['close', 'close']
		]);
	});

	test('announces only the pinned tabs as pinned when pinned tabs are on a separate row', () => {
		partOptions = { ...partOptions, pinnedTabsOnSeparateRow: true };
		for (let i = 2; i < 5; i++) {
			model.openEditor(createNamedEditor(`file${i}.txt`), { pinned: true, index: i });
		}
		for (const editor of model.getEditors(EditorsOrder.SEQUENTIAL).slice(0, 2)) {
			model.stick(editor);
		}
		control.dispose();
		container.replaceChildren();
		const multiRowControl = disposables.add(instantiationService.createInstance(MultiRowEditorControl, container, editorPartsView, groupsView, groupView, model, undefined, false, false));
		multiRowControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));

		const tabBars = Array.from(container.querySelectorAll('.tabs-container'));
		assert.deepStrictEqual(tabBars.map(tabBar => Array.from(tabBar.querySelectorAll('.tab'), tab => tab.getAttribute('aria-label'))), [
			['file0.txt, pinned', 'file1.txt, pinned'],
			['file2.txt', 'file3.txt', 'file4.txt'],
		]);
	});

	test('announces a tab as pinned once it is pinned and no longer once it is unpinned', () => {
		const [first, second] = model.getEditors(EditorsOrder.SEQUENTIAL);
		model.stick(first);
		control.dispose();
		container.replaceChildren();
		control = createControl();
		const initial = tabAriaLabels();

		model.unstick(first);
		control.unstickEditor(first);
		const afterUnpin = tabAriaLabels();

		// A pin moves the editor to the end of the pinned editors, which the editor group tells the tabs first
		model.stick(second);
		control.moveEditor(second, 1, 0);
		control.stickEditor(second);

		assert.deepStrictEqual({ initial, afterUnpin, afterPin: tabAriaLabels() }, {
			initial: ['file0.txt, pinned', 'file1.txt'],
			afterUnpin: ['file0.txt', 'file1.txt'],
			afterPin: ['file1.txt, pinned', 'file0.txt'],
		});
	});

	test('draws the tab of an editor that opened before a pin but reached the tabs after it', () => {
		const [, second] = model.getEditors(EditorsOrder.SEQUENTIAL);

		// The editor group opens several editors at once and tells the tabs once all of them opened,
		// after it told them of a pin that opening one of them caused
		const opened = createNamedEditor('file2.txt');
		model.openEditor(opened, { pinned: true, active: false, index: 2 });
		model.stick(second);
		control.moveEditor(second, 1, 0);
		control.stickEditor(second);
		control.openEditors([opened]);

		assert.deepStrictEqual(tabAriaLabels(), ['file1.txt, pinned', 'file0.txt', 'file2.txt']);
	});

	test('announces a preview tab as a preview no longer once it is kept open', () => {
		const preview = createNamedEditor('file2.txt');
		model.openEditor(preview, { pinned: false, index: 2 });
		control.openEditor(preview);
		const initial = tabAriaLabels();

		model.pin(preview);
		control.pinEditor(preview);

		assert.deepStrictEqual({ initial, keptOpen: tabAriaLabels() }, {
			initial: ['file0.txt', 'file1.txt', 'file2.txt, preview'],
			keptOpen: ['file0.txt', 'file1.txt', 'file2.txt'],
		});
	});

	test('draws the tab of an editor that opened before a preview was kept open but reached the tabs after it', () => {
		const preview = createNamedEditor('file2.txt');
		model.openEditor(preview, { pinned: false, index: 2 });
		control.openEditor(preview);

		// The editor group opens several editors at once and tells the tabs once all of them opened,
		// after it told them that opening one of them kept a preview open
		const opened = createNamedEditor('file3.txt');
		model.openEditor(opened, { pinned: true, active: false, index: 3 });
		model.pin(preview);
		control.pinEditor(preview);
		control.openEditors([opened]);

		assert.deepStrictEqual(tabAriaLabels(), ['file0.txt', 'file1.txt', 'file2.txt', 'file3.txt']);
	});

	test('a pin or a preview kept open redraws the accessible name of every tab whose label changed with it, such as for a new number of groups', () => {
		const [first] = model.getEditors(EditorsOrder.SEQUENTIAL);
		const preview = createNamedEditor('file2.txt');
		model.openEditor(preview, { pinned: false, index: 2 });
		control.openEditor(preview);
		const initial = tabAriaLabels();

		// Nothing tells the tabs of a new number of groups, but the next recompute of their labels counts it
		editorGroupCount = 2;
		model.stick(first);
		control.stickEditor(first);
		const afterPin = tabAriaLabels();

		editorGroupCount = 1;
		model.pin(preview);
		control.pinEditor(preview);

		assert.deepStrictEqual({ initial, afterPin, afterPreviewKeptOpen: tabAriaLabels() }, {
			initial: ['file0.txt', 'file1.txt', 'file2.txt, preview'],
			afterPin: ['file0.txt, pinned, Editor Group 1', 'file1.txt, Editor Group 1', 'file2.txt, preview, Editor Group 1'],
			afterPreviewKeptOpen: ['file0.txt, pinned', 'file1.txt', 'file2.txt'],
		});
	});

	test('makes no DOM mutations to the tabs container and adds no tab stack indicators without tab stacks', () => {
		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		const observer = new MutationObserver(() => { });
		observer.observe(tabsContainer, { childList: true });
		const [first] = model.getEditors(EditorsOrder.SEQUENTIAL);

		control.updateTabStacks();
		model.moveEditor(first, 1);
		control.moveEditor(first, 0, 1);
		const afterMove = strip();
		model.stick(first);
		control.moveEditor(first, 1, 0);
		control.stickEditor(first);
		control.updateStyles();
		const childListChanges = observer.takeRecords().length;
		observer.disconnect();

		assert.deepStrictEqual({ afterMove, afterStick: strip(), childListChanges, indicators: container.querySelectorAll('.tab-stack-indicator').length }, {
			afterMove: ['T:file1.txt', 'T:file0.txt'],
			afterStick: ['T:file0.txt', 'T:file1.txt'],
			childListChanges: 0,
			indicators: 0,
		});
	});

	test('does not walk the tabs container to put tab stack headers in place while no tab stack shows and no header is left', () => {
		const [a, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		const walks = countReads(tabsChild(''), ['firstElementChild']);

		control.updateTabStacks();
		model.moveEditor(a, 2);
		control.moveEditor(a, 0, 2);
		const withoutTabStacks = walks.count;

		addTabStack([b, c]);
		model.removeEditorsFromTabStack([b, c]);
		control.updateTabStacks();
		walks.count = 0;
		control.updateTabStacks();

		assert.deepStrictEqual({ withoutTabStacks, onceTheHeaderIsGone: walks.count, tabs: strip() }, {
			withoutTabStacks: 0,
			onceTheHeaderIsGone: 0,
			tabs: ['T:b', 'T:c', 'T:a'],
		});
	});

	test('renders a header before the first tab of each tab stack and keeps the Add Tab control last', () => {
		const [, b, c, , e] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e'], undefined, { tabsBarAddTab: MenuId.for('test.tabStacks.addTab') });

		addTabStack([b, c], { label: 'Auth' });
		addTabStack([e]);

		assert.deepStrictEqual(strip(), ['T:a', 'H:Auth', 'T:b*', 'T:c*', 'T:d', 'H:∅', 'T:e*', '+']);
	});

	test('detaches the tabs of a collapsed tab stack and shows the same tabs again when it expands', () => {
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c', 'd']);
		const tabStack = addTabStack([b, c], { label: 'Auth' });
		const tabs = shownTabs();

		model.updateTabStack(tabStack, { collapsed: true });
		control.updateTabStacks();
		const collapsed = { tabs: strip(), attached: tabs.map(tab => tab.isConnected), display: tabs.map(tab => tab.style.display) };

		model.updateTabStack(tabStack, { collapsed: false });
		control.updateTabStacks();

		assert.deepStrictEqual({ collapsed, expanded: strip(), sameTabs: shownTabs().every((tab, index) => tab === tabs[index]) }, {
			collapsed: { tabs: ['T:a', 'H:Auth(collapsed)', 'T:d'], attached: [true, false, false, true], display: ['', '', '', ''] },
			expanded: ['T:a', 'H:Auth', 'T:b*', 'T:c*', 'T:d'],
			sameTabs: true,
		});
	});

	test('shows no tab stacks while they are disabled and shows them once enabled', () => {
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c'], { enableTabStacks: false });
		addTabStack([b, c], { label: 'Auth', collapsed: true });
		const disabled = { tabs: strip(), ariaLabel: shownTabs()[1].getAttribute('aria-label')?.includes('tab stack') };

		const oldOptions = partOptions;
		partOptions = { ...partOptions, enableTabStacks: true };
		control.updateOptions(oldOptions, partOptions);

		assert.deepStrictEqual({ disabled, enabled: strip() }, {
			disabled: { tabs: ['T:a', 'T:b', 'T:c'], ariaLabel: false },
			enabled: ['T:a', 'H:Auth(collapsed)'],
		});
	});

	test('keeps the tab stack styling of tabs that a move redraws', () => {
		const [, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd']);
		addTabStack([b, c], { color: 'red' });

		model.moveEditor(d, 0);
		control.moveEditor(d, 3, 0);

		// The indicator comes last because connected tabs clip their first child, the fill
		const memberTab = shownTabs()[2];
		assert.deepStrictEqual({
			tabs: strip(),
			colors: shownTabs().map(tab => tab.style.getPropertyValue('--tab-stack-color')),
			memberTabChildren: [memberTab.firstElementChild?.className, memberTab.lastElementChild?.className],
		}, {
			tabs: ['T:d', 'T:a', 'H:∅', 'T:b*', 'T:c*'],
			colors: ['', '', 'var(--vscode-tabStack-red)', 'var(--vscode-tabStack-red)'],
			memberTabChildren: ['tab-fill', 'tab-stack-indicator'],
		});
	});

	test('keeps the left offsets of sticky tabs before a tab stack and moves the header when its first tab is stuck', () => {
		const [a, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd'], { pinnedTabSizing: 'compact' });
		for (const editor of [a, b]) {
			model.stick(editor);
			control.stickEditor(editor);
		}
		addTabStack([c, d]);
		const beforeStick = { tabs: strip(), offsets: shownTabs().map(tab => tab.style.left) };

		model.stick(c);
		control.stickEditor(c);

		assert.deepStrictEqual({ beforeStick, afterStick: { tabs: strip(), offsets: shownTabs().map(tab => tab.style.left) } }, {
			beforeStick: { tabs: ['T:a', 'T:b', 'H:∅', 'T:c*', 'T:d*'], offsets: ['0px', '38px', 'auto', 'auto'] },
			afterStick: { tabs: ['T:a', 'T:b', 'T:c', 'H:∅', 'T:d*'], offsets: ['0px', '38px', '76px', 'auto'] },
		});
	});

	test('reuses tab stack headers when redrawing and removes them and the indicators of the tabs with their tab stack', () => {
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b, c]);
		const [header] = tabStackHeaders();

		control.updateStyles();
		control.updateTabStacks();
		const reused = tabStackHeaders()[0] === header;
		const indicators = container.querySelectorAll('.tab-stack-indicator').length;

		model.removeEditorsFromTabStack([b, c]);
		control.updateTabStacks();

		assert.deepStrictEqual({ reused, indicators, removed: !header.isConnected, tabs: strip(), indicatorsAfterRemove: container.querySelectorAll('.tab-stack-indicator').length }, {
			reused: true,
			indicators: 2,
			removed: true,
			tabs: ['T:a', 'T:b', 'T:c'],
			indicatorsAfterRemove: 0,
		});
	});

	test('closing every editor removes all tabs and tab stack headers', () => {
		const editors = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack(editors.slice(1), { collapsed: true });

		for (const editor of editors) {
			model.closeEditor(editor);
		}
		control.closeEditors(editors);
		const closed = strip();

		editors.forEach((editor, index) => model.openEditor(editor, { pinned: true, active: index === 0, index }));
		control.openEditors(editors);
		addTabStack(editors.slice(0, 2));

		assert.deepStrictEqual({ closed, reopened: strip() }, {
			closed: [],
			reopened: ['H:∅', 'T:a*', 'T:b*', 'T:c'],
		});
	});

	test('moving editors and updating tab stacks while an opened editor has no tab yet does not fail, as when merging groups', () => {
		const [a, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b, c]);
		const d = disposables.add(new TestFileEditorInput(URI.file('/path/d'), 'testEditorInput'));

		// Merging a group opens editors in the model and updates the tabs once all are moved
		model.openEditor(d, { pinned: true, index: 3 });
		model.moveEditor(a, 3);
		control.moveEditor(a, 0, 3);
		control.updateTabStacks();
		control.openEditors([d]);

		assert.deepStrictEqual(strip(), ['H:∅', 'T:b*', 'T:c*', 'T:d', 'T:a']);
	});

	test('clicking a tab stack header toggles it and a double click on it does not reach the tabs container', () => {
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b, c], { label: 'Auth' });
		const [header] = tabStackHeaders();
		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		let doubleClicksOnTabsContainer = 0;
		disposables.add(addDisposableListener(tabsContainer, EventType.DBLCLICK, () => doubleClicksOnTabsContainer++));

		header.dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true, button: 0 }));
		const afterClick = strip();
		header.dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true, button: 0 }));
		const afterSecondClick = strip();
		header.dispatchEvent(new MouseEvent(EventType.DBLCLICK, { bubbles: true, cancelable: true, button: 0 }));

		assert.deepStrictEqual({ afterClick, afterSecondClick, doubleClicksOnTabsContainer }, {
			afterClick: ['T:a', 'H:Auth(collapsed)'],
			afterSecondClick: ['T:a', 'H:Auth', 'T:b*', 'T:c*'],
			doubleClicksOnTabsContainer: 0,
		});
	});

	test('clicking a tab stack header keeps the tabs scrolled where they are rather than revealing the active tab', async () => {
		const group = classicGroup();
		const [, , , , , f] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		addTabStack([f], { collapsed: true });
		await layoutConnectedGroup(group, 250);
		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		tabsContainer.classList.add('scroll');
		tabsContainer.scrollLeft = tabsContainer.scrollWidth - tabsContainer.clientWidth;
		tabsContainer.dispatchEvent(new UIEvent(EventType.SCROLL));
		tabsContainer.classList.remove('scroll');
		const scrollLeft = tabsContainer.scrollLeft;

		tabStackHeaders()[0].dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true, button: 0 }));
		await nextAnimationFrame();

		assert.deepStrictEqual({ tabs: strip(), scrolled: scrollLeft > 0, keptScrollLeft: tabsContainer.scrollLeft === scrollLeft }, {
			tabs: ['T:a', 'T:b', 'T:c', 'T:d', 'T:e', 'H:∅', 'T:f*'],
			scrolled: true,
			keptScrollLeft: true,
		});
	});

	test('while a drag is over the tabs they scroll only sideways, so the top edge of the tabs stays in view', async () => {
		const group = connectedGroup();
		await layoutConnectedGroup(group, 300);
		dispatchDrag(EventType.DRAG_ENTER, '', 'left');
		const { overflowX, overflowY } = mainWindow.getComputedStyle(tabsChild(''));

		assert.deepStrictEqual({ overflowX, overflowY }, { overflowX: 'scroll', overflowY: 'hidden' });
	});

	test('an action of the menu of a tab stack header that changes nothing does not stop the next reveal of the active tab', async () => {
		let actionRunner: IActionRunner | undefined;
		// The context menu UI is the boundary: it runs the actions of the menu with the action runner the tab bar gives it
		instantiationService.stub(IContextMenuService, new class extends mock<IContextMenuService>() {
			override showContextMenu(delegate: IContextMenuMenuDelegate): void {
				actionRunner = delegate.actionRunner;
			}
		});
		const group = classicGroup();
		const [, b, , , e] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		addTabStack([b]);
		await layoutConnectedGroup(group, 250);

		// Like a rename whose input is cancelled, the action ends without changing the tab stack
		tabStackHeaders()[0].dispatchEvent(new MouseEvent(EventType.CONTEXT_MENU, { bubbles: true, cancelable: true, button: 2 }));
		await actionRunner!.run(disposables.add(new Action('test.tabStacks.cancelled')));
		const revealedBefore = isActiveTabRevealed();
		model.openEditor(e, { active: true });
		control.openEditors([e]);
		await nextAnimationFrame();

		assert.deepStrictEqual({ revealedBefore, revealedAfter: isActiveTabRevealed() }, {
			revealedBefore: true,
			revealedAfter: true,
		});
	});

	test('clicking a tab stack header while tabs wrap does not stop revealing the active tab once they no longer wrap', async () => {
		const group = classicGroup();
		const [, b, , , e] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		addTabStack([b]);
		await layoutConnectedGroup(group, 250);
		const tabsAndActionsContainer = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
		const wrapped = tabsAndActionsContainer.classList.contains('wrapping');

		tabStackHeaders()[0].dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true, button: 0 }));
		await nextAnimationFrame();
		model.openEditor(e, { active: true });
		control.openEditors([e]);
		const oldOptions = partOptions;
		partOptions = { ...partOptions, wrapTabs: false };
		control.updateOptions(oldOptions, partOptions);
		await nextAnimationFrame();

		assert.deepStrictEqual({ wrapped, wrappedAfter: tabsAndActionsContainer.classList.contains('wrapping'), revealed: isActiveTabRevealed() }, {
			wrapped: true,
			wrappedAfter: false,
			revealed: true,
		});
	});

	test('Enter and Space toggle a focused tab stack header, and Shift+F10 and right click open its menu for the index of its first editor in the group', () => {
		const menus: { menuId: string | undefined; context: unknown }[] = [];
		// The context menu UI is the boundary: it renders the menu the tab bar asks for
		instantiationService.stub(IContextMenuService, new class extends mock<IContextMenuService>() {
			override showContextMenu(delegate: IContextMenuMenuDelegate): void {
				menus.push({ menuId: delegate.menuId?.id, context: delegate.getActionsContext?.() });
			}
		});
		const [s, , b, c] = createTabStacksGroup(['s', 'a', 'b', 'c'], { pinnedTabsOnSeparateRow: true });
		model.stick(s);
		addTabStack([b, c], { label: 'Auth' });
		control.dispose();
		container.replaceChildren();
		const multiRowControl = disposables.add(instantiationService.createInstance(MultiRowEditorControl, container, editorPartsView, groupsView, groupView, model, undefined, false, false));
		multiRowControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const unstickyTabs = container.querySelectorAll<HTMLElement>('.tabs-container')[1];
		const header = unstickyTabs.querySelector<HTMLElement>('.tab-stack-header')!;
		const states: string[][] = [];
		groupView.updateTabStack = (tabStack, update) => {
			model.updateTabStack(tabStack, update);
			multiRowControl.updateTabStacks();
		};

		for (const keyCode of [13 /* Enter */, 32 /* Space */]) {
			header.dispatchEvent(new KeyboardEvent(EventType.KEY_UP, { keyCode, bubbles: true, cancelable: true }));
			states.push(strip(unstickyTabs));
		}
		header.dispatchEvent(new KeyboardEvent(EventType.KEY_DOWN, { keyCode: 121 /* F10 */, shiftKey: true, bubbles: true, cancelable: true }));
		header.dispatchEvent(new MouseEvent(EventType.CONTEXT_MENU, { bubbles: true, cancelable: true, button: 2 }));

		const menu = { menuId: EditorTabStackContextMenuId.id, context: { groupId: model.id, editorIndex: 2 } };
		assert.deepStrictEqual({ states, menus }, {
			states: [['T:a', 'H:Auth(collapsed)'], ['T:a', 'H:Auth', 'T:b*', 'T:c*']],
			menus: [menu, menu],
		});
	});

	test('a tab stack header is a tab that tells whether it is expanded and how many editors it has, and its hover tells it in sentence case', () => {
		const hovers = new Map<HTMLElement, IManagedHoverContentOrFactory>();
		// The hover UI is the boundary: it shows the content the tab bar gives it
		instantiationService.stub(IHoverService, {
			...NullHoverService,
			setupManagedHover: (hoverDelegate, targetElement, content, options) => {
				hovers.set(targetElement, content);
				return NullHoverService.setupManagedHover(hoverDelegate, targetElement, content, options);
			}
		});
		const [, b, c, d, e, f, g] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
		addTabStack([b, c], { label: 'Auth' });
		addTabStack([d], { label: 'Solo', collapsed: true });
		addTabStack([e, f]);
		addTabStack([g]);

		assert.deepStrictEqual(tabStackHeaders().map(header => {
			const hover = hovers.get(header);
			return {
				role: header.getAttribute('role'),
				selected: header.getAttribute('aria-selected'),
				expanded: header.getAttribute('aria-expanded'),
				label: header.getAttribute('aria-label'),
				hover: typeof hover === 'function' ? hover() : hover,
				tabIndex: header.tabIndex,
				unnamed: header.classList.contains('unnamed'),
			};
		}), [
			{ role: 'tab', selected: 'false', expanded: 'true', label: 'tab stack Auth, 2 editors', hover: 'Auth (2 editors)', tabIndex: -1, unnamed: false },
			{ role: 'tab', selected: 'false', expanded: 'false', label: 'tab stack Solo, 1 editor', hover: 'Solo (1 editor)', tabIndex: -1, unnamed: false },
			{ role: 'tab', selected: 'false', expanded: 'true', label: 'unnamed tab stack, 2 editors', hover: 'Unnamed tab stack (2 editors)', tabIndex: -1, unnamed: true },
			{ role: 'tab', selected: 'false', expanded: 'true', label: 'unnamed tab stack, 1 editor', hover: 'Unnamed tab stack (1 editor)', tabIndex: -1, unnamed: true },
		]);
	});

	test('clicking a tab stack header announces that its tab stack collapsed or expanded while a screen reader is in use, and nothing when the tab stack stays expanded', () => {
		const announcements: string[] = [];
		let screenReaderOptimized = true;
		// The screen reader is the boundary: it speaks what the tab bar announces
		instantiationService.stub(IAccessibilityService, new class extends TestAccessibilityService {
			override isScreenReaderOptimized(): boolean { return screenReaderOptimized; }
			override status(message: string): void { announcements.push(message); }
		});
		const click = (header: HTMLElement) => header.dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true, button: 0 }));

		const [, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b], { label: 'Auth' });
		addTabStack([c]);
		const [auth, unnamed] = tabStackHeaders();
		click(auth);
		click(auth);
		click(unnamed);
		screenReaderOptimized = false;
		click(unnamed);
		screenReaderOptimized = true;

		// Collapsing would hide the only editor, so the tab stack stays expanded
		const [only] = createTabStacksGroup(['only']);
		addTabStack([only], { label: 'Solo' });
		click(tabStackHeaders()[0]);

		assert.deepStrictEqual(announcements, [
			'Collapsed tab stack Auth',
			'Expanded tab stack Auth',
			'Collapsed unnamed tab stack',
		]);
	});

	test('the accessible names of a tab stack header and of the tabs of its tab stack follow a rename and the editors that join or close', () => {
		const [, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd']);
		const tabStack = addTabStack([b, c], { label: 'Auth' });
		const names = () => ({
			header: tabStackHeaders()[0].getAttribute('aria-label'),
			tabs: tabAriaLabels().map(label => /, in tab stack (?<tabStack>\w+)$/.exec(label ?? '')?.groups?.tabStack ?? '-')
		});

		const initially = names();
		model.updateTabStack(tabStack, { label: 'Docs' });
		control.updateTabStacks();
		const afterRename = names();
		model.addEditorsToTabStack([d], tabStack);
		control.updateTabStacks();
		const afterJoin = names();
		model.closeEditor(c);
		control.closeEditor(c);

		assert.deepStrictEqual({ initially, afterRename, afterJoin, afterClose: names() }, {
			initially: { header: 'tab stack Auth, 2 editors', tabs: ['-', 'Auth', 'Auth', '-'] },
			afterRename: { header: 'tab stack Docs, 2 editors', tabs: ['-', 'Docs', 'Docs', '-'] },
			afterJoin: { header: 'tab stack Docs, 3 editors', tabs: ['-', 'Docs', 'Docs', 'Docs'] },
			afterClose: { header: 'tab stack Docs, 2 editors', tabs: ['-', 'Docs', 'Docs'] },
		});
	});

	test('tabs name their tab stack in their aria label by editor when pinned tabs are on a separate row', () => {
		const [s1, s2, , b, c] = createTabStacksGroup(['s1', 's2', 'a', 'b', 'c'], { pinnedTabsOnSeparateRow: true });
		model.stick(s1);
		model.stick(s2);
		model.updateTabStack(model.addEditorsToTabStack([b]).tabStack!.id, { label: 'Auth' });
		model.addEditorsToTabStack([c]);
		control.dispose();
		container.replaceChildren();
		const multiRowControl = disposables.add(instantiationService.createInstance(MultiRowEditorControl, container, editorPartsView, groupsView, groupView, model, undefined, false, false));
		multiRowControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));

		const unstickyTabs = Array.from(container.querySelectorAll<HTMLElement>('.tabs-container')[1].querySelectorAll<HTMLElement>('.tab'));
		assert.deepStrictEqual(unstickyTabs.map(tab => {
			const ariaLabel = tab.getAttribute('aria-label')!;
			return ariaLabel.endsWith(', in tab stack Auth') ? 'Auth' : ariaLabel.endsWith(', in unnamed tab stack') ? 'unnamed' : undefined;
		}), [undefined, 'Auth', 'unnamed']);
	});

	test('connected row markers and minimum widths ignore the tabs of a collapsed tab stack', async () => {
		const group = connectedGroup();
		const [, , c, d] = createTabStacksGroup(['a', 'b', 'c', 'd'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		const tabStack = addTabStack([c, d]);
		const [a, b, ...collapsedTabs] = shownTabs();
		await layoutConnectedGroup(group, 150);

		model.updateTabStack(tabStack, { collapsed: true });
		control.updateTabStacks();
		await layoutConnectedGroup(group, 150);

		assert.deepStrictEqual({
			tabs: strip(),
			upperRow: [a, b].map(tab => tab.classList.contains('connected-tab-upper-row')),
			topRow: [a, b].map(tab => tab.classList.contains('connected-tab-top-row')),
			collapsedMinimumWidths: collapsedTabs.map(tab => /^\d+px$/.test(tab.style.getPropertyValue('--connected-tab-min-width'))),
		}, {
			tabs: ['T:a', 'T:b', 'H:∅(collapsed)'],
			upperRow: [true, false],
			topRow: [true, false],
			collapsedMinimumWidths: [true, true],
		});
	});

	test('marks a tab stack header that ends a wrapped row as last in its row and leaves no row marker on the tabs that a collapse hides', async () => {
		const group = classicGroup();
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		const tabStack = addTabStack([b, c]);
		const [header] = tabStackHeaders();
		const [, ...memberTabs] = shownTabs();
		await layoutConnectedGroup(group, 600);

		// The first tab and the header fit in the first row, but its first tab does not
		await layoutConnectedGroup(group, 120 + header.offsetWidth + 10);
		const lastInRow = (element: HTMLElement) => element.classList.contains('last-in-row');
		const tabsAndActionsContainer = container.querySelector<HTMLElement>('.tabs-and-actions-container')!;
		const wrapped = { wrapping: tabsAndActionsContainer.classList.contains('wrapping'), header: lastInRow(header), memberTabs: memberTabs.map(lastInRow) };

		model.updateTabStack(tabStack, { collapsed: true });
		control.updateTabStacks();
		await layoutConnectedGroup(group, 600);
		model.updateTabStack(tabStack, { collapsed: false });
		control.updateTabStacks();
		await layoutConnectedGroup(group, 600);

		assert.deepStrictEqual({ wrapped, unwrapped: { wrapping: tabsAndActionsContainer.classList.contains('wrapping'), tabs: strip(), lastInRow: [header, ...shownTabs()].map(lastInRow) } }, {
			wrapped: { wrapping: true, header: true, memberTabs: [true, true] },
			unwrapped: { wrapping: false, tabs: ['T:a', 'H:∅', 'T:b*', 'T:c*'], lastInRow: [false, false, false, false] },
		});
	});

	test('tabs do not wrap when the header of a collapsed last tab stack does not fit next to the editor actions', async () => {
		const group = classicGroup();
		const [, b] = createTabStacksGroup(['a', 'b'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 50, tabSizingFixedMaxWidth: 50, editorActionsLocation: 'hidden' });
		addTabStack([b], { label: 'A tab stack with a name longer than its header', collapsed: true });
		await layoutConnectedGroup(group, 100);

		assert.deepStrictEqual({
			tabs: strip(),
			headerWidth: tabStackHeaders()[0].offsetWidth,
			wrapping: container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping'),
		}, {
			tabs: ['T:a', 'H:A tab stack with a name longer than its header(collapsed)'],
			headerWidth: 120,
			wrapping: false,
		});
	});

	test('fixed tab sizing freezes the tabs of a collapsed tab stack at the width of the shown tabs, which they keep when a close shows them', async () => {
		const group = classicGroup();
		const [, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		const tabs = shownTabs();
		addTabStack([c, d], { collapsed: true });
		await layoutConnectedGroup(group, 800);
		const frozenWidth = (tab: HTMLElement) => tab.style.getPropertyValue('--tab-sizing-current-width');

		// Closing a tab while the mouse is over the tabs freezes their widths
		container.querySelector('.tabs-container')!.dispatchEvent(new MouseEvent(EventType.MOUSE_ENTER));
		control.beforeCloseEditor(b);
		const frozenWidths = tabs.map(frozenWidth);
		model.closeEditor(b);
		control.closeEditor(b);

		assert.deepStrictEqual({ frozenWidths, tabs: strip(), shownWidths: shownTabs().map(frozenWidth) }, {
			frozenWidths: ['100px', '100px', '100px', '100px', '100px', '100px'],
			tabs: ['T:a', 'H:∅(collapsed)', 'T:e', 'T:f'],
			shownWidths: ['100px', '100px', '100px'],
		});
	});

	test('shift click selects the editors in between except those hidden in a collapsed tab stack', async () => {
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c', 'd']);
		addTabStack([b, c], { collapsed: true });
		const lastTab = shownTabs()[1];

		lastTab.dispatchEvent(new MouseEvent(EventType.MOUSE_DOWN, { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
		await Promise.resolve();

		assert.deepStrictEqual(model.selectedEditors.map(editor => editor.resource?.path).sort(), ['/path/a', '/path/d']);
	});

	test('tab stack headers show black or white text, whichever contrasts more with their color in the current theme', () => {
		const themeService = instantiationService.get(IThemeService) as TestThemeService;
		// A translucent color shows the tabs background through it
		themeService.setTheme(new TestColorTheme({ 'tabStack.yellow': '#CCA70066', 'tabStack.purple': '#652D90', 'editorGroupHeader.tabsBackground': '#252526' }));
		const [, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd']);
		addTabStack([b], { color: 'yellow' });
		addTabStack([c], { color: 'purple' });
		addTabStack([d], { color: '#1a2b3c' });
		const headerColors = () => tabStackHeaders().map(header => [header.style.getPropertyValue('--tab-stack-color'), header.style.getPropertyValue('--tab-stack-foreground')]);
		const initialHeaders = headerColors();

		themeService.setTheme(new TestColorTheme({ 'tabStack.yellow': '#CCA70066', 'tabStack.purple': '#E0C8F0', 'editorGroupHeader.tabsBackground': '#FFFFFF' }));

		assert.deepStrictEqual({
			initialHeaders,
			headersAfterThemeChange: headerColors(),
			tabs: shownTabs().map(tab => tab.style.getPropertyValue('--tab-stack-color')),
		}, {
			initialHeaders: [
				['var(--vscode-tabStack-yellow)', '#ffffff'],
				['var(--vscode-tabStack-purple)', '#ffffff'],
				['#1a2b3c', '#ffffff'],
			],
			headersAfterThemeChange: [
				['var(--vscode-tabStack-yellow)', '#000000'],
				['var(--vscode-tabStack-purple)', '#000000'],
				['#1a2b3c', '#ffffff'],
			],
			tabs: ['', 'var(--vscode-tabStack-yellow)', 'var(--vscode-tabStack-purple)', '#1a2b3c'],
		});
	});

	/**
	 * Lists the parts of a tab painted in the color `rgb(1, 2, 3)`.
	 */
	function partsInTabStackColor(tab: HTMLElement): string[] {
		const color = 'rgb(1, 2, 3)';
		const fill = tab.querySelector<HTMLElement>('.tab-fill')!;
		const fillStyle = mainWindow.getComputedStyle(fill);
		const shoulders = [mainWindow.getComputedStyle(fill, '::before'), mainWindow.getComputedStyle(fill, '::after')];
		const indicatorStyle = mainWindow.getComputedStyle(tab.querySelector<HTMLElement>('.tab-stack-indicator')!);
		const parts: [string, boolean][] = [
			['top edge', fillStyle.borderTopWidth !== '0px' && fillStyle.borderTopColor === color],
			['sides', fillStyle.borderLeftWidth !== '0px' && fillStyle.borderLeftColor === color && fillStyle.borderRightWidth !== '0px' && fillStyle.borderRightColor === color],
			['shoulders', shoulders.every(shoulder => shoulder.content !== 'none' && shoulder.borderBottomColor === color)],
			['outline', fillStyle.outlineStyle !== 'none' && fillStyle.outlineColor === color],
			['indicator', indicatorStyle.display !== 'none' && indicatorStyle.backgroundColor === color],
		];

		return parts.filter(([, painted]) => painted).map(([part]) => part);
	}

	test('the active tab of a tab stack carries the color of its tab stack in connected, pill and classic tabs', async () => {
		const group = connectedGroup();
		const root = group.closest<HTMLElement>('.monaco-workbench')!;
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b, c], { color: '#010203' });
		model.openEditor(b, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		const [, activeTab, nextTab] = shownTabs();
		await layoutConnectedGroup(group, 600);
		const connected = partsInTabStackColor(activeTab);
		const activeFill = activeTab.querySelector<HTMLElement>('.tab-fill')!;
		const shoulderBottom = activeFill.getBoundingClientRect().bottom - Number.parseFloat(mainWindow.getComputedStyle(activeFill).borderBottomWidth) - Number.parseFloat(mainWindow.getComputedStyle(activeFill, '::after').bottom);
		const nextIndicatorMeetsShoulder = nextTab.querySelector<HTMLElement>('.tab-stack-indicator')!.getBoundingClientRect().bottom === shoulderBottom;

		root.classList.remove('modern-ui-connected-editor-tabs');
		await layoutConnectedGroup(group, 600);
		const pill = partsInTabStackColor(activeTab);

		root.classList.remove('modern-ui', 'modern-ui-tabs');
		await layoutConnectedGroup(group, 600);

		assert.deepStrictEqual({ connected, nextIndicatorMeetsShoulder, pill, classic: partsInTabStackColor(activeTab) }, {
			connected: ['top edge', 'sides', 'shoulders'], // open to the document below it, where the indicators of the tabs next to it meet its shoulders
			nextIndicatorMeetsShoulder: true,
			pill: ['outline', 'indicator'],
			classic: ['indicator'],
		});
	});

	test('the overflow edge that stands in for the clipped part of the active tab takes the color of its tab stack only while that tab is in one', async () => {
		const group = connectedGroup();
		const [a, b] = createTabStacksGroup(['a', 'b', 'c'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 160, tabSizingFixedMaxWidth: 160, editorActionsLocation: 'hidden' });
		addTabStack([a], { color: '#010203' });
		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		const overflowEdge = container.querySelector<HTMLElement>('.tab-connected-overflow-edge')!;
		const clipActiveTab = async () => {
			await layoutConnectedGroup(group, 240);
			tabsContainer.classList.add('scroll');
			tabsContainer.scrollLeft = container.querySelector<HTMLElement>('.tabs-container > .tab.active')!.offsetLeft + 40;
			tabsContainer.dispatchEvent(new UIEvent(EventType.SCROLL));

			return {
				clipped: overflowEdge.classList.contains('connected-tab-left-clipped'),
				edgeInTabStackColor: mainWindow.getComputedStyle(overflowEdge, '::before').borderLeftColor === 'rgb(1, 2, 3)',
			};
		};
		const inTabStack = await clipActiveTab();

		model.openEditor(b, { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));

		assert.deepStrictEqual({ inTabStack, outsideTabStack: await clipActiveTab() }, {
			inTabStack: { clipped: true, edgeInTabStackColor: true },
			outsideTabStack: { clipped: true, edgeInTabStackColor: false },
		});
	});

	test('in classic tabs the indicator of the active tab of a tab stack stays above the border bottom of the active tab', async () => {
		(instantiationService.get(IThemeService) as TestThemeService).setTheme(new TestColorTheme({ 'tab.activeBorder': '#ff0000' }));
		const group = classicGroup();
		const [a, b] = createTabStacksGroup(['a', 'b']);
		addTabStack([a, b], { color: '#010203' });
		await layoutConnectedGroup(group, 400);
		const [activeTab] = shownTabs();
		const indicator = activeTab.querySelector<HTMLElement>('.tab-stack-indicator')!.getBoundingClientRect();
		const borderBottom = activeTab.querySelector<HTMLElement>('.tab-border-bottom-container')!.getBoundingClientRect();

		assert.deepStrictEqual({ borderBottomHeight: borderBottom.height, overlap: Math.max(0, indicator.bottom - borderBottom.top) }, { borderBottomHeight: 1, overlap: 0 });
	});

	test('editTabStack opens the editor of an expanded or a collapsed tab stack, and not for a tab stack without a header, and the editor closes with its header', () => {
		const [, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd']);
		const auth = addTabStack([b, c], { label: 'Auth' });
		const docs = addTabStack([d], { label: 'Docs', collapsed: true });
		const shownName = () => shownTabStackEditor()?.querySelector('input')?.value;

		const expanded = { opened: control.editTabStack(auth), name: shownName() };
		const collapsed = { opened: control.editTabStack(docs), name: shownName() };
		const unknown = control.editTabStack('unknown');
		const oldOptions = partOptions;
		partOptions = { ...partOptions, enableTabStacks: false };
		control.updateOptions(oldOptions, partOptions);

		assert.deepStrictEqual({ expanded, collapsed, unknown, afterDisabling: { name: shownName(), opened: control.editTabStack(auth) } }, {
			expanded: { opened: true, name: 'Auth' },
			collapsed: { opened: true, name: 'Docs' },
			unknown: false,
			afterDisabling: { name: undefined, opened: false },
		});
	});

	test('editTabStack of pinned tabs on a separate row opens the editor from the row that shows the header', () => {
		const [s, , b] = createTabStacksGroup(['s', 'a', 'b'], { pinnedTabsOnSeparateRow: true });
		model.stick(s);
		const tabStack = addTabStack([b], { label: 'Auth' });
		control.dispose();
		container.replaceChildren();
		const multiRowControl = disposables.add(instantiationService.createInstance(MultiRowEditorControl, container, editorPartsView, groupsView, groupView, model, undefined, false, false));
		multiRowControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));

		assert.deepStrictEqual({ opened: multiRowControl.editTabStack(tabStack), name: shownTabStackEditor()?.querySelector('input')?.value }, {
			opened: true,
			name: 'Auth',
		});
	});

	test('typing a name in the editor of a tab stack keeps the tabs scrolled where they are rather than revealing the active tab', async () => {
		const group = classicGroup();
		const [, , , , , f] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		const tabStack = addTabStack([f]);
		await layoutConnectedGroup(group, 250);
		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		tabsContainer.classList.add('scroll');
		tabsContainer.scrollLeft = tabsContainer.scrollWidth - tabsContainer.clientWidth;
		tabsContainer.dispatchEvent(new UIEvent(EventType.SCROLL));
		tabsContainer.classList.remove('scroll');
		const scrollLeft = tabsContainer.scrollLeft;

		control.editTabStack(tabStack);
		const input = shownTabStackEditor()!.querySelector('input')!;
		input.value = 'Auth';
		input.dispatchEvent(new InputEvent(EventType.INPUT));
		await nextAnimationFrame();

		assert.deepStrictEqual({ tabs: strip(), scrolled: scrollLeft > 0, keptScrollLeft: tabsContainer.scrollLeft === scrollLeft, revealed: isActiveTabRevealed() }, {
			tabs: ['T:a', 'T:b', 'T:c', 'T:d', 'T:e', 'H:Auth', 'T:f*'],
			scrolled: true,
			keptScrollLeft: true,
			revealed: false,
		});
	});

	test('the editor of a tab stack stays under its header when a layout of the tabs moves the header', async () => {
		const group = classicGroup();
		const [, , , , , f] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		const tabStack = addTabStack([f]);
		await layoutConnectedGroup(group, 250);
		const [header] = tabStackHeaders();
		const offsetFromHeader = () => Math.round(shownTabStackEditor()!.getBoundingClientRect().left - header.getBoundingClientRect().left);

		control.editTabStack(tabStack);
		const headerLeft = header.getBoundingClientRect().left;
		const offsetBefore = offsetFromHeader();
		model.openEditor(f, { active: true });
		control.openEditors([f]);
		await nextAnimationFrame();

		assert.deepStrictEqual({ offsetBefore, headerMoved: header.getBoundingClientRect().left < headerLeft, offsetAfter: offsetFromHeader() }, {
			offsetBefore: 0,
			headerMoved: true,
			offsetAfter: 0,
		});
	});

	test('the editor of a tab stack stays under its header when the tabs scroll', async () => {
		const group = classicGroup();
		const [, b] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		const tabStack = addTabStack([b]);
		await layoutConnectedGroup(group, 250);
		const [header] = tabStackHeaders();
		const offsetFromHeader = () => Math.round(shownTabStackEditor()!.getBoundingClientRect().left - header.getBoundingClientRect().left);
		control.editTabStack(tabStack);
		const headerLeft = header.getBoundingClientRect().left;
		const offsetBefore = offsetFromHeader();

		const tabsContainer = container.querySelector<HTMLElement>('.tabs-container')!;
		tabsContainer.classList.add('scroll');
		tabsContainer.scrollLeft = 60;
		tabsContainer.dispatchEvent(new UIEvent(EventType.SCROLL));
		tabsContainer.classList.remove('scroll');

		assert.deepStrictEqual({ offsetBefore, headerMoved: header.getBoundingClientRect().left < headerLeft, offsetAfter: offsetFromHeader() }, {
			offsetBefore: 0,
			headerMoved: true,
			offsetAfter: 0,
		});
	});

	test('editTabStack first scrolls a header that the tabs have scrolled out of view into view, where the layout that the new tab stack scheduled keeps it', async () => {
		const group = classicGroup();
		const editors = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f'], { tabSizing: 'fixed', tabSizingFixedMinWidth: 100, tabSizingFixedMaxWidth: 100, editorActionsLocation: 'hidden' });
		model.openEditor(editors[5], { active: true });
		control.openEditors([editors[5]]);
		await layoutConnectedGroup(group, 250);
		const viewport = container.querySelector<HTMLElement>('.monaco-scrollable-element')!;
		const isInView = (element: HTMLElement) => element.getBoundingClientRect().left >= viewport.getBoundingClientRect().left && element.getBoundingClientRect().right <= viewport.getBoundingClientRect().right;

		const tabStack = addTabStack(editors);
		const [header] = tabStackHeaders();
		const headerInViewBefore = isInView(header);
		const opened = control.editTabStack(tabStack);
		await nextAnimationFrame();

		assert.deepStrictEqual({ headerInViewBefore, opened, headerInView: isInView(header), offsetFromHeader: Math.round(shownTabStackEditor()!.getBoundingClientRect().left - header.getBoundingClientRect().left) }, {
			headerInViewBefore: false,
			opened: true,
			headerInView: true,
			offsetFromHeader: 0,
		});
	});

	test('a touch long press on a tab stack header opens only its menu', () => {
		const menus: (string | undefined)[] = [];
		// The context menu UI is the boundary: it renders the menu the tab bar asks for
		instantiationService.stub(IContextMenuService, new class extends mock<IContextMenuService>() {
			override showContextMenu(delegate: IContextMenuMenuDelegate): void {
				menus.push(delegate.menuId?.id);
			}
		});
		const [, b] = createTabStacksGroup(['a', 'b']);
		addTabStack([b]);
		const [header] = tabStackHeaders();

		// Like Gesture, dispatch the long press to each gesture target containing where it started, innermost first
		const longPress = mainWindow.document.createEvent('CustomEvent') as unknown as GestureEvent;
		longPress.initEvent(TouchEventType.Contextmenu, false, true);
		longPress.initialTarget = header;
		header.dispatchEvent(longPress);
		container.querySelector('.tabs-container')!.dispatchEvent(longPress);

		assert.deepStrictEqual(menus, [EditorTabStackContextMenuId.id]);
	});

	test('the context menu of a tab shows the tab stack commands after Pin, each only where it applies, for a tab that is not pinned while tab stacks are enabled', () => {
		const itemsBefore = new Set(MenuRegistry.getMenuItems(MenuId.EditorTitleContext));
		disposables.add(registerTabStackContextMenuItems());
		const enabled: Record<string, ContextKeyValue> = { 'config.workbench.editor.enableTabStacks': true, [EditorTabsVisibleContext.key]: true };
		const isShown = (when: ContextKeyExpression | undefined, keys: Record<string, ContextKeyValue>) => when?.evaluate({ getValue: <T extends ContextKeyValue = ContextKeyValue>(key: string) => keys[key] as T | undefined }) ?? true;
		const title = (value: string | ICommandActionTitle) => typeof value === 'string' ? value : value.value;

		assert.deepStrictEqual(MenuRegistry.getMenuItems(MenuId.EditorTitleContext).filter(item => !itemsBefore.has(item)).map(item => ({
			item: isISubmenuItem(item) ? `submenu ${item.submenu.id}: ${title(item.title)}` : `command ${item.command.id}: ${title(item.command.title)}`,
			group: item.group,
			order: item.order,
			shownFor: {
				tab: isShown(item.when, enabled),
				tabOfGroupWithTabStacks: isShown(item.when, { ...enabled, [EditorGroupHasTabStacksContext.key]: true }),
				tabInTabStack: isShown(item.when, { ...enabled, [EditorGroupHasTabStacksContext.key]: true, [ActiveEditorInTabStackContext.key]: true }),
				pinnedTab: isShown(item.when, { ...enabled, [EditorGroupHasTabStacksContext.key]: true, [ActiveEditorStickyContext.key]: true }),
				tabStacksDisabled: isShown(item.when, { ...enabled, 'config.workbench.editor.enableTabStacks': false }),
				tabsNotShownAsMultiple: isShown(item.when, { ...enabled, [EditorTabsVisibleContext.key]: false }),
			},
		})), [
			{ item: 'command workbench.action.addEditorToNewTabStack: Add to New Tab Stack', group: '3_preview', order: 30, shownFor: { tab: true, tabOfGroupWithTabStacks: true, tabInTabStack: true, pinnedTab: false, tabStacksDisabled: false, tabsNotShownAsMultiple: false } },
			{ item: 'command workbench.action.addEditorToTabStack: Add to Tab Stack...', group: '3_preview', order: 31, shownFor: { tab: false, tabOfGroupWithTabStacks: true, tabInTabStack: true, pinnedTab: false, tabStacksDisabled: false, tabsNotShownAsMultiple: false } },
			{ item: 'command workbench.action.removeEditorFromTabStack: Remove from Tab Stack', group: '3_preview', order: 32, shownFor: { tab: false, tabOfGroupWithTabStacks: false, tabInTabStack: true, pinnedTab: false, tabStacksDisabled: false, tabsNotShownAsMultiple: false } },
		]);
	});

	test('with tab stacks disabled, a drag over the tabs shows the drop between the tabs next to it, and a drag of files enters as a copy while one of tabs leaves the effect to the browser', async () => {
		const group = classicGroup();
		const [a, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd'], { enableTabStacks: false });
		await layoutConnectedGroup(group, 800);

		const feedback = [];
		for (const [editors, description, side] of [[[a], 'T:c', 'right'], [[b, d], 'T:a', 'left'], [[c], 'T:d', 'right'], [[a], '', 'left']] as const) {
			dragEditors(editors);
			feedback.push(`${description || 'tabs'} ${side}: ${dragOver(description, side)}`);
		}
		const tabsDrag = new EffectsDataTransfer();
		dispatchDrag(EventType.DRAG_ENTER, 'T:b', 'left', { dataTransfer: tabsDrag });

		LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().clearData(DraggedEditorIdentifier.prototype);
		const filesDrag = new EffectsDataTransfer();
		filesDrag.setData(DataTransfers.RESOURCES, JSON.stringify([URI.file('/path/x').toString()]));
		dispatchDrag(EventType.DRAG_ENTER, 'T:b', 'left', { dataTransfer: filesDrag });

		assert.deepStrictEqual({ feedback, tabsDropEffect: tabsDrag.recorded.dropEffect, filesDropEffect: filesDrag.recorded.dropEffect }, {
			feedback: ['T:c right: T:c | T:d', 'T:a left: ∅ | T:a', 'T:d right: T:d | ∅', 'tabs left: T:d | ∅'],
			tabsDropEffect: undefined,
			filesDropEffect: 'copy',
		});
	});

	/**
	 * Replaces the group with one whose tabs are laid out, with the tab stack
	 * `Auth` of `b`, `c` and `d` and the collapsed tab stack `Docs` of `f`.
	 */
	async function createDropTabStacksGroup(): Promise<EditorInput[]> {
		const group = classicGroup();
		const editors = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
		const [, b, c, d, , f] = editors;
		addTabStack([b, c, d], { label: 'Auth' });
		addTabStack([f], { label: 'Docs', collapsed: true });
		await layoutConnectedGroup(group, 1200);

		return editors;
	}

	/**
	 * Replaces the group with one whose tabs are laid out 120 pixels wide in a
	 * group of the width, with the tab stack `S` of `b` and `c` in the color
	 * `rgb(1, 2, 3)` and a white drop marker, and starts a drag of `b`.
	 */
	async function createDropMarkerTabStacksGroup(names: readonly string[], width: number, options?: Partial<IEditorPartOptions>): Promise<void> {
		const group = classicGroup();
		group.style.setProperty('--vscode-tab-dragAndDropBorder', 'white');
		const [, b, c] = createTabStacksGroup(names, { tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, ...options });
		addTabStack([b, c], { label: 'S', color: '#010203' });
		await layoutConnectedGroup(group, width);
		dragEditors([b]);
	}

	/**
	 * Describes the drop marker that a pseudo-element of a tab draws: whether
	 * it stands on a foot in the color of the tab stack of
	 * {@link createDropMarkerTabStacksGroup}, and the pixels from the left edge
	 * of the tab where the marker and its foot start and end.
	 */
	function describeDropMarker(tab: HTMLElement, pseudoElement: '::before' | '::after'): { foot: boolean; from: number; to: number } {
		const style = mainWindow.getComputedStyle(tab, pseudoElement);
		const translateX = style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m41;
		const from = parseFloat(mainWindow.getComputedStyle(tab).borderLeftWidth) + parseFloat(style.left) + translateX;

		return { foot: style.backgroundImage.includes('rgb(1, 2, 3)'), from: Math.round(from), to: Math.round(from + parseFloat(style.width)) };
	}

	test('a drag of tabs over tabs with tab stacks shows the drop inside a tab stack between its tabs, on its start slot after its header and over the right half of its last tab, and outside of it before a header over its left half, over the left half of the tab after it and after a collapsed tab stack over the right half of its header', async () => {
		const [a] = await createDropTabStacksGroup();
		const tabs = strip();
		dragEditors([a]);

		const feedback = [];
		for (const [description, side] of [
			['T:c*', 'left'],
			['H:Auth', 'right'],
			['T:b*', 'left'],
			['H:Auth', 'left'],
			['T:d*', 'right'],
			['T:e', 'left'],
			['H:Docs(collapsed)', 'left'],
			['H:Docs(collapsed)', 'right'],
			['T:g', 'right'],
			['', 'left'],
		] as const) {
			feedback.push(`${description || 'tabs'} ${side}: ${dragOver(description, side)}`);
		}

		assert.deepStrictEqual({ tabs, feedback }, {
			tabs: ['T:a', 'H:Auth', 'T:b*', 'T:c*', 'T:d*', 'T:e', 'H:Docs(collapsed)', 'T:g'],
			feedback: [
				'T:c* left: T:b* | T:c* in Auth',
				'H:Auth right: H:Auth | T:b* in Auth',
				'T:b* left: H:Auth | T:b* in Auth',
				'H:Auth left: T:a | H:Auth',
				'T:d* right: T:d* | T:e in Auth',
				'T:e left: T:d* | T:e',
				'H:Docs(collapsed) left: T:e | H:Docs(collapsed)',
				'H:Docs(collapsed) right: H:Docs(collapsed) | T:g',
				'T:g right: T:g | ∅',
				'tabs left: T:g | ∅',
			]
		});
	});

	test('a drag of files over a tab stack shows the drop after the tab stack, and over its start slot before its header', async () => {
		await createDropTabStacksGroup();

		const feedback = [];
		for (const [description, side] of [['T:c*', 'left'], ['H:Auth', 'right'], ['T:b*', 'left'], ['T:d*', 'right']] as const) {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData(DataTransfers.RESOURCES, JSON.stringify([URI.file('/path/x').toString()]));
			feedback.push(`${description} ${side}: ${dragOver(description, side, { dataTransfer })}`);
		}

		assert.deepStrictEqual(feedback, [
			'T:c* left: T:d* | T:e',
			'H:Auth right: T:a | H:Auth',
			'T:b* left: T:a | H:Auth',
			'T:d* right: T:d* | T:e',
		]);
	});

	test('the drop feedback moves from a tab to a tab stack header and is gone once the drag leaves the tabs', async () => {
		const [a] = await createDropTabStacksGroup();
		dragEditors([a]);

		dispatchDrag(EventType.DRAG_ENTER, 'T:c*', 'left');
		dispatchDrag(EventType.DRAG_OVER, 'T:c*', 'left');
		const overTab = dropFeedback();
		dispatchDrag(EventType.DRAG_ENTER, 'H:Auth', 'left');
		dispatchDrag(EventType.DRAG_LEAVE, 'T:c*', 'left');
		dispatchDrag(EventType.DRAG_OVER, 'H:Auth', 'left');
		const overHeader = dropFeedback();
		const markers = container.querySelectorAll('.drop-target-left, .drop-target-right, .drop-target-in-tab-stack').length;
		dispatchDrag(EventType.DRAG_LEAVE, 'H:Auth', 'left');

		assert.deepStrictEqual({ overTab, overHeader, markers, afterLeave: dropFeedback() }, {
			overTab: 'T:b* | T:c* in Auth',
			overHeader: 'T:a | H:Auth',
			markers: 2,
			afterLeave: '∅ | ∅',
		});
	});

	test('the drop feedback of a drag of tabs over the end of a tab stack shows the drop inside it over the right half of its last tab, and outside of it over the left half of the tab after it and over a collapsed tab stack, without leaving the tabs', async () => {
		const [, , c] = await createDropTabStacksGroup();
		dragEditors([c]);

		dispatchDrag(EventType.DRAG_ENTER, 'T:d*', 'right');
		dispatchDrag(EventType.DRAG_OVER, 'T:d*', 'right');
		const overLastTab = dropFeedback();
		dispatchDrag(EventType.DRAG_ENTER, 'T:e', 'left');
		dispatchDrag(EventType.DRAG_LEAVE, 'T:d*', 'right');
		dispatchDrag(EventType.DRAG_OVER, 'T:e', 'left');
		const overTabAfter = dropFeedback();
		dispatchDrag(EventType.DRAG_ENTER, 'H:Docs(collapsed)', 'left');
		dispatchDrag(EventType.DRAG_LEAVE, 'T:e', 'left');
		dispatchDrag(EventType.DRAG_OVER, 'H:Docs(collapsed)', 'left');
		const overCollapsedHeader = [dropFeedback()];
		dispatchDrag(EventType.DRAG_OVER, 'H:Docs(collapsed)', 'right');
		overCollapsedHeader.push(dropFeedback());

		assert.deepStrictEqual({ overLastTab, overTabAfter, overCollapsedHeader }, {
			overLastTab: 'T:d* | T:e in Auth',
			overTabAfter: 'T:d* | T:e',
			overCollapsedHeader: ['T:e | H:Docs(collapsed)', 'H:Docs(collapsed) | T:g'],
		});
	});

	test('a drag of tabs over a tab stack that ends the tabs shows the drop inside it over the right half of its last tab, and outside of it over the empty space of the tabs', async () => {
		const group = classicGroup();
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 1200);
		dragEditors([b]);

		const feedback = [];
		for (const [description, side] of [['T:c*', 'right'], ['', 'left']] as const) {
			feedback.push(`${description || 'tabs'} ${side}: ${dragOver(description, side)}`);
		}

		assert.deepStrictEqual(feedback, [
			'T:c* right: T:c* | ∅ in S',
			'tabs left: T:c* | ∅',
		]);
	});

	test('the marker of a drop inside a tab stack that ends the tabs stands on a foot that reaches past its last tab into the empty space after the tabs, which the marker of a drop outside of it there does not have', async () => {
		await createDropMarkerTabStacksGroup(['a', 'b', 'c'], 1200);

		const markers = [];
		for (const [description, side] of [['T:c*', 'right'], ['', 'left']] as const) {
			markers.push(`${description || 'tabs'} ${side}: ${dragOver(description, side)}`);
			markers.push(describeDropMarker(tabsChild('T:c*'), '::after'));
		}

		assert.deepStrictEqual({ tabWidth: tabsChild('T:c*').offsetWidth, markers }, {
			tabWidth: 120,
			markers: [
				'T:c* right: T:c* | ∅ in S',
				{ foot: true, from: 111, to: 131 },
				'tabs left: T:c* | ∅',
				{ foot: false, from: 120, to: 122 },
			],
		});
	});

	/**
	 * Returns the top and the bottom of the element in pixels from the top of
	 * the tabs container, or of the drop marker that its pseudo-element draws.
	 */
	function describeRowExtent(element: HTMLElement, pseudoElement?: '::before' | '::after'): { top: number; bottom: number } {
		const rect = element.getBoundingClientRect();
		const containerTop = tabsChild('').getBoundingClientRect().top;
		if (!pseudoElement) {
			return { top: Math.round(rect.top - containerTop), bottom: Math.round(rect.bottom - containerTop) };
		}

		const style = mainWindow.getComputedStyle(element, pseudoElement);
		const top = rect.top - containerTop + parseFloat(mainWindow.getComputedStyle(element).borderTopWidth) + parseFloat(style.top);

		return { top: Math.round(top), bottom: Math.round(top + parseFloat(style.height)) };
	}

	test('where connected tabs wrap, the marker of a drop on a tab stack header in the row that joins the document is as tall as the tabs of that row, and the foot of the marker of a drop inside a tab stack stands where the line under its tabs does', async () => {
		const group = connectedGroup();
		group.style.setProperty('--vscode-tab-dragAndDropBorder', 'white');
		const [, b, c, d] = createTabStacksGroup(['a', 'b', 'c', 'd'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		addTabStack([b, c], { label: 'S', color: '#010203' });
		addTabStack([d], { label: 'T' });
		await layoutConnectedGroup(group, 330);
		dragEditors([b]);

		const markers = [];
		for (const [description, side] of [['T:c*', 'right'], ['H:T', 'left']] as const) {
			markers.push(`${description} ${side}: ${dragOver(description, side)}`);
			markers.push({ foot: describeDropMarker(tabsChild('H:T'), '::before').foot, ...describeRowExtent(tabsChild('H:T'), '::before') });
		}

		assert.deepStrictEqual({
			lastRow: strip().slice(-3),
			tab: describeRowExtent(tabsChild('T:c*')),
			indicator: describeRowExtent(tabsChild('T:c*').querySelector<HTMLElement>('.tab-stack-indicator')!),
			markers
		}, {
			lastRow: ['T:c*', 'H:T', 'T:d*'],
			tab: { top: 30, bottom: 58 },
			indicator: { top: 56, bottom: 58 },
			markers: [
				'T:c* right: T:c* | H:T in S',
				{ foot: true, top: 30, bottom: 58 },
				'H:T left: T:c* | H:T',
				{ foot: false, top: 30, bottom: 58 },
			],
		});
	});

	test('where a tab stack ends a row of wrapped tabs, the marker of a drop inside it stands at the start of the next row on a foot that runs into the tab there, which the marker of a drop outside of it there does not have', async () => {
		await createDropMarkerTabStacksGroup(['a', 'b', 'c', 'd'], 460, { wrapTabs: true, editorActionsLocation: 'hidden' });

		const markers = [];
		for (const [description, side] of [['T:c*', 'right'], ['T:d', 'left']] as const) {
			markers.push(`${description} ${side}: ${dragOver(description, side)}`);
			markers.push(describeDropMarker(tabsChild('T:d'), '::before'));
		}

		assert.deepStrictEqual({ rowEnd: tabsChild('T:c*').classList.contains('last-in-row'), markers }, {
			rowEnd: true,
			markers: [
				'T:c* right: T:c* | T:d in S',
				{ foot: true, from: 0, to: 20 },
				'T:d left: T:c* | T:d',
				{ foot: false, from: 0, to: 2 },
			],
		});
	});

	test('a drag of tabs over tabs that overflow and end with a tab stack shows the drop outside of it right past its last tab once the tabs scroll to their end', async () => {
		const group = classicGroup();
		const editors = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f']);
		addTabStack(editors.slice(4), { label: 'S' });
		await layoutConnectedGroup(group, 300);
		dragEditors([editors[1]]);

		// While a drag stays near the end of the tabs, the browser scrolls them to their end a while after the drag enters
		dispatchDrag(EventType.DRAG_ENTER, 'T:f*', 'right');
		await nextAnimationFrame();
		const tabsContainer = tabsChild('');
		tabsContainer.scrollLeft = tabsContainer.scrollWidth;
		await nextAnimationFrame();

		// The drag goes on to the right end of the visible tabs, over whatever is there
		const viewport = container.querySelector<HTMLElement>('.monaco-scrollable-element')!.getBoundingClientRect();
		const point = { clientX: viewport.right - 2, clientY: viewport.top + viewport.height / 2 };
		const target = mainWindow.document.elementFromPoint(point.clientX, point.clientY)!;
		for (const type of [EventType.DRAG_ENTER, EventType.DRAG_OVER]) {
			target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), ...point }));
		}

		assert.deepStrictEqual(dropFeedback(), 'T:f* | ∅');
	});

	test('a drag of tabs over tabs that overflow, end with a tab stack and are scrolled to their end scrolls them on in the next frame to show the empty space after the tab stack, without measuring them when the drag enters', async () => {
		const group = classicGroup();
		const editors = createTabStacksGroup(['a', 'b', 'c', 'd', 'e', 'f']);
		addTabStack(editors.slice(4), { label: 'S' });
		model.openEditor(editors[5], { active: true });
		control.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		await layoutConnectedGroup(group, 300);
		dragEditors([editors[1]]);

		const viewport = container.querySelector<HTMLElement>('.monaco-scrollable-element')!.getBoundingClientRect();
		const spaceAfterLastTab = () => Math.round(viewport.right) - Math.round(tabsChild('T:f*').getBoundingClientRect().right);
		const before = spaceAfterLastTab();
		const widthReads = countReads(tabsChild(''), ['offsetWidth', 'scrollWidth']);
		dispatchDrag(EventType.DRAG_ENTER, 'T:f*', 'right');
		const widthReadsOnDragEnter = widthReads.count;
		await nextAnimationFrame();

		assert.deepStrictEqual({ before, widthReadsOnDragEnter, during: spaceAfterLastTab() }, { before: 0, widthReadsOnDragEnter: 0, during: 28 });
	});

	test('after a drop on a tab from outside of the tabs, such as from another group, the next drag of tabs that leaves the tabs takes its drop feedback and the empty space after a tab stack that ends the tabs with it', async () => {
		const group = classicGroup();
		const [a, b, c] = createTabStacksGroup(['a', 'b', 'c']);
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 1200);

		// The tab takes the drop, so it does not reach the tabs container
		dispatchDrag(EventType.DRAG_ENTER, 'T:a', 'left');
		dispatchDrag(EventType.DROP, 'T:a', 'left');

		dragEditors([a]);
		dispatchDrag(EventType.DRAG_ENTER, 'T:a', 'left');
		dispatchDrag(EventType.DRAG_LEAVE, 'T:a', 'left');

		assert.deepStrictEqual({ dropFeedback: dropFeedback(), dropSpace: tabsChild('').classList.contains('tab-stack-drop-space') }, {
			dropFeedback: '∅ | ∅',
			dropSpace: false,
		});
	});

	test('a drag of tabs over connected tabs that wrapped and fit on one row again adds the empty space after a tab stack that ends the tabs', async () => {
		const group = connectedGroup();
		const [a, b, c] = createTabStacksGroup(['a', 'b', 'c'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 150);
		await layoutConnectedGroup(group, 900);

		dragEditors([a]);
		dispatchDrag(EventType.DRAG_ENTER, 'T:a', 'left');

		assert.deepStrictEqual({
			wrapping: container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping'),
			dropSpace: tabsChild('').classList.contains('tab-stack-drop-space'),
		}, {
			wrapping: false,
			dropSpace: true,
		});
	});

	test('a drag of tabs over tabs that can wrap and nearly fill their row adds the empty space after a tab stack that ends the tabs without wrapping them', async () => {
		const group = classicGroup();
		const [a, b, c] = createTabStacksGroup(['a', 'b', 'c'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 900);
		await layoutConnectedGroup(group, Math.ceil(tabsChild('T:c*').getBoundingClientRect().right - tabsChild('').getBoundingClientRect().left) + 10);

		dragEditors([a]);
		dispatchDrag(EventType.DRAG_ENTER, 'T:a', 'left');
		await nextAnimationFrame();

		assert.deepStrictEqual({
			wrapping: container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping'),
			dropSpace: tabsChild('').classList.contains('tab-stack-drop-space'),
		}, {
			wrapping: false,
			dropSpace: true,
		});
	});

	test('a layout during a drag of tabs over tabs that can wrap and nearly fill their row, as when the drag opens the tab it rests on, keeps them on one row with the empty space after a tab stack that ends the tabs', async () => {
		const group = classicGroup();
		const [a, b, c] = createTabStacksGroup(['a', 'b', 'c'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 900);
		const width = Math.ceil(tabsChild('T:c*').getBoundingClientRect().right - tabsChild('').getBoundingClientRect().left) + 10;
		await layoutConnectedGroup(group, width);

		dragEditors([a]);
		dispatchDrag(EventType.DRAG_ENTER, 'T:a', 'left');
		await layoutConnectedGroup(group, width);

		assert.deepStrictEqual({
			wrapping: container.querySelector('.tabs-and-actions-container')!.classList.contains('wrapping'),
			dropSpace: tabsChild('').classList.contains('tab-stack-drop-space'),
		}, {
			wrapping: false,
			dropSpace: true,
		});
	});

	test('a drag over the empty space of the tabs shows the drop after the last tab, also when the Add Tab control follows the tabs', async () => {
		const group = connectedGroup();
		control.dispose();
		reset(container);
		control = createControl({ tabsBarAddTab: MenuId.for('test.dropFeedback.addTab') });
		await layoutConnectedGroup(group, 600);
		dragEditors([model.getEditorByIndex(0)!]);

		const feedback = dragOver('', 'left');
		const { content, display } = mainWindow.getComputedStyle(tabsChild('T:file1.txt'), '::after');

		assert.deepStrictEqual({ tabs: strip(), feedback, marker: { content, display } }, {
			tabs: ['T:file0.txt', 'T:file1.txt', '+'],
			feedback: 'T:file1.txt | ∅',
			marker: { content: '""', display: 'block' },
		});
	});

	test('a drag that moves on from the last tab over the Add Tab control shows no drop there, where a drop does nothing, and the drop after the last tab again over the empty space of the tabs', async () => {
		const group = connectedGroup();
		control.dispose();
		reset(container);
		control = createControl({ tabsBarAddTab: MenuId.for('test.dropFeedback.addTab') });
		await layoutConnectedGroup(group, 600);
		dragEditors([model.getEditorByIndex(0)!]);

		const feedback = [];
		for (const [description, side] of [['T:file1.txt', 'right'], ['+', 'left'], ['', 'right']] as const) {
			feedback.push(`${description || 'tabs'} ${side}: ${dragOver(description, side)}`);
		}

		// A drag over the Add Tab control enters the action inside it
		const addTabAction = tabsChild('+').querySelector('.action-label')!;
		addTabAction.dispatchEvent(new DragEvent(EventType.DRAG_ENTER, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
		feedback.push(`+ action: ${dropFeedback()}`);
		addTabAction.dispatchEvent(new DragEvent(EventType.DROP, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));

		assert.deepStrictEqual({ feedback, tabs: strip(), editors: model.getEditors(EditorsOrder.SEQUENTIAL).map(editor => editor.getName()) }, {
			feedback: [
				'T:file1.txt right: T:file1.txt | ∅',
				'+ left: ∅ | ∅',
				'tabs right: T:file1.txt | ∅',
				'+ action: ∅ | ∅',
			],
			tabs: ['T:file0.txt', 'T:file1.txt', '+'],
			editors: ['file0.txt', 'file1.txt'],
		});
	});

	test('a drag of tabs that moves on from a drop inside a tab stack that ends the tabs over the Add Tab control shows no drop there, and the empty space after the tab stack, which follows the Add Tab control, shows the drop outside of it', async () => {
		const group = connectedGroup();
		const [, b, c] = createTabStacksGroup(['a', 'b', 'c'], undefined, { tabsBarAddTab: MenuId.for('test.dropFeedback.addTab') });
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 1200);
		dragEditors([b]);

		const feedback = [];
		for (const [description, side] of [['T:c*', 'right'], ['+', 'left'], ['', 'right']] as const) {
			const drop = dragOver(description, side);
			feedback.push(`${description || 'tabs'} ${side}: ${drop}${tabsChild('').classList.contains('tab-stack-drop-space') ? ', with the empty space after the tab stack' : ''}`);
		}

		assert.deepStrictEqual({ tabs: strip(), feedback }, {
			tabs: ['T:a', 'H:S', 'T:b*', 'T:c*', '+'],
			feedback: [
				'T:c* right: T:c* | ∅ in S, with the empty space after the tab stack',
				'+ left: ∅ | ∅, with the empty space after the tab stack',
				'tabs right: T:c* | ∅, with the empty space after the tab stack',
			],
		});
	});

	test('dragging a tab stack header drags only its tab stack, as a move that the tabs of its group take, until the drag ends', async () => {
		await createDropTabStacksGroup();
		const tabsTransfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier | DraggedEditorGroupIdentifier>();

		const dragStart = new EffectsDataTransfer();
		dispatchDrag(EventType.DRAG_START, 'H:Auth', 'left', { dataTransfer: dragStart });
		const dragImage = mainWindow.document.querySelector('.monaco-drag-image')?.textContent;
		const draggedGroupOrEditors = tabsTransfer.hasData(DraggedEditorGroupIdentifier.prototype) || tabsTransfer.hasData(DraggedEditorIdentifier.prototype);
		const dragEnter = new EffectsDataTransfer();
		dispatchDrag(EventType.DRAG_ENTER, 'T:g', 'left', { dataTransfer: dragEnter });
		dispatchDrag(EventType.DRAG_OVER, 'T:g', 'left');
		const feedback = dropFeedback();
		dispatchDrag(EventType.DRAG_END, 'H:Auth', 'left');
		const dragEnterAfterEnd = new EffectsDataTransfer();
		dispatchDrag(EventType.DRAG_ENTER, 'T:g', 'left', { dataTransfer: dragEnterAfterEnd });

		assert.deepStrictEqual({
			effectAllowed: dragStart.recorded.effectAllowed,
			types: [...dragStart.types],
			dragImage,
			draggedGroupOrEditors,
			dropEffect: dragEnter.recorded.dropEffect,
			feedback,
			dropEffectAfterEnd: dragEnterAfterEnd.recorded.dropEffect,
			feedbackAfterEnd: dropFeedback(),
		}, {
			effectAllowed: 'move',
			types: isFirefox ? [DataTransfers.TEXT] : [],
			dragImage: 'Auth (3 editors)',
			draggedGroupOrEditors: false,
			dropEffect: 'move',
			feedback: 'H:Docs(collapsed) | T:g',
			dropEffectAfterEnd: 'none',
			feedbackAfterEnd: '∅ | ∅',
		});
	});

	test('a tab stack that goes away while its header is dragged ends the drag of its header, so the tabs take the drags that follow', async () => {
		const [, b, c, d] = await createDropTabStacksGroup();
		dragTabStackHeader('H:Auth');
		model.removeEditorsFromTabStack([b, c, d]);
		control.updateTabStacks();

		const filesDrag = new EffectsDataTransfer();
		filesDrag.setData(DataTransfers.RESOURCES, JSON.stringify([URI.file('/path/x').toString()]));
		const feedback = dragOver('T:c', 'left', { dataTransfer: filesDrag });

		assert.deepStrictEqual({ tabs: strip(), dropEffect: filesDrag.recorded.dropEffect, feedback }, {
			tabs: ['T:a', 'T:b', 'T:c', 'T:d', 'T:e', 'H:Docs(collapsed)', 'T:g'],
			dropEffect: 'copy',
			feedback: 'T:b | T:c',
		});
	});

	test('a dragged tab stack header shows the drop before or after the tab under it, and after the last tab over the empty space of the tabs', async () => {
		const group = classicGroup();
		const [, b, c] = createTabStacksGroup(['1', '2', '3', '4', '5']);
		addTabStack([b, c], { label: 'S' });
		await layoutConnectedGroup(group, 1200);

		const feedback = [];
		for (const [description, side] of [['T:5', 'left'], ['T:5', 'right'], ['T:1', 'left'], ['', 'left']] as const) {
			dragTabStackHeader('H:S');
			feedback.push(`${description || 'tabs'} ${side}: ${dragOver(description, side)}`);
		}

		assert.deepStrictEqual(feedback, [
			'T:5 left: T:4 | T:5',
			'T:5 right: T:5 | ∅',
			'T:1 left: ∅ | T:1',
			'tabs left: T:5 | ∅',
		]);
	});

	test('a dragged tab stack header shows the drop before or after another tab stack by its middle, after the pinned tabs, and none over or next to its own tab stack', async () => {
		const group = classicGroup();
		const [sticky, , b, c, , e, f] = createTabStacksGroup(['0', '1', '2', '3', '4', '5', '6', '7']);
		model.stick(sticky);
		control.stickEditor(sticky);
		addTabStack([b, c], { label: 'S' });
		const other = addTabStack([e, f], { label: 'T' });
		await layoutConnectedGroup(group, 1200);

		const feedback: string[] = [];
		const dragHeaderOver = (description: string, side: 'left' | 'right') => {
			dragTabStackHeader('H:S');
			feedback.push(`${description} ${side}: ${dragOver(description, side)}`);
		};
		for (const [description, side] of [['T:2*', 'right'], ['H:S', 'right'], ['T:1', 'right'], ['T:4', 'left'], ['T:5*', 'left'], ['H:T', 'right'], ['T:6*', 'right'], ['T:0', 'left']] as const) {
			dragHeaderOver(description, side);
		}
		model.updateTabStack(other, { collapsed: true });
		control.updateTabStacks();
		dragHeaderOver('H:T(collapsed)', 'left');
		dragHeaderOver('H:T(collapsed)', 'right');

		assert.deepStrictEqual(feedback, [
			'T:2* right: ∅ | ∅',
			'H:S right: ∅ | ∅',
			'T:1 right: ∅ | ∅',
			'T:4 left: ∅ | ∅',
			'T:5* left: T:4 | H:T',
			'H:T right: T:4 | H:T',
			'T:6* right: T:6* | T:7',
			'T:0 left: T:0 | T:1',
			'H:T(collapsed) left: T:4 | H:T(collapsed)',
			'H:T(collapsed) right: H:T(collapsed) | T:7',
		]);
	});

	test('with wrapped tabs, a dragged tab stack header shows the drop before another tab stack over its first half and after it over its last half, in the order of its header and tabs, and by the side of its middle tab', async () => {
		const group = classicGroup();
		const [a, , c, d] = createTabStacksGroup(['a', 'b', 'c', 'd', 'e'], { wrapTabs: true, tabSizing: 'fixed', tabSizingFixedMinWidth: 120, tabSizingFixedMaxWidth: 120, editorActionsLocation: 'hidden' });
		addTabStack([a], { label: 'S' });
		addTabStack([c, d], { label: 'T' });
		await layoutConnectedGroup(group, 1200);
		const [headerS, headerT] = tabStackHeaders();

		// The header and the first tab of T end the first row, and its other tab wraps onto the second row
		await layoutConnectedGroup(group, headerS.offsetWidth + 3 * 120 + headerT.offsetWidth + 10);
		const rowTops = new Set([headerT, tabsChild('T:c*'), tabsChild('T:d*')].map(element => element.offsetTop)).size;

		const feedback = [];
		for (const [description, side] of [['H:T', 'left'], ['H:T', 'right'], ['T:c*', 'left'], ['T:c*', 'right'], ['T:d*', 'left'], ['T:d*', 'right']] as const) {
			dragTabStackHeader('H:S');
			feedback.push(`${description} ${side}: ${dragOver(description, side)}`);
		}

		assert.deepStrictEqual({ rowTops, feedback }, {
			rowTops: 2,
			feedback: [
				'H:T left: T:b | H:T',
				'H:T right: T:b | H:T',
				'T:c* left: T:b | H:T',
				'T:c* right: T:d* | T:e',
				'T:d* left: T:d* | T:e',
				'T:d* right: T:d* | T:e',
			]
		});
	});

	test('with pinned tabs on a separate row, a dragged tab stack header shows the drop in the row of the other tabs and none in the row of pinned tabs', () => {
		const [sticky, , b, c] = createTabStacksGroup(['s', 'a', 'b', 'c', 'd'], { pinnedTabsOnSeparateRow: true });
		model.stick(sticky);
		addTabStack([b, c], { label: 'S' });
		control.dispose();
		container.replaceChildren();
		classicGroup();
		const multiRowControl = disposables.add(instantiationService.createInstance(MultiRowEditorControl, container, editorPartsView, groupsView, groupView, model, undefined, false, false));
		multiRowControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
		multiRowControl.layout({ container: new Dimension(1200, 70), available: new Dimension(1200, 300) });

		const feedback = [];
		for (const description of ['T:d', 'T:s']) {
			dragTabStackHeader('H:S');
			feedback.push(`${description} right: ${dragOver(description, 'right')}`);
			dispatchDrag(EventType.DRAG_END, 'H:S', 'left');
		}

		assert.deepStrictEqual(feedback, [
			'T:d right: T:d | ∅',
			'T:s right: ∅ | ∅',
		]);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
