/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { workbenchInstantiationService, registerTestEditor, TestFileEditorInput, TestEditorPart, TestServiceAccessor, ITestInstantiationService, workbenchTeardown, createEditorParts, TestEditorParts, registerTestFileEditor } from '../../../../test/browser/workbenchTestServices.js';
import { GroupDirection, GroupsOrder, MergeGroupMode, GroupOrientation, GroupLocation, isEditorGroup, IEditorGroupsService, GroupsArrangement, IEditorGroupContextKeyProvider, GroupActivationReason, IEditorGroupActivationEvent, IEditorGroup } from '../../common/editorGroupsService.js';
import { CloseDirection, IEditorPartOptions, EditorsOrder, EditorInputCapabilities, GroupModelChangeKind, SideBySideEditor, IEditorFactoryRegistry, EditorExtensions, EditorResourceAccessor } from '../../../../common/editor.js';
import { URI } from '../../../../../base/common/uri.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { MockScopableContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ConfirmResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { SideBySideEditorInput } from '../../../../common/editor/sideBySideEditorInput.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IGroupModelChangeEvent, IGroupEditorMoveEvent, IGroupEditorOpenEvent, isGroupEditorMoveEvent } from '../../../../common/editor/editorGroupModel.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { basename, isEqual } from '../../../../../base/common/resources.js';
import { CloseAllEditorGroupsAction } from '../../../../browser/parts/editor/editorActions.js';
import { ActiveEditorGroupHasCollapsedTabStacksContext, ActiveEditorInTabStackContext, EditorGroupHasTabStacksContext } from '../../../../common/contextkeys.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IContextMenuMenuDelegate, IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorGroupView, moveEditorsByTabWithTabStacks } from '../../../../browser/parts/editor/editor.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { EventType, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Extensions as DragAndDropExtensions, IDragAndDropContributionRegistry, LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier, fillEditorsDragData } from '../../../../browser/dnd.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { EditorService } from '../../browser/editorService.js';
import { IEditorService } from '../../common/editorService.js';
import { ITreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDndService.js';
import { DraggedTreeItemsIdentifier, TreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDnd.js';
import { createStringDataTransferItem, UriList, VSDataTransfer } from '../../../../../base/common/dataTransfer.js';
import { Mimes } from '../../../../../base/common/mime.js';
import { ITextEditorService } from '../../../textfile/common/textEditorService.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { WorkspaceTrustUriResponse } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';

suite('EditorGroupsService', () => {

	const TEST_EDITOR_ID = 'MyFileEditorForEditorGroupService';
	const TEST_EDITOR_INPUT_ID = 'testEditorInputForEditorGroupService';

	const disposables = new DisposableStore();

	let testLocalInstantiationService: ITestInstantiationService | undefined = undefined;

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput), new SyncDescriptor(SideBySideEditorInput)], TEST_EDITOR_INPUT_ID));
	});

	teardown(async () => {
		if (testLocalInstantiationService) {
			await workbenchTeardown(testLocalInstantiationService);
			testLocalInstantiationService = undefined;
		}

		disposables.clear();
	});

	async function createParts(instantiationService = workbenchInstantiationService(undefined, disposables)): Promise<[TestEditorParts, TestInstantiationService]> {
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, parts);

		testLocalInstantiationService = instantiationService;

		return [parts, instantiationService];
	}

	async function createPart(instantiationService?: TestInstantiationService): Promise<[TestEditorPart, TestInstantiationService]> {
		const [parts, testInstantiationService] = await createParts(instantiationService);
		return [parts.testMainPart, testInstantiationService];
	}

	function createTestFileEditorInput(resource: URI, typeId: string): TestFileEditorInput {
		return disposables.add(new TestFileEditorInput(resource, typeId));
	}

	function createCannotCloseTestFileEditorInput(resource: URI, typeId: string): TestFileEditorInput {
		const input = createTestFileEditorInput(resource, typeId);
		input.capabilities = EditorInputCapabilities.CannotClose;

		return input;
	}

	test('groups basics', async function () {
		const instantiationService = workbenchInstantiationService({ contextKeyService: instantiationService => instantiationService.createInstance(MockScopableContextKeyService) }, disposables);
		const [part] = await createPart(instantiationService);

		let activeGroupModelChangeCounter = 0;
		const activeGroupModelChangeListener = part.onDidChangeActiveGroup(() => {
			activeGroupModelChangeCounter++;
		});

		let groupAddedCounter = 0;
		const groupAddedListener = part.onDidAddGroup(() => {
			groupAddedCounter++;
		});

		let groupRemovedCounter = 0;
		const groupRemovedListener = part.onDidRemoveGroup(() => {
			groupRemovedCounter++;
		});

		let groupMovedCounter = 0;
		const groupMovedListener = part.onDidMoveGroup(() => {
			groupMovedCounter++;
		});

		// always a root group
		const rootGroup = part.groups[0];
		assert.strictEqual(isEditorGroup(rootGroup), true);
		assert.strictEqual(part.groups.length, 1);
		assert.strictEqual(part.count, 1);
		assert.strictEqual(rootGroup, part.getGroup(rootGroup.id));
		assert.ok(part.activeGroup === rootGroup);
		assert.strictEqual(rootGroup.label, 'Group 1');

		let mru = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru.length, 1);
		assert.strictEqual(mru[0], rootGroup);

		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		assert.strictEqual(rightGroup, part.getGroup(rightGroup.id));
		assert.strictEqual(groupAddedCounter, 1);
		assert.strictEqual(part.groups.length, 2);
		assert.strictEqual(part.count, 2);
		assert.ok(part.activeGroup === rootGroup);
		assert.strictEqual(rootGroup.label, 'Group 1');
		assert.strictEqual(rightGroup.label, 'Group 2');

		mru = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru.length, 2);
		assert.strictEqual(mru[0], rootGroup);
		assert.strictEqual(mru[1], rightGroup);

		assert.strictEqual(activeGroupModelChangeCounter, 0);

		let rootGroupActiveChangeCounter = 0;
		const rootGroupModelChangeListener = rootGroup.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_ACTIVE) {
				rootGroupActiveChangeCounter++;
			}
		});

		let rightGroupActiveChangeCounter = 0;
		const rightGroupModelChangeListener = rightGroup.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_ACTIVE) {
				rightGroupActiveChangeCounter++;
			}
		});

		part.activateGroup(rightGroup);
		assert.ok(part.activeGroup === rightGroup);
		assert.strictEqual(activeGroupModelChangeCounter, 1);
		assert.strictEqual(rootGroupActiveChangeCounter, 1);
		assert.strictEqual(rightGroupActiveChangeCounter, 1);

		rootGroupModelChangeListener.dispose();
		rightGroupModelChangeListener.dispose();

		mru = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru.length, 2);
		assert.strictEqual(mru[0], rightGroup);
		assert.strictEqual(mru[1], rootGroup);

		const downGroup = part.addGroup(rightGroup, GroupDirection.DOWN);
		let didDispose = false;
		disposables.add(downGroup.onWillDispose(() => {
			didDispose = true;
		}));
		assert.strictEqual(groupAddedCounter, 2);
		assert.strictEqual(part.groups.length, 3);
		assert.ok(part.activeGroup === rightGroup);
		assert.ok(!downGroup.activeEditorPane);
		assert.strictEqual(rootGroup.label, 'Group 1');
		assert.strictEqual(rightGroup.label, 'Group 2');
		assert.strictEqual(downGroup.label, 'Group 3');

		mru = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru.length, 3);
		assert.strictEqual(mru[0], rightGroup);
		assert.strictEqual(mru[1], rootGroup);
		assert.strictEqual(mru[2], downGroup);

		const gridOrder = part.getGroups(GroupsOrder.GRID_APPEARANCE);
		assert.strictEqual(gridOrder.length, 3);
		assert.strictEqual(gridOrder[0], rootGroup);
		assert.strictEqual(gridOrder[0].index, 0);
		assert.strictEqual(gridOrder[1], rightGroup);
		assert.strictEqual(gridOrder[1].index, 1);
		assert.strictEqual(gridOrder[2], downGroup);
		assert.strictEqual(gridOrder[2].index, 2);

		part.moveGroup(downGroup, rightGroup, GroupDirection.DOWN);
		assert.strictEqual(groupMovedCounter, 1);

		part.removeGroup(downGroup);
		assert.ok(!part.getGroup(downGroup.id));
		assert.ok(!part.hasGroup(downGroup.id));
		assert.strictEqual(didDispose, true);
		assert.strictEqual(groupRemovedCounter, 1);
		assert.strictEqual(part.groups.length, 2);
		assert.ok(part.activeGroup === rightGroup);
		assert.strictEqual(rootGroup.label, 'Group 1');
		assert.strictEqual(rightGroup.label, 'Group 2');

		mru = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru.length, 2);
		assert.strictEqual(mru[0], rightGroup);
		assert.strictEqual(mru[1], rootGroup);

		const rightGroupContextKeyService = part.activeGroup.scopedContextKeyService;
		const rootGroupContextKeyService = rootGroup.scopedContextKeyService;

		assert.ok(rightGroupContextKeyService);
		assert.ok(rootGroupContextKeyService);
		assert.ok(rightGroupContextKeyService !== rootGroupContextKeyService);

		part.removeGroup(rightGroup);
		assert.strictEqual(groupRemovedCounter, 2);
		assert.strictEqual(part.groups.length, 1);
		assert.ok(part.activeGroup === rootGroup);

		mru = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru.length, 1);
		assert.strictEqual(mru[0], rootGroup);

		part.removeGroup(rootGroup); // cannot remove root group
		assert.strictEqual(part.groups.length, 1);
		assert.strictEqual(groupRemovedCounter, 2);
		assert.ok(part.activeGroup === rootGroup);

		part.setGroupOrientation(part.orientation === GroupOrientation.HORIZONTAL ? GroupOrientation.VERTICAL : GroupOrientation.HORIZONTAL);

		activeGroupModelChangeListener.dispose();
		groupAddedListener.dispose();
		groupRemovedListener.dispose();
		groupMovedListener.dispose();
	});

	test('sideGroup', async () => {
		const instantiationService = workbenchInstantiationService({ contextKeyService: instantiationService => instantiationService.createInstance(MockScopableContextKeyService) }, disposables);
		const [part] = await createPart(instantiationService);

		const rootGroup = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await rootGroup.openEditor(input1, { pinned: true });
		await part.sideGroup.openEditor(input2, { pinned: true });
		assert.strictEqual(part.count, 2);

		part.activateGroup(rootGroup);
		await part.sideGroup.openEditor(input3, { pinned: true });
		assert.strictEqual(part.count, 2);
	});

	test('save & restore state', async function () {
		const [part, instantiationService] = await createPart();

		const rootGroup = part.groups[0];
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		const downGroup = part.addGroup(rightGroup, GroupDirection.DOWN);

		const rootGroupInput = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		await rootGroup.openEditor(rootGroupInput, { pinned: true });

		const rightGroupInput = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		await rightGroup.openEditor(rightGroupInput, { pinned: true });

		assert.strictEqual(part.groups.length, 3);

		part.testSaveState();
		part.dispose();

		const [restoredPart] = await createPart(instantiationService);

		assert.strictEqual(restoredPart.groups.length, 3);
		assert.ok(restoredPart.getGroup(rootGroup.id));
		assert.ok(restoredPart.hasGroup(rootGroup.id));
		assert.ok(restoredPart.getGroup(rightGroup.id));
		assert.ok(restoredPart.hasGroup(rightGroup.id));
		assert.ok(restoredPart.getGroup(downGroup.id));
		assert.ok(restoredPart.hasGroup(downGroup.id));

		restoredPart.clearState();
	});

	test('groups index / labels', async function () {
		const [part] = await createPart();

		const rootGroup = part.groups[0];
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		const downGroup = part.addGroup(rightGroup, GroupDirection.DOWN);

		let groupIndexChangedCounter = 0;
		const groupIndexChangedListener = part.onDidChangeGroupIndex(() => {
			groupIndexChangedCounter++;
		});

		let indexChangeCounter = 0;
		const labelChangeListener = downGroup.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_INDEX) {
				indexChangeCounter++;
			}
		});

		assert.strictEqual(rootGroup.index, 0);
		assert.strictEqual(rightGroup.index, 1);
		assert.strictEqual(downGroup.index, 2);
		assert.strictEqual(rootGroup.label, 'Group 1');
		assert.strictEqual(rightGroup.label, 'Group 2');
		assert.strictEqual(downGroup.label, 'Group 3');

		part.removeGroup(rightGroup);
		assert.strictEqual(rootGroup.index, 0);
		assert.strictEqual(downGroup.index, 1);
		assert.strictEqual(rootGroup.label, 'Group 1');
		assert.strictEqual(downGroup.label, 'Group 2');
		assert.strictEqual(indexChangeCounter, 1);
		assert.strictEqual(groupIndexChangedCounter, 1);

		part.moveGroup(downGroup, rootGroup, GroupDirection.UP);
		assert.strictEqual(downGroup.index, 0);
		assert.strictEqual(rootGroup.index, 1);
		assert.strictEqual(downGroup.label, 'Group 1');
		assert.strictEqual(rootGroup.label, 'Group 2');
		assert.strictEqual(indexChangeCounter, 2);
		assert.strictEqual(groupIndexChangedCounter, 3);

		const newFirstGroup = part.addGroup(downGroup, GroupDirection.UP);
		assert.strictEqual(newFirstGroup.index, 0);
		assert.strictEqual(downGroup.index, 1);
		assert.strictEqual(rootGroup.index, 2);
		assert.strictEqual(newFirstGroup.label, 'Group 1');
		assert.strictEqual(downGroup.label, 'Group 2');
		assert.strictEqual(rootGroup.label, 'Group 3');
		assert.strictEqual(indexChangeCounter, 3);
		assert.strictEqual(groupIndexChangedCounter, 6);

		labelChangeListener.dispose();
		groupIndexChangedListener.dispose();
	});

	test('groups label', async function () {
		const [part] = await createPart();

		const rootGroup = part.groups[0];
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);

		let partLabelChangedCounter = 0;
		const groupIndexChangedListener = part.onDidChangeGroupLabel(() => {
			partLabelChangedCounter++;
		});

		let rootGroupLabelChangeCounter = 0;
		const rootGroupLabelChangeListener = rootGroup.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_LABEL) {
				rootGroupLabelChangeCounter++;
			}
		});

		let rightGroupLabelChangeCounter = 0;
		const rightGroupLabelChangeListener = rightGroup.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_LABEL) {
				rightGroupLabelChangeCounter++;
			}
		});

		assert.strictEqual(rootGroup.label, 'Group 1');
		assert.strictEqual(rightGroup.label, 'Group 2');

		part.notifyGroupsLabelChange('Window 2');

		assert.strictEqual(rootGroup.label, 'Window 2: Group 1');
		assert.strictEqual(rightGroup.label, 'Window 2: Group 2');

		assert.strictEqual(rootGroupLabelChangeCounter, 1);
		assert.strictEqual(rightGroupLabelChangeCounter, 1);
		assert.strictEqual(partLabelChangedCounter, 2);

		part.notifyGroupsLabelChange('Window 3');

		assert.strictEqual(rootGroup.label, 'Window 3: Group 1');
		assert.strictEqual(rightGroup.label, 'Window 3: Group 2');

		assert.strictEqual(rootGroupLabelChangeCounter, 2);
		assert.strictEqual(rightGroupLabelChangeCounter, 2);
		assert.strictEqual(partLabelChangedCounter, 4);

		rootGroupLabelChangeListener.dispose();
		rightGroupLabelChangeListener.dispose();
		groupIndexChangedListener.dispose();
	});

	test('copy/merge groups', async () => {
		const [part] = await createPart();

		let groupAddedCounter = 0;
		const groupAddedListener = part.onDidAddGroup(() => {
			groupAddedCounter++;
		});

		let groupRemovedCounter = 0;
		const groupRemovedListener = part.onDidRemoveGroup(() => {
			groupRemovedCounter++;
		});

		const rootGroup = part.groups[0];
		let rootGroupDisposed = false;
		const disposeListener = rootGroup.onWillDispose(() => {
			rootGroupDisposed = true;
		});

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);

		await rootGroup.openEditor(input, { pinned: true });
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		part.activateGroup(rightGroup);
		const downGroup = part.copyGroup(rootGroup, rightGroup, GroupDirection.DOWN);
		assert.strictEqual(groupAddedCounter, 2);
		assert.strictEqual(downGroup.count, 1);
		assert.ok(downGroup.activeEditor instanceof TestFileEditorInput);
		let res = part.mergeGroup(rootGroup, rightGroup, { mode: MergeGroupMode.COPY_EDITORS });
		assert.strictEqual(res, true);
		assert.strictEqual(rightGroup.count, 1);
		assert.ok(rightGroup.activeEditor instanceof TestFileEditorInput);
		res = part.mergeGroup(rootGroup, rightGroup, { mode: MergeGroupMode.MOVE_EDITORS });
		assert.strictEqual(res, true);
		assert.strictEqual(rootGroup.count, 0);
		res = part.mergeGroup(rootGroup, downGroup);
		assert.strictEqual(res, true);
		assert.strictEqual(groupRemovedCounter, 1);
		assert.strictEqual(rootGroupDisposed, true);

		groupAddedListener.dispose();
		groupRemovedListener.dispose();
		disposeListener.dispose();
		part.dispose();
	});

	test('merge all groups', async () => {
		const [part] = await createPart();

		const rootGroup = part.groups[0];

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await rootGroup.openEditor(input1, { pinned: true });

		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		await rightGroup.openEditor(input2, { pinned: true });

		const downGroup = part.copyGroup(rootGroup, rightGroup, GroupDirection.DOWN);
		await downGroup.openEditor(input3, { pinned: true });

		part.activateGroup(rootGroup);

		assert.strictEqual(rootGroup.count, 1);

		const result = part.mergeAllGroups(part.activeGroup);
		assert.strictEqual(result, true);
		assert.strictEqual(rootGroup.count, 3);

		part.dispose();
	});

	test('whenReady / whenRestored', async () => {
		const [part] = await createPart();

		await part.whenReady;
		assert.strictEqual(part.isReady, true);
		await part.whenRestored;
	});

	test('options', async () => {
		const [part] = await createPart();

		let oldOptions!: IEditorPartOptions;
		let newOptions!: IEditorPartOptions;
		disposables.add(part.onDidChangeEditorPartOptions(event => {
			oldOptions = event.oldPartOptions;
			newOptions = event.newPartOptions;
		}));

		const currentOptions = part.partOptions;
		assert.ok(currentOptions);

		disposables.add(part.enforcePartOptions({ showTabs: 'single' }));
		assert.strictEqual(part.partOptions.showTabs, 'single');
		assert.strictEqual(newOptions.showTabs, 'single');
		assert.strictEqual(oldOptions, currentOptions);

		const enforced = part.enforcePartOptions({ allowDropIntoGroup: false });
		assert.strictEqual(part.partOptions.allowDropIntoGroup, false);
		enforced.dispose();
		assert.strictEqual(part.partOptions.allowDropIntoGroup, true);
	});

	test('editor basics', async function () {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		let activeEditorChangeCounter = 0;
		let editorDidOpenCounter = 0;
		const editorOpenEvents: IGroupModelChangeEvent[] = [];
		let editorCloseCounter = 0;
		const editorCloseEvents: IGroupModelChangeEvent[] = [];
		let editorPinCounter = 0;
		let editorStickyCounter = 0;
		let editorCapabilitiesCounter = 0;
		const editorGroupModelChangeListener = group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.EDITOR_OPEN) {
				assert.ok(e.editor);
				editorDidOpenCounter++;
				editorOpenEvents.push(e);
			} else if (e.kind === GroupModelChangeKind.EDITOR_PIN) {
				assert.ok(e.editor);
				editorPinCounter++;
			} else if (e.kind === GroupModelChangeKind.EDITOR_STICKY) {
				assert.ok(e.editor);
				editorStickyCounter++;
			} else if (e.kind === GroupModelChangeKind.EDITOR_CAPABILITIES) {
				assert.ok(e.editor);
				editorCapabilitiesCounter++;
			} else if (e.kind === GroupModelChangeKind.EDITOR_CLOSE) {
				assert.ok(e.editor);
				editorCloseCounter++;
				editorCloseEvents.push(e);
			}
		});
		const activeEditorChangeListener = group.onDidActiveEditorChange(e => {
			assert.ok(e.editor);
			activeEditorChangeCounter++;
		});

		let editorCloseCounter1 = 0;
		const editorCloseListener = group.onDidCloseEditor(() => {
			editorCloseCounter1++;
		});

		let editorWillCloseCounter = 0;
		const editorWillCloseListener = group.onWillCloseEditor(() => {
			editorWillCloseCounter++;
		});

		let editorDidCloseCounter = 0;
		const editorDidCloseListener = group.onDidCloseEditor(() => {
			editorDidCloseCounter++;
		});

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputInactive, { inactive: true });

		assert.strictEqual(group.isActive(input), true);
		assert.strictEqual(group.isActive(inputInactive), false);
		assert.strictEqual(group.contains(input), true);
		assert.strictEqual(group.contains(inputInactive), true);
		assert.strictEqual(group.isEmpty, false);
		assert.strictEqual(group.count, 2);
		assert.strictEqual(editorCapabilitiesCounter, 0);
		assert.strictEqual(editorDidOpenCounter, 2);
		assert.strictEqual((editorOpenEvents[0] as IGroupEditorOpenEvent).editorIndex, 0);
		assert.strictEqual((editorOpenEvents[1] as IGroupEditorOpenEvent).editorIndex, 1);
		assert.strictEqual(editorOpenEvents[0].editor, input);
		assert.strictEqual(editorOpenEvents[1].editor, inputInactive);
		assert.strictEqual(activeEditorChangeCounter, 1);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);
		assert.strictEqual(group.getIndexOfEditor(input), 0);
		assert.strictEqual(group.getIndexOfEditor(inputInactive), 1);
		assert.strictEqual(group.isFirst(input), true);
		assert.strictEqual(group.isFirst(inputInactive), false);
		assert.strictEqual(group.isLast(input), false);
		assert.strictEqual(group.isLast(inputInactive), true);

		input.capabilities = EditorInputCapabilities.RequiresTrust;
		assert.strictEqual(editorCapabilitiesCounter, 1);

		inputInactive.capabilities = EditorInputCapabilities.Singleton;
		assert.strictEqual(editorCapabilitiesCounter, 2);

		assert.strictEqual(group.previewEditor, inputInactive);
		assert.strictEqual(group.isPinned(inputInactive), false);
		group.pinEditor(inputInactive);
		assert.strictEqual(editorPinCounter, 1);
		assert.strictEqual(group.isPinned(inputInactive), true);
		assert.ok(!group.previewEditor);

		assert.strictEqual(group.activeEditor, input);
		assert.strictEqual(group.activeEditorPane?.getId(), TEST_EDITOR_ID);
		assert.strictEqual(group.count, 2);

		const mru = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru[0], input);
		assert.strictEqual(mru[1], inputInactive);

		await group.openEditor(inputInactive);
		assert.strictEqual(activeEditorChangeCounter, 2);
		assert.strictEqual(group.activeEditor, inputInactive);

		await group.openEditor(input);
		const closed = await group.closeEditor(inputInactive);
		assert.strictEqual(closed, true);

		assert.strictEqual(activeEditorChangeCounter, 3);
		assert.strictEqual(editorCloseCounter, 1);
		assert.strictEqual((editorCloseEvents[0] as IGroupEditorOpenEvent).editorIndex, 1);
		assert.strictEqual(editorCloseEvents[0].editor, inputInactive);
		assert.strictEqual(editorCloseCounter1, 1);
		assert.strictEqual(editorWillCloseCounter, 1);
		assert.strictEqual(editorDidCloseCounter, 1);

		assert.ok(inputInactive.gotDisposed);

		assert.strictEqual(group.activeEditor, input);

		assert.strictEqual(editorStickyCounter, 0);
		group.stickEditor(input);
		assert.strictEqual(editorStickyCounter, 1);
		group.unstickEditor(input);
		assert.strictEqual(editorStickyCounter, 2);

		editorCloseListener.dispose();
		editorWillCloseListener.dispose();
		editorDidCloseListener.dispose();
		activeEditorChangeListener.dispose();
		editorGroupModelChangeListener.dispose();
	});

	test('openEditors / closeEditors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input, options: { pinned: true } },
			{ editor: inputInactive }
		]);

		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);

		await group.closeEditors([input, inputInactive]);

		assert.ok(input.gotDisposed);
		assert.ok(inputInactive.gotDisposed);

		assert.strictEqual(group.isEmpty, true);
	});

	test('closeEditor - dirty editor handling', async () => {
		const [part, instantiationService] = await createPart();

		const accessor = instantiationService.createInstance(TestServiceAccessor);
		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);

		const group = part.activeGroup;

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		input.dirty = true;

		await group.openEditor(input);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		let closed = await group.closeEditor(input);
		assert.strictEqual(closed, false);

		assert.ok(!input.gotDisposed);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		closed = await group.closeEditor(input);
		assert.strictEqual(closed, true);

		assert.ok(input.gotDisposed);
	});

	test('closeEditor (one, opened in multiple groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }]);
		await rightGroup.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }]);

		let closed = await rightGroup.closeEditor(input);
		assert.strictEqual(closed, true);

		assert.ok(!input.gotDisposed);

		closed = await group.closeEditor(input);
		assert.strictEqual(closed, true);

		assert.ok(input.gotDisposed);
	});

	test('closeEditor - cannot close editor handling', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input = createCannotCloseTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input);

		const closed = await group.closeEditor(input);
		assert.strictEqual(closed, false);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.activeEditor, input);
		assert.ok(!input.gotDisposed);

		const forceClosed = await group.closeEditor(input, { force: true });
		assert.strictEqual(forceClosed, true);
		assert.strictEqual(group.isEmpty, true);
		assert.ok(input.gotDisposed);
	});

	test('closeEditors - dirty editor handling', async () => {
		const [part, instantiationService] = await createPart();

		const accessor = instantiationService.createInstance(TestServiceAccessor);
		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		let closeResult = false;

		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		input1.dirty = true;

		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input1);
		await group.openEditor(input2);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		closeResult = await group.closeEditors([input1, input2]);
		assert.strictEqual(closeResult, false);

		assert.ok(!input1.gotDisposed);
		assert.ok(!input2.gotDisposed);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		closeResult = await group.closeEditors([input1, input2]);
		assert.strictEqual(closeResult, true);

		assert.ok(input1.gotDisposed);
		assert.ok(input2.gotDisposed);
	});

	test('closeEditors (except one)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ except: input2 });
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), input2);
	});

	test('closeEditors - cannot close editor handling', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createCannotCloseTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true } },
			{ editor: input2, options: { pinned: true } }
		]);

		const closeResult = await group.closeEditors([input1, input2]);
		assert.strictEqual(closeResult, true);
		assert.deepStrictEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [input2]);
		assert.ok(input1.gotDisposed);
		assert.ok(!input2.gotDisposed);

		const forceCloseResult = await group.closeEditors([input2], { force: true });
		assert.strictEqual(forceCloseResult, true);
		assert.strictEqual(group.isEmpty, true);
		assert.ok(input2.gotDisposed);
	});

	test('closeEditors (except one, sticky editor)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true, sticky: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ except: input2, excludeSticky: true });

		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);

		await group.closeEditors({ except: input2 });

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.stickyCount, 0);
		assert.strictEqual(group.getEditorByIndex(0), input2);
	});

	test('closeEditors (saved only)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ savedOnly: true });
		assert.strictEqual(group.count, 0);
	});

	test('closeEditors (saved only, sticky editor)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true, sticky: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ savedOnly: true, excludeSticky: true });

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);

		await group.closeEditors({ savedOnly: true });
		assert.strictEqual(group.count, 0);
	});

	test('closeEditors (direction: right)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ direction: CloseDirection.RIGHT, except: input2 });
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
	});

	test('closeEditors (direction: right, sticky editor)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true, sticky: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ direction: CloseDirection.RIGHT, except: input2, excludeSticky: true });
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);

		await group.closeEditors({ direction: CloseDirection.RIGHT, except: input2 });
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
	});

	test('closeEditors (direction: left)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ direction: CloseDirection.LEFT, except: input2 });
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input2);
		assert.strictEqual(group.getEditorByIndex(1), input3);
	});

	test('closeEditors (direction: left, sticky editor)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true, sticky: true } },
			{ editor: input2, options: { pinned: true } },
			{ editor: input3 }
		]);

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ direction: CloseDirection.LEFT, except: input2, excludeSticky: true });
		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);

		await group.closeEditors({ direction: CloseDirection.LEFT, except: input2 });
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input2);
		assert.strictEqual(group.getEditorByIndex(1), input3);
	});

	test('closeAllEditors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input, options: { pinned: true } },
			{ editor: inputInactive }
		]);

		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);

		await group.closeAllEditors();
		assert.strictEqual(group.isEmpty, true);
	});

	test('closeAllEditors - dirty editor handling', async () => {
		const [part, instantiationService] = await createPart();
		let closeResult = true;

		const accessor = instantiationService.createInstance(TestServiceAccessor);
		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);

		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		input1.dirty = true;

		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input1);
		await group.openEditor(input2);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		closeResult = await group.closeAllEditors();

		assert.strictEqual(closeResult, false);
		assert.ok(!input1.gotDisposed);
		assert.ok(!input2.gotDisposed);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		closeResult = await group.closeAllEditors();

		assert.strictEqual(closeResult, true);
		assert.ok(input1.gotDisposed);
		assert.ok(input2.gotDisposed);
	});

	test('closeAllEditors (sticky editor)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input, options: { pinned: true, sticky: true } },
			{ editor: inputInactive }
		]);

		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.stickyCount, 1);

		await group.closeAllEditors({ excludeSticky: true });

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditorByIndex(0), input);

		await group.closeAllEditors();

		assert.strictEqual(group.isEmpty, true);
	});

	test('closeAllEditors - cannot close editor handling', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createCannotCloseTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([
			{ editor: input1, options: { pinned: true } },
			{ editor: input2, options: { pinned: true } }
		]);

		const closeResult = await group.closeAllEditors();
		assert.strictEqual(closeResult, true);
		assert.deepStrictEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [input2]);
		assert.ok(input1.gotDisposed);
		assert.ok(!input2.gotDisposed);
	});

	test('closeAllEditors - force closes cannot close editors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input = createCannotCloseTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input);

		const closeResult = await group.closeAllEditors({ force: true });
		assert.strictEqual(closeResult, true);
		assert.strictEqual(group.isEmpty, true);
		assert.ok(input.gotDisposed);
	});

	test('moveEditor (same group)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		const moveEvents: IGroupModelChangeEvent[] = [];
		const editorGroupModelChangeListener = group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.EDITOR_MOVE) {
				assert.ok(e.editor);
				moveEvents.push(e);
			}
		});

		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }]);
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);
		group.moveEditor(inputInactive, group, { index: 0 });
		assert.strictEqual(moveEvents.length, 1);
		assert.strictEqual((moveEvents[0] as IGroupEditorOpenEvent).editorIndex, 0);
		assert.strictEqual((moveEvents[0] as IGroupEditorMoveEvent).oldEditorIndex, 1);
		assert.strictEqual(moveEvents[0].editor, inputInactive);
		assert.strictEqual(group.getEditorByIndex(0), inputInactive);
		assert.strictEqual(group.getEditorByIndex(1), input);

		const res = group.moveEditors([{ editor: inputInactive, options: { index: 1 } }], group);
		assert.strictEqual(res, true);
		assert.strictEqual(moveEvents.length, 2);
		assert.strictEqual((moveEvents[1] as IGroupEditorOpenEvent).editorIndex, 1);
		assert.strictEqual((moveEvents[1] as IGroupEditorMoveEvent).oldEditorIndex, 0);
		assert.strictEqual(moveEvents[1].editor, inputInactive);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);

		editorGroupModelChangeListener.dispose();
	});

	test('moveEditor (across groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }]);
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);
		group.moveEditor(inputInactive, rightGroup, { index: 0 });
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(rightGroup.count, 1);
		assert.strictEqual(rightGroup.getEditorByIndex(0), inputInactive);
	});

	test('moveEditors (across groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([{ editor: input1, options: { pinned: true } }, { editor: input2, options: { pinned: true } }, { editor: input3, options: { pinned: true } }]);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);
		group.moveEditors([{ editor: input2 }, { editor: input3 }], rightGroup);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(rightGroup.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(rightGroup.getEditorByIndex(0), input2);
		assert.strictEqual(rightGroup.getEditorByIndex(1), input3);
	});

	test('copyEditor (across groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }]);
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);
		group.copyEditor(inputInactive, rightGroup, { index: 0 });
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.getEditorByIndex(0), input);
		assert.strictEqual(group.getEditorByIndex(1), inputInactive);
		assert.strictEqual(rightGroup.count, 1);
		assert.strictEqual(rightGroup.getEditorByIndex(0), inputInactive);
	});

	test('copyEditors (across groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([{ editor: input1, options: { pinned: true } }, { editor: input2, options: { pinned: true } }, { editor: input3, options: { pinned: true } }]);
		assert.strictEqual(group.getEditorByIndex(0), input1);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input3);
		group.copyEditors([{ editor: input1 }, { editor: input2 }, { editor: input3 }], rightGroup);
		[group, rightGroup].forEach(group => {
			assert.strictEqual(group.getEditorByIndex(0), input1);
			assert.strictEqual(group.getEditorByIndex(1), input2);
			assert.strictEqual(group.getEditorByIndex(2), input3);
		});
	});

	test('replaceEditors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), input);

		await group.replaceEditors([{ editor: input, replacement: inputInactive }]);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), inputInactive);
	});

	test('replaceEditors - dirty editor handling', async () => {
		const [part, instantiationService] = await createPart();

		const accessor = instantiationService.createInstance(TestServiceAccessor);
		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);

		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		input1.dirty = true;

		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input1);
		assert.strictEqual(group.activeEditor, input1);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		await group.replaceEditors([{ editor: input1, replacement: input2 }]);

		assert.strictEqual(group.activeEditor, input1);
		assert.ok(!input1.gotDisposed);

		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		await group.replaceEditors([{ editor: input1, replacement: input2 }]);

		assert.strictEqual(group.activeEditor, input2);
		assert.ok(input1.gotDisposed);
	});

	test('replaceEditors - forceReplaceDirty flag', async () => {
		const [part, instantiationService] = await createPart();

		const accessor = instantiationService.createInstance(TestServiceAccessor);
		accessor.fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);

		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		input1.dirty = true;

		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input1);
		assert.strictEqual(group.activeEditor, input1);
		accessor.fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		await group.replaceEditors([{ editor: input1, replacement: input2, forceReplaceDirty: false }]);

		assert.strictEqual(group.activeEditor, input1);
		assert.ok(!input1.gotDisposed);

		await group.replaceEditors([{ editor: input1, replacement: input2, forceReplaceDirty: true }]);

		assert.strictEqual(group.activeEditor, input2);
		assert.ok(input1.gotDisposed);
	});

	test('replaceEditors - proper index handling', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);
		const input4 = createTestFileEditorInput(URI.file('foo/bar4'), TEST_EDITOR_INPUT_ID);
		const input5 = createTestFileEditorInput(URI.file('foo/bar5'), TEST_EDITOR_INPUT_ID);

		const input6 = createTestFileEditorInput(URI.file('foo/bar6'), TEST_EDITOR_INPUT_ID);
		const input7 = createTestFileEditorInput(URI.file('foo/bar7'), TEST_EDITOR_INPUT_ID);
		const input8 = createTestFileEditorInput(URI.file('foo/bar8'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input1, { pinned: true });
		await group.openEditor(input2, { pinned: true });
		await group.openEditor(input3, { pinned: true });
		await group.openEditor(input4, { pinned: true });
		await group.openEditor(input5, { pinned: true });

		await group.replaceEditors([
			{ editor: input1, replacement: input6 },
			{ editor: input3, replacement: input7 },
			{ editor: input5, replacement: input8 }
		]);

		assert.strictEqual(group.getEditorByIndex(0), input6);
		assert.strictEqual(group.getEditorByIndex(1), input2);
		assert.strictEqual(group.getEditorByIndex(2), input7);
		assert.strictEqual(group.getEditorByIndex(3), input4);
		assert.strictEqual(group.getEditorByIndex(4), input8);
	});

	test('replaceEditors - should be able to replace when side by side editor is involved with same input side by side', async () => {
		const [part, instantiationService] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const sideBySideInput = instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, input, input);

		await group.openEditor(input);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), input);

		await group.replaceEditors([{ editor: input, replacement: sideBySideInput }]);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), sideBySideInput);

		await group.replaceEditors([{ editor: sideBySideInput, replacement: input }]);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditorByIndex(0), input);
	});

	test('replaceEditors - cannot close editor handling', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input = createCannotCloseTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const replacement = createTestFileEditorInput(URI.file('foo/baz'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input);
		await group.replaceEditors([{ editor: input, replacement }]);

		assert.deepStrictEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [replacement]);
		assert.ok(input.gotDisposed);
	});

	test('find editors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		const group2 = part.addGroup(group, GroupDirection.RIGHT);
		assert.strictEqual(group.isEmpty, true);

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar1'), `${TEST_EDITOR_INPUT_ID}-1`);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);
		const input4 = createTestFileEditorInput(URI.file('foo/bar4'), TEST_EDITOR_INPUT_ID);
		const input5 = createTestFileEditorInput(URI.file('foo/bar4'), `${TEST_EDITOR_INPUT_ID}-1`);

		await group.openEditor(input1, { pinned: true });
		await group.openEditor(input2, { pinned: true });
		await group.openEditor(input3, { pinned: true });
		await group.openEditor(input4, { pinned: true });
		await group2.openEditor(input5, { pinned: true });

		let foundEditors = group.findEditors(URI.file('foo/bar1'));
		assert.strictEqual(foundEditors.length, 2);
		foundEditors = group2.findEditors(URI.file('foo/bar4'));
		assert.strictEqual(foundEditors.length, 1);
	});

	test('find editors (side by side support)', async () => {
		const [part, instantiationService] = await createPart();

		const accessor = instantiationService.createInstance(TestServiceAccessor);

		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const secondaryInput = createTestFileEditorInput(URI.file('foo/bar-secondary'), TEST_EDITOR_INPUT_ID);
		const primaryInput = createTestFileEditorInput(URI.file('foo/bar-primary'), `${TEST_EDITOR_INPUT_ID}-1`);

		const sideBySideEditor = new SideBySideEditorInput(undefined, undefined, secondaryInput, primaryInput, accessor.editorService);
		await group.openEditor(sideBySideEditor, { pinned: true });

		let foundEditors = group.findEditors(URI.file('foo/bar-secondary'));
		assert.strictEqual(foundEditors.length, 0);

		foundEditors = group.findEditors(URI.file('foo/bar-secondary'), { supportSideBySide: SideBySideEditor.PRIMARY });
		assert.strictEqual(foundEditors.length, 0);

		foundEditors = group.findEditors(URI.file('foo/bar-primary'), { supportSideBySide: SideBySideEditor.PRIMARY });
		assert.strictEqual(foundEditors.length, 1);

		foundEditors = group.findEditors(URI.file('foo/bar-secondary'), { supportSideBySide: SideBySideEditor.SECONDARY });
		assert.strictEqual(foundEditors.length, 1);

		foundEditors = group.findEditors(URI.file('foo/bar-primary'), { supportSideBySide: SideBySideEditor.SECONDARY });
		assert.strictEqual(foundEditors.length, 0);

		foundEditors = group.findEditors(URI.file('foo/bar-secondary'), { supportSideBySide: SideBySideEditor.ANY });
		assert.strictEqual(foundEditors.length, 1);

		foundEditors = group.findEditors(URI.file('foo/bar-primary'), { supportSideBySide: SideBySideEditor.ANY });
		assert.strictEqual(foundEditors.length, 1);
	});

	test('find neighbour group (left/right)', async function () {
		const [part] = await createPart();
		const rootGroup = part.activeGroup;
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);

		assert.strictEqual(rightGroup, part.findGroup({ direction: GroupDirection.RIGHT }, rootGroup));
		assert.strictEqual(rootGroup, part.findGroup({ direction: GroupDirection.LEFT }, rightGroup));
	});

	test('find neighbour group (up/down)', async function () {
		const [part] = await createPart();
		const rootGroup = part.activeGroup;
		const downGroup = part.addGroup(rootGroup, GroupDirection.DOWN);

		assert.strictEqual(downGroup, part.findGroup({ direction: GroupDirection.DOWN }, rootGroup));
		assert.strictEqual(rootGroup, part.findGroup({ direction: GroupDirection.UP }, downGroup));
	});

	test('find group by location (left/right)', async function () {
		const [part] = await createPart();
		const rootGroup = part.activeGroup;
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		const downGroup = part.addGroup(rightGroup, GroupDirection.DOWN);

		assert.strictEqual(rootGroup, part.findGroup({ location: GroupLocation.FIRST }));
		assert.strictEqual(downGroup, part.findGroup({ location: GroupLocation.LAST }));

		assert.strictEqual(rightGroup, part.findGroup({ location: GroupLocation.NEXT }, rootGroup));
		assert.strictEqual(rootGroup, part.findGroup({ location: GroupLocation.PREVIOUS }, rightGroup));

		assert.strictEqual(downGroup, part.findGroup({ location: GroupLocation.NEXT }, rightGroup));
		assert.strictEqual(rightGroup, part.findGroup({ location: GroupLocation.PREVIOUS }, downGroup));
	});

	test('applyLayout (2x2)', async function () {
		const [part] = await createPart();

		part.applyLayout({ groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }], orientation: GroupOrientation.HORIZONTAL });

		assert.strictEqual(part.groups.length, 4);
	});

	test('getLayout', async function () {
		const [part] = await createPart();

		// 2x2
		part.applyLayout({ groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }], orientation: GroupOrientation.HORIZONTAL });
		let layout = part.getLayout();

		assert.strictEqual(layout.orientation, GroupOrientation.HORIZONTAL);
		assert.strictEqual(layout.groups.length, 2);
		assert.strictEqual(layout.groups[0].groups!.length, 2);
		assert.strictEqual(layout.groups[1].groups!.length, 2);

		// 3 columns
		part.applyLayout({ groups: [{}, {}, {}], orientation: GroupOrientation.VERTICAL });
		layout = part.getLayout();

		assert.strictEqual(layout.orientation, GroupOrientation.VERTICAL);
		assert.strictEqual(layout.groups.length, 3);
		assert.ok(typeof layout.groups[0].size === 'number');
		assert.ok(typeof layout.groups[1].size === 'number');
		assert.ok(typeof layout.groups[2].size === 'number');
	});

	test('centeredLayout', async function () {
		const [part] = await createPart();

		part.centerLayout(true);

		assert.strictEqual(part.isLayoutCentered(), true);
	});

	test('sticky editors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		assert.strictEqual(group.stickyCount, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL).length, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true }).length, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 0);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputInactive, { inactive: true });

		assert.strictEqual(group.stickyCount, 0);
		assert.strictEqual(group.isSticky(input), false);
		assert.strictEqual(group.isSticky(inputInactive), false);

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true }).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 2);

		group.stickEditor(input);

		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.isSticky(input), true);
		assert.strictEqual(group.isSticky(inputInactive), false);

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true }).length, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 1);

		group.unstickEditor(input);

		assert.strictEqual(group.stickyCount, 0);
		assert.strictEqual(group.isSticky(input), false);
		assert.strictEqual(group.isSticky(inputInactive), false);

		assert.strictEqual(group.getIndexOfEditor(input), 0);
		assert.strictEqual(group.getIndexOfEditor(inputInactive), 1);

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true }).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 2);

		let editorMoveCounter = 0;
		const editorGroupModelChangeListener = group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.EDITOR_MOVE) {
				assert.ok(e.editor);
				editorMoveCounter++;
			}
		});

		group.stickEditor(inputInactive);

		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.isSticky(input), false);
		assert.strictEqual(group.isSticky(inputInactive), true);

		assert.strictEqual(group.getIndexOfEditor(input), 1);
		assert.strictEqual(group.getIndexOfEditor(inputInactive), 0);
		assert.strictEqual(editorMoveCounter, 1);

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true }).length, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 1);

		const inputSticky = createTestFileEditorInput(URI.file('foo/bar/sticky'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(inputSticky, { sticky: true });

		assert.strictEqual(group.stickyCount, 2);
		assert.strictEqual(group.isSticky(input), false);
		assert.strictEqual(group.isSticky(inputInactive), true);
		assert.strictEqual(group.isSticky(inputSticky), true);

		assert.strictEqual(group.getIndexOfEditor(inputInactive), 0);
		assert.strictEqual(group.getIndexOfEditor(inputSticky), 1);
		assert.strictEqual(group.getIndexOfEditor(input), 2);

		await group.openEditor(input, { sticky: true });

		assert.strictEqual(group.stickyCount, 3);
		assert.strictEqual(group.isSticky(input), true);
		assert.strictEqual(group.isSticky(inputInactive), true);
		assert.strictEqual(group.isSticky(inputSticky), true);

		assert.strictEqual(group.getIndexOfEditor(inputInactive), 0);
		assert.strictEqual(group.getIndexOfEditor(inputSticky), 1);
		assert.strictEqual(group.getIndexOfEditor(input), 2);

		editorGroupModelChangeListener.dispose();
	});

	test('sticky: true wins over index', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		assert.strictEqual(group.stickyCount, 0);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);
		const inputSticky = createTestFileEditorInput(URI.file('foo/bar/sticky'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputInactive, { inactive: true });
		await group.openEditor(inputSticky, { sticky: true, index: 2 });

		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.isSticky(inputSticky), true);

		assert.strictEqual(group.getIndexOfEditor(input), 1);
		assert.strictEqual(group.getIndexOfEditor(inputInactive), 2);
		assert.strictEqual(group.getIndexOfEditor(inputSticky), 0);
	});

	test('selection: setSelection, isSelected, selectedEditors', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		function isSelection(inputs: TestFileEditorInput[]): boolean {
			for (const input of inputs) {
				if (group.selectedEditors.indexOf(input) === -1) {
					return false;
				}
			}
			return inputs.length === group.selectedEditors.length;
		}

		// Active: input1, Selected: input1
		await group.openEditors([input1, input2, input3].map(editor => ({ editor, options: { pinned: true } })));

		assert.strictEqual(group.isActive(input1), true);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input2), false);
		assert.strictEqual(group.isSelected(input3), false);

		assert.strictEqual(isSelection([input1]), true);

		// Active: input1, Selected: input1, input3
		await group.setSelection(input1, [input3]);

		assert.strictEqual(group.isActive(input1), true);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input2), false);
		assert.strictEqual(group.isSelected(input3), true);

		assert.strictEqual(isSelection([input1, input3]), true);

		// Active: input2, Selected: input1, input3
		await group.setSelection(input2, [input1, input3]);

		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isActive(input2), true);
		assert.strictEqual(group.isSelected(input2), true);
		assert.strictEqual(group.isSelected(input3), true);

		assert.strictEqual(isSelection([input1, input2, input3]), true);

		await group.setSelection(input1, []);

		// Selected: input3
		assert.strictEqual(group.isActive(input1), true);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input2), false);
		assert.strictEqual(group.isSelected(input3), false);

		assert.strictEqual(isSelection([input1]), true);
	});

	test('moveEditor with context (across groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);
		const thirdInput = createTestFileEditorInput(URI.file('foo/bar/third'), TEST_EDITOR_INPUT_ID);

		let leftFiredCount = 0;
		const leftGroupListener = group.onWillMoveEditor(() => {
			leftFiredCount++;
		});

		let rightFiredCount = 0;
		const rightGroupListener = rightGroup.onWillMoveEditor(() => {
			rightFiredCount++;
		});

		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }, { editor: thirdInput }]);
		assert.strictEqual(leftFiredCount, 0);
		assert.strictEqual(rightFiredCount, 0);

		let result = group.moveEditor(input, rightGroup);
		assert.strictEqual(result, true);
		assert.strictEqual(leftFiredCount, 1);
		assert.strictEqual(rightFiredCount, 0);

		result = group.moveEditor(inputInactive, rightGroup);
		assert.strictEqual(result, true);
		assert.strictEqual(leftFiredCount, 2);
		assert.strictEqual(rightFiredCount, 0);

		result = rightGroup.moveEditor(inputInactive, group);
		assert.strictEqual(result, true);
		assert.strictEqual(leftFiredCount, 2);
		assert.strictEqual(rightFiredCount, 1);

		leftGroupListener.dispose();
		rightGroupListener.dispose();
	});

	test('moveEditor disabled', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);
		const thirdInput = createTestFileEditorInput(URI.file('foo/bar/third'), TEST_EDITOR_INPUT_ID);

		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }, { editor: thirdInput }]);

		input.setMoveDisabled('disabled');
		const result = group.moveEditor(input, rightGroup);

		assert.strictEqual(result, false);
		assert.strictEqual(group.count, 3);
	});

	test('onWillOpenEditor', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const secondInput = createTestFileEditorInput(URI.file('foo/bar/second'), TEST_EDITOR_INPUT_ID);
		const thirdInput = createTestFileEditorInput(URI.file('foo/bar/third'), TEST_EDITOR_INPUT_ID);

		let leftFiredCount = 0;
		const leftGroupListener = group.onWillOpenEditor(() => {
			leftFiredCount++;
		});

		let rightFiredCount = 0;
		const rightGroupListener = rightGroup.onWillOpenEditor(() => {
			rightFiredCount++;
		});

		await group.openEditor(input);
		assert.strictEqual(leftFiredCount, 1);
		assert.strictEqual(rightFiredCount, 0);

		rightGroup.openEditor(secondInput);
		assert.strictEqual(leftFiredCount, 1);
		assert.strictEqual(rightFiredCount, 1);

		group.openEditor(thirdInput);
		assert.strictEqual(leftFiredCount, 2);
		assert.strictEqual(rightFiredCount, 1);

		// Ensure move fires the open event too
		rightGroup.moveEditor(secondInput, group);
		assert.strictEqual(leftFiredCount, 3);
		assert.strictEqual(rightFiredCount, 1);

		leftGroupListener.dispose();
		rightGroupListener.dispose();
	});

	test('copyEditor with context (across groups)', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);
		let firedCount = 0;
		const moveListener = group.onWillMoveEditor(() => firedCount++);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);
		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputInactive = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);
		await group.openEditors([{ editor: input, options: { pinned: true } }, { editor: inputInactive }]);
		assert.strictEqual(firedCount, 0);

		group.copyEditor(inputInactive, rightGroup, { index: 0 });

		assert.strictEqual(firedCount, 0);
		moveListener.dispose();
	});

	test('locked groups - basics', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);

		let leftFiredCountFromPart = 0;
		let rightFiredCountFromPart = 0;
		const partListener = part.onDidChangeGroupLocked(g => {
			if (g === group) {
				leftFiredCountFromPart++;
			} else if (g === rightGroup) {
				rightFiredCountFromPart++;
			}
		});

		let leftFiredCountFromGroup = 0;
		const leftGroupListener = group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_LOCKED) {
				leftFiredCountFromGroup++;
			}
		});

		let rightFiredCountFromGroup = 0;
		const rightGroupListener = rightGroup.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_LOCKED) {
				rightFiredCountFromGroup++;
			}
		});

		rightGroup.lock(true);
		rightGroup.lock(true);

		assert.strictEqual(leftFiredCountFromGroup, 0);
		assert.strictEqual(leftFiredCountFromPart, 0);
		assert.strictEqual(rightFiredCountFromGroup, 1);
		assert.strictEqual(rightFiredCountFromPart, 1);

		rightGroup.lock(false);
		rightGroup.lock(false);

		assert.strictEqual(leftFiredCountFromGroup, 0);
		assert.strictEqual(leftFiredCountFromPart, 0);
		assert.strictEqual(rightFiredCountFromGroup, 2);
		assert.strictEqual(rightFiredCountFromPart, 2);

		group.lock(true);
		group.lock(true);

		assert.strictEqual(leftFiredCountFromGroup, 1);
		assert.strictEqual(leftFiredCountFromPart, 1);
		assert.strictEqual(rightFiredCountFromGroup, 2);
		assert.strictEqual(rightFiredCountFromPart, 2);

		group.lock(false);
		group.lock(false);

		assert.strictEqual(leftFiredCountFromGroup, 2);
		assert.strictEqual(leftFiredCountFromPart, 2);
		assert.strictEqual(rightFiredCountFromGroup, 2);
		assert.strictEqual(rightFiredCountFromPart, 2);

		partListener.dispose();
		leftGroupListener.dispose();
		rightGroupListener.dispose();
	});

	test('locked groups - single group is can be locked', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		group.lock(true);
		assert.strictEqual(group.isLocked, true);

		const rightGroup = part.addGroup(group, GroupDirection.RIGHT);
		rightGroup.lock(true);

		assert.strictEqual(rightGroup.isLocked, true);

		part.removeGroup(group);
		assert.strictEqual(rightGroup.isLocked, true);

		const rightGroup2 = part.addGroup(rightGroup, GroupDirection.RIGHT);
		rightGroup.lock(true);
		rightGroup2.lock(true);

		assert.strictEqual(rightGroup.isLocked, true);
		assert.strictEqual(rightGroup2.isLocked, true);

		part.removeGroup(rightGroup2);

		assert.strictEqual(rightGroup.isLocked, true);
	});

	test('closeAllGroups action - cannot close editor handling', async () => {
		const [part, instantiationService] = await createPart();
		const rootGroup = part.activeGroup;
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);

		const rootInput = createTestFileEditorInput(URI.file('foo/root'), TEST_EDITOR_INPUT_ID);
		const rightInput = createCannotCloseTestFileEditorInput(URI.file('foo/right'), TEST_EDITOR_INPUT_ID);

		await rootGroup.openEditor(rootInput);
		await rightGroup.openEditor(rightInput);

		await instantiationService.invokeFunction(accessor => new CloseAllEditorGroupsAction().run(accessor));

		assert.strictEqual(part.count, 1);
		assert.strictEqual(part.activeGroup, rightGroup);
		assert.deepStrictEqual(rightGroup.getEditors(EditorsOrder.SEQUENTIAL), [rightInput]);
		assert.ok(rootInput.gotDisposed);
		assert.ok(!rightInput.gotDisposed);
	});

	test('locked groups - auto locking via setting', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('workbench', { 'editor': { 'autoLockGroups': { 'testEditorInputForEditorGroupService': true } } });
		instantiationService.stub(IConfigurationService, configurationService);

		const [part] = await createPart(instantiationService);

		const rootGroup = part.activeGroup;
		let rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);

		let input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		let input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		// First editor opens in right group: Locked=true
		await rightGroup.openEditor(input1, { pinned: true });
		assert.strictEqual(rightGroup.isLocked, true);

		// Second editors opens in now unlocked right group: Locked=false
		rightGroup.lock(false);
		await rightGroup.openEditor(input2, { pinned: true });
		assert.strictEqual(rightGroup.isLocked, false);

		//First editor opens in root group without other groups being opened: Locked=false
		await rightGroup.closeAllEditors();
		part.removeGroup(rightGroup);
		await rootGroup.closeAllEditors();

		input1 = createTestFileEditorInput(URI.file('foo/bar1'), TEST_EDITOR_INPUT_ID);
		input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await rootGroup.openEditor(input1, { pinned: true });
		assert.strictEqual(rootGroup.isLocked, false);
		rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		assert.strictEqual(rootGroup.isLocked, false);
		const leftGroup = part.addGroup(rootGroup, GroupDirection.LEFT);
		assert.strictEqual(rootGroup.isLocked, false);
		part.removeGroup(leftGroup);
		assert.strictEqual(rootGroup.isLocked, false);
	});

	test('maximize editor group', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const [part] = await createPart(instantiationService);

		const rootGroup = part.activeGroup;
		const editorPartSize = part.getSize(rootGroup);

		// If there is only one group, it should not be considered maximized
		assert.strictEqual(part.hasMaximizedGroup(), false);

		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);
		const rightBottomGroup = part.addGroup(rightGroup, GroupDirection.DOWN);

		const sizeRootGroup = part.getSize(rootGroup);
		const sizeRightGroup = part.getSize(rightGroup);
		const sizeRightBottomGroup = part.getSize(rightBottomGroup);

		let maximizedValue;
		const maxiizeGroupEventDisposable = part.onDidChangeGroupMaximized((maximized) => {
			maximizedValue = maximized;
		});

		assert.strictEqual(part.hasMaximizedGroup(), false);

		part.arrangeGroups(GroupsArrangement.MAXIMIZE, rootGroup);

		assert.strictEqual(part.hasMaximizedGroup(), true);

		// getSize()
		assert.deepStrictEqual(part.getSize(rootGroup), editorPartSize);
		assert.deepStrictEqual(part.getSize(rightGroup), { width: 0, height: 0 });
		assert.deepStrictEqual(part.getSize(rightBottomGroup), { width: 0, height: 0 });

		assert.deepStrictEqual(maximizedValue, true);

		part.toggleMaximizeGroup();

		assert.strictEqual(part.hasMaximizedGroup(), false);

		// Size is restored
		assert.deepStrictEqual(part.getSize(rootGroup), sizeRootGroup);
		assert.deepStrictEqual(part.getSize(rightGroup), sizeRightGroup);
		assert.deepStrictEqual(part.getSize(rightBottomGroup), sizeRightBottomGroup);

		assert.deepStrictEqual(maximizedValue, false);
		maxiizeGroupEventDisposable.dispose();
	});

	test('transient editors - basics', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputTransient = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputTransient, { transient: true });

		assert.strictEqual(group.isTransient(input), false);
		assert.strictEqual(group.isTransient(inputTransient), true);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputTransient, { transient: true });

		assert.strictEqual(group.isTransient(inputTransient), true);

		await group.openEditor(inputTransient, { transient: false });
		assert.strictEqual(group.isTransient(inputTransient), false);

		await group.openEditor(inputTransient, { transient: true });
		assert.strictEqual(group.isTransient(inputTransient), false); // cannot make a non-transient editor transient when already opened
	});

	test('transient editors - pinning clears transient', async () => {
		const [part] = await createPart();
		const group = part.activeGroup;

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const inputTransient = createTestFileEditorInput(URI.file('foo/bar/inactive'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputTransient, { transient: true });

		assert.strictEqual(group.isTransient(input), false);
		assert.strictEqual(group.isTransient(inputTransient), true);

		await group.openEditor(input, { pinned: true });
		await group.openEditor(inputTransient, { pinned: true, transient: true });

		assert.strictEqual(group.isTransient(inputTransient), false);
	});

	test('transient editors - overrides enablePreview setting', async function () {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('workbench', { 'editor': { 'enablePreview': false } });
		instantiationService.stub(IConfigurationService, configurationService);

		const [part] = await createPart(instantiationService);

		const group = part.activeGroup;
		assert.strictEqual(group.isEmpty, true);

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await group.openEditor(input, { pinned: false });
		assert.strictEqual(group.isPinned(input), true);

		await group.openEditor(input2, { transient: true });
		assert.strictEqual(group.isPinned(input2), false);

		group.focus();
		assert.strictEqual(group.isPinned(input2), true);
	});

	test('working sets - create / apply state', async function () {
		const [part] = await createPart();

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		const pane1 = await part.activeGroup.openEditor(input, { pinned: true });
		const pane2 = await part.sideGroup.openEditor(input2, { pinned: true });

		const state = part.createState();

		await pane2?.group.closeAllEditors();
		await pane1?.group.closeAllEditors();

		assert.strictEqual(part.count, 1);
		assert.strictEqual(part.activeGroup.isEmpty, true);

		await part.applyState(state);

		assert.strictEqual(part.count, 2);

		assert.strictEqual(part.groups[0].contains(input), true);
		assert.strictEqual(part.groups[1].contains(input2), true);

		for (const group of part.groups) {
			await group.closeAllEditors();
		}

		const emptyState = part.createState();

		await part.applyState(emptyState);
		assert.strictEqual(part.count, 1);

		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);
		input3.dirty = true;
		await part.activeGroup.openEditor(input3, { pinned: true });

		await part.applyState(emptyState);

		assert.strictEqual(part.count, 1);
		assert.strictEqual(part.groups[0].contains(input3), true); // dirty editors enforce to be there even when state is empty

		await part.applyState('empty');

		assert.strictEqual(part.count, 1);
		assert.strictEqual(part.groups[0].contains(input3), true); // dirty editors enforce to be there even when state is empty

		input3.dirty = false;

		await part.applyState('empty');

		assert.strictEqual(part.count, 1);
		assert.strictEqual(part.activeGroup.isEmpty, true);
	});

	test('working sets - apply state when the part has never been laid out does not throw and registers restored groups', async function () {
		const [part] = await createPart();

		const input = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		await part.activeGroup.openEditor(input, { pinned: true });
		await part.sideGroup.openEditor(input2, { pinned: true });

		const state = part.createState();

		for (const group of part.groups) {
			await group.closeAllEditors();
		}

		// Simulate an editor part that has never been laid out (e.g. it stayed
		// hidden since the window opened, like the Agents window editor area
		// after a reload with the side pane closed). In that state
		// `_contentDimension` is still undefined and laying out during the
		// restore would throw, aborting before the `onDidAddGroup` events fire.
		(part as unknown as { _contentDimension: unknown })._contentDimension = undefined;

		let addedGroups = 0;
		const listener = part.onDidAddGroup(() => addedGroups++);

		// Must not throw, must restore the groups, and must fire `onDidAddGroup`
		// for them so listeners (e.g. the editor service) register them.
		await part.applyState(state);
		listener.dispose();

		assert.strictEqual(part.count, 2);
		assert.strictEqual(part.groups[0].contains(input), true);
		assert.strictEqual(part.groups[1].contains(input2), true);
		assert.strictEqual(addedGroups, 2, `expected exactly 2 onDidAddGroup events, got ${addedGroups}`);
	});

	test('context key provider', async function () {
		const disposables = new DisposableStore();

		// Instantiate workbench and setup initial state
		const instantiationService = workbenchInstantiationService({ contextKeyService: instantiationService => instantiationService.createInstance(MockScopableContextKeyService) }, disposables);
		const rootContextKeyService = instantiationService.get(IContextKeyService);

		const [parts] = await createParts(instantiationService);

		const input1 = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);
		const input3 = createTestFileEditorInput(URI.file('foo/bar3'), TEST_EDITOR_INPUT_ID);

		const group1 = parts.activeGroup;
		const group2 = parts.addGroup(group1, GroupDirection.RIGHT);

		await group2.openEditor(input2, { pinned: true });
		await group1.openEditor(input1, { pinned: true });

		// Create context key provider
		const rawContextKey = new RawContextKey<number>('testContextKey', parts.activeGroup.id);
		const contextKeyProvider: IEditorGroupContextKeyProvider<number> = {
			contextKey: rawContextKey,
			getGroupContextKeyValue: (group) => group.id
		};
		disposables.add(parts.registerContextKeyProvider(contextKeyProvider));

		// Initial state: group1 is active
		assert.strictEqual(parts.activeGroup.id, group1.id);

		let globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		let group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		let group2ContextKeyValue = group2.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, group1.id);
		assert.strictEqual(group1ContextKeyValue, group1.id);
		assert.strictEqual(group2ContextKeyValue, group2.id);

		// Make group2 active and ensure both gloabal and local context key values are updated
		parts.activateGroup(group2);

		globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		group2ContextKeyValue = group2.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, group2.id);
		assert.strictEqual(group1ContextKeyValue, group1.id);
		assert.strictEqual(group2ContextKeyValue, group2.id);

		// Add a new group and ensure both gloabal and local context key values are updated
		// Group 3 will be active
		const group3 = parts.addGroup(group2, GroupDirection.RIGHT);
		await group3.openEditor(input3, { pinned: true });

		globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		group2ContextKeyValue = group2.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		const group3ContextKeyValue = group3.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, group3.id);
		assert.strictEqual(group1ContextKeyValue, group1.id);
		assert.strictEqual(group2ContextKeyValue, group2.id);
		assert.strictEqual(group3ContextKeyValue, group3.id);

		disposables.dispose();
	});

	test('context key provider: onDidChange', async function () {
		const disposables = new DisposableStore();

		// Instantiate workbench and setup initial state
		const instantiationService = workbenchInstantiationService({ contextKeyService: instantiationService => instantiationService.createInstance(MockScopableContextKeyService) }, disposables);
		const rootContextKeyService = instantiationService.get(IContextKeyService);

		const parts = await createEditorParts(instantiationService, disposables);

		const input1 = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		const group1 = parts.activeGroup;
		const group2 = parts.addGroup(group1, GroupDirection.RIGHT);

		await group2.openEditor(input2, { pinned: true });
		await group1.openEditor(input1, { pinned: true });

		// Create context key provider
		let offset = 0;
		const _onDidChange = new Emitter<void>();

		const rawContextKey = new RawContextKey<number>('testContextKey', parts.activeGroup.id);
		const contextKeyProvider: IEditorGroupContextKeyProvider<number> = {
			contextKey: rawContextKey,
			getGroupContextKeyValue: (group) => group.id + offset,
			onDidChange: _onDidChange.event
		};
		disposables.add(parts.registerContextKeyProvider(contextKeyProvider));

		// Initial state: group1 is active
		assert.strictEqual(parts.activeGroup.id, group1.id);

		let globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		let group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		let group2ContextKeyValue = group2.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, group1.id + offset);
		assert.strictEqual(group1ContextKeyValue, group1.id + offset);
		assert.strictEqual(group2ContextKeyValue, group2.id + offset);

		// Make a change to the context key provider and fire onDidChange such that all context key values are updated
		offset = 10;
		_onDidChange.fire();

		globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		group2ContextKeyValue = group2.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, group1.id + offset);
		assert.strictEqual(group1ContextKeyValue, group1.id + offset);
		assert.strictEqual(group2ContextKeyValue, group2.id + offset);

		disposables.dispose();
	});

	test('context key provider: active editor change', async function () {
		const disposables = new DisposableStore();

		// Instantiate workbench and setup initial state
		const instantiationService = workbenchInstantiationService({ contextKeyService: instantiationService => instantiationService.createInstance(MockScopableContextKeyService) }, disposables);
		const rootContextKeyService = instantiationService.get(IContextKeyService);

		const parts = await createEditorParts(instantiationService, disposables);

		const input1 = createTestFileEditorInput(URI.file('foo/bar'), TEST_EDITOR_INPUT_ID);
		const input2 = createTestFileEditorInput(URI.file('foo/bar2'), TEST_EDITOR_INPUT_ID);

		const group1 = parts.activeGroup;

		await group1.openEditor(input2, { pinned: true });
		await group1.openEditor(input1, { pinned: true });

		// Create context key provider
		const rawContextKey = new RawContextKey<string>('testContextKey', input1.resource.toString());
		const contextKeyProvider: IEditorGroupContextKeyProvider<string> = {
			contextKey: rawContextKey,
			getGroupContextKeyValue: (group) => group.activeEditor?.resource?.toString() ?? '',
		};
		disposables.add(parts.registerContextKeyProvider(contextKeyProvider));

		// Initial state: input1 is active
		assert.strictEqual(isEqual(group1.activeEditor?.resource, input1.resource), true);

		let globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		let group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, input1.resource.toString());
		assert.strictEqual(group1ContextKeyValue, input1.resource.toString());

		// Make input2 active and ensure both gloabal and local context key values are updated
		await group1.openEditor(input2);

		globalContextKeyValue = rootContextKeyService.getContextKeyValue(rawContextKey.key);
		group1ContextKeyValue = group1.scopedContextKeyService.getContextKeyValue(rawContextKey.key);
		assert.strictEqual(globalContextKeyValue, input2.resource.toString());
		assert.strictEqual(group1ContextKeyValue, input2.resource.toString());

		disposables.dispose();
	});

	test('onDidActivateGroup carries activation reason', async function () {
		const [part] = await createPart();

		const activationEvents: IEditorGroupActivationEvent[] = [];
		disposables.add(part.onDidActivateGroup(e => activationEvents.push(e)));

		const rootGroup = part.groups[0];
		const rightGroup = part.addGroup(rootGroup, GroupDirection.RIGHT);

		// Activate a group explicitly - should carry DEFAULT reason
		activationEvents.length = 0;
		part.activateGroup(rightGroup);
		assert.strictEqual(activationEvents.length, 1);
		assert.strictEqual(activationEvents[0].group, rightGroup);
		assert.strictEqual(activationEvents[0].reason, GroupActivationReason.DEFAULT);

		// Activate the same group again - should still fire with DEFAULT reason
		activationEvents.length = 0;
		part.activateGroup(rightGroup);
		assert.strictEqual(activationEvents.length, 1);
		assert.strictEqual(activationEvents[0].group, rightGroup);
		assert.strictEqual(activationEvents[0].reason, GroupActivationReason.DEFAULT);

		// Activate root group back
		activationEvents.length = 0;
		part.activateGroup(rootGroup);
		assert.strictEqual(activationEvents.length, 1);
		assert.strictEqual(activationEvents[0].group, rootGroup);
		assert.strictEqual(activationEvents[0].reason, GroupActivationReason.DEFAULT);
	});

	function createTabStacksInstantiationService(contextKeyService?: IContextKeyService, editorConfiguration?: object): TestInstantiationService {
		return workbenchInstantiationService({
			configurationService: () => {
				const configurationService = new TestConfigurationService({ workbench: { editor: { enableTabStacks: true, ...editorConfiguration } } });
				disposables.add(configurationService.onDidChangeConfigurationEmitter);

				return configurationService;
			},
			contextKeyService: contextKeyService ? () => contextKeyService : undefined
		}, disposables);
	}

	function createNamedTestEditors(...names: string[]): TestFileEditorInput[] {
		return names.map(name => createTestFileEditorInput(URI.file(name), TEST_EDITOR_INPUT_ID));
	}

	async function openPinnedTestEditors(group: IEditorGroup, ...names: string[]): Promise<TestFileEditorInput[]> {
		const editors = createNamedTestEditors(...names);
		for (const editor of editors) {
			await group.openEditor(editor, { pinned: true });
		}

		return editors;
	}

	/**
	 * Returns the name of the resource of the editor, which is the resource of
	 * the primary side for a side by side editor, the same as its tab shows.
	 */
	function editorName(editor: EditorInput | undefined): string {
		const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });

		return resource ? basename(resource) : '';
	}

	/**
	 * Describes the editors of a group in order, each as its name followed by
	 * `s` when it is sticky, a letter per tab stack in order of appearance, `^`
	 * when that tab stack is collapsed, `?` for the preview editor and `*` for
	 * the active editor.
	 */
	function tabStackState(group: IEditorGroup): string {
		const letters = new Map(group.tabStacks.map((tabStack, index) => [tabStack.id, String.fromCharCode('a'.charCodeAt(0) + index)]));

		return group.getEditors(EditorsOrder.SEQUENTIAL).map(editor => {
			const tabStack = group.getTabStack(editor);

			return [
				editorName(editor),
				group.isSticky(editor) ? 's' : '',
				tabStack ? letters.get(tabStack.id) : '',
				tabStack?.collapsed ? '^' : '',
				group.isPinned(editor) ? '' : '?',
				group.isActive(editor) ? '*' : ''
			].join('');
		}).join(' ');
	}

	/**
	 * Describes the tab bar of a group in order: each tab as the name of its
	 * editor and each tab stack header as `H`, followed by `^` when its tab
	 * stack is collapsed, with `=` where the drop feedback shows a drop inside
	 * a tab stack, `_` where it shows any other drop, and `|` between the rows
	 * of pinned and other tabs.
	 */
	function tabBar(group: IEditorGroupView): string {
		return Array.from(group.element.querySelectorAll('.tabs-container'), tabsContainer => Array.from(tabsContainer.children).flatMap((child, index, children) => {
			const slot = child.classList.contains('tab-stack-header') ? `H${child.classList.contains('collapsed') ? '^' : ''}` : child.getAttribute('data-resource-name');
			const isDropBefore = child.classList.contains('drop-target-right') && !children[index - 1]?.classList.contains('drop-target-left');
			const drop = child.classList.contains('drop-target-in-tab-stack') ? '=' : '_';

			return [...(isDropBefore ? [drop] : []), slot, ...(child.classList.contains('drop-target-left') ? [drop] : [])];
		}).join(' ')).join(' | ');
	}

	test('tab stacks - replaceEditors keeps the replacements in the tab stack of the replaced editors', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [, first, middle, last] = await openPinnedTestEditors(group, '1', '2', '3', '4', '5');
		group.addEditorsToTabStack([first, middle, last]);
		await group.openEditor(middle);

		const [firstReplacement, middleReplacement, lastReplacement] = createNamedTestEditors('6', '7', '8');
		await group.replaceEditors([
			{ editor: first, replacement: firstReplacement },
			{ editor: middle, replacement: middleReplacement },
			{ editor: last, replacement: lastReplacement }
		]);

		assert.deepStrictEqual(tabStackState(group), '1 6a 7a* 8a 5');
	});

	test('tab stacks - replaceEditors keeps a replacement that the group has already in the tab stack of the replaced first or last editor', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third, fourth, fifth] = await openPinnedTestEditors(group, '1', '2', '3', '4', '5');
		group.addEditorsToTabStack([second, third, fourth]);

		await group.replaceEditors([{ editor: second, replacement: fifth }]);
		await group.replaceEditors([{ editor: fourth, replacement: first }]);

		assert.deepStrictEqual({ editors: tabStackState(group), tabBar: tabBar(group) }, { editors: '5a* 3a 1a', tabBar: 'H 5 3 1' });
	});

	test('tab stacks - replaceEditors while tab stacks are hidden keeps the replacements in the tab stack of the replaced editors once shown', async () => {
		const results: Record<string, string> = {};
		for (const [name, fixture, active, replaced, replacement] of [
			['inactive', '1a 2a 3a 4', '4', '2', '9'],
			['active', '1a 2a 3a 4', '2', '2', '9'],
			['alreadyOpen', '1a 2b 3b 4 5', '5', '3', '4']
		]) {
			const [part] = await createPart(createTabStacksInstantiationService());
			const group = part.activeGroup;
			await openFixture(group, fixture);
			await group.openEditor(editorOf(group, active));

			const enforced = part.enforcePartOptions({ showTabs: 'single' });
			await group.replaceEditors([{ editor: editorOf(group, replaced), replacement: createNamedTestEditors(replacement)[0] }]);
			enforced.dispose();

			results[name] = tabStackState(group);
		}

		assert.deepStrictEqual(results, {
			inactive: '1a 9a 3a 4*',
			active: '1a 9a* 3a 4',
			alreadyOpen: '1a 2b 4b 5*'
		});
	});

	test('tab stacks - collapsing the tab stack of the active editor opens the nearest editor outside of it', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third] = await openPinnedTestEditors(group, '1', '2', '3', '4');
		group.addEditorsToTabStack([second, third]);
		await group.openEditor(second);
		await group.setSelection(second, [first]);

		const activeEditorChange = Event.toPromise(group.onDidActiveEditorChange);
		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });
		await activeEditorChange;

		assert.deepStrictEqual({
			state: tabStackState(group),
			selection: group.selectedEditors.map(editorName),
			activeEditorPane: editorName(group.activeEditorPane?.input)
		}, {
			state: '1 2a^ 3a^ 4*',
			selection: ['1', '4'],
			activeEditorPane: '4'
		});
	});

	test('tab stacks - collapsing the tab stack of the active editor of an inactive group keeps the other group active', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [, second] = await openPinnedTestEditors(group, '1', '2', '3');
		group.addEditorsToTabStack([second]);
		await group.openEditor(second);
		const otherGroup = part.addGroup(group, GroupDirection.RIGHT);
		await openPinnedTestEditors(otherGroup, '4');
		part.activateGroup(otherGroup);

		const activeEditorChange = Event.toPromise(group.onDidActiveEditorChange);
		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });
		await activeEditorChange;

		assert.deepStrictEqual({
			activeGroup: part.activeGroup.id,
			state: tabStackState(group),
			activeEditorPane: editorName(group.activeEditorPane?.input)
		}, {
			activeGroup: otherGroup.id,
			state: '1 2a^ 3*',
			activeEditorPane: '3'
		});
	});

	test('tab stacks - collapsing does nothing when every editor of the group is in the tab stack', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const editors = await openPinnedTestEditors(group, '1', '2');
		group.addEditorsToTabStack(editors);

		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });

		assert.deepStrictEqual({
			state: tabStackState(group),
			activeEditorPane: editorName(group.activeEditorPane?.input)
		}, {
			state: '1a 2a*',
			activeEditorPane: '2'
		});
	});

	test('tab stacks - enforcing a single tab hides tab stacks and restores them with their collapsed state', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third] = await openPinnedTestEditors(group, '1', '2', '3', '4');
		group.addEditorsToTabStack([first, second]);
		group.addEditorsToTabStack([third]);
		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });

		const enforced = part.enforcePartOptions({ showTabs: 'single' });
		const whileEnforced = tabStackState(group);
		enforced.dispose();

		assert.deepStrictEqual({ whileEnforced, afterwards: tabStackState(group), tabBar: tabBar(group) }, {
			whileEnforced: '1 2 3 4*',
			afterwards: '1a^ 2a^ 3b 4*',
			tabBar: 'H^ H 3 4'
		});
	});

	test('tab stacks - editTabStack opens the editor of a tab stack only while the tab bar shows the header of the tab stack', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const partContainer = part.getContainer()!;
		mainWindow.document.body.appendChild(partContainer);
		disposables.add(toDisposable(() => partContainer.remove()));
		const group = part.activeGroup;

		const [first] = await openPinnedTestEditors(group, '1', '2');
		const tabStack = group.addEditorsToTabStack([first])!.id;

		const opened = group.editTabStack(tabStack);
		const enforced = part.enforcePartOptions({ showTabs: 'single' });
		const openedWithSingleTab = group.editTabStack(tabStack);
		enforced.dispose();

		assert.deepStrictEqual({ opened, openedWithSingleTab, openedWithTabsAgain: group.editTabStack(group.tabStacks[0].id) }, {
			opened: true,
			openedWithSingleTab: false,
			openedWithTabsAgain: true
		});
	});

	test('tab stacks - tab stack operations keep the tab bar in the order of the editors with a header before each tab stack', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third, , fifth] = await openPinnedTestEditors(group, '1', '2', '3', '4', '5');
		const tabStack = group.addEditorsToTabStack([first, third, fifth])!.id;
		const afterAdd = tabBar(group);
		group.moveTabStack(tabStack, 2);
		const afterMove = tabBar(group);
		group.removeEditorsFromTabStack([third]);
		const afterRemove = tabBar(group);
		group.moveEditorsWithinGroup([third], 0);
		const afterMoveWithinGroup = tabBar(group);

		// Collapsing the tab stack of the active editor opens the nearest editor outside of it
		const activeEditorChange = Event.toPromise(group.onDidActiveEditorChange);
		group.updateTabStack(tabStack, { collapsed: true });
		await activeEditorChange;
		const afterCollapse = tabBar(group);
		group.addEditorsToTabStack([second], tabStack);

		assert.deepStrictEqual({ afterAdd, afterMove, afterRemove, afterMoveWithinGroup, afterCollapse, afterAddToCollapsed: tabBar(group), editors: tabStackState(group) }, {
			afterAdd: 'H 1 3 5 2 4',
			afterMove: '2 4 H 1 3 5',
			afterRemove: '2 4 H 1 5 3',
			afterMoveWithinGroup: '3 2 4 H 1 5',
			afterCollapse: '3 2 4 H^',
			afterAddToCollapsed: '3 4 H^',
			editors: '3 4* 2a^ 1a^ 5a^'
		});
	});

	test('tab stacks - opening an editor hidden in a collapsed tab stack shows the tab stack expanded in the tab bar', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third] = await openPinnedTestEditors(group, '1', '2', '3');
		group.addEditorsToTabStack([second, third]);
		await group.openEditor(first);
		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });
		const collapsed = tabBar(group);

		await group.openEditor(third);

		assert.deepStrictEqual({ collapsed, expanded: tabBar(group), editors: tabStackState(group) }, {
			collapsed: '1 H^',
			expanded: '1 H 2 3',
			editors: '1 2a 3a*'
		});
	});

	test('tab stacks - clicking the header of the tab stack of the active editor collapses it and opens the nearest editor outside of it', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [, second, third] = await openPinnedTestEditors(group, '1', '2', '3', '4');
		group.addEditorsToTabStack([second, third]);
		await group.openEditor(second);

		const activeEditorChange = Event.toPromise(group.onDidActiveEditorChange);
		group.element.querySelector('.tab-stack-header')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
		await activeEditorChange;

		assert.deepStrictEqual({ tabBar: tabBar(group), editors: tabStackState(group), activeEditorPane: editorName(group.activeEditorPane?.input) }, {
			tabBar: '1 H^ 4',
			editors: '1 2a^ 3a^ 4*',
			activeEditorPane: '4'
		});
	});

	test('tab stacks - adding a preview editor to a tab stack shows it pinned in the tab bar', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;
		const isTabItalic = () => !!group.element.querySelector('.tab[data-resource-name="2"] .italic');

		const [pinnedEditor, previewEditor] = createNamedTestEditors('1', '2');
		await group.openEditor(pinnedEditor, { pinned: true });
		await group.openEditor(previewEditor);
		const italicBefore = isTabItalic();

		group.addEditorsToTabStack([previewEditor]);

		assert.deepStrictEqual({ italicBefore, pinned: group.isPinned(previewEditor), italicAfter: isTabItalic() }, {
			italicBefore: true,
			pinned: true,
			italicAfter: false
		});
	});

	test('tab stacks - adding a preview editor to a tab stack announces its tab as a member and no longer as a preview', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;
		const ariaLabel = () => group.element.querySelector('.tab[data-resource-name="2"]')!.getAttribute('aria-label');

		const [pinnedEditor, previewEditor] = createNamedTestEditors('1', '2');
		await group.openEditor(pinnedEditor, { pinned: true });
		await group.openEditor(previewEditor);
		const before = ariaLabel();

		group.updateTabStack(group.addEditorsToTabStack([previewEditor])!.id, { label: 'Auth' });

		assert.deepStrictEqual({ before, after: ariaLabel() }, {
			before: `${previewEditor.getAriaLabel()}, preview`,
			after: `${previewEditor.getAriaLabel()}, in tab stack Auth`,
		});
	});

	test('tab stacks - a tab stack operation that moves no editor sets the accessible name of each tab and of the header once', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;
		await openFixture(group, '1 2a 3a 4');
		const tabStack = group.tabStacks[0].id;
		const accessibleNameWrites = (operation: () => void) => {
			const observer = new MutationObserver(() => { });
			observer.observe(group.element, { subtree: true, attributeFilter: ['aria-label'] });
			operation();
			const slots = observer.takeRecords().map(({ target }) => target).filter(isHTMLElement).filter(element => element.matches('.tab, .tab-stack-header'));
			observer.disconnect();

			return slots.map(slot => slot.getAttribute('data-resource-name') ?? 'H').join(' ');
		};

		assert.deepStrictEqual({
			add: accessibleNameWrites(() => group.addEditorsToTabStack([editorOf(group, '4')], tabStack)),
			rename: accessibleNameWrites(() => group.updateTabStack(tabStack, { label: 'Auth' })),
			remove: accessibleNameWrites(() => group.removeEditorsFromTabStack([editorOf(group, '4')]))
		}, {
			add: '1 2 3 4 H',
			rename: '1 2 3 4 H',
			remove: '1 2 3 4 H'
		});
	});

	test('tab stacks - moveEditorsWithinGroup pins the moved editors', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		await openPinnedTestEditors(group, '1', '2');
		const [previewEditor] = createNamedTestEditors('3');
		await group.openEditor(previewEditor);

		group.moveEditorsWithinGroup([previewEditor], 0);

		assert.deepStrictEqual(tabStackState(group), '3* 1 2');
	});

	test('tab stacks - moveEditorsWithinGroup moves editors dropped among the sticky editors one at a time, and the tab bar shows them pinned', async () => {
		const [part] = await createPart(createTabStacksInstantiationService(undefined, { pinnedTabsOnSeparateRow: true }));
		const group = part.activeGroup;

		const [first, second, third, fourth] = await openPinnedTestEditors(group, '1', '2', '3', '4', '5');
		group.stickEditor(first);
		group.stickEditor(second);
		group.addEditorsToTabStack([third, fourth]);

		group.moveEditorsWithinGroup([third, fourth], 1);

		assert.deepStrictEqual({ state: tabStackState(group), tabBar: tabBar(group) }, {
			state: '1s 3s 4s 2s 5*',
			tabBar: '1 3 4 2 | 5'
		});
	});

	test('tab stacks - copyEditor within its group forwards the tab stack hint, as moveEditor does', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third] = await openPinnedTestEditors(group, '1', '2', '3', '4');
		const tabStack = group.addEditorsToTabStack([second, third])!.id;

		group.copyEditor(first, group, { index: 2 }, { tabStack });

		assert.deepStrictEqual(tabStackState(group), '2a 3a 1a 4*');
	});

	/**
	 * Opens the fixture with the editor marked `*` active and those marked `+`
	 * selected, and describes the group after each press, or `declined` where
	 * tab stacks do not change the move.
	 */
	async function openMarkedFixture(group: IEditorGroup, fixture: string): Promise<void> {
		await openFixture(group, fixture.replace(/[*+]/g, ''));
		const editorsMarked = (marker: string) => fixture.split(' ').filter(token => token.endsWith(marker)).map(token => editorOf(group, /^\d+/.exec(token)![0]));
		await group.setSelection(editorsMarked('*')[0], editorsMarked('+'));
	}

	async function movesByTab(fixture: string, presses: string): Promise<string> {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;
		await openMarkedFixture(group, fixture);

		const states = presses.split(', ').map(press => {
			const [to, value] = press.split(' ');

			return moveEditorsByTabWithTabStacks(group, group.selectedEditors, { to, value: Number(value ?? 1) }, new TestAccessibilityService()) ? tabStackState(group) : 'declined';
		});

		return `${fixture}, ${presses}: ${states.join(' / ')}`;
	}

	test('tab stacks - moving editors by tab joins or leaves an expanded tab stack at its edge before moving, hops over a collapsed one, leaves at the end of the tabs, moves a whole tab stack past a tab or a tab stack and never crosses the pinned tabs, as Chrome does', async () => {
		const results = [];
		for (const [fixture, presses] of [
			['1 2* 3a 4a 5', 'right, right'],
			['1 2* 3a 4a 5', 'right 2'],
			['1 2a 3a* 4', 'right, right'],
			['1* 2a^ 3a^ 4', 'right'],
			['1 2a^ 3a^ 4*', 'left'],
			['1 2a 3a*', 'right, right'],
			['1a 2a* 3b 4b', 'right, right'],
			['1s 2a* 3a 4', 'left, left'],
			['1s 2s* 3a 4', 'right, left'],
			['1 2a* 3a+ 4b 5b 6', 'right, left'],
			['1 2* 3a+ 4a', 'right, right'],
			['1* 2 3+ 4a 5a', 'right'],
			['1s 2 3a 4a* 5', 'first'],
			['1s 2 3a 4a* 5', 'last'],
			['1 2 3a* 4a+', 'first'],
			['1s* 2s 3a 4', 'last'],
			['1s 2s* 3a 4a', 'first'],
			['1s 2* 3', 'left'],
		] as const) {
			results.push(await movesByTab(fixture, presses));
		}

		assert.deepStrictEqual(results, [
			'1 2* 3a 4a 5, right, right: 1 2a* 3a 4a 5 / 1 3a 2a* 4a 5',
			'1 2* 3a 4a 5, right 2: 1 3a 2a* 4a 5',
			'1 2a 3a* 4, right, right: 1 2a 3* 4 / 1 2a 4 3*',
			'1* 2a^ 3a^ 4, right: 2a^ 3a^ 1* 4',
			'1 2a^ 3a^ 4*, left: 1 4* 2a^ 3a^',
			'1 2a 3a*, right, right: 1 2a 3* / 1 2a 3*',
			'1a 2a* 3b 4b, right, right: 1a 2* 3b 4b / 1a 2b* 3b 4b',
			'1s 2a* 3a 4, left, left: 1s 2* 3a 4 / 1s 2* 3a 4',
			'1s 2s* 3a 4, right, left: 1s 2s* 3a 4 / 2s* 1s 3a 4',
			'1 2a* 3a+ 4b 5b 6, right, left: 1 4a 5a 2b* 3b 6 / 1 2a* 3a 4b 5b 6',
			'1 2* 3a+ 4a, right, right: 1 2* 3 4a / 1 2a* 3a 4a',
			'1* 2 3+ 4a 5a, right: 2 1* 3a 4a 5a',
			'1s 2 3a 4a* 5, first: 1s 4* 2 3a 5',
			'1s 2 3a 4a* 5, last: 1s 2 3a 5 4*',
			'1 2 3a* 4a+, first: 3a* 4a 1 2',
			'1s* 2s 3a 4, last: 2s 1s* 3a 4',
			'1s 2s* 3a 4a, first: 2s* 1s 3a 4a',
			'1s 2* 3, left: declined',
		]);
	});

	test('tab stacks - moving editors by tab announces the active editor joining or leaving a tab stack while a screen reader is in use', async () => {
		const announcements: string[] = [];
		for (const screenReaderOptimized of [true, false]) {
			const [part] = await createPart(createTabStacksInstantiationService());
			const group = part.activeGroup;
			await openFixture(group, '1 2 3a 4b');
			group.updateTabStack(group.tabStacks[1].id, { label: 'Auth' });
			await group.openEditor(editorOf(group, '2'));
			const accessibilityService = new class extends TestAccessibilityService {
				override isScreenReaderOptimized(): boolean {
					return screenReaderOptimized;
				}

				override status(message: string): void {
					announcements.push(`${tabStackState(group)}: ${message}`);
				}
			};

			for (let press = 0; press < 6; press++) {
				moveEditorsByTabWithTabStacks(group, group.selectedEditors, { to: 'right', value: 1 }, accessibilityService);
			}
		}

		assert.deepStrictEqual(announcements, [
			'1 2a* 3a 4b: Moved into unnamed tab stack',
			'1 3a 2* 4b: Removed from unnamed tab stack',
			'1 3a 2b* 4b: Moved into tab stack Auth',
			'1 3a 4b 2*: Removed from tab stack Auth',
		]);
	});

	test('tab stacks - moving editors by tab keeps the keyboard focus on the tab of the moved editor when the tab bar detaches or reorders the focused tab, as past a collapsed tab stack', async () => {
		const results = [];
		for (const [fixture, focused, to] of [
			['1* 2a^ 3a^ 4', '1', 'right'],
			['1 2a^ 3a^ 4*', '4', 'left'],
			['1 2a^ 3a^ 4*', '4', 'first'],
			['1* 2a^ 3a^ 4', '1', 'last'],
			['1 2a* 3a+ 4b^ 5b^ 6', '2', 'right'],
			['1a* 2a 3a 4', '1', 'left'],
		] as const) {
			const [part] = await createShownPart();
			const group = part.activeGroup;
			await openMarkedFixture(group, fixture);
			tabOf(group, focused).focus();

			moveEditorsByTabWithTabStacks(group, group.selectedEditors, { to, value: 1 }, new TestAccessibilityService());
			results.push(`${fixture}, ${to}: ${tabStackState(group)}, focus ${getActiveElement()?.getAttribute('data-resource-name') ?? 'lost'}`);
		}

		assert.deepStrictEqual(results, [
			'1* 2a^ 3a^ 4, right: 2a^ 3a^ 1* 4, focus 1',
			'1 2a^ 3a^ 4*, left: 1 4* 2a^ 3a^, focus 4',
			'1 2a^ 3a^ 4*, first: 4* 1 2a^ 3a^, focus 4',
			'1* 2a^ 3a^ 4, last: 2a^ 3a^ 4 1*, focus 1',
			'1 2a* 3a+ 4b^ 5b^ 6, right: 1 4a^ 5a^ 2b* 3b 6, focus 2',
			'1a* 2a 3a 4, left: 1* 2a 3a 4, focus 1',
		]);
	});

	test('tab stacks - a focused tab stack header keeps the keyboard focus when the tab bar moves it, and passes it to the tab of the active editor, or else to the group, when the tab bar removes it', async () => {
		const results = [];
		for (const [fixture, change, editorConfiguration] of [
			['1* 2a 3a 4', 'right', undefined],
			['1* 2a 3a 4', 'ungroup', undefined],
			['1s* 2a 3a 4', 'ungroup', { pinnedTabsOnSeparateRow: true }],
		] as const) {
			const [part] = await createShownPart(editorConfiguration);
			const group = part.activeGroup;
			await openMarkedFixture(group, fixture);
			let groupFocus = 0;
			disposables.add(group.onDidFocus(() => groupFocus++));
			tabStackHeaderOf(group, 0).focus();

			if (change === 'right') {
				moveEditorsByTabWithTabStacks(group, group.selectedEditors, { to: 'right', value: 1 }, new TestAccessibilityService());
			} else {
				group.removeEditorsFromTabStack(group.tabStacks[0].editors);
			}
			const focus = getActiveElement();
			results.push(`${fixture}, ${change}: ${tabStackState(group)}, focus ${focus?.classList.contains('tab-stack-header') ? 'header' : focus?.getAttribute('data-resource-name') ?? (groupFocus > 0 ? 'group' : 'lost')}`);
		}

		assert.deepStrictEqual(results, [
			'1* 2a 3a 4, right: 1a* 2a 3a 4, focus header',
			'1* 2a 3a 4, ungroup: 1* 2 3 4, focus 1',
			'1s* 2a 3a 4, ungroup: 1s* 2 3 4, focus group',
		]);
	});

	test('tab stacks - openEditors from an editor in a tab stack opens the other editors in order after the tab stack', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [, second, third] = await openPinnedTestEditors(group, '1', '2', '3', '4');
		group.addEditorsToTabStack([second, third]);

		await group.openEditors([second, ...createNamedTestEditors('5', '6')].map(editor => ({ editor })));

		assert.deepStrictEqual(tabStackState(group), '1 2a* 3a 5 6 4');
	});

	test('tab stacks - openEditors from an editor in a tab stack keeps the editors that already follow it in order where they are, and opens the others in order after the tab stack', async () => {
		const results = [];
		for (const [fixture, names] of [
			['1 2a 3a 4', '2 3 5'],
			['1 2a 3a 4a 5', '2 3 5'],
			['1 2a 3a 4 6', '2 4 5'],
		] as const) {
			const [part] = await createPart(createTabStacksInstantiationService());
			const group = part.activeGroup;
			await openFixture(group, fixture);
			const namesOfFixture = new Set(group.getEditors(EditorsOrder.SEQUENTIAL).map(editorName));

			await group.openEditors(names.split(' ').map(name => ({ editor: namesOfFixture.has(name) ? editorOf(group, name) : createNamedTestEditors(name)[0] })));

			results.push(`${names} from ${fixture}: ${tabStackState(group)}`);
		}

		assert.deepStrictEqual(results, [
			'2 3 5 from 1 2a 3a 4: 1 2a* 3a 5 4',
			'2 3 5 from 1 2a 3a 4a 5: 1 2a* 3a 4a 5',
			'2 4 5 from 1 2a 3a 4 6: 1 2a* 3a 4 5 6',
		]);
	});

	test('tab stacks - mergeGroup at an index inside a tab stack moves the editors in order after the tab stack and keeps both tab stacks', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const targetGroup = part.activeGroup;

		await openFixture(targetGroup, '1 2a 3a 4');
		const sourceGroup = part.addGroup(targetGroup, GroupDirection.RIGHT);
		await openFixture(sourceGroup, '5a 6a');
		part.activateGroup(sourceGroup);

		part.mergeGroup(sourceGroup, targetGroup, { index: 2 });

		assert.deepStrictEqual(tabStackState(targetGroup), '1 2a 3a 5b 6b* 4');
	});

	test('tab stacks - mergeGroup keeps the tab stacks of the merged group with their name, color and collapsed state, also as a copy', async () => {
		const results = [];
		for (const mode of [MergeGroupMode.MOVE_EDITORS, MergeGroupMode.COPY_EDITORS]) {
			const [part] = await createPart(createTabStacksInstantiationService());
			const targetGroup = part.activeGroup;
			await openFixture(targetGroup, '1 2');
			const sourceGroup = part.addGroup(targetGroup, GroupDirection.RIGHT);
			await openFixture(sourceGroup, '3a^ 4a^ 5b 6');
			sourceGroup.updateTabStack(sourceGroup.tabStacks[0].id, { label: 'Auth', color: 'red' });
			part.activateGroup(sourceGroup);

			part.mergeGroup(sourceGroup, targetGroup, { mode });

			results.push({
				target: tabStackState(targetGroup),
				tabStacks: targetGroup.tabStacks.map(({ label, color }) => ({ label, color })),
				source: part.groups.includes(sourceGroup) ? tabStackState(sourceGroup) : undefined
			});
		}

		const tabStacks = [{ label: 'Auth', color: 'red' }, { label: '', color: 'purple' }];
		assert.deepStrictEqual(results, [
			{ target: '1 2 3a^ 4a^ 5b 6*', tabStacks, source: undefined },
			{ target: '1 2 3a^ 4a^ 5b 6*', tabStacks, source: '3a^ 4a^ 5b 6*' }
		]);
	});

	test('tab stacks - removing a group, applying a layout with fewer groups and joining all groups keep the tab stacks of the merged group', async () => {
		const merges: [string, (part: TestEditorPart, targetGroup: IEditorGroupView, sourceGroup: IEditorGroupView) => void][] = [
			['removeGroup', (part, _targetGroup, sourceGroup) => part.removeGroup(sourceGroup)],
			['applyLayout', part => part.applyLayout({ groups: [{}], orientation: GroupOrientation.HORIZONTAL })],
			['mergeAllGroups', (part, targetGroup) => part.mergeAllGroups(targetGroup)]
		];

		const results: string[] = [];
		for (const [name, merge] of merges) {
			const [part] = await createPart(createTabStacksInstantiationService());
			const targetGroup = part.activeGroup;
			await openFixture(targetGroup, '1 2');
			const sourceGroup = part.addGroup(targetGroup, GroupDirection.RIGHT);
			await openFixture(sourceGroup, '3a^ 4a^ 5b 6');
			part.activateGroup(sourceGroup);

			merge(part, targetGroup, sourceGroup);

			results.push(`${name}: ${part.groups.map(group => tabStackState(group)).join(' | ')}`);
		}

		assert.deepStrictEqual(results, [
			'removeGroup: 1 2 3a^ 4a^ 5b 6*',
			'applyLayout: 1 2 3a^ 4a^ 5b 6*',
			'mergeAllGroups: 1 2 3a^ 4a^ 5b 6*'
		]);
	});

	test('tab stacks - merging with preserveExistingIndex, as closing an auxiliary window does, keeps a tab stack as its longest run', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const targetGroup = part.activeGroup;
		await openFixture(targetGroup, '2 4');
		const sourceGroup = part.addGroup(targetGroup, GroupDirection.RIGHT);
		await openFixture(sourceGroup, '1a 2a 3a');
		part.activateGroup(sourceGroup);

		part.mergeAllGroups(targetGroup, { preserveExistingIndex: true });

		assert.deepStrictEqual(tabStackState(targetGroup), '2 4 1a 3a*');
	});

	test('tab stacks - merging a group that shares editors with a tab stack of the target keeps that tab stack whole', async () => {
		const results: string[] = [];
		for (const name of ['split editor', 'duplicate group']) {
			const [part] = await createPart(createTabStacksInstantiationService());
			const group = part.activeGroup;
			await openFixture(group, '1a 2a 3');
			if (name === 'split editor') {
				const otherGroup = part.addGroup(group, GroupDirection.RIGHT);
				group.copyEditor(editorOf(group, '1'), otherGroup);
				part.activateGroup(otherGroup);
				part.mergeGroup(otherGroup, group);
			} else {
				part.copyGroup(group, group, GroupDirection.RIGHT);
				part.mergeAllGroups(group);
			}

			results.push(`${name}: ${tabStackState(group)} | ${tabBar(group)}`);
		}

		assert.deepStrictEqual(results, [
			'split editor: 1a* 2a 3 | H 1 2 3',
			'duplicate group: 1a 2a 3* | H 1 2 3'
		]);
	});

	test('tab stacks - mergeGroup as a copy keeps an editor whose copy does not match it in its tab stack', async () => {
		class NonMatchingCopyTestEditorInput extends TestFileEditorInput {
			override copy(): EditorInput {
				return createTestFileEditorInput(URI.file('8'), this.typeId);
			}
		}

		const [part] = await createPart(createTabStacksInstantiationService());
		const targetGroup = part.activeGroup;
		await openFixture(targetGroup, '7');
		const sourceGroup = part.addGroup(targetGroup, GroupDirection.RIGHT);
		await openFixture(sourceGroup, '1a 2a 3a', async names => {
			const editors = names.map(name => name === '2' ? disposables.add(new NonMatchingCopyTestEditorInput(URI.file(name), TEST_EDITOR_INPUT_ID)) : createNamedTestEditors(name)[0]);
			for (const editor of editors) {
				await sourceGroup.openEditor(editor, { pinned: true });
			}

			return editors;
		});
		part.activateGroup(sourceGroup);

		part.mergeGroup(sourceGroup, targetGroup, { mode: MergeGroupMode.COPY_EDITORS });

		assert.deepStrictEqual(tabStackState(targetGroup), '7 1a 8a 3a*');
	});

	test('tab stacks - an editor moved to another group opens outside of tab stacks', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const sourceGroup = part.activeGroup;
		const [sourceFirst, sourceSecond] = await openPinnedTestEditors(sourceGroup, 's1', 's2', 's3');
		sourceGroup.addEditorsToTabStack([sourceFirst, sourceSecond]);
		const targetGroup = part.addGroup(sourceGroup, GroupDirection.RIGHT);
		const [targetFirst, targetSecond] = await openPinnedTestEditors(targetGroup, 't1', 't2', 't3');
		targetGroup.addEditorsToTabStack([targetFirst, targetSecond]);

		sourceGroup.moveEditor(sourceFirst, targetGroup, { index: 1 });

		assert.deepStrictEqual({ source: tabStackState(sourceGroup), target: tabStackState(targetGroup) }, {
			source: 's2a s3*',
			target: 't1a t2a s1* t3'
		});
	});

	test('tab stacks - an editor moved to another group with a tab stack hint joins that tab stack at the index', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const sourceGroup = part.activeGroup;
		const [sourceFirst] = await openPinnedTestEditors(sourceGroup, 's1', 's2');
		sourceGroup.addEditorsToTabStack([sourceFirst]);
		const targetGroup = part.addGroup(sourceGroup, GroupDirection.RIGHT);
		const [targetFirst, targetSecond] = await openPinnedTestEditors(targetGroup, 't1', 't2', 't3');
		const targetTabStack = targetGroup.addEditorsToTabStack([targetFirst, targetSecond]);

		sourceGroup.moveEditor(sourceFirst, targetGroup, { index: 1 }, { tabStack: targetTabStack?.id });

		assert.deepStrictEqual({ source: tabStackState(sourceGroup), sourceTabStacks: sourceGroup.tabStacks.length, target: tabStackState(targetGroup) }, {
			source: 's2*',
			sourceTabStacks: 0,
			target: 't1a s1a* t2a t3'
		});
	});

	test('tab stacks - an editor copied to another group with a tab stack hint joins that tab stack at the index', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const sourceGroup = part.activeGroup;
		const [sourceEditor] = await openPinnedTestEditors(sourceGroup, 's1');
		const targetGroup = part.addGroup(sourceGroup, GroupDirection.RIGHT);
		const targetEditors = await openPinnedTestEditors(targetGroup, 't1', 't2');
		const targetTabStack = targetGroup.addEditorsToTabStack(targetEditors);

		sourceGroup.copyEditor(sourceEditor, targetGroup, { index: 1 }, { tabStack: targetTabStack?.id });

		assert.deepStrictEqual({ source: tabStackState(sourceGroup), target: tabStackState(targetGroup) }, {
			source: 's1*',
			target: 't1a s1a* t2a'
		});
	});

	test('tab stacks - editors moved to another group one after the other with a tab stack hint join that tab stack as a run', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const sourceGroup = part.activeGroup;
		const [sourceFirst, sourceSecond] = await openPinnedTestEditors(sourceGroup, 's1', 's2', 's3');
		const targetGroup = part.addGroup(sourceGroup, GroupDirection.RIGHT);
		const targetEditors = await openPinnedTestEditors(targetGroup, 't1', 't2');
		const targetTabStack = targetGroup.addEditorsToTabStack(targetEditors);

		sourceGroup.moveEditor(sourceFirst, targetGroup, { index: 1 }, { tabStack: targetTabStack?.id });
		sourceGroup.moveEditor(sourceSecond, targetGroup, { index: 2 }, { tabStack: targetTabStack?.id });

		assert.deepStrictEqual(tabStackState(targetGroup), 't1a s1a s2a* t2a');
	});

	test('tab stacks - copyGroup keeps tab stacks', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third] = await openPinnedTestEditors(group, '1', '2', '3', '4');
		group.addEditorsToTabStack([first, second]);
		group.addEditorsToTabStack([third]);
		group.updateTabStack(group.tabStacks[0].id, { label: 'Auth', color: 'red', collapsed: true });

		const copiedGroup = part.copyGroup(group, group, GroupDirection.RIGHT);

		assert.deepStrictEqual({
			state: tabStackState(copiedGroup),
			tabStacks: copiedGroup.tabStacks.map(({ label, color }) => ({ label, color }))
		}, {
			state: '1a^ 2a^ 3b 4*',
			tabStacks: [{ label: 'Auth', color: 'red' }, { label: '', color: 'purple' }]
		});
	});

	test('tab stacks - closing the other editors also closes editors hidden in a collapsed tab stack', async () => {
		const [part] = await createPart(createTabStacksInstantiationService());
		const group = part.activeGroup;

		const [first, second, third] = await openPinnedTestEditors(group, '1', '2', '3');
		group.addEditorsToTabStack([first, second]);
		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });

		await group.closeEditors({ except: third });

		assert.deepStrictEqual(tabStackState(group), '3*');
	});

	test('tab stacks - the context menu of a tab tells whether that tab is in a tab stack', async () => {
		const instantiationService = createTabStacksInstantiationService(new MockScopableContextKeyService());
		const inTabStackValues: (boolean | undefined)[] = [];
		// The context menu UI is the boundary: it renders the menu the tab asks for
		instantiationService.stub(IContextMenuService, new class extends mock<IContextMenuService>() {
			override showContextMenu(delegate: IContextMenuMenuDelegate): void {
				inTabStackValues.push(delegate.contextKeyService?.getContextKeyValue<boolean>(ActiveEditorInTabStackContext.key));
			}
		});
		const [part] = await createPart(instantiationService);
		const group = part.activeGroup;

		const [, second] = await openPinnedTestEditors(group, '1', '2');
		group.addEditorsToTabStack([second]);

		for (const name of ['2', '1']) {
			group.element.querySelector(`.tab[data-resource-name="${name}"]`)?.dispatchEvent(new MouseEvent('contextmenu'));
		}

		assert.deepStrictEqual(inTabStackValues, [true, false]);
	});

	test('tab stacks - context keys follow the active editor and the tab stacks of the group', async () => {
		const [part] = await createPart(createTabStacksInstantiationService(new MockScopableContextKeyService()));
		const group = part.activeGroup;
		const contextKeys = (editorGroup: IEditorGroup) => ({
			activeEditorIsInTabStack: editorGroup.scopedContextKeyService.getContextKeyValue(ActiveEditorInTabStackContext.key),
			editorGroupHasTabStacks: editorGroup.scopedContextKeyService.getContextKeyValue(EditorGroupHasTabStacksContext.key)
		});

		const [first, second] = await openPinnedTestEditors(group, '1', '2');
		const initially = contextKeys(group);

		group.addEditorsToTabStack([second]);
		const afterAddingActiveEditor = contextKeys(group);
		const copiedGroup = contextKeys(part.copyGroup(group, group, GroupDirection.RIGHT));

		await group.openEditor(first);
		const afterOpeningEditorOutside = contextKeys(group);

		await group.openEditor(second);
		const afterOpeningEditorInside = contextKeys(group);

		const enforced = part.enforcePartOptions({ showTabs: 'single' });
		const whileHidden = contextKeys(group);
		enforced.dispose();
		const afterShownAgain = contextKeys(group);

		group.removeEditorsFromTabStack([second]);
		const afterRemovingTabStack = contextKeys(group);

		assert.deepStrictEqual({ initially, afterAddingActiveEditor, copiedGroup, afterOpeningEditorOutside, afterOpeningEditorInside, whileHidden, afterShownAgain, afterRemovingTabStack }, {
			initially: { activeEditorIsInTabStack: false, editorGroupHasTabStacks: false },
			afterAddingActiveEditor: { activeEditorIsInTabStack: true, editorGroupHasTabStacks: true },
			copiedGroup: { activeEditorIsInTabStack: true, editorGroupHasTabStacks: true },
			afterOpeningEditorOutside: { activeEditorIsInTabStack: false, editorGroupHasTabStacks: true },
			afterOpeningEditorInside: { activeEditorIsInTabStack: true, editorGroupHasTabStacks: true },
			whileHidden: { activeEditorIsInTabStack: false, editorGroupHasTabStacks: false },
			afterShownAgain: { activeEditorIsInTabStack: true, editorGroupHasTabStacks: true },
			afterRemovingTabStack: { activeEditorIsInTabStack: false, editorGroupHasTabStacks: false }
		});
	});

	test('tab stacks - the context key of collapsed tab stacks in the active group follows collapsing, expanding, hiding and the active group', async () => {
		const contextKeyService = new MockScopableContextKeyService();
		const [part] = await createPart(createTabStacksInstantiationService(contextKeyService));
		const group = part.activeGroup;
		await openFixture(group, '1 2a 3');
		const otherGroup = part.addGroup(group, GroupDirection.RIGHT);
		await openPinnedTestEditors(otherGroup, '4');
		part.activateGroup(group);
		const contextKeys = () => ({
			group: group.scopedContextKeyService.getContextKeyValue(ActiveEditorGroupHasCollapsedTabStacksContext.key),
			global: contextKeyService.getContextKeyValue(ActiveEditorGroupHasCollapsedTabStacksContext.key)
		});

		const initially = contextKeys();
		group.updateTabStack(group.tabStacks[0].id, { collapsed: true });
		const afterCollapsing = contextKeys();
		part.activateGroup(otherGroup);
		const otherGroupActive = contextKeys();
		part.activateGroup(group);
		const enforced = part.enforcePartOptions({ showTabs: 'single' });
		const whileHidden = contextKeys();
		enforced.dispose();
		const afterShownAgain = contextKeys();
		group.updateTabStack(group.tabStacks[0].id, { collapsed: false });
		const afterExpanding = contextKeys();

		assert.deepStrictEqual({ initially, afterCollapsing, otherGroupActive, whileHidden, afterShownAgain, afterExpanding }, {
			initially: { group: false, global: false },
			afterCollapsing: { group: true, global: true },
			otherGroupActive: { group: true, global: false },
			whileHidden: { group: false, global: false },
			afterShownAgain: { group: true, global: true },
			afterExpanding: { group: false, global: false }
		});
	});

	test('tab stacks - a click on a focused tab stack header toggles its tab stack and keeps the header in place, so focus is not lost, and a mouse press on it also passes focus to the active editor of the group', async () => {
		const [part] = await createShownPart();
		const group = part.activeGroup;
		await openFixture(group, '1 2a 3a 4b 5');
		await group.openEditor(editorOf(group, '4'));
		let groupFocus = 0;
		disposables.add(group.onDidFocus(() => groupFocus++));

		const results: string[] = [];
		for (const [input, index] of [['click', 0], ['click', 0], ['press', 0], ['press', 1]] as const) {
			const header = tabStackHeaderOf(group, index);
			header.focus();
			for (const type of input === 'press' ? [EventType.MOUSE_DOWN, EventType.MOUSE_UP, EventType.CLICK] : [EventType.CLICK]) {
				header.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
			}
			await timeout(0);
			results.push(`${input} ${index}: ${tabStackState(group)}, ${tabStackHeaderOf(group, index) === header ? 'same header' : 'new header'}, ${getActiveElement() === mainWindow.document.body ? 'focus lost' : 'focus kept'}, group focused ${groupFocus}`);
		}

		assert.deepStrictEqual(results, [
			'click 0: 1 2a^ 3a^ 4b* 5, same header, focus kept, group focused 0',
			'click 0: 1 2a 3a 4b* 5, same header, focus kept, group focused 0',
			'press 0: 1 2a^ 3a^ 4b* 5, same header, focus kept, group focused 1',
			'press 1: 1 2a^ 3a^ 4b^ 5*, same header, focus kept, group focused 2'
		]);
	});

	/**
	 * Creates an editor part and puts it into the document under a workbench
	 * element, so that its tabs are laid out and a drag can be over either
	 * half of them, and gives it the service that its tabs take the data of
	 * dropped tree items from. Tab stacks are enabled unless the configuration
	 * turns them off.
	 */
	async function createShownPart(editorConfiguration?: object): Promise<[TestEditorPart, TestInstantiationService]> {
		const instantiationService = createTabStacksInstantiationService(undefined, editorConfiguration);
		instantiationService.stub(ITreeViewsDnDService, new TreeViewsDnDService<VSDataTransfer>());
		const [part] = await createPart(instantiationService);
		let root = part.activeGroup.element;
		while (root.parentElement) {
			root = root.parentElement;
		}

		const workbench = mainWindow.document.createElement('div');
		workbench.classList.add('monaco-workbench');
		workbench.appendChild(root);
		mainWindow.document.body.appendChild(workbench);
		disposables.add(toDisposable(() => {
			workbench.remove();

			const transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier | DraggedEditorGroupIdentifier | DraggedTreeItemsIdentifier>();
			transfer.clearData(DraggedEditorIdentifier.prototype);
			transfer.clearData(DraggedEditorGroupIdentifier.prototype);
			transfer.clearData(DraggedTreeItemsIdentifier.prototype);
		}));

		return [part, instantiationService];
	}

	/**
	 * A drop of the files with the space-separated names, from the Explorer or
	 * as the tree items of a tree view, or of the editor of the group with the
	 * name from the Open Editors view, on the tabs of a group with file editors
	 * for the editors of the fixture, near the left or right edge of what
	 * {@link dropTargetOf} returns for the target. A registered drop handler
	 * that takes the files, or their trust prompt, cancelled, can refuse it.
	 */
	type FileDropRow = readonly [fixture: string, names: string, target: string, side: 'left' | 'right', source?: 'explorer' | 'treeItem' | 'openEditors', refusal?: 'dropHandler' | 'trust'];

	/**
	 * Drops as the row says on the tabs of a new shown editor part with an
	 * editor service that opens files, once `prepareGroup` changed the group
	 * with the editors of the fixture, and describes the drop, the drop feedback
	 * right before it, and the group afterwards.
	 */
	async function dropFileOnFixture([fixture, names, target, side, source = 'explorer', refusal]: FileDropRow, editorConfiguration?: object, prepareGroup?: (group: IEditorGroupView, instantiationService: TestInstantiationService) => Promise<void>): Promise<string> {
		const [part, instantiationService] = await createShownPart(editorConfiguration);
		const editorService = disposables.add(instantiationService.createInstance(EditorService, undefined));
		instantiationService.stub(IEditorService, editorService);

		// Tabs open dropped tree items with the editor service they were created with
		const initialGroup = part.activeGroup;
		const group = part.addGroup(initialGroup, GroupDirection.RIGHT);
		part.removeGroup(initialGroup);
		await openFixture(group, fixture, fixtureNames => openPinnedFileEditors(editorService, group, fixtureNames));
		await prepareGroup?.(group, instantiationService);

		const droppedNames = names.split(' ');
		const dataTransfer = new DataTransfer();
		if (source === 'treeItem') {
			const treeItemData = new VSDataTransfer();
			treeItemData.append(Mimes.uriList, createStringDataTransferItem(UriList.create(droppedNames.map(name => URI.file(name)))));
			instantiationService.get(ITreeViewsDnDService).addDragOperationTransfer(names, Promise.resolve(treeItemData));
			LocalSelectionTransfer.getInstance<DraggedTreeItemsIdentifier>().setData([new DraggedTreeItemsIdentifier(names)], DraggedTreeItemsIdentifier.prototype);
		} else {
			const dragStart = new DragEvent(EventType.DRAG_START, { dataTransfer });
			instantiationService.invokeFunction(accessor => source === 'openEditors'
				? fillEditorsDragData(accessor, [{ editor: editorOf(group, names), groupId: group.id }], dragStart)
				: fillEditorsDragData(accessor, droppedNames.map(name => ({ resource: URI.file(name), isDirectory: false })), dragStart));
		}

		const refused = new DeferredPromise<void>();
		const dropHandler = refusal === 'dropHandler' ? Registry.as<IDragAndDropContributionRegistry>(DragAndDropExtensions.DragAndDropContribution).registerDropHandler({
			handleDrop: async () => {
				refused.complete();
				return true;
			}
		}) : undefined;
		if (refusal === 'trust') {
			instantiationService.createInstance(TestServiceAccessor).workspaceTrustRequestService.requestOpenUrisHandler = async () => {
				refused.complete();
				return WorkspaceTrustUriResponse.Cancel;
			};
		}

		// The group opens the first dropped editor active and then the others after it
		const opened = refusal ? refused.p : Promise.all([
			Event.toPromise(group.onDidActiveEditorChange),
			Event.toPromise(Event.filter(group.onWillOpenEditor, e => editorName(e.editor) === droppedNames.at(-1)))
		]);
		const dropTarget = dropTargetOf(group, target);
		dispatchDrags(dropTarget, [EventType.DRAG_ENTER, EventType.DRAG_OVER], side, { dataTransfer });
		const dropFeedback = tabBar(group);
		dispatchDrags(dropTarget, [EventType.DROP], side, { dataTransfer });
		await opened;
		dropHandler?.dispose();

		// A refused drop finishes right after it is refused
		if (refusal) {
			await timeout(0);
		}

		// The tab bar shows the editors that the group opens inactive once all of them opened
		for (let tries = 0; tries < 10 && !hasTabOfEveryShownEditor(group); tries++) {
			await timeout(0);
		}

		const drop = `${names}${source === 'treeItem' ? ' as a tree item' : ''} ${side} of ${target || 'the tabs'}${refusal === 'dropHandler' ? ', taken by a drop handler' : refusal === 'trust' ? ', with trust cancelled' : ''} [${dropFeedback}]: ${describeDrop(group)}`;

		// The editor service opened the files as editors that only closing them disposes
		await workbenchTeardown(instantiationService);

		return drop;
	}

	/**
	 * Opens a file editor for each name in the group through the editor
	 * service, pinned and in order, which a drop of the file with that name
	 * finds in the group.
	 */
	async function openPinnedFileEditors(editorService: IEditorService, group: IEditorGroup, names: readonly string[]): Promise<EditorInput[]> {
		const editors: EditorInput[] = [];
		for (const name of names) {
			await editorService.openEditor({ resource: URI.file(name), options: { pinned: true } }, group);
			editors.push(group.activeEditor!);
		}

		return editors;
	}

	/**
	 * Opens an editor for each name of the fixture in the group, pinned and in
	 * order, sticks those with an `s` after their name, and gathers those with
	 * the same letter after it into a tab stack, which a `^` collapses. The
	 * editors are test editors unless `openEditors` opens other ones.
	 */
	async function openFixture(group: IEditorGroup, fixture: string, openEditors: (names: string[]) => Promise<readonly EditorInput[]> = names => openPinnedTestEditors(group, ...names)): Promise<void> {
		const tokens = fixture.split(' ').map(token => /^(?<name>\d+)(?<sticky>s?)(?<tabStack>[a-e]?)(?<collapsed>\^?)$/.exec(token)!.groups!);
		const editors = await openEditors(tokens.map(({ name }) => name));
		editors.filter((_, index) => tokens[index].sticky).forEach(editor => group.stickEditor(editor));
		for (const letter of new Set(tokens.map(({ tabStack }) => tabStack).filter(letter => letter))) {
			const tabStack = group.addEditorsToTabStack(editors.filter((_, index) => tokens[index].tabStack === letter))!;
			group.updateTabStack(tabStack.id, { collapsed: tokens.some(token => token.tabStack === letter && token.collapsed) });
		}
	}

	function editorOf(group: IEditorGroup, name: string): EditorInput {
		return group.getEditors(EditorsOrder.SEQUENTIAL).find(editor => editorName(editor) === name)!;
	}

	function tabOf(group: IEditorGroupView, name: string): HTMLElement {
		return group.element.querySelector<HTMLElement>(`.tabs-container > .tab[data-resource-name="${name}"]`)!;
	}

	/**
	 * Returns whether the tab bar of the group has a tab for each editor of the
	 * group outside of collapsed tab stacks.
	 */
	function hasTabOfEveryShownEditor(group: IEditorGroupView): boolean {
		return group.getEditors(EditorsOrder.SEQUENTIAL).every(editor => group.getTabStack(editor)?.collapsed || !!tabOf(group, editorName(editor)));
	}

	function tabStackHeaderOf(group: IEditorGroupView, index: number): HTMLElement {
		return group.element.querySelectorAll<HTMLElement>('.tabs-container > .tab-stack-header')[index];
	}

	/**
	 * Returns the tab of the editor with the name, the header of the n-th tab
	 * stack for `H<n>`, or the tabs of editors that are not pinned for ''.
	 */
	function dropTargetOf(group: IEditorGroupView, target: string): HTMLElement {
		if (!target) {
			return Array.from(group.element.querySelectorAll<HTMLElement>('.tabs-container')).at(-1)!;
		}

		return target.startsWith('H') ? tabStackHeaderOf(group, Number(target.slice(1))) : tabOf(group, target);
	}

	/**
	 * Dispatches drag events near the left or right edge of a laid out tab, tab
	 * stack header or tabs container.
	 */
	function dispatchDrags(element: HTMLElement, types: string[], side: 'left' | 'right', init?: DragEventInit): void {
		const rect = element.getBoundingClientRect();
		assert.ok(rect.width > 0, 'a drag needs laid out tabs');
		for (const type of types) {
			element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: side === 'left' ? rect.left + 1 : rect.right - 1, dataTransfer: new DataTransfer(), ...init }));
		}
	}

	/**
	 * Starts a drag of editors of a group the way its tabs do.
	 */
	function dragEditors(sourceGroup: IEditorGroup, editors: readonly EditorInput[]): void {
		LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().setData(editors.map(editor => new DraggedEditorIdentifier({ editor, groupId: sourceGroup.id })), DraggedEditorIdentifier.prototype);
	}

	/**
	 * Describes the editors and the tab bar of a group after a drop, and the
	 * editors of the group that the drop came from when that is another one.
	 */
	function describeDrop(group: IEditorGroupView, sourceGroup?: IEditorGroup): string {
		return `${tabStackState(group)} [${tabBar(group)}]${sourceGroup ? `, source: ${tabStackState(sourceGroup) || 'empty'}` : ''}`;
	}

	/**
	 * A drop on the tabs of a group with the editors of the fixture, of editors
	 * of that group, or of editors of a second group with the editors of
	 * `sourceFixture`, near the left or right edge of what {@link dropTargetOf}
	 * returns for the target.
	 */
	type EditorsDropRow = readonly [fixture: string, dragged: string, target: string, side: 'left' | 'right', sourceFixture?: string];

	/**
	 * Drops as the row says on the tabs of a new shown editor part, and
	 * describes the drop, the drop feedback right before it, and the group
	 * afterwards.
	 */
	async function dropEditorsOnFixture([fixture, dragged, target, side, sourceFixture]: EditorsDropRow, editorConfiguration?: object, init?: DragEventInit): Promise<string> {
		const [part] = await createShownPart(editorConfiguration);
		const group = part.activeGroup;
		await openFixture(group, fixture);
		const sourceGroup = sourceFixture ? part.addGroup(group, GroupDirection.RIGHT) : undefined;
		if (sourceGroup && sourceFixture) {
			await openFixture(sourceGroup, sourceFixture);
		}

		dragEditors(sourceGroup ?? group, dragged.split(' ').map(name => editorOf(sourceGroup ?? group, name)));
		const dropTarget = dropTargetOf(group, target);
		dispatchDrags(dropTarget, [EventType.DRAG_ENTER, EventType.DRAG_OVER], side, init);
		const dropFeedback = tabBar(group);
		dispatchDrags(dropTarget, [EventType.DROP], side, init);

		return `${dragged} ${side} of ${target || 'the tabs'} [${dropFeedback}]: ${describeDrop(group, sourceGroup)}`;
	}

	/**
	 * Drags the header of the first tab stack of a new shown editor part with
	 * the editors of the fixture, drops it near the left or right edge of what
	 * {@link dropTargetOf} returns for the target, and describes the drop and
	 * the group afterwards.
	 */
	async function dropTabStackHeaderOnFixture(fixture: string, target: string, side: 'left' | 'right', editorConfiguration?: object): Promise<string> {
		const [part] = await createShownPart(editorConfiguration);
		const group = part.activeGroup;
		await openFixture(group, fixture);
		const header = tabStackHeaderOf(group, 0);

		dispatchDrags(header, [EventType.DRAG_START], 'left');
		dispatchDrags(dropTargetOf(group, target), [EventType.DRAG_ENTER, EventType.DRAG_OVER, EventType.DROP], side);
		dispatchDrags(header, [EventType.DRAG_END], 'left');

		return `H0 ${side} of ${target || 'the tabs'}: ${describeDrop(group)}`;
	}

	test('tab stacks - tabs dropped in their group land where the drop feedback shows: in a tab stack between its tabs, on its start slot and over the right half of its last tab, also a tab dropped on itself, and outside of it over the left half of the tab or header after it and otherwise', async () => {
		const drops = [];
		for (const [dragged, target, side] of [
			['5', '3', 'left'],
			['5', 'H0', 'right'],
			['5', '2', 'left'],
			['5', 'H0', 'left'],
			['1', '4', 'left'],
			['1', '4', 'right'],
			['1', 'H1', 'right'],
			['3', '4', 'right'],
			['3', '5', 'left'],
			['4', '5', 'left'],
			['3 5', '4', 'right'],
			['1', '7', 'right'],
			['1', '', 'left'],
		] as const) {
			drops.push(await dropEditorsOnFixture(['1 2a 3a 4a 5 6b^ 7', dragged, target, side]));
		}
		for (const [dragged, target, side] of [['3', 'H1', 'left'], ['3', '3', 'right']] as const) {
			drops.push(await dropEditorsOnFixture(['1 2a 3a 4b 5b', dragged, target, side]));
		}

		assert.deepStrictEqual(drops, [
			'5 left of 3 [1 H 2 = 3 4 5 H^ 7]: 1 2a 5a 3a 4a 6b^ 7* [1 H 2 5 3 4 H^ 7]',
			'5 right of H0 [1 H = 2 3 4 5 H^ 7]: 1 5a 2a 3a 4a 6b^ 7* [1 H 5 2 3 4 H^ 7]',
			'5 left of 2 [1 H = 2 3 4 5 H^ 7]: 1 5a 2a 3a 4a 6b^ 7* [1 H 5 2 3 4 H^ 7]',
			'5 left of H0 [1 _ H 2 3 4 5 H^ 7]: 1 5 2a 3a 4a 6b^ 7* [1 5 H 2 3 4 H^ 7]',
			'1 left of 4 [1 H 2 3 = 4 5 H^ 7]: 2a 3a 1a 4a 5 6b^ 7* [H 2 3 1 4 5 H^ 7]',
			'1 right of 4 [1 H 2 3 4 = 5 H^ 7]: 2a 3a 4a 1a 5 6b^ 7* [H 2 3 4 1 5 H^ 7]',
			'1 right of H1 [1 H 2 3 4 5 H^ _ 7]: 2a 3a 4a 5 6b^ 1 7* [H 2 3 4 5 H^ 1 7]',
			'3 right of 4 [1 H 2 3 4 = 5 H^ 7]: 1 2a 4a 3a 5 6b^ 7* [1 H 2 4 3 5 H^ 7]',
			'3 left of 5 [1 H 2 3 4 _ 5 H^ 7]: 1 2a 4a 3 5 6b^ 7* [1 H 2 4 3 5 H^ 7]',
			'4 left of 5 [1 H 2 3 4 _ 5 H^ 7]: 1 2a 3a 4 5 6b^ 7* [1 H 2 3 4 5 H^ 7]',
			'3 5 right of 4 [1 H 2 3 4 = 5 H^ 7]: 1 2a 4a 3a 5a 6b^ 7* [1 H 2 4 3 5 H^ 7]',
			'1 right of 7 [1 H 2 3 4 5 H^ 7 _]: 2a 3a 4a 5 6b^ 7* 1 [H 2 3 4 5 H^ 7 1]',
			'1 left of the tabs [1 H 2 3 4 5 H^ 7 _]: 2a 3a 4a 5 6b^ 7* 1 [H 2 3 4 5 H^ 7 1]',
			'3 left of H1 [1 H 2 3 _ H 4 5]: 1 2a 3 4b 5b* [1 H 2 3 H 4 5]',
			'3 right of 3 [1 H 2 3 = H 4 5]: 1 2a 3a 4b 5b* [1 H 2 3 H 4 5]',
		]);
	});

	test('tab stacks - a whole tab stack, also one of a single editor, dropped in its group lands where the drop feedback shows, and stays one outside of other tab stacks and joins another one inside of it', async () => {
		const drops = [];
		for (const row of [
			['1 2a 3a 4', '2 3', 'H0', 'left'],
			['1 2a 3a 4', '2 3', '1', 'left'],
			['1 2a 3a 4b 5b', '2 3', '', 'left'],
			['1 2a 3a 4b 5b', '2 3', '5', 'right'],
			['1 2a 3a 4b 5b', '2 3', '5', 'left'],
			['1 2a 3a 4b^ 5', '2 3', 'H1', 'right'],
			['1 2a 3 4b', '2', 'H1', 'left'],
		] as const) {
			drops.push(await dropEditorsOnFixture(row));
		}

		assert.deepStrictEqual(drops, [
			'2 3 left of H0 [1 _ H 2 3 4]: 1 2a 3a 4* [1 H 2 3 4]',
			'2 3 left of 1 [_ 1 H 2 3 4]: 2a 3a 1 4* [H 2 3 1 4]',
			'2 3 left of the tabs [1 H 2 3 H 4 5 _]: 1 4a 5a* 2b 3b [1 H 4 5 H 2 3]',
			'2 3 right of 5 [1 H 2 3 H 4 5 =]: 1 4a 5a* 2a 3a [1 H 4 5 2 3]',
			'2 3 left of 5 [1 H 2 3 H 4 = 5]: 1 4a 2a 3a 5a* [1 H 4 2 3 5]',
			'2 3 right of H1 [1 H 2 3 H^ _ 5]: 1 4a^ 2b 3b 5* [1 H^ H 2 3 5]',
			'2 left of H1 [1 H 2 3 _ H 4]: 1 3 2a 4b* [1 3 H 2 H 4]',
		]);
	});

	test('tab stacks - pinned tabs dropped in a group with tab stacks are unpinned past the slot right after the pinned tabs, also on the start slot of a tab stack there, where they move together with the other tabs the way unpinned tabs do, and stay pinned on that slot and among them', async () => {
		const drops = [];
		for (const row of [
			['0s 1 2a 3a 4', '0', '4', 'left'],
			['0s 1 2a 3a 4', '0', '3', 'left'],
			['0s 1 2a 3a 4', '0', '3', 'right'],
			['0s 1 2a 3a 4', '4', '0', 'left'],
			['0s 1 2a 3a 4', '4', '0', 'right'],
			['0s 1 2a 3a 4', '0', 'H0', 'right', '0'],
			['1s 2 3a 4a', '1 3', 'H0', 'left'],
			['1s 2 3a 4a', '1 4', 'H0', 'left'],
			['1s 2 3a 4a', '1 2', '4', 'left'],
			['1s 2a 3a', '3', 'H0', 'left'],
			['1s 2a 3a', '1 3', 'H0', 'left'],
			['1s 2a 3a 4', '1 4', 'H0', 'right'],
			['1s 2a 3a', '1', 'H0', 'right'],
			['1s 2a 3a', '1', '2', 'left'],
		] as const) {
			drops.push(await dropEditorsOnFixture(row));
		}
		drops.push(await dropEditorsOnFixture(['0s 1 2a 3a 4', '1', '0', 'right'], { pinnedTabsOnSeparateRow: true }));
		drops.push(await dropEditorsOnFixture(['1s 2 3a 4a', '1 3', 'H0', 'left'], { pinnedTabsOnSeparateRow: true }));

		assert.deepStrictEqual(drops, [
			'0 left of 4 [0 1 H 2 3 _ 4]: 1 2a 3a 0 4* [1 H 2 3 0 4]',
			'0 left of 3 [0 1 H 2 = 3 4]: 1 2a 0a 3a 4* [1 H 2 0 3 4]',
			'0 right of 3 [0 1 H 2 3 = 4]: 1 2a 3a 0a 4* [1 H 2 3 0 4]',
			'4 left of 0 [_ 0 1 H 2 3 4]: 4s* 0s 1 2a 3a [4 0 1 H 2 3]',
			'4 right of 0 [0 _ 1 H 2 3 4]: 0s 4* 1 2a 3a [0 4 1 H 2 3]',
			'0 right of H0 [0 1 H = 2 3 4]: 1 0a* 2a 3a 4 [1 H 0 2 3 4], source: empty',
			'1 3 left of H0 [1 2 _ H 3 4]: 2 1 3 4a* [2 1 3 H 4]',
			'1 4 left of H0 [1 2 _ H 3 4]: 2 1 4* 3a [2 1 4 H 3]',
			'1 2 left of 4 [1 2 H 3 = 4]: 3a 1a 2a 4a* [H 3 1 2 4]',
			'3 left of H0 [1 _ H 2 3]: 1s 3* 2a [1 3 H 2]',
			'1 3 left of H0 [1 _ H 2 3]: 1s 3* 2a [1 3 H 2]',
			'1 4 right of H0 [1 H = 2 3 4]: 1a 4a* 2a 3a [H 1 4 2 3]',
			'1 right of H0 [1 H = 2 3]: 1a 2a 3a* [H 1 2 3]',
			'1 left of 2 [1 H = 2 3]: 1a 2a 3a* [H 1 2 3]',
			'1 right of 0 [0 _ | 1 H 2 3 4]: 0s 1s 2a 3a 4* [0 1 | H 2 3 4]',
			'1 3 left of H0 [1 | 2 _ H 3 4]: 2 1 3 4a* [ | 2 1 3 H 4]',
		]);
	});

	test('tab stacks - tabs dropped on the empty space of the tabs after a tab stack land outside of it, also its own tabs, and those dropped over the right half of its last tab land in it', async () => {
		const drops = [];
		for (const row of [
			['1 2 3a 4a', '3', '', 'left'],
			['1 2 3a 4a', '3', '4', 'right'],
			['1 2 3a 4a', '1', '', 'left'],
			['1 2 3a 4a', '1', '4', 'right'],
			['1 2 3a 4a', '1 3', '', 'left'],
			['1 2 3a 4a', '5', '', 'left', '5'],
			['1 2 3a^ 4a^', '1', '', 'left'],
			['1 2 3a^ 4a^', '5', '', 'left', '5'],
		] as const) {
			drops.push(await dropEditorsOnFixture(row));
		}

		assert.deepStrictEqual(drops, [
			'3 left of the tabs [1 2 H 3 4 _]: 1 2 4a* 3 [1 2 H 4 3]',
			'3 right of 4 [1 2 H 3 4 =]: 1 2 4a* 3a [1 2 H 4 3]',
			'1 left of the tabs [1 2 H 3 4 _]: 2 3a 4a* 1 [2 H 3 4 1]',
			'1 right of 4 [1 2 H 3 4 =]: 2 3a 4a* 1a [2 H 3 4 1]',
			'1 3 left of the tabs [1 2 H 3 4 _]: 2 4a* 1 3 [2 H 4 1 3]',
			'5 left of the tabs [1 2 H 3 4 _]: 1 2 3a 4a 5* [1 2 H 3 4 5], source: empty',
			'1 left of the tabs [1 2 H^ _]: 2* 3a^ 4a^ 1 [2 H^ 1]',
			'5 left of the tabs [1 2 H^ _]: 1 2 3a^ 4a^ 5* [1 2 H^ 5], source: empty',
		]);
	});

	test('tab stacks - tabs dropped from another group land where the drop feedback shows, also as a copy: in a tab stack between its tabs, on its start slot and over the right half of its last tab, and outside of it over the left half of the tab after it and after a collapsed tab stack', async () => {
		const drops = [];
		for (const [dragged, target, side] of [
			['7', '3', 'left'],
			['7', 'H0', 'right'],
			['7', '2', 'left'],
			['7', 'H0', 'left'],
			['7', '3', 'right'],
			['7', '4', 'left'],
			['7', 'H1', 'right'],
			['7 8', '3', 'left'],
		] as const) {
			drops.push(await dropEditorsOnFixture(['1 2a 3a 4 5b^ 6', dragged, target, side, '7 8']));
		}
		drops.push(await dropEditorsOnFixture(['1 2a 3a 4 5b^ 6', '7', '3', 'left', '7 8'], undefined, { altKey: isMacintosh, ctrlKey: !isMacintosh }));

		assert.deepStrictEqual(drops, [
			'7 left of 3 [1 H 2 = 3 4 H^ 6]: 1 2a 7a* 3a 4 5b^ 6 [1 H 2 7 3 4 H^ 6], source: 8*',
			'7 right of H0 [1 H = 2 3 4 H^ 6]: 1 7a* 2a 3a 4 5b^ 6 [1 H 7 2 3 4 H^ 6], source: 8*',
			'7 left of 2 [1 H = 2 3 4 H^ 6]: 1 7a* 2a 3a 4 5b^ 6 [1 H 7 2 3 4 H^ 6], source: 8*',
			'7 left of H0 [1 _ H 2 3 4 H^ 6]: 1 7* 2a 3a 4 5b^ 6 [1 7 H 2 3 4 H^ 6], source: 8*',
			'7 right of 3 [1 H 2 3 = 4 H^ 6]: 1 2a 3a 7a* 4 5b^ 6 [1 H 2 3 7 4 H^ 6], source: 8*',
			'7 left of 4 [1 H 2 3 _ 4 H^ 6]: 1 2a 3a 7* 4 5b^ 6 [1 H 2 3 7 4 H^ 6], source: 8*',
			'7 right of H1 [1 H 2 3 4 H^ _ 6]: 1 2a 3a 4 5b^ 7* 6 [1 H 2 3 4 H^ 7 6], source: 8*',
			'7 8 left of 3 [1 H 2 = 3 4 H^ 6]: 1 2a 7a 8a* 3a 4 5b^ 6 [1 H 2 7 8 3 4 H^ 6], source: empty',
			'7 left of 3 [1 H 2 = 3 4 H^ 6]: 1 2a 7a* 3a 4 5b^ 6 [1 H 2 7 3 4 H^ 6], source: 7 8*',
		]);
	});

	test('tab stacks - an editor that the group has already, dropped from another group, lands where the drop feedback shows and joins a tab stack only between its tabs, on its start slot or over the right half of its last tab', async () => {
		const drops = [];
		for (const row of [
			['1 2a 3a 4b 5b', '1', 'H1', 'left', '1'],
			['1 2a 3a 4b 5b', '1', '3', 'right', '1'],
			['1 2a 3a 4b 5b', '1', '5', 'left', '1'],
			['1 2a 3a 4b 5b', '1', 'H0', 'right', '1'],
			['1 2a 3a 4b^ 5b^', '1', 'H1', 'left', '1'],
			['1 2a 3a 4b^ 5b^', '1', 'H1', 'right', '1'],
			['1a 2a 3', '3', 'H0', 'right', '3'],
			['1a 2a 3', '1', 'H0', 'left', '1'],
		] as const) {
			drops.push(await dropEditorsOnFixture(row));
		}

		assert.deepStrictEqual(drops, [
			'1 left of H1 [1 H 2 3 _ H 4 5]: 2a 3a 1* 4b 5b [H 2 3 1 H 4 5], source: empty',
			'1 right of 3 [1 H 2 3 = H 4 5]: 2a 3a 1a* 4b 5b [H 2 3 1 H 4 5], source: empty',
			'1 left of 5 [1 H 2 3 H 4 = 5]: 2a 3a 4b 1b* 5b [H 2 3 H 4 1 5], source: empty',
			'1 right of H0 [1 H = 2 3 H 4 5]: 1a* 2a 3a 4b 5b [H 1 2 3 H 4 5], source: empty',
			'1 left of H1 [1 H 2 3 _ H^]: 2a 3a 1* 4b^ 5b^ [H 2 3 1 H^], source: empty',
			'1 right of H1 [1 H 2 3 H^ _]: 2a 3a 4b^ 5b^ 1* [H 2 3 H^ 1], source: empty',
			'3 right of H0 [H = 1 2 3]: 3a* 1a 2a [H 3 1 2], source: empty',
			'1 left of H0 [_ H 1 2 3]: 1* 2a 3 [1 H 2 3], source: empty',
		]);
	});

	test('tab stacks - files dropped inside a tab stack open after it, and those dropped on its start slot open before its header', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const [target, side] of [['3', 'left'], ['4', 'left'], ['H0', 'right'], ['2', 'left']] as const) {
			drops.push(await dropFileOnFixture(['1 2a 3a 4a 5', '9', target, side]));
		}

		assert.deepStrictEqual(drops, [
			'9 left of 3 [1 H 2 3 4 _ 5]: 1 2a 3a 4a 9* 5 [1 H 2 3 4 9 5]',
			'9 left of 4 [1 H 2 3 4 _ 5]: 1 2a 3a 4a 9* 5 [1 H 2 3 4 9 5]',
			'9 right of H0 [1 _ H 2 3 4 5]: 1 9* 2a 3a 4a 5 [1 9 H 2 3 4 5]',
			'9 left of 2 [1 _ H 2 3 4 5]: 1 9* 2a 3a 4a 5 [1 9 H 2 3 4 5]',
		]);
	});

	test('tab stacks - a single file dropped from the Explorer or as a tree item lands where the drop feedback shows, which is outside of tab stacks, so one that the group has already leaves its own unless it is its only editor', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const row of [
			['1 2a 3a 4b 5b 6c 7c', '1', 'H1', 'left'],
			['1 2a 3a 4b 5b 6c 7c', '1', '5', 'left'],
			['1 2a 3a 4b 5b 6c 7c', '1', 'H0', 'right'],
			['1 2a 3a 4b 5b 6c 7c', '6', 'H0', 'left'],
			['1 2a 3a 4b 5b 6c 7c', '9', 'H1', 'left'],
			['1 2a 3a 4b 5b 6c 7c', '1', 'H1', 'left', 'treeItem'],
			['1 2a^ 3a^ 4', '2', 'H0', 'right'],
			['1 2a^ 3a^ 4', '3', 'H0', 'right'],
			['1 2a^ 3a^ 4', '3', 'H0', 'left'],
			['1 2 3a 4a', '3', 'H0', 'left'],
			['1 2a 3a 4', '2', '3', 'right'],
			['1 2a 3a 4', '2', '4', 'left'],
			['1 2a 3a 4', '1', '3', 'right'],
			['1 2a 3a 4a 5', '2', '4', 'left'],
			['1 2a 3a', '2', '', 'left'],
			['1 2a 3', '2', '', 'left'],
			['1 2a^ 3a^ 4', '2', 'H0', 'right', 'treeItem'],
		] as const) {
			drops.push(await dropFileOnFixture(row));
		}

		assert.deepStrictEqual(drops, [
			'1 left of H1 [1 H 2 3 _ H 4 5 H 6 7]: 2a 3a 1* 4b 5b 6c 7c [H 2 3 1 H 4 5 H 6 7]',
			'1 left of 5 [1 H 2 3 H 4 5 _ H 6 7]: 2a 3a 4b 5b 1* 6c 7c [H 2 3 H 4 5 1 H 6 7]',
			'1 right of H0 [1 _ H 2 3 H 4 5 H 6 7]: 1* 2a 3a 4b 5b 6c 7c [1 H 2 3 H 4 5 H 6 7]',
			'6 left of H0 [1 _ H 2 3 H 4 5 H 6 7]: 1 6* 2a 3a 4b 5b 7c [1 6 H 2 3 H 4 5 H 7]',
			'9 left of H1 [1 H 2 3 _ H 4 5 H 6 7]: 1 2a 3a 9* 4b 5b 6c 7c [1 H 2 3 9 H 4 5 H 6 7]',
			'1 as a tree item left of H1 [1 H 2 3 _ H 4 5 H 6 7]: 2a 3a 1* 4b 5b 6c 7c [H 2 3 1 H 4 5 H 6 7]',
			'2 right of H0 [1 H^ _ 4]: 1 3a^ 2* 4 [1 H^ 2 4]',
			'3 right of H0 [1 H^ _ 4]: 1 2a^ 3* 4 [1 H^ 3 4]',
			'3 left of H0 [1 _ H^ 4]: 1 3* 2a^ 4 [1 3 H^ 4]',
			'3 left of H0 [1 2 _ H 3 4]: 1 2 3* 4a [1 2 3 H 4]',
			'2 right of 3 [1 H 2 3 _ 4]: 1 3a 2* 4 [1 H 3 2 4]',
			'2 left of 4 [1 H 2 3 _ 4]: 1 3a 2* 4 [1 H 3 2 4]',
			'1 right of 3 [1 H 2 3 _ 4]: 2a 3a 1* 4 [H 2 3 1 4]',
			'2 left of 4 [1 H 2 3 4 _ 5]: 1 3a 4a 2* 5 [1 H 3 4 2 5]',
			'2 left of the tabs [1 H 2 3 _]: 1 3a 2* [1 H 3 2]',
			'2 left of the tabs [1 H 2 3 _]: 1 3 2a* [1 3 H 2]',
			'2 as a tree item right of H0 [1 H^ _ 4]: 1 3a^ 2* 4 [1 H^ 2 4]',
		]);
	});

	test('tab stacks - files that the group has already, one in a side by side or diff editor, dropped from the Explorer or the Open Editors view, land in drop order where the drop feedback shows, also with tab stacks disabled, and never join a tab stack', async () => {
		disposables.add(registerTestFileEditor());

		// The editors that splitting an editor in its group and comparing a file with another one replace it with
		const splitFirstEditor = async (group: IEditorGroupView, instantiationService: TestInstantiationService) => {
			const editor = editorOf(group, '1');
			await group.replaceEditors([{ editor, replacement: instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, editor, editor) }]);
		};
		const compareFirstEditor = async (group: IEditorGroupView, instantiationService: TestInstantiationService) => {
			const diffEditor = instantiationService.invokeFunction(accessor => accessor.get(ITextEditorService).createTextEditor({ original: { resource: URI.file('0') }, modified: { resource: URI.file('1') } }));
			await group.replaceEditors([{ editor: editorOf(group, '1'), replacement: diffEditor }]);
		};

		const drops = [
			await dropFileOnFixture(['1 2a 3a 4b 5b', '1', 'H1', 'left'], undefined, splitFirstEditor),
			await dropFileOnFixture(['1 2 3a 4a', '1', 'H0', 'left', 'openEditors'], undefined, compareFirstEditor),
			await dropFileOnFixture(['1 2 3a 4a', '1 2', 'H0', 'left'], undefined, splitFirstEditor),
			await dropFileOnFixture(['1 2 3 4', '1 2', '3', 'right'], { enableTabStacks: false }, splitFirstEditor),
		];

		assert.deepStrictEqual(drops, [
			'1 left of H1 [1 H 2 3 _ H 4 5]: 2a 3a 1* 4b 5b [H 2 3 1 H 4 5]',
			'1 left of H0 [1 2 _ H 3 4]: 2 1* 3a 4a [2 1 H 3 4]',
			'1 2 left of H0 [1 2 _ H 3 4]: 1* 2 3a 4a [1 2 H 3 4]',
			'1 2 right of 3 [1 2 3 _ 4]: 3 1* 2 4 [3 1 2 4]',
		]);
	});

	test('tab stacks - a file that the group has only in an editor of another kind, dropped from the Explorer, opens where the drop feedback shows and leaves that editor in place, also with tab stacks disabled', async () => {
		disposables.add(registerTestFileEditor());

		// The editor that reopening an editor with another editor replaces it with
		const reopenFirstEditorWithOtherEditor = async (group: IEditorGroupView) => {
			await group.replaceEditors([{ editor: editorOf(group, '1'), replacement: createTestFileEditorInput(URI.file('1'), 'otherKind') }]);
		};

		const drops = [
			await dropFileOnFixture(['1 2a 3a 4', '1', '4', 'left'], undefined, reopenFirstEditorWithOtherEditor),
			await dropFileOnFixture(['1 2 3 4', '1', '3', 'left'], { enableTabStacks: false }, reopenFirstEditorWithOtherEditor),
		];

		assert.deepStrictEqual(drops, [
			'1 left of 4 [1 H 2 3 _ 4]: 1 2a 3a 1* 4 [1 H 2 3 1 4]',
			'1 left of 3 [1 2 _ 3 4]: 1 2 1* 3 4 [1 2 1 3 4]',
		]);
	});

	test('tab stacks - files dropped from the Explorer land in drop order where the drop feedback shows, which is outside of tab stacks, so those that the group has already leave their tab stack unless they are all of its editors and no file opens between them', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const row of [
			['1 2 3', '9 1', '3', 'right'],
			['1 2 3a 4a', '9 1', 'H0', 'left'],
			['1 2 3a 4a', '9 1', 'H0', 'left', 'treeItem'],
			['1 2 3a 4a', '1 9', 'H0', 'left'],
			['1 2 3a 4a', '1 9 2', 'H0', 'left'],
			['1 2a 3a 4b 5b 6c 7c', '3 4', 'H2', 'left'],
			['1 2a^ 3a^ 4a^ 5', '2 3', 'H0', 'right'],
			['1 2a^ 3a^ 4', '2 3', 'H0', 'right'],
			['1 2a 3a 4a 5', '2 3', '4', 'right'],
			['1 2a 3a 4', '9 2', '3', 'right'],
			['1 2a 3a 4a 5', '4 3 2', '1', 'left'],
			['1 2a 3a 4a 5', '2 9 3', '4', 'right'],
			['1 2a^ 3a^ 4', '2 9 3', 'H0', 'right'],
			['1s 2s 3a 4a 5', '2 3', '2', 'left'],
			['1s 2 3a 4a 5', '1 2 4', '2', 'left'],
		] as const) {
			drops.push(await dropFileOnFixture(row));
		}

		assert.deepStrictEqual(drops, [
			'9 1 right of 3 [1 2 3 _]: 2 3 9* 1 [2 3 9 1]',
			'9 1 left of H0 [1 2 _ H 3 4]: 2 9* 1 3a 4a [2 9 1 H 3 4]',
			'9 1 as a tree item left of H0 [1 2 _ H 3 4]: 2 9* 1 3a 4a [2 9 1 H 3 4]',
			'1 9 left of H0 [1 2 _ H 3 4]: 2 1* 9 3a 4a [2 1 9 H 3 4]',
			'1 9 2 left of H0 [1 2 _ H 3 4]: 1* 9 2 3a 4a [1 9 2 H 3 4]',
			'3 4 left of H2 [1 H 2 3 H 4 5 _ H 6 7]: 1 2a 5b 3* 4 6c 7c [1 H 2 H 5 3 4 H 6 7]',
			'2 3 right of H0 [1 H^ _ 5]: 1 4a^ 2* 3 5 [1 H^ 2 3 5]',
			'2 3 right of H0 [1 H^ _ 4]: 1 2a* 3a 4 [1 H 2 3 4]',
			'2 3 right of 4 [1 H 2 3 4 _ 5]: 1 4a 2* 3 5 [1 H 4 2 3 5]',
			'9 2 right of 3 [1 H 2 3 _ 4]: 1 3a 9* 2 4 [1 H 3 9 2 4]',
			'4 3 2 left of 1 [_ 1 H 2 3 4 5]: 4a* 3a 2a 1 5 [H 4 3 2 1 5]',
			'2 9 3 right of 4 [1 H 2 3 4 _ 5]: 1 4a 2* 9 3 5 [1 H 4 2 9 3 5]',
			'2 9 3 right of H0 [1 H^ _ 4]: 1 2* 9 3 4 [1 2 9 3 4]',
			'2 3 left of 2 [1 _ 2 H 3 4 5]: 1s 2s* 3 4a 5 [1 2 3 H 4 5]',
			'1 2 4 left of 2 [1 _ 2 H 3 4 5]: 1s* 2 4 3a 5 [1 2 4 H 3 5]',
		]);
	});

	test('tab stacks - with tab stacks disabled, files that the group has already, dropped from the Explorer or as a tree item, land in drop order where the drop feedback shows', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const row of [
			['1 2 3 4', '1', '3', 'right'],
			['1 2 3 4', '3', '1', 'left'],
			['1 2 3 4', '1', '3', 'right', 'treeItem'],
			['1s 2s 3 4', '2', '3', 'right'],
			['1s 2s 3 4', '2', '3', 'left'],
			['1s 2s 3 4', '9 2', '3', 'left'],
			['1s 2s 3 4', '1 2', '3', 'left'],
			['1 2 3 4', '9 1', '3', 'right'],
			['1 2 3 4 5', '3 2 1', '4', 'right'],
		] as const) {
			drops.push(await dropFileOnFixture(row, { enableTabStacks: false }));
		}

		assert.deepStrictEqual(drops, [
			'1 right of 3 [1 2 3 _ 4]: 2 3 1* 4 [2 3 1 4]',
			'3 left of 1 [_ 1 2 3 4]: 3* 1 2 4 [3 1 2 4]',
			'1 as a tree item right of 3 [1 2 3 _ 4]: 2 3 1* 4 [2 3 1 4]',
			'2 right of 3 [1 2 3 _ 4]: 1s 3 2* 4 [1 3 2 4]',
			'2 left of 3 [1 2 _ 3 4]: 1s 2s* 3 4 [1 2 3 4]',
			'9 2 left of 3 [1 2 _ 3 4]: 1s 9* 2 3 4 [1 9 2 3 4]',
			'1 2 left of 3 [1 2 _ 3 4]: 1s* 2s 3 4 [1 2 3 4]',
			'9 1 right of 3 [1 2 3 _ 4]: 2 3 9* 1 4 [2 3 9 1 4]',
			'3 2 1 right of 4 [1 2 3 4 _ 5]: 4 3* 2 1 5 [4 3 2 1 5]',
		]);
	});

	test('tab stacks - with pinned tabs on a separate row, pinned files that the group has already, dropped on the other tabs, are unpinned where the drop feedback shows', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const [row, enableTabStacks] of [
			[['1s 2s 3 4', '2', '3', 'left'], false],
			[['1s 2s 3 4', '1', '4', 'right'], false],
			[['1s 2s 3a 4a 5', '2', 'H0', 'left'], true],
			[['1s 2s 3a 4a 5', '9 2 1', 'H0', 'left'], true],
		] as const) {
			drops.push(await dropFileOnFixture(row, { enableTabStacks, pinnedTabsOnSeparateRow: true }));
		}

		assert.deepStrictEqual(drops, [
			'2 left of 3 [1 2 | _ 3 4]: 1s 2* 3 4 [1 | 2 3 4]',
			'1 right of 4 [1 2 | 3 4 _]: 2s 3 4 1* [2 | 3 4 1]',
			'2 left of H0 [1 2 | _ H 3 4 5]: 1s 2* 3a 4a 5 [1 | 2 H 3 4 5]',
			'9 2 1 left of H0 [1 2 | _ H 3 4 5]: 9* 2 1 3a 4a 5 [ | 9 2 1 H 3 4 5]',
		]);
	});

	test('tab stacks - pinned files that the group has already, dropped after the pinned tabs, are unpinned where the drop feedback shows and none joins another tab stack, and those dropped right after the pinned tabs stay pinned unless they follow a file that is not pinned or that the group does not have yet in drop order', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const row of [
			['1s 2a 3a', '1 3', '', 'left'],
			['1s 2 3a 4a 5', '1 4', '4', 'right'],
			['1s 2 3a 4a', '3 1', 'H0', 'left'],
			['1s 2a 3a 4a', '3 9 1', '', 'left'],
			['1s 2s 3 4a 5a', '1', '3', 'left'],
			['1s 2s 3 4', '1 2', '3', 'left'],
			['1s 2s 3 4', '9 2', '3', 'left'],
			['1s 2s 3a 4a', '9 2', 'H0', 'left'],
			['1s 2 3a 4a', '9 1', 'H0', 'left'],
			['1s 2a 3a 4', '2 1', 'H0', 'left'],
			['1s 2a 3a 4', '1 3', 'H0', 'left'],
			['1s 2a 3a 4', '1 2', 'H0', 'left'],
			['1s 2s 3a 4a 5', '3 2', 'H0', 'left'],
			['1s 2 3a 4a', '1 2 3', '2', 'left'],
		] as const) {
			drops.push(await dropFileOnFixture(row));
		}

		assert.deepStrictEqual(drops, [
			'1 3 left of the tabs [1 H 2 3 _]: 2a 1* 3 [H 2 1 3]',
			'1 4 right of 4 [1 2 H 3 4 _ 5]: 2 3a 1* 4 5 [2 H 3 1 4 5]',
			'3 1 left of H0 [1 2 _ H 3 4]: 2 3* 1 4a [2 3 1 H 4]',
			'3 9 1 left of the tabs [1 H 2 3 4 _]: 2a 4a 3* 9 1 [H 2 4 3 9 1]',
			'1 left of 3 [1 2 _ 3 H 4 5]: 2s 1s* 3 4a 5a [2 1 3 H 4 5]',
			'1 2 left of 3 [1 2 _ 3 4]: 1s* 2s 3 4 [1 2 3 4]',
			'9 2 left of 3 [1 2 _ 3 4]: 1s 9* 2 3 4 [1 9 2 3 4]',
			'9 2 left of H0 [1 2 _ H 3 4]: 1s 9* 2 3a 4a [1 9 2 H 3 4]',
			'9 1 left of H0 [1 2 _ H 3 4]: 2 9* 1 3a 4a [2 9 1 H 3 4]',
			'2 1 left of H0 [1 _ H 2 3 4]: 2* 1 3a 4 [2 1 H 3 4]',
			'1 3 left of H0 [1 _ H 2 3 4]: 1s* 3 2a 4 [1 3 H 2 4]',
			'1 2 left of H0 [1 _ H 2 3 4]: 1s* 2 3a 4 [1 2 H 3 4]',
			'3 2 left of H0 [1 2 _ H 3 4 5]: 1s 3* 2 4a 5 [1 3 2 H 4 5]',
			'1 2 3 left of 2 [1 _ 2 H 3 4]: 1s* 2 3 4a [1 2 3 H 4]',
		]);
	});

	test('tab stacks - files dropped from the Explorer that a registered drop handler takes, or files and tree items whose trust is cancelled, move, unpin and ungroup no editor, also with tab stacks disabled', async () => {
		disposables.add(registerTestFileEditor());

		const drops = [];
		for (const [row, enableTabStacks] of [
			[['1 2a 3a 4', '2', '4', 'left', 'explorer', 'dropHandler'], true],
			[['1 2a 3a 4', '2', '4', 'left', 'explorer', 'trust'], true],
			[['1 2a 3a 4', '2', '4', 'left', 'treeItem', 'trust'], true],
			[['1s 2s 3 4', '9 2', '3', 'left', 'explorer', 'dropHandler'], false],
			[['1s 2s 3 4', '9 2', '3', 'left', 'treeItem', 'trust'], false],
		] as const) {
			drops.push(await dropFileOnFixture(row, { enableTabStacks }));
		}

		assert.deepStrictEqual(drops, [
			'2 left of 4, taken by a drop handler [1 H 2 3 _ 4]: 1 2a 3a 4* [1 H 2 3 4]',
			'2 left of 4, with trust cancelled [1 H 2 3 _ 4]: 1 2a 3a 4* [1 H 2 3 4]',
			'2 as a tree item left of 4, with trust cancelled [1 H 2 3 _ 4]: 1 2a 3a 4* [1 H 2 3 4]',
			'9 2 left of 3, taken by a drop handler [1 2 _ 3 4]: 1s 2s 3 4* [1 2 3 4]',
			'9 2 as a tree item left of 3, with trust cancelled [1 2 _ 3 4]: 1s 2s 3 4* [1 2 3 4]',
		]);
	});

	test('tab stacks - files dropped on the tabs land where the drop feedback showed, also when an editor closes while the drop waits for trust, and with tab stacks disabled', async () => {
		disposables.add(registerTestFileEditor());

		// The trust prompt closes the first editor
		const closeFirstEditorOnTrustPrompt = async (group: IEditorGroupView, instantiationService: TestInstantiationService) => {
			const editor = editorOf(group, '1');
			instantiationService.createInstance(TestServiceAccessor).workspaceTrustRequestService.requestOpenUrisHandler = async () => {
				await group.closeEditor(editor);
				return WorkspaceTrustUriResponse.Open;
			};
		};

		const drops = [
			await dropFileOnFixture(['1 2a 3a 4', '2', '4', 'left'], undefined, closeFirstEditorOnTrustPrompt),
			await dropFileOnFixture(['1 2a 3a 4', '2', '4', 'left', 'treeItem'], undefined, closeFirstEditorOnTrustPrompt),
			await dropFileOnFixture(['1 2 3 4', '9', '3', 'left'], { enableTabStacks: false }, closeFirstEditorOnTrustPrompt),
		];

		assert.deepStrictEqual(drops, [
			'2 left of 4 [1 H 2 3 _ 4]: 3a 2* 4 [H 3 2 4]',
			'2 as a tree item left of 4 [1 H 2 3 _ 4]: 3a 2* 4 [H 3 2 4]',
			'9 left of 3 [1 2 _ 3 4]: 2 9* 3 4 [2 9 3 4]',
		]);
	});

	test('tab stacks - with tab stacks disabled, tabs dropped on tabs land where the drop feedback shows, also an editor that the group has already', async () => {
		const drops = [];
		for (const row of [
			['1 2 3 4', '1', '3', 'right'],
			['1 2 3 4', '2 4', '1', 'left'],
			['1 2 3 4', '3', '4', 'right'],
			['1 2 3 4', '1', '', 'left'],
			['1 2 3 4', '1', '4', 'left', '1'],
		] as const) {
			drops.push(await dropEditorsOnFixture(row, { enableTabStacks: false }));
		}

		assert.deepStrictEqual(drops, [
			'1 right of 3 [1 2 3 _ 4]: 2 3 1 4* [2 3 1 4]',
			'2 4 left of 1 [_ 1 2 3 4]: 2 4* 1 3 [2 4 1 3]',
			'3 right of 4 [1 2 3 4 _]: 1 2 4* 3 [1 2 4 3]',
			'1 left of the tabs [1 2 3 4 _]: 2 3 4* 1 [2 3 4 1]',
			'1 left of 4 [1 2 3 _ 4]: 2 3 1* 4 [2 3 1 4], source: empty',
		]);
	});

	test('tab stacks - an editor group dropped on the empty space of the tabs merges after the last editor, also with pinned tabs on a separate row', async () => {
		const drops = [];
		for (const [fixture, editorConfiguration] of [['1 2a 3a', {}], ['0s 1 2a 3a', { pinnedTabsOnSeparateRow: true }]] as const) {
			const [part] = await createShownPart(editorConfiguration);
			const group = part.activeGroup;
			await openFixture(group, fixture);
			const sourceGroup = part.addGroup(group, GroupDirection.RIGHT);
			await openFixture(sourceGroup, '4 5');

			LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>().setData([new DraggedEditorGroupIdentifier(sourceGroup.id)], DraggedEditorGroupIdentifier.prototype);
			dispatchDrags(dropTargetOf(group, ''), [EventType.DRAG_ENTER, EventType.DRAG_OVER, EventType.DROP], 'left');
			drops.push(describeDrop(group));
		}

		assert.deepStrictEqual(drops, [
			'1 2a 3a 4 5* [1 H 2 3 4 5]',
			'0s 1 2a 3a 4 5* [0 | 1 H 2 3 4 5]',
		]);
	});

	test('tab stacks - a dropped tab stack header lands before the tab under the drop, before or after another tab stack by its middle and after the pinned tabs, and does not move over or next to its tab stack', async () => {
		const drops = [];
		for (const [fixture, target, side] of [
			['1 2a 3a 4 5', '5', 'left'],
			['1 2a 3a 4 5', '5', 'right'],
			['1 2a 3a 4 5', '1', 'left'],
			['1 2a 3a 4 5', '', 'left'],
			['0s 1 2a 3a 4 5b 6b 7', '2', 'right'],
			['0s 1 2a 3a 4 5b 6b 7', 'H0', 'right'],
			['0s 1 2a 3a 4 5b 6b 7', '1', 'right'],
			['0s 1 2a 3a 4 5b 6b 7', '4', 'left'],
			['0s 1 2a 3a 4 5b 6b 7', '5', 'left'],
			['0s 1 2a 3a 4 5b 6b 7', '6', 'right'],
			['0s 1 2a 3a 4 5b 6b 7', '0', 'left'],
			['0s 1 2a 3a 4 5b^ 6b^ 7', 'H1', 'left'],
			['0s 1 2a 3a 4 5b^ 6b^ 7', 'H1', 'right'],
		] as const) {
			drops.push(await dropTabStackHeaderOnFixture(fixture, target, side));
		}
		for (const target of ['4', '0']) {
			drops.push(await dropTabStackHeaderOnFixture('0s 1 2a 3a 4', target, 'right', { pinnedTabsOnSeparateRow: true }));
		}

		assert.deepStrictEqual(drops, [
			'H0 left of 5: 1 4 2a 3a 5* [1 4 H 2 3 5]',
			'H0 right of 5: 1 4 5* 2a 3a [1 4 5 H 2 3]',
			'H0 left of 1: 2a 3a 1 4 5* [H 2 3 1 4 5]',
			'H0 left of the tabs: 1 4 5* 2a 3a [1 4 5 H 2 3]',
			'H0 right of 2: 0s 1 2a 3a 4 5b 6b 7* [0 1 H 2 3 4 H 5 6 7]',
			'H0 right of H0: 0s 1 2a 3a 4 5b 6b 7* [0 1 H 2 3 4 H 5 6 7]',
			'H0 right of 1: 0s 1 2a 3a 4 5b 6b 7* [0 1 H 2 3 4 H 5 6 7]',
			'H0 left of 4: 0s 1 2a 3a 4 5b 6b 7* [0 1 H 2 3 4 H 5 6 7]',
			'H0 left of 5: 0s 1 4 2a 3a 5b 6b 7* [0 1 4 H 2 3 H 5 6 7]',
			'H0 right of 6: 0s 1 4 5a 6a 2b 3b 7* [0 1 4 H 5 6 H 2 3 7]',
			'H0 left of 0: 0s 2a 3a 1 4 5b 6b 7* [0 H 2 3 1 4 H 5 6 7]',
			'H0 left of H1: 0s 1 4 2a 3a 5b^ 6b^ 7* [0 1 4 H 2 3 H^ 7]',
			'H0 right of H1: 0s 1 4 5a^ 6a^ 2b 3b 7* [0 1 4 H^ H 2 3 7]',
			'H0 right of 4: 0s 1 4* 2a 3a [0 | 1 4 H 2 3]',
			'H0 right of 0: 0s 1 2a 3a 4* [0 | 1 H 2 3 4]',
		]);
	});

	test('tab stacks - a tab stack header dragged right drops before the tab under the drop, and its editors move one at a time in an order that replays to the new order', async () => {
		const [part] = await createShownPart();
		const group = part.activeGroup;
		await openFixture(group, '1 2a 3a 4 5');

		// Replay the moves the way the extension host follows the tabs of a group
		const replayed = group.getEditors(EditorsOrder.SEQUENTIAL).map(editorName);
		disposables.add(group.onDidModelChange(e => {
			if (isGroupEditorMoveEvent(e)) {
				replayed.splice(e.editorIndex, 0, ...replayed.splice(e.oldEditorIndex, 1));
			}
		}));

		dispatchDrags(tabStackHeaderOf(group, 0), [EventType.DRAG_START], 'left');
		dispatchDrags(tabOf(group, '5'), [EventType.DRAG_ENTER, EventType.DRAG_OVER, EventType.DROP], 'left');

		assert.deepStrictEqual({ tabBar: tabBar(group), editors: tabStackState(group), replayed: replayed.join(' ') }, {
			tabBar: '1 4 H 2 3 5',
			editors: '1 4 2a 3a 5*',
			replayed: '1 4 2 3 5'
		});
	});

	test('tab stacks - the tabs of a copy of a group do not take a dragged tab stack header, although the copy has the same tab stack', async () => {
		const [part] = await createShownPart();
		const group = part.activeGroup;
		await openFixture(group, '1 2a 3');
		const copiedGroup = part.copyGroup(group, group, GroupDirection.RIGHT);
		const header = tabStackHeaderOf(group, 0);

		dispatchDrags(header, [EventType.DRAG_START], 'left');
		dispatchDrags(tabOf(copiedGroup, '3'), [EventType.DRAG_ENTER, EventType.DRAG_OVER], 'right');
		const dropFeedback = copiedGroup.element.querySelectorAll('.drop-target-left, .drop-target-right').length;
		dispatchDrags(tabOf(copiedGroup, '3'), [EventType.DROP], 'right');
		dispatchDrags(header, [EventType.DRAG_END], 'left');

		assert.deepStrictEqual({ sameTabStack: copiedGroup.tabStacks[0].id === group.tabStacks[0].id, dropFeedback, group: tabStackState(group), copiedGroup: tabStackState(copiedGroup) }, {
			sameTabStack: true,
			dropFeedback: 0,
			group: '1 2a 3*',
			copiedGroup: '1 2a 3*'
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
