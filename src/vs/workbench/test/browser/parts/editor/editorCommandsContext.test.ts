/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { workbenchInstantiationService, TestServiceAccessor, registerTestEditor, registerTestFileEditor, registerTestResourceEditor, TestFileEditorInput, createEditorPart, registerTestSideBySideEditor, TestEditorInput } from '../../workbenchTestServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorService } from '../../../../services/editor/browser/editorService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { resolveCommandsContext } from '../../../../browser/parts/editor/editorCommandsContext.js';
import { IListService, WorkbenchListWidget } from '../../../../../platform/list/browser/listService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ICommandActionTitle } from '../../../../../platform/action/common/action.js';
import { isISubmenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpression, ContextKeyValue } from '../../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorInTabStackContext, ActiveEditorStickyContext, EditorTabsVisibleContext } from '../../../../common/contextkeys.js';
import { ADD_EDITOR_TO_NEW_TAB_STACK_COMMAND_ID, REMOVE_EDITOR_FROM_TAB_STACK_COMMAND_ID, registerTabStackCommands } from '../../../../browser/parts/editor/editorCommands.js';
import { EditorsOrder, IEditorCommandsContext } from '../../../../common/editor.js';

class TestListService implements IListService {
	declare readonly _serviceBrand: undefined;
	readonly lastFocusedList: WorkbenchListWidget | undefined = undefined;
}

