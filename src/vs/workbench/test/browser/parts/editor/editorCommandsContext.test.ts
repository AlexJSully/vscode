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
import { resolveCommandsContext, resolveTabStack, resolveTabStackEditors, resolveTabStackGroupedEditors } from '../../../../browser/parts/editor/editorCommandsContext.js';
import { IEditorCommandsContext } from '../../../../common/editor.js';
import { IListService, WorkbenchListWidget } from '../../../../../platform/list/browser/listService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';

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

	function createTabStacksConfigurationService(): TestConfigurationService {
		const configurationService = new TestConfigurationService({ workbench: { editor: { enableTabStacks: true } } });
		disposables.add(configurationService.onDidChangeConfigurationEmitter);

		return configurationService;
	}

	function editorNames(editors: readonly EditorInput[]): string[] {
		return editors.map(editor => editor.resource?.authority ?? '');
	}

	test('tab stack editors are the editors of the first group without sticky editors', async () => {
		const accessor = await createServices(createTabStacksConfigurationService());
		const editorGroupService = accessor.editorGroupService;

		const group1 = editorGroupService.activeGroup;
		const group2 = editorGroupService.addGroup(group1, GroupDirection.RIGHT);

		const stickyInput = input('sticky');
		const input1 = input('1');
		const input2 = input('2');
		await group1.openEditor(stickyInput, { pinned: true, sticky: true });
		await group1.openEditor(input1, { pinned: true });
		await group1.openEditor(input2, { pinned: true });

		const input3 = input('3');
		await group2.openEditor(input3, { pinned: true });

		const resolve = (...groupedEditors: { group: IEditorGroup; editors: EditorInput[] }[]) => {
			const resolved = resolveTabStackEditors({ groupedEditors, preserveFocus: false }, editorGroupService);

			return resolved && { group: resolved.group.id, editors: editorNames(resolved.editors) };
		};

		assert.deepStrictEqual({
			selection: resolve({ group: group1, editors: [input2, stickyInput, input1] }, { group: group2, editors: [input3] }),
			stickyOnly: resolve({ group: group1, editors: [stickyInput] }, { group: group2, editors: [input3] }),
			noEditor: resolve({ group: group1, editors: [] })
		}, {
			selection: { group: group1.id, editors: ['2', '1'] },
			stickyOnly: undefined,
			noEditor: undefined
		});
	});

	test('tab stack of the right-clicked editor rather than of the active editor', async () => {
		const accessor = await createServices(createTabStacksConfigurationService());
		const group = accessor.editorGroupService.activeGroup;

		const [input1, input2, input3, input4, input5] = ['1', '2', '3', '4', '5'].map(id => input(id));
		for (const editor of [input1, input2, input3, input4, input5]) {
			await group.openEditor(editor, { pinned: true });
		}

		group.addEditorsToTabStack([input1, input2]);
		group.addEditorsToTabStack([input3, input4]);
		const [tabStackA, tabStackB] = group.tabStacks;
		group.updateTabStack(tabStackA.id, { label: 'A' });
		group.updateTabStack(tabStackB.id, { label: 'B' });

		await group.openEditor(input4);
		await group.setSelection(input4, [input1]);

		const resolve = (...commandArgs: unknown[]) => {
			const resolved = resolveTabStack(resolveCommandsContext(commandArgs, accessor.editorService, accessor.editorGroupService, testListService), accessor.editorGroupService);

			return resolved && { tabStack: resolved.tabStack.label, editors: editorNames(resolved.editors) };
		};
		const tabContext = (editor: EditorInput): IEditorCommandsContext => ({ groupId: group.id, editorIndex: group.getIndexOfEditor(editor) });

		assert.deepStrictEqual({
			activeEditor: resolve(),
			selectedTab: resolve(tabContext(input1)),
			unselectedTab: resolve(tabContext(input2)),
			tabOutsideOfTabStacks: resolve(tabContext(input5))
		}, {
			activeEditor: { tabStack: 'B', editors: ['3', '4'] },
			selectedTab: { tabStack: 'A', editors: ['1', '2'] },
			unselectedTab: { tabStack: 'A', editors: ['1', '2'] },
			tabOutsideOfTabStacks: undefined
		});
	});

	test('tab stack resolvers resolve nothing while tab stacks are disabled', async () => {
		const accessor = await createServices(createTabStacksConfigurationService());
		const group = accessor.editorGroupService.activeGroup;

		const input1 = input('1');
		await group.openEditor(input1, { pinned: true });
		group.addEditorsToTabStack([input1]);

		const resolveAll = () => {
			const resolvedContext = resolveCommandsContext([], accessor.editorService, accessor.editorGroupService, testListService);
			const tabStackEditors = resolveTabStackEditors(resolvedContext, accessor.editorGroupService);
			const tabStack = resolveTabStack(resolvedContext, accessor.editorGroupService);

			return {
				tabStackEditors: tabStackEditors && editorNames(tabStackEditors.editors),
				tabStack: tabStack && editorNames(tabStack.editors),
				groupedEditors: resolveTabStackGroupedEditors(resolvedContext, accessor.editorGroupService).map(({ editors }) => editorNames(editors))
			};
		};

		const singleTab = accessor.editorGroupService.getPart(group).enforcePartOptions({ showTabs: 'single' });
		const whileSingleTab = resolveAll();
		singleTab.dispose();

		assert.deepStrictEqual({ whileSingleTab, withMultipleTabs: resolveAll() }, {
			whileSingleTab: { tabStackEditors: undefined, tabStack: undefined, groupedEditors: [] },
			withMultipleTabs: { tabStackEditors: ['1'], tabStack: ['1'], groupedEditors: [['1']] }
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