suite('Resolving Editor Commands Context', () => {

	const disposables = new DisposableStore();

	const TEST_EDITOR_ID = 'MyTestEditorForEditors';

	let instantiationService: IInstantiationService;
	let accessor: TestServiceAccessor;

	const testListService = new TestListService();

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, disposables);
		accessor = instantiationService.createInstance(TestServiceAccessor);

		disposables.add(accessor.untitledTextEditorService);
		disposables.add(registerTestFileEditor());
		disposables.add(registerTestSideBySideEditor());
		disposables.add(registerTestResourceEditor());
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)]));
	});

	teardown(() => {
		disposables.clear();
	});

	let index = 0;
	function input(id = String(index++)): EditorInput {
		return disposables.add(new TestEditorInput(URI.parse(`file://${id}`), 'testInput'));
	}

	async function createServices(configurationService?: TestConfigurationService): Promise<TestServiceAccessor> {
		const instantiationService = workbenchInstantiationService(configurationService ? { configurationService: () => configurationService } : undefined, disposables);

		const part = await createEditorPart(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, part);

		const editorService = disposables.add(instantiationService.createInstance(EditorService, undefined));
		instantiationService.stub(IEditorService, editorService);

		return instantiationService.createInstance(TestServiceAccessor);
	}

	test('use editor group selection', async () => {
		const accessor = await createServices();
		const activeGroup = accessor.editorGroupService.activeGroup;

		const input1 = input();
		const input2 = input();
		const input3 = input();
		activeGroup.openEditor(input1, { pinned: true });
		activeGroup.openEditor(input2, { pinned: true });
		activeGroup.openEditor(input3, { pinned: true });

		activeGroup.setSelection(input1, [input2]);

		// use editor commands context
		const editorCommandContext: IEditorCommandsContext = { groupId: activeGroup.id, editorIndex: activeGroup.getIndexOfEditor(input1), preserveFocus: true };
		const resolvedContext1 = resolveCommandsContext([editorCommandContext], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext1.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].group.id, activeGroup.id);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors.length, 2);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors[0], input1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors[1], input2);
		assert.strictEqual(resolvedContext1.preserveFocus, true);

		// use URI
		const resolvedContext2 = resolveCommandsContext([input2.resource], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext2.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext2.groupedEditors[0].group.id, activeGroup.id);
		assert.strictEqual(resolvedContext2.groupedEditors[0].editors.length, 2);
		assert.strictEqual(resolvedContext2.groupedEditors[0].editors[0], input2);
		assert.strictEqual(resolvedContext2.groupedEditors[0].editors[1], input1);
		assert.strictEqual(resolvedContext2.preserveFocus, false);

		// use URI and commandContext
		const editor1CommandContext: IEditorCommandsContext = { groupId: activeGroup.id, editorIndex: activeGroup.getIndexOfEditor(input1), preserveFocus: true };
		const resolvedContext3 = resolveCommandsContext([editor1CommandContext], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext3.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext3.groupedEditors[0].group.id, activeGroup.id);
		assert.strictEqual(resolvedContext3.groupedEditors[0].editors.length, 2);
		assert.strictEqual(resolvedContext3.groupedEditors[0].editors[0], input1);
		assert.strictEqual(resolvedContext3.groupedEditors[0].editors[1], input2);
		assert.strictEqual(resolvedContext3.preserveFocus, true);
	});

	test('don\'t use editor group selection', async () => {
		const accessor = await createServices();
		const activeGroup = accessor.editorGroupService.activeGroup;

		const input1 = input();
		const input2 = input();
		const input3 = input();
		activeGroup.openEditor(input1, { pinned: true });
		activeGroup.openEditor(input2, { pinned: true });
		activeGroup.openEditor(input3, { pinned: true });

		activeGroup.setSelection(input1, [input2]);

		// use editor commands context
		const editorCommandContext: IEditorCommandsContext = { groupId: activeGroup.id, editorIndex: activeGroup.getIndexOfEditor(input3), preserveFocus: true };
		const resolvedContext1 = resolveCommandsContext([editorCommandContext], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext1.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].group.id, activeGroup.id);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors.length, 1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors[0], input3);
		assert.strictEqual(resolvedContext1.preserveFocus, true);

		// use URI
		const resolvedContext2 = resolveCommandsContext([input3.resource], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext2.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext2.groupedEditors[0].group.id, activeGroup.id);
		assert.strictEqual(resolvedContext2.groupedEditors[0].editors.length, 1);
		assert.strictEqual(resolvedContext2.groupedEditors[0].editors[0], input3);
		assert.strictEqual(resolvedContext2.preserveFocus, false);
	});

	test('inactive edior group command context', async () => {
		const accessor = await createServices();
		const editorGroupService = accessor.editorGroupService;

		const group1 = editorGroupService.activeGroup;
		const group2 = editorGroupService.addGroup(group1, GroupDirection.RIGHT);

		const input11 = input();
		const input12 = input();
		group1.openEditor(input11, { pinned: true });
		group1.openEditor(input12, { pinned: true });

		const input21 = input();
		group2.openEditor(input21, { pinned: true });

		editorGroupService.activateGroup(group1);
		group1.setSelection(input11, [input12]);

		// use editor commands context of inactive group with editor index
		const editorCommandContext1: IEditorCommandsContext = { groupId: group2.id, editorIndex: group2.getIndexOfEditor(input21), preserveFocus: true };
		const resolvedContext1 = resolveCommandsContext([editorCommandContext1], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext1.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].group.id, group2.id);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors.length, 1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors[0], input21);
		assert.strictEqual(resolvedContext1.preserveFocus, true);

		// use editor commands context of inactive group without editor index
		const editorCommandContext2: IEditorCommandsContext = { groupId: group2.id, preserveFocus: true };
		const resolvedContext2 = resolveCommandsContext([editorCommandContext2], accessor.editorService, accessor.editorGroupService, testListService);

		assert.strictEqual(resolvedContext2.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext2.groupedEditors[0].group.id, group2.id);
		assert.strictEqual(resolvedContext2.groupedEditors[0].editors.length, 1);
		assert.strictEqual(resolvedContext1.groupedEditors[0].editors[0], input21);
		assert.strictEqual(resolvedContext2.preserveFocus, true);
	});

	test('resolves context from right-clicked editor (not active)', async () => {
		const accessor = await createServices();
		const group = accessor.editorGroupService.activeGroup;

		const input1 = input();
		const input2 = input();
		await group.openEditor(input1, { pinned: true });
		await group.openEditor(input2, { pinned: true });

		// input2 is now active (last opened), but we simulate right-click on input1
		assert.strictEqual(group.activeEditor, input2);

		const editorCommandContext: IEditorCommandsContext = {
			groupId: group.id,
			editorIndex: group.getIndexOfEditor(input1),
			preserveFocus: false
		};
		const resolvedContext = resolveCommandsContext([editorCommandContext], accessor.editorService, accessor.editorGroupService, testListService);

		// Should resolve to input1 (right-clicked editor), not input2 (active editor)
		assert.strictEqual(resolvedContext.groupedEditors.length, 1);
		assert.strictEqual(resolvedContext.groupedEditors[0].group.id, group.id);
		assert.strictEqual(resolvedContext.groupedEditors[0].editors.length, 1);
		assert.strictEqual(resolvedContext.groupedEditors[0].editors[0], input1);
		assert.notStrictEqual(resolvedContext.groupedEditors[0].editors[0], input2);
		assert.strictEqual(resolvedContext.preserveFocus, false);
	});

	test('tab stack commands act on the right-clicked editor, with the selection it is in, and skip pinned editors', async () => {
		// Setup: services with tab stacks on, the commands, and a second group
		const configurationService = new TestConfigurationService({ workbench: { editor: { enableTabStacks: true } } });
		disposables.add(configurationService.onDidChangeConfigurationEmitter);
		const accessor = await createServices(configurationService);
		disposables.add(registerTabStackCommands());
		const activeGroup = accessor.editorGroupService.activeGroup;
		const group = accessor.editorGroupService.addGroup(activeGroup, GroupDirection.RIGHT);

		// Setup: run a command the way the context menu of a tab of the second group does
		const runOnTab = (commandId: string, editor: EditorInput) => accessor.instantiationService.invokeFunction(servicesAccessor => {
			const editorCommandContext: IEditorCommandsContext = { groupId: group.id, editorIndex: group.getIndexOfEditor(editor), preserveFocus: false };
			CommandsRegistry.getCommand(commandId)!.handler(servicesAccessor, editorCommandContext);
		});
		const state = (editorGroup: IEditorGroup) => editorGroup.getEditors(EditorsOrder.SEQUENTIAL).map(editor => `${editor.resource?.authority}${editorGroup.getTabStack(editor) ? '+' : ''}`).join(' ');

		// Setup: in a group that is not active, a pinned editor and three other editors, with the first and last selected with it
		await activeGroup.openEditor(input('active'), { pinned: true });
		const pinnedInput = input('pinned');
		const [input1, input2, input3] = [input('1'), input('2'), input('3')];
		await group.openEditor(pinnedInput, { pinned: true, sticky: true });
		for (const editor of [input1, input2, input3]) {
			await group.openEditor(editor, { pinned: true });
		}
		accessor.editorGroupService.activateGroup(activeGroup);
		await group.setSelection(input3, [pinnedInput, input1]);

		// Add to New Tab Stack on the last selected tab
		const isOtherGroupActive = accessor.editorGroupService.activeGroup === activeGroup;
		runOnTab(ADD_EDITOR_TO_NEW_TAB_STACK_COMMAND_ID, input3);
		const afterAdd = { isOtherGroupActive, activeGroup: state(activeGroup), group: state(group) };

		// Remove from Tab Stack on a tab that is not selected
		await group.setSelection(input2, []);
		runOnTab(REMOVE_EDITOR_FROM_TAB_STACK_COMMAND_ID, input1);

		// Check: Add takes the selection without the pinned editor, and Remove only the right-clicked tab
		assert.deepStrictEqual({ afterAdd, afterRemove: state(group) }, {
			afterAdd: { isOtherGroupActive: true, activeGroup: 'active', group: 'pinned 1+ 3+ 2' },
			afterRemove: 'pinned 1 3+ 2'
		});
	});

	test('the context menu of a tab shows the tab stack commands, each only where it applies, for a tab that is not pinned while tab stacks are enabled', () => {
		// Register the commands, keeping the menu items they add apart from the others
		const itemsBefore = new Set(MenuRegistry.getMenuItems(MenuId.EditorTitleContext));
		disposables.add(registerTabStackCommands());

		// Setup: evaluate when clauses against context keys of a tab of a group with tab stacks on
		const enabled: Record<string, ContextKeyValue> = { 'config.workbench.editor.enableTabStacks': true, [EditorTabsVisibleContext.key]: true };
		const isShown = (when: ContextKeyExpression | undefined, keys: Record<string, ContextKeyValue>) => when?.evaluate({ getValue: <T extends ContextKeyValue = ContextKeyValue>(key: string) => keys[key] as T | undefined }) ?? true;
		const title = (value: string | ICommandActionTitle) => typeof value === 'string' ? value : value.value;

		// Check: each added item, and for which tabs it shows
		assert.deepStrictEqual(MenuRegistry.getMenuItems(MenuId.EditorTitleContext).filter(item => !itemsBefore.has(item)).map(item => ({
			item: isISubmenuItem(item) ? `submenu ${item.submenu.id}: ${title(item.title)}` : `command ${item.command.id}: ${title(item.command.title)}`,
			group: item.group,
			order: item.order,
			shownFor: {
				tab: isShown(item.when, enabled),
				tabInTabStack: isShown(item.when, { ...enabled, [ActiveEditorInTabStackContext.key]: true }),
				pinnedTab: isShown(item.when, { ...enabled, [ActiveEditorStickyContext.key]: true }),
				tabStacksDisabled: isShown(item.when, { ...enabled, 'config.workbench.editor.enableTabStacks': false }),
				tabsNotShownAsMultiple: isShown(item.when, { ...enabled, [EditorTabsVisibleContext.key]: false }),
			},
		})), [
			{ item: 'command workbench.action.addEditorToNewTabStack: Add to New Tab Stack', group: '3_preview', order: 30, shownFor: { tab: true, tabInTabStack: true, pinnedTab: false, tabStacksDisabled: false, tabsNotShownAsMultiple: false } },
			{ item: 'command workbench.action.removeEditorFromTabStack: Remove from Tab Stack', group: '3_preview', order: 32, shownFor: { tab: false, tabInTabStack: true, pinnedTab: false, tabStacksDisabled: false, tabsNotShownAsMultiple: false } },
		]);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
