/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EditorGroupModel, IGroupEditorChangeEvent, IGroupEditorCloseEvent, IGroupEditorMoveEvent, IGroupEditorOpenEvent, ISerializedEditorGroupModel, ISerializedEditorInput, isGroupEditorChangeEvent, isGroupEditorCloseEvent, isGroupEditorMoveEvent, isGroupEditorOpenEvent, parseTabStackColor, TabStackId } from '../../../../common/editor/editorGroupModel.js';
import { EditorExtensions, IEditorFactoryRegistry, IFileEditorInput, IEditorSerializer, CloseDirection, EditorsOrder, IResourceDiffEditorInput, IResourceSideBySideEditorInput, SideBySideEditor, EditorCloseContext, GroupModelChangeKind } from '../../../../common/editor.js';
import { URI } from '../../../../../base/common/uri.js';
import { TestLifecycleService, workbenchInstantiationService } from '../../workbenchTestServices.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { DiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { TestContextService, TestStorageService } from '../../../common/workbenchTestServices.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../common/editor/sideBySideEditorInput.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('EditorGroupModel', () => {

	let testInstService: TestInstantiationService | undefined;

	suiteTeardown(() => {
		testInstService?.dispose();
		testInstService = undefined;
	});

	function inst(editorConfiguration: object = {}): IInstantiationService {
		if (!testInstService) {
			testInstService = new TestInstantiationService();
		}
		const inst = testInstService;
		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(ILifecycleService, disposables.add(new TestLifecycleService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'right', focusRecentEditorAfterClose: true, ...editorConfiguration } });
		inst.stub(IConfigurationService, config);

		return inst;
	}

	function createEditorGroupModel(serialized?: ISerializedEditorGroupModel, editorConfiguration?: object): EditorGroupModel {
		const group = disposables.add(inst(editorConfiguration).createInstance(EditorGroupModel, serialized));

		disposables.add(toDisposable(() => {
			for (const editor of group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
				group.closeEditor(editor);
			}
		}));

		return group;
	}

	function closeAllEditors(group: EditorGroupModel): void {
		for (const editor of group.getEditors(EditorsOrder.SEQUENTIAL)) {
			group.closeEditor(editor, undefined, false);
		}
	}

	function closeEditors(group: EditorGroupModel, except: EditorInput, direction?: CloseDirection): void {
		const index = group.indexOf(except);
		if (index === -1) {
			return; // not found
		}

		// Close to the left
		if (direction === CloseDirection.LEFT) {
			for (let i = index - 1; i >= 0; i--) {
				group.closeEditor(group.getEditorByIndex(i)!);
			}
		}

		// Close to the right
		else if (direction === CloseDirection.RIGHT) {
			for (let i = group.getEditors(EditorsOrder.SEQUENTIAL).length - 1; i > index; i--) {
				group.closeEditor(group.getEditorByIndex(i)!);
			}
		}

		// Both directions
		else {
			group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).filter(editor => !editor.matches(except)).forEach(editor => group.closeEditor(editor));
		}
	}

	interface GroupEvents {
		locked: number[];
		active: number[];
		index: number[];
		label: number[];
		opened: IGroupEditorOpenEvent[];
		activated: IGroupEditorChangeEvent[];
		closed: IGroupEditorCloseEvent[];
		pinned: IGroupEditorChangeEvent[];
		unpinned: IGroupEditorChangeEvent[];
		sticky: IGroupEditorChangeEvent[];
		unsticky: IGroupEditorChangeEvent[];
		transient: IGroupEditorChangeEvent[];
		moved: IGroupEditorMoveEvent[];
		disposed: IGroupEditorChangeEvent[];
	}

	function groupListener(group: EditorGroupModel): GroupEvents {
		const groupEvents: GroupEvents = {
			active: [],
			index: [],
			label: [],
			locked: [],
			opened: [],
			closed: [],
			activated: [],
			pinned: [],
			unpinned: [],
			sticky: [],
			unsticky: [],
			transient: [],
			moved: [],
			disposed: []
		};

		disposables.add(group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.GROUP_LOCKED) {
				groupEvents.locked.push(group.id);
				return;
			} else if (e.kind === GroupModelChangeKind.GROUP_ACTIVE) {
				groupEvents.active.push(group.id);
				return;
			} else if (e.kind === GroupModelChangeKind.GROUP_INDEX) {
				groupEvents.index.push(group.id);
				return;
			} else if (e.kind === GroupModelChangeKind.GROUP_LABEL) {
				groupEvents.label.push(group.id);
				return;
			}
			if (!e.editor) {
				return;
			}
			switch (e.kind) {
				case GroupModelChangeKind.EDITOR_OPEN:
					if (isGroupEditorOpenEvent(e)) {
						groupEvents.opened.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_CLOSE:
					if (isGroupEditorCloseEvent(e)) {
						groupEvents.closed.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_ACTIVE:
					if (isGroupEditorChangeEvent(e)) {
						groupEvents.activated.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_PIN:
					if (isGroupEditorChangeEvent(e)) {
						group.isPinned(e.editor) ? groupEvents.pinned.push(e) : groupEvents.unpinned.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_STICKY:
					if (isGroupEditorChangeEvent(e)) {
						group.isSticky(e.editor) ? groupEvents.sticky.push(e) : groupEvents.unsticky.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_TRANSIENT:
					if (isGroupEditorChangeEvent(e)) {
						groupEvents.transient.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_MOVE:
					if (isGroupEditorMoveEvent(e)) {
						groupEvents.moved.push(e);
					}
					break;
				case GroupModelChangeKind.EDITOR_WILL_DISPOSE:
					if (isGroupEditorChangeEvent(e)) {
						groupEvents.disposed.push(e);
					}
					break;
			}
		}));

		return groupEvents;
	}

	let index = 0;
	class TestEditorInput extends EditorInput {

		readonly resource = undefined;

		constructor(public id: string) {
			super();
		}
		override get typeId() { return 'testEditorInputForGroups'; }
		override async resolve(): Promise<IDisposable> { return null!; }

		override matches(other: TestEditorInput): boolean {
			return other && this.id === other.id && other instanceof TestEditorInput;
		}

		setDirty(): void {
			this._onDidChangeDirty.fire();
		}

		setLabel(): void {
			this._onDidChangeLabel.fire();
		}
	}

	class NonSerializableTestEditorInput extends EditorInput {

		readonly resource = undefined;

		constructor(public id: string) {
			super();
		}
		override get typeId() { return 'testEditorInputForGroups-nonSerializable'; }
		override async resolve(): Promise<IDisposable | null> { return null; }

		override matches(other: NonSerializableTestEditorInput): boolean {
			return other && this.id === other.id && other instanceof NonSerializableTestEditorInput;
		}
	}

	class TestFileEditorInput extends EditorInput implements IFileEditorInput {

		readonly preferredResource;

		constructor(public id: string, public resource: URI) {
			super();

			this.preferredResource = this.resource;
		}
		override get typeId() { return 'testFileEditorInputForGroups'; }
		override get editorId() { return this.id; }
		override async resolve(): Promise<IDisposable | null> { return null; }
		setPreferredName(name: string): void { }
		setPreferredDescription(description: string): void { }
		setPreferredResource(resource: URI): void { }
		async setEncoding(encoding: string) { }
		getEncoding() { return undefined; }
		setPreferredEncoding(encoding: string) { }
		setForceOpenAsBinary(): void { }
		setPreferredContents(contents: string): void { }
		setLanguageId(languageId: string) { }
		setPreferredLanguageId(languageId: string) { }
		isResolved(): boolean { return false; }

		override matches(other: TestFileEditorInput): boolean {
			if (super.matches(other)) {
				return true;
			}

			if (other instanceof TestFileEditorInput) {
				return isEqual(other.resource, this.resource);
			}

			return false;
		}
	}

	function input(id = String(index++), nonSerializable?: boolean, resource?: URI): EditorInput {
		if (resource) {
			return disposables.add(new TestFileEditorInput(id, resource));
		}

		return nonSerializable ? disposables.add(new NonSerializableTestEditorInput(id)) : disposables.add(new TestEditorInput(id));
	}

	interface ISerializedTestInput {
		id: string;
	}

	class TestEditorInputSerializer implements IEditorSerializer {

		static disableSerialize = false;
		static disableDeserialize = false;

		canSerialize(editorInput: EditorInput): boolean {
			return true;
		}

		serialize(editorInput: EditorInput): string | undefined {
			if (TestEditorInputSerializer.disableSerialize) {
				return undefined;
			}

			const testEditorInput = <TestEditorInput>editorInput;
			const testInput: ISerializedTestInput = {
				id: testEditorInput.id
			};

			return JSON.stringify(testInput);
		}

		deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
			if (TestEditorInputSerializer.disableDeserialize) {
				return undefined;
			}

			const testInput: ISerializedTestInput = JSON.parse(serializedEditorInput);

			return disposables.add(new TestEditorInput(testInput.id));
		}
	}

	const disposables = new DisposableStore();

	setup(() => {
		TestEditorInputSerializer.disableSerialize = false;
		TestEditorInputSerializer.disableDeserialize = false;

		disposables.add(Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer('testEditorInputForGroups', TestEditorInputSerializer));
	});

	teardown(() => {
		disposables.clear();

		index = 1;
	});

	test('Clone Group', function () {
		const group = createEditorGroupModel();

		const input1 = input() as TestEditorInput;
		const input2 = input();
		const input3 = input();

		// Pinned and Active
		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		// Sticky
		group.stick(input2);
		assert.ok(group.isSticky(input2));

		// Locked
		assert.strictEqual(group.isLocked, false);
		group.lock(true);
		assert.strictEqual(group.isLocked, true);

		const clone = disposables.add(group.clone());
		assert.notStrictEqual(group.id, clone.id);
		assert.strictEqual(clone.count, 3);
		assert.strictEqual(clone.isLocked, false); // locking does not clone over

		let didEditorLabelChange = false;
		const toDispose = clone.onDidModelChange((e) => {
			if (e.kind === GroupModelChangeKind.EDITOR_LABEL) {
				didEditorLabelChange = true;
			}
		});
		input1.setLabel();
		assert.ok(didEditorLabelChange);

		assert.strictEqual(clone.isPinned(input1), true);
		assert.strictEqual(clone.isActive(input1), false);
		assert.strictEqual(clone.isSticky(input1), false);

		assert.strictEqual(clone.isPinned(input2), true);
		assert.strictEqual(clone.isActive(input2), false);
		assert.strictEqual(clone.isSticky(input2), true);

		assert.strictEqual(clone.isPinned(input3), false);
		assert.strictEqual(clone.isActive(input3), true);
		assert.strictEqual(clone.isSticky(input3), false);

		toDispose.dispose();
	});

	test('isActive - untyped', () => {
		const group = createEditorGroupModel();
		const input = disposables.add(new TestFileEditorInput('testInput', URI.file('fake')));
		const input2 = disposables.add(new TestFileEditorInput('testInput2', URI.file('fake2')));
		const untypedInput = { resource: URI.file('/fake'), options: { override: 'testInput' } };
		const untypedNonActiveInput = { resource: URI.file('/fake2'), options: { override: 'testInput2' } };

		group.openEditor(input, { pinned: true, active: true });
		group.openEditor(input2, { active: false });

		assert.ok(group.isActive(input));
		assert.ok(group.isActive(untypedInput));
		assert.ok(!group.isActive(untypedNonActiveInput));
	});

	test('openEditor - prefers existing side by side editor if same', () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);

		const group = createEditorGroupModel();
		const input1 = disposables.add(new TestFileEditorInput('testInput', URI.file('fake1')));
		const input2 = disposables.add(new TestFileEditorInput('testInput', URI.file('fake2')));

		const sideBySideInputSame = instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, input1, input1);
		const sideBySideInputDifferent = instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, input1, input2);

		let res = group.openEditor(sideBySideInputSame, { pinned: true, active: true });
		assert.strictEqual(res.editor, sideBySideInputSame);
		assert.strictEqual(res.isNew, true);

		res = group.openEditor(input1, { pinned: true, active: true, supportSideBySide: SideBySideEditor.BOTH });
		assert.strictEqual(res.editor, sideBySideInputSame);
		assert.strictEqual(res.isNew, false);

		group.closeEditor(sideBySideInputSame);
		res = group.openEditor(sideBySideInputDifferent, { pinned: true, active: true });
		assert.strictEqual(res.editor, sideBySideInputDifferent);
		assert.strictEqual(res.isNew, true);

		res = group.openEditor(input1, { pinned: true, active: true });
		assert.strictEqual(res.editor, input1);
		assert.strictEqual(res.isNew, true);
	});

	test('indexOf() - prefers direct matching editor over side by side matching one', () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);

		const group = createEditorGroupModel();
		const input1 = disposables.add(new TestFileEditorInput('testInput', URI.file('fake1')));

		const sideBySideInput = instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, input1, input1);

		group.openEditor(sideBySideInput, { pinned: true, active: true });
		assert.strictEqual(group.indexOf(sideBySideInput), 0);
		assert.strictEqual(group.indexOf(input1), -1);
		assert.strictEqual(group.indexOf(input1, undefined, { supportSideBySide: SideBySideEditor.BOTH }), 0);
		assert.strictEqual(group.indexOf(input1, undefined, { supportSideBySide: SideBySideEditor.ANY }), 0);

		group.openEditor(input1, { pinned: true, active: true });
		assert.strictEqual(group.indexOf(input1), 1);
		assert.strictEqual(group.indexOf(input1, undefined, { supportSideBySide: SideBySideEditor.BOTH }), 1);
		assert.strictEqual(group.indexOf(input1, undefined, { supportSideBySide: SideBySideEditor.ANY }), 1);
	});

	test('contains() - untyped', function () {
		const group = createEditorGroupModel();
		const instantiationService = workbenchInstantiationService(undefined, disposables);

		const input1 = input('input1', false, URI.file('/input1'));
		const input2 = input('input2', false, URI.file('/input2'));

		const untypedInput1 = { resource: URI.file('/input1'), options: { override: 'input1' } };
		const untypedInput2 = { resource: URI.file('/input2'), options: { override: 'input2' } };

		const diffInput1 = instantiationService.createInstance(DiffEditorInput, 'name', 'description', input1, input2, undefined);
		const diffInput2 = instantiationService.createInstance(DiffEditorInput, 'name', 'description', input2, input1, undefined);

		const untypedDiffInput1: IResourceDiffEditorInput = {
			original: untypedInput1,
			modified: untypedInput2
		};
		const untypedDiffInput2: IResourceDiffEditorInput = {
			original: untypedInput2,
			modified: untypedInput1
		};

		const sideBySideInputSame = instantiationService.createInstance(SideBySideEditorInput, 'name', undefined, input1, input1);
		const sideBySideInputDifferent = instantiationService.createInstance(SideBySideEditorInput, 'name', undefined, input1, input2);

		const untypedSideBySideInputSame: IResourceSideBySideEditorInput = {
			primary: untypedInput1,
			secondary: untypedInput1
		};
		const untypedSideBySideInputDifferent: IResourceSideBySideEditorInput = {
			primary: untypedInput2,
			secondary: untypedInput1
		};

		group.openEditor(input1, { pinned: true, active: true });

		assert.strictEqual(group.contains(untypedInput1), true);
		assert.strictEqual(group.contains(untypedInput1, { strictEquals: true }), false);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.BOTH }), true);
		assert.strictEqual(group.contains(untypedInput2), false);
		assert.strictEqual(group.contains(untypedInput2, { strictEquals: true }), false);
		assert.strictEqual(group.contains(untypedInput2, { supportSideBySide: SideBySideEditor.ANY }), false);
		assert.strictEqual(group.contains(untypedInput2, { supportSideBySide: SideBySideEditor.BOTH }), false);
		assert.strictEqual(group.contains(untypedDiffInput1), false);
		assert.strictEqual(group.contains(untypedDiffInput2), false);

		group.openEditor(input2, { pinned: true, active: true });

		assert.strictEqual(group.contains(untypedInput1), true);
		assert.strictEqual(group.contains(untypedInput2), true);
		assert.strictEqual(group.contains(untypedDiffInput1), false);
		assert.strictEqual(group.contains(untypedDiffInput2), false);

		group.openEditor(diffInput1, { pinned: true, active: true });

		assert.strictEqual(group.contains(untypedInput1), true);
		assert.strictEqual(group.contains(untypedInput2), true);
		assert.strictEqual(group.contains(untypedDiffInput1), true);
		assert.strictEqual(group.contains(untypedDiffInput2), false);

		group.openEditor(diffInput2, { pinned: true, active: true });

		assert.strictEqual(group.contains(untypedInput1), true);
		assert.strictEqual(group.contains(untypedInput2), true);
		assert.strictEqual(group.contains(untypedDiffInput1), true);
		assert.strictEqual(group.contains(untypedDiffInput2), true);

		group.closeEditor(input1);

		assert.strictEqual(group.contains(untypedInput1), false);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.BOTH }), false);
		assert.strictEqual(group.contains(untypedInput2), true);
		assert.strictEqual(group.contains(untypedDiffInput1), true);
		assert.strictEqual(group.contains(untypedDiffInput2), true);

		group.closeEditor(input2);

		assert.strictEqual(group.contains(untypedInput1), false);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedInput2), false);
		assert.strictEqual(group.contains(untypedInput2, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedDiffInput1), true);
		assert.strictEqual(group.contains(untypedDiffInput2), true);

		group.closeEditor(diffInput1);

		assert.strictEqual(group.contains(untypedInput1), false);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedInput2), false);
		assert.strictEqual(group.contains(untypedInput2, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedDiffInput1), false);
		assert.strictEqual(group.contains(untypedDiffInput2), true);

		group.closeEditor(diffInput2);

		assert.strictEqual(group.contains(untypedInput1), false);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), false);
		assert.strictEqual(group.contains(untypedInput2), false);
		assert.strictEqual(group.contains(untypedInput2, { supportSideBySide: SideBySideEditor.ANY }), false);
		assert.strictEqual(group.contains(untypedDiffInput1), false);
		assert.strictEqual(group.contains(untypedDiffInput2), false);

		assert.strictEqual(group.count, 0);
		group.openEditor(sideBySideInputSame, { pinned: true, active: true });
		assert.strictEqual(group.contains(untypedSideBySideInputSame), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.BOTH }), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY, strictEquals: true }), false);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.BOTH, strictEquals: true }), false);

		group.closeEditor(sideBySideInputSame);

		assert.strictEqual(group.count, 0);
		group.openEditor(sideBySideInputDifferent, { pinned: true, active: true });
		assert.strictEqual(group.contains(untypedSideBySideInputDifferent), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(untypedInput1, { supportSideBySide: SideBySideEditor.BOTH }), false);
	});

	test('contains()', () => {
		const group = createEditorGroupModel();
		const instantiationService = workbenchInstantiationService(undefined, disposables);

		const input1 = input();
		const input2 = input();

		const diffInput1 = instantiationService.createInstance(DiffEditorInput, 'name', 'description', input1, input2, undefined);
		const diffInput2 = instantiationService.createInstance(DiffEditorInput, 'name', 'description', input2, input1, undefined);

		const sideBySideInputSame = instantiationService.createInstance(SideBySideEditorInput, 'name', undefined, input1, input1);
		const sideBySideInputDifferent = instantiationService.createInstance(SideBySideEditorInput, 'name', undefined, input1, input2);

		group.openEditor(input1, { pinned: true, active: true });

		assert.strictEqual(group.contains(input1), true);
		assert.strictEqual(group.contains(input1, { strictEquals: true }), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(input2), false);
		assert.strictEqual(group.contains(input2, { strictEquals: true }), false);
		assert.strictEqual(group.contains(input2, { supportSideBySide: SideBySideEditor.ANY }), false);
		assert.strictEqual(group.contains(diffInput1), false);
		assert.strictEqual(group.contains(diffInput2), false);

		group.openEditor(input2, { pinned: true, active: true });

		assert.strictEqual(group.contains(input1), true);
		assert.strictEqual(group.contains(input2), true);
		assert.strictEqual(group.contains(diffInput1), false);
		assert.strictEqual(group.contains(diffInput2), false);

		group.openEditor(diffInput1, { pinned: true, active: true });

		assert.strictEqual(group.contains(input1), true);
		assert.strictEqual(group.contains(input2), true);
		assert.strictEqual(group.contains(diffInput1), true);
		assert.strictEqual(group.contains(diffInput2), false);

		group.openEditor(diffInput2, { pinned: true, active: true });

		assert.strictEqual(group.contains(input1), true);
		assert.strictEqual(group.contains(input2), true);
		assert.strictEqual(group.contains(diffInput1), true);
		assert.strictEqual(group.contains(diffInput2), true);

		group.closeEditor(input1);

		assert.strictEqual(group.contains(input1), false);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(input2), true);
		assert.strictEqual(group.contains(diffInput1), true);
		assert.strictEqual(group.contains(diffInput2), true);

		group.closeEditor(input2);

		assert.strictEqual(group.contains(input1), false);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(input2), false);
		assert.strictEqual(group.contains(input2, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(diffInput1), true);
		assert.strictEqual(group.contains(diffInput2), true);

		group.closeEditor(diffInput1);

		assert.strictEqual(group.contains(input1), false);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(input2), false);
		assert.strictEqual(group.contains(input2, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(diffInput1), false);
		assert.strictEqual(group.contains(diffInput2), true);

		group.closeEditor(diffInput2);

		assert.strictEqual(group.contains(input1), false);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), false);
		assert.strictEqual(group.contains(input2), false);
		assert.strictEqual(group.contains(input2, { supportSideBySide: SideBySideEditor.ANY }), false);
		assert.strictEqual(group.contains(diffInput1), false);
		assert.strictEqual(group.contains(diffInput2), false);

		const input3 = input(undefined, true, URI.parse('foo://bar'));

		const input4 = input(undefined, true, URI.parse('foo://barsomething'));

		group.openEditor(input3, { pinned: true, active: true });
		assert.strictEqual(group.contains(input4), false);
		assert.strictEqual(group.contains(input3), true);

		group.closeEditor(input3);

		assert.strictEqual(group.contains(input3), false);

		assert.strictEqual(group.count, 0);
		group.openEditor(sideBySideInputSame, { pinned: true, active: true });

		assert.strictEqual(group.contains(sideBySideInputSame), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.BOTH }), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY, strictEquals: true }), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.BOTH, strictEquals: true }), true);

		group.closeEditor(sideBySideInputSame);

		assert.strictEqual(group.count, 0);
		group.openEditor(sideBySideInputDifferent, { pinned: true, active: true });
		assert.strictEqual(group.contains(sideBySideInputDifferent), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY }), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.ANY, strictEquals: true }), true);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.BOTH }), false);
		assert.strictEqual(group.contains(input1, { supportSideBySide: SideBySideEditor.BOTH, strictEquals: true }), false);
	});

	test('group serialization', function () {
		inst().invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();

		// Case 1: inputs can be serialized and deserialized

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		let deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 3);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.SEQUENTIAL).length, 3);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 3);
		assert.strictEqual(deserialized.isPinned(input1), true);
		assert.strictEqual(deserialized.isPinned(input2), true);
		assert.strictEqual(deserialized.isPinned(input3), false);
		assert.strictEqual(deserialized.isActive(input3), true);

		// Case 2: inputs cannot be serialized
		TestEditorInputSerializer.disableSerialize = true;

		deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.SEQUENTIAL).length, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);

		// Case 3: inputs cannot be deserialized
		TestEditorInputSerializer.disableSerialize = false;
		TestEditorInputSerializer.disableDeserialize = true;

		deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.SEQUENTIAL).length, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
	});

	test('group serialization (sticky editor)', function () {
		inst().invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();

		// Case 1: inputs can be serialized and deserialized

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		group.stick(input2);
		assert.ok(group.isSticky(input2));

		let deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 3);

		assert.strictEqual(deserialized.isPinned(input1), true);
		assert.strictEqual(deserialized.isActive(input1), false);
		assert.strictEqual(deserialized.isSticky(input1), false);

		assert.strictEqual(deserialized.isPinned(input2), true);
		assert.strictEqual(deserialized.isActive(input2), false);
		assert.strictEqual(deserialized.isSticky(input2), true);

		assert.strictEqual(deserialized.isPinned(input3), false);
		assert.strictEqual(deserialized.isActive(input3), true);
		assert.strictEqual(deserialized.isSticky(input3), false);

		// Case 2: inputs cannot be serialized
		TestEditorInputSerializer.disableSerialize = true;

		deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 0);
		assert.strictEqual(deserialized.stickyCount, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.SEQUENTIAL).length, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);

		// Case 3: inputs cannot be deserialized
		TestEditorInputSerializer.disableSerialize = false;
		TestEditorInputSerializer.disableDeserialize = true;

		deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 0);
		assert.strictEqual(deserialized.stickyCount, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.SEQUENTIAL).length, 0);
		assert.strictEqual(deserialized.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
	});

	test('group serialization (locked group)', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		assert.strictEqual(events.locked.length, 0);

		group.lock(true);
		group.lock(true);

		assert.strictEqual(events.locked.length, 1);

		group.lock(false);
		group.lock(false);

		assert.strictEqual(events.locked.length, 2);
	});

	test('locked group', function () {
		const group = createEditorGroupModel();
		group.lock(true);

		let deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 0);
		assert.strictEqual(deserialized.isLocked, true);

		group.lock(false);
		deserialized = createEditorGroupModel(group.serialize());
		assert.strictEqual(group.id, deserialized.id);
		assert.strictEqual(deserialized.count, 0);
		assert.strictEqual(deserialized.isLocked, false);
	});

	test('index', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		assert.strictEqual(events.index.length, 0);

		group.setIndex(4);

		assert.strictEqual(events.index.length, 1);
	});

	test('label', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		assert.strictEqual(events.label.length, 0);

		group.setLabel('Window 1');

		assert.strictEqual(events.label.length, 1);
	});

	test('active', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		assert.strictEqual(events.active.length, 0);

		group.setActive(undefined);

		assert.strictEqual(events.active.length, 1);
	});

	test('One Editor', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);

		// Active && Pinned
		const input1 = input();
		const { editor: openedEditor, isNew } = group.openEditor(input1, { active: true, pinned: true });
		assert.strictEqual(openedEditor, input1);
		assert.strictEqual(isNew, true);

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 1);
		assert.strictEqual(group.findEditor(input1)![0], input1);
		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.isActive(input1), true);
		assert.strictEqual(group.isPinned(input1), true);
		assert.strictEqual(group.isPinned(0), true);
		assert.strictEqual(group.isFirst(input1), true);
		assert.strictEqual(group.isLast(input1), true);

		assert.strictEqual(events.opened[0].editor, input1);
		assert.strictEqual(events.opened[0].editorIndex, 0);
		assert.strictEqual(events.activated[0].editor, input1);
		assert.strictEqual(events.activated[0].editorIndex, 0);

		const index = group.indexOf(input1);
		assert.strictEqual(group.findEditor(input1)![1], index);
		let event = group.closeEditor(input1, EditorCloseContext.UNPIN);
		assert.strictEqual(event?.editor, input1);
		assert.strictEqual(event?.editorIndex, index);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(group.isFirst(input1), false);
		assert.strictEqual(group.isLast(input1), false);
		assert.strictEqual(events.closed[0].editor, input1);
		assert.strictEqual(events.closed[0].editorIndex, 0);
		assert.strictEqual(events.closed[0].context === EditorCloseContext.UNPIN, true);

		// Active && Preview
		const input2 = input();
		group.openEditor(input2, { active: true, pinned: false });

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 1);
		assert.strictEqual(group.activeEditor, input2);
		assert.strictEqual(group.isActive(input2), true);
		assert.strictEqual(group.isPinned(input2), false);
		assert.strictEqual(group.isPinned(0), false);

		assert.strictEqual(events.opened[1].editor, input2);
		assert.strictEqual(events.opened[1].editorIndex, 0);
		assert.strictEqual(events.activated[1].editor, input2);
		assert.strictEqual(events.activated[1].editorIndex, 0);

		group.closeEditor(input2);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(events.closed[1].editor, input2);
		assert.strictEqual(events.closed[1].editorIndex, 0);
		assert.strictEqual(events.closed[1].context === EditorCloseContext.REPLACE, false);

		event = group.closeEditor(input2);
		assert.ok(!event);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(events.closed[1].editor, input2);

		// Nonactive && Pinned => gets active because its first editor
		const input3 = input();
		group.openEditor(input3, { active: false, pinned: true });

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 1);
		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.isActive(input3), true);
		assert.strictEqual(group.isPinned(input3), true);
		assert.strictEqual(group.isPinned(0), true);

		assert.strictEqual(events.opened[2].editor, input3);
		assert.strictEqual(events.activated[2].editor, input3);

		group.closeEditor(input3);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(events.closed[2].editor, input3);

		assert.strictEqual(events.opened[2].editor, input3);
		assert.strictEqual(events.activated[2].editor, input3);

		group.closeEditor(input3);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(events.closed[2].editor, input3);

		// Nonactive && Preview => gets active because its first editor
		const input4 = input();
		group.openEditor(input4);

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 1);
		assert.strictEqual(group.activeEditor, input4);
		assert.strictEqual(group.isActive(input4), true);
		assert.strictEqual(group.isPinned(input4), false);
		assert.strictEqual(group.isPinned(0), false);

		assert.strictEqual(events.opened[3].editor, input4);
		assert.strictEqual(events.activated[3].editor, input4);

		group.closeEditor(input4);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(events.closed[3].editor, input4);
	});

	test('Multiple Editors - Pinned and Active', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input('1');
		const input1Copy = input('1');
		const input2 = input('2');
		const input3 = input('3');

		// Pinned and Active
		let openedEditorResult = group.openEditor(input1, { pinned: true, active: true });
		assert.strictEqual(openedEditorResult.editor, input1);
		assert.strictEqual(openedEditorResult.isNew, true);

		openedEditorResult = group.openEditor(input1Copy, { pinned: true, active: true }); // opening copy of editor should still return existing one
		assert.strictEqual(openedEditorResult.editor, input1);
		assert.strictEqual(openedEditorResult.isNew, false);

		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: true, active: true });

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 3);
		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.isActive(input1), false);
		assert.strictEqual(group.isPinned(input1), true);
		assert.strictEqual(group.isActive(input2), false);
		assert.strictEqual(group.isPinned(input2), true);
		assert.strictEqual(group.isActive(input3), true);
		assert.strictEqual(group.isPinned(input3), true);
		assert.strictEqual(group.isFirst(input1), true);
		assert.strictEqual(group.isFirst(input2), false);
		assert.strictEqual(group.isFirst(input3), false);
		assert.strictEqual(group.isLast(input1), false);
		assert.strictEqual(group.isLast(input2), false);
		assert.strictEqual(group.isLast(input3), true);

		assert.strictEqual(events.opened[0].editor, input1);
		assert.strictEqual(events.opened[1].editor, input2);
		assert.strictEqual(events.opened[2].editor, input3);

		assert.strictEqual(events.activated[0].editor, input1);
		assert.strictEqual(events.activated[0].editorIndex, 0);
		assert.strictEqual(events.activated[1].editor, input2);
		assert.strictEqual(events.activated[1].editorIndex, 1);
		assert.strictEqual(events.activated[2].editor, input3);
		assert.strictEqual(events.activated[2].editorIndex, 2);

		const mru = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru[0], input3);
		assert.strictEqual(mru[1], input2);
		assert.strictEqual(mru[2], input1);

		// Add some tests where a matching input is used
		// and verify that events carry the original input
		const sameInput1 = input('1');
		group.openEditor(sameInput1, { pinned: true, active: true });
		assert.strictEqual(events.activated[3].editor, input1);
		assert.strictEqual(events.activated[3].editorIndex, 0);

		group.unpin(sameInput1);
		assert.strictEqual(events.unpinned[0].editor, input1);
		assert.strictEqual(events.unpinned[0].editorIndex, 0);

		group.pin(sameInput1);
		assert.strictEqual(events.pinned[0].editor, input1);
		assert.strictEqual(events.pinned[0].editorIndex, 0);

		group.stick(sameInput1);
		assert.strictEqual(events.sticky[0].editor, input1);
		assert.strictEqual(events.sticky[0].editorIndex, 0);

		group.unstick(sameInput1);
		assert.strictEqual(events.unsticky[0].editor, input1);
		assert.strictEqual(events.unsticky[0].editorIndex, 0);

		group.moveEditor(sameInput1, 1);
		assert.strictEqual(events.moved[0].editor, input1);
		assert.strictEqual(events.moved[0].oldEditorIndex, 0);
		assert.strictEqual(events.moved[0].editorIndex, 1);

		group.closeEditor(sameInput1);
		assert.strictEqual(events.closed[0].editor, input1);
		assert.strictEqual(events.closed[0].editorIndex, 1);

		closeAllEditors(group);

		assert.strictEqual(events.closed.length, 3);
		assert.strictEqual(group.count, 0);
	});

	test('Multiple Editors - Preview editor moves to the side of the active one', function () {
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();

		group.openEditor(input1, { pinned: false, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: true, active: true });

		assert.strictEqual(input3, group.getEditors(EditorsOrder.SEQUENTIAL)[2]);

		const input4 = input();
		group.openEditor(input4, { pinned: false, active: true }); // this should cause the preview editor to move after input3

		assert.strictEqual(input4, group.getEditors(EditorsOrder.SEQUENTIAL)[2]);
	});

	test('Multiple Editors - Pinned and Active (DEFAULT_OPEN_EDITOR_DIRECTION = Direction.LEFT)', function () {
		const inst = new TestInstantiationService();
		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(ILifecycleService, disposables.add(new TestLifecycleService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		inst.stub(IConfigurationService, config);
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'left' } });

		const group: EditorGroupModel = disposables.add(inst.createInstance(EditorGroupModel, undefined));

		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();

		// Pinned and Active
		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: true, active: true });

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[2], input1);

		closeAllEditors(group);

		assert.strictEqual(events.closed.length, 3);
		assert.strictEqual(group.count, 0);
		inst.dispose();
	});

	test('Multiple Editors - Pinned and Not Active', function () {
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();

		// Pinned and Active
		group.openEditor(input1, { pinned: true });
		group.openEditor(input2, { pinned: true });
		group.openEditor(input3, { pinned: true });

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 3);
		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.isActive(input1), true);
		assert.strictEqual(group.isPinned(input1), true);
		assert.strictEqual(group.isPinned(0), true);
		assert.strictEqual(group.isActive(input2), false);
		assert.strictEqual(group.isPinned(input2), true);
		assert.strictEqual(group.isPinned(1), true);
		assert.strictEqual(group.isActive(input3), false);
		assert.strictEqual(group.isPinned(input3), true);
		assert.strictEqual(group.isPinned(2), true);
		assert.strictEqual(group.isPinned(input3), true);

		const mru = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru[0], input1);
		assert.strictEqual(mru[1], input3);
		assert.strictEqual(mru[2], input2);
	});

	test('Multiple Editors - Preview gets overwritten', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();

		// Non active, preview
		group.openEditor(input1); // becomes active, preview
		group.openEditor(input2); // overwrites preview
		group.openEditor(input3); // overwrites preview

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 1);
		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.isActive(input3), true);
		assert.strictEqual(group.isPinned(input3), false);
		assert.strictEqual(!group.isPinned(input3), true);

		assert.strictEqual(events.opened[0].editor, input1);
		assert.strictEqual(events.opened[1].editor, input2);
		assert.strictEqual(events.opened[2].editor, input3);
		assert.strictEqual(events.closed[0].editor, input1);
		assert.strictEqual(events.closed[1].editor, input2);
		assert.strictEqual(events.closed[0].context === EditorCloseContext.REPLACE, true);
		assert.strictEqual(events.closed[1].context === EditorCloseContext.REPLACE, true);

		const mru = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru[0], input3);
		assert.strictEqual(mru.length, 1);
	});

	test('Multiple Editors - set active', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		assert.strictEqual(group.activeEditor, input3);

		let mru = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru[0], input3);
		assert.strictEqual(mru[1], input2);
		assert.strictEqual(mru[2], input1);

		group.setActive(input3);
		assert.strictEqual(events.activated.length, 3);

		group.setActive(input1);
		assert.strictEqual(events.activated[3].editor, input1);
		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.isActive(input1), true);
		assert.strictEqual(group.isActive(input2), false);
		assert.strictEqual(group.isActive(input3), false);

		mru = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mru[0], input1);
		assert.strictEqual(mru[1], input3);
		assert.strictEqual(mru[2], input2);
	});

	test('Multiple Editors - pin and unpin', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 3);

		group.pin(input3);

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.isPinned(input3), true);
		assert.strictEqual(group.isActive(input3), true);
		assert.strictEqual(events.pinned[0].editor, input3);
		assert.strictEqual(group.count, 3);

		group.unpin(input1);

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.isPinned(input1), false);
		assert.strictEqual(group.isActive(input1), false);
		assert.strictEqual(events.unpinned[0].editor, input1);
		assert.strictEqual(group.count, 3);

		group.unpin(input2);

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 2); // 2 previews got merged into one
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input3);
		assert.strictEqual(events.closed[0].editor, input1);
		assert.strictEqual(group.count, 2);

		group.unpin(input3);

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 1); // pinning replaced the preview
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input3);
		assert.strictEqual(events.closed[1].editor, input2);
		assert.strictEqual(group.count, 1);
	});

	test('Multiple Editors - closing picks next from MRU list', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();
		const input4 = input();
		const input5 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: true, active: true });
		group.openEditor(input4, { pinned: true, active: true });
		group.openEditor(input5, { pinned: true, active: true });

		assert.strictEqual(group.activeEditor, input5);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0], input5);
		assert.strictEqual(group.count, 5);

		group.closeEditor(input5);
		assert.strictEqual(group.activeEditor, input4);
		assert.strictEqual(events.activated[5].editor, input4);
		assert.strictEqual(group.count, 4);

		group.setActive(input1);
		group.setActive(input4);
		group.closeEditor(input4);

		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.count, 3);

		group.closeEditor(input1);

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 2);

		group.setActive(input2);
		group.closeEditor(input2);

		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 1);

		group.closeEditor(input3);

		assert.ok(!group.activeEditor);
		assert.strictEqual(group.count, 0);
	});

	test('Multiple Editors - closing picks next to the right', function () {
		const inst = new TestInstantiationService();
		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(ILifecycleService, disposables.add(new TestLifecycleService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { focusRecentEditorAfterClose: false } });
		inst.stub(IConfigurationService, config);

		const group = disposables.add(inst.createInstance(EditorGroupModel, undefined));
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();
		const input4 = input();
		const input5 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: true, active: true });
		group.openEditor(input4, { pinned: true, active: true });
		group.openEditor(input5, { pinned: true, active: true });

		assert.strictEqual(group.activeEditor, input5);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0], input5);
		assert.strictEqual(group.count, 5);

		group.closeEditor(input5);
		assert.strictEqual(group.activeEditor, input4);
		assert.strictEqual(events.activated[5].editor, input4);
		assert.strictEqual(group.count, 4);

		group.setActive(input1);
		group.closeEditor(input1);

		assert.strictEqual(group.activeEditor, input2);
		assert.strictEqual(group.count, 3);

		group.setActive(input3);
		group.closeEditor(input3);

		assert.strictEqual(group.activeEditor, input4);
		assert.strictEqual(group.count, 2);

		group.closeEditor(input4);

		assert.strictEqual(group.activeEditor, input2);
		assert.strictEqual(group.count, 1);

		group.closeEditor(input2);

		assert.ok(!group.activeEditor);
		assert.strictEqual(group.count, 0);
		inst.dispose();
	});

	test('Multiple Editors - move editor', function () {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		const input3 = input();
		const input4 = input();
		const input5 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });

		group.moveEditor(input1, 1);

		assert.strictEqual(events.moved[0].editor, input1);
		assert.strictEqual(events.moved[0].oldEditorIndex, 0);
		assert.strictEqual(events.moved[0].editorIndex, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input1);

		group.setActive(input1);
		group.openEditor(input3, { pinned: true, active: true });
		group.openEditor(input4, { pinned: true, active: true });
		group.openEditor(input5, { pinned: true, active: true });

		group.moveEditor(input4, 0);

		assert.strictEqual(events.moved[1].editor, input4);
		assert.strictEqual(events.moved[1].oldEditorIndex, 3);
		assert.strictEqual(events.moved[1].editorIndex, 0);
		assert.strictEqual(events.moved[1].editor, input4);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input4);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[2], input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[3], input3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[4], input5);

		group.moveEditor(input4, 3);
		group.moveEditor(input2, 1);

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[2], input3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[3], input4);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[4], input5);

		assert.strictEqual(events.moved.length, 4);
		group.moveEditor(input1, 0);
		assert.strictEqual(events.moved.length, 4);
		group.moveEditor(input1, -1);
		assert.strictEqual(events.moved.length, 4);

		group.moveEditor(input5, 4);
		assert.strictEqual(events.moved.length, 4);
		group.moveEditor(input5, 100);
		assert.strictEqual(events.moved.length, 4);

		group.moveEditor(input5, -1);
		assert.strictEqual(events.moved.length, 5);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input5);

		group.moveEditor(input1, 100);
		assert.strictEqual(events.moved.length, 6);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[4], input1);
	});

	test('Multiple Editors - move editor across groups', function () {
		const group1 = createEditorGroupModel();
		const group2 = createEditorGroupModel();

		const g1_input1 = input();
		const g1_input2 = input();
		const g2_input1 = input();

		group1.openEditor(g1_input1, { active: true, pinned: true });
		group1.openEditor(g1_input2, { active: true, pinned: true });
		group2.openEditor(g2_input1, { active: true, pinned: true });

		// A move across groups is a close in the one group and an open in the other group at a specific index
		group2.closeEditor(g2_input1);
		group1.openEditor(g2_input1, { active: true, pinned: true, index: 1 });

		assert.strictEqual(group1.count, 3);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[0], g1_input1);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[1], g2_input1);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[2], g1_input2);
	});

	test('Multiple Editors - move editor across groups (input already exists in group 1)', function () {
		const group1 = createEditorGroupModel();
		const group2 = createEditorGroupModel();

		const g1_input1 = input();
		const g1_input2 = input();
		const g1_input3 = input();
		const g2_input1 = g1_input2;

		group1.openEditor(g1_input1, { active: true, pinned: true });
		group1.openEditor(g1_input2, { active: true, pinned: true });
		group1.openEditor(g1_input3, { active: true, pinned: true });
		group2.openEditor(g2_input1, { active: true, pinned: true });

		// A move across groups is a close in the one group and an open in the other group at a specific index
		group2.closeEditor(g2_input1);
		group1.openEditor(g2_input1, { active: true, pinned: true, index: 0 });

		assert.strictEqual(group1.count, 3);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[0], g1_input2);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[1], g1_input1);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[2], g1_input3);
	});

	test('Multiple Editors - Pinned & Non Active', function () {
		const group = createEditorGroupModel();

		const input1 = input();
		group.openEditor(input1);
		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.previewEditor, input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input1);
		assert.strictEqual(group.count, 1);

		const input2 = input();
		group.openEditor(input2, { pinned: true, active: false });
		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.previewEditor, input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input2);
		assert.strictEqual(group.count, 2);

		const input3 = input();
		group.openEditor(input3, { pinned: true, active: false });
		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.previewEditor, input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[2], input2);
		assert.strictEqual(group.isPinned(input1), false);
		assert.strictEqual(group.isPinned(input2), true);
		assert.strictEqual(group.isPinned(input3), true);
		assert.strictEqual(group.count, 3);
	});

	test('Multiple Editors - Close Others, Close Left, Close Right', function () {
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();
		const input4 = input();
		const input5 = input();

		group.openEditor(input1, { active: true, pinned: true });
		group.openEditor(input2, { active: true, pinned: true });
		group.openEditor(input3, { active: true, pinned: true });
		group.openEditor(input4, { active: true, pinned: true });
		group.openEditor(input5, { active: true, pinned: true });

		// Close Others
		closeEditors(group, group.activeEditor!);
		assert.strictEqual(group.activeEditor, input5);
		assert.strictEqual(group.count, 1);

		closeAllEditors(group);
		group.openEditor(input1, { active: true, pinned: true });
		group.openEditor(input2, { active: true, pinned: true });
		group.openEditor(input3, { active: true, pinned: true });
		group.openEditor(input4, { active: true, pinned: true });
		group.openEditor(input5, { active: true, pinned: true });
		group.setActive(input3);

		// Close Left
		assert.strictEqual(group.activeEditor, input3);
		closeEditors(group, group.activeEditor, CloseDirection.LEFT);
		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input4);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[2], input5);

		closeAllEditors(group);
		group.openEditor(input1, { active: true, pinned: true });
		group.openEditor(input2, { active: true, pinned: true });
		group.openEditor(input3, { active: true, pinned: true });
		group.openEditor(input4, { active: true, pinned: true });
		group.openEditor(input5, { active: true, pinned: true });
		group.setActive(input3);

		// Close Right
		assert.strictEqual(group.activeEditor, input3);
		closeEditors(group, group.activeEditor, CloseDirection.RIGHT);
		assert.strictEqual(group.activeEditor, input3);
		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], input1);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], input2);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[2], input3);
	});

	test('Multiple Editors - real user example', function () {
		const group = createEditorGroupModel();

		// [] -> /index.html/
		const indexHtml = input('index.html');
		let openedEditor = group.openEditor(indexHtml).editor;
		assert.strictEqual(openedEditor, indexHtml);
		assert.strictEqual(group.activeEditor, indexHtml);
		assert.strictEqual(group.previewEditor, indexHtml);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], indexHtml);
		assert.strictEqual(group.count, 1);

		// /index.html/ -> /index.html/
		const sameIndexHtml = input('index.html');
		openedEditor = group.openEditor(sameIndexHtml).editor;
		assert.strictEqual(openedEditor, indexHtml);
		assert.strictEqual(group.activeEditor, indexHtml);
		assert.strictEqual(group.previewEditor, indexHtml);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], indexHtml);
		assert.strictEqual(group.count, 1);

		// /index.html/ -> /style.css/
		const styleCss = input('style.css');
		openedEditor = group.openEditor(styleCss).editor;
		assert.strictEqual(openedEditor, styleCss);
		assert.strictEqual(group.activeEditor, styleCss);
		assert.strictEqual(group.previewEditor, styleCss);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], styleCss);
		assert.strictEqual(group.count, 1);

		// /style.css/ -> [/style.css/, test.js]
		const testJs = input('test.js');
		openedEditor = group.openEditor(testJs, { active: true, pinned: true }).editor;
		assert.strictEqual(openedEditor, testJs);
		assert.strictEqual(group.previewEditor, styleCss);
		assert.strictEqual(group.activeEditor, testJs);
		assert.strictEqual(group.isPinned(styleCss), false);
		assert.strictEqual(group.isPinned(testJs), true);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], styleCss);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], testJs);
		assert.strictEqual(group.count, 2);

		// [/style.css/, test.js] -> [test.js, /index.html/]
		const indexHtml2 = input('index.html');
		group.openEditor(indexHtml2, { active: true });
		assert.strictEqual(group.activeEditor, indexHtml2);
		assert.strictEqual(group.previewEditor, indexHtml2);
		assert.strictEqual(group.isPinned(indexHtml2), false);
		assert.strictEqual(group.isPinned(testJs), true);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[0], testJs);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], indexHtml2);
		assert.strictEqual(group.count, 2);

		// make test.js active
		const testJs2 = input('test.js');
		group.setActive(testJs2);
		assert.strictEqual(group.activeEditor, testJs);
		assert.strictEqual(group.isActive(testJs2), true);
		assert.strictEqual(group.count, 2);

		// [test.js, /indexHtml/] -> [test.js, index.html]
		const indexHtml3 = input('index.html');
		group.pin(indexHtml3);
		assert.strictEqual(group.isPinned(indexHtml3), true);
		assert.strictEqual(group.activeEditor, testJs);

		// [test.js, index.html] -> [test.js, file.ts, index.html]
		const fileTs = input('file.ts');
		group.openEditor(fileTs, { active: true, pinned: true });
		assert.strictEqual(group.isPinned(fileTs), true);
		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.activeEditor, fileTs);

		// [test.js, index.html, file.ts] -> [test.js, /file.ts/, index.html]
		group.unpin(fileTs);
		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.isPinned(fileTs), false);
		assert.strictEqual(group.activeEditor, fileTs);

		// [test.js, /file.ts/, index.html] -> [test.js, /other.ts/, index.html]
		const otherTs = input('other.ts');
		group.openEditor(otherTs, { active: true });
		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.activeEditor, otherTs);
		assert.ok(group.getEditors(EditorsOrder.SEQUENTIAL)[0].matches(testJs));
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], otherTs);
		assert.ok(group.getEditors(EditorsOrder.SEQUENTIAL)[2].matches(indexHtml));

		// make index.html active
		const indexHtml4 = input('index.html');
		group.setActive(indexHtml4);
		assert.strictEqual(group.activeEditor, indexHtml2);

		// [test.js, /other.ts/, index.html] -> [test.js, /other.ts/]
		group.closeEditor(indexHtml);
		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.activeEditor, otherTs);
		assert.ok(group.getEditors(EditorsOrder.SEQUENTIAL)[0].matches(testJs));
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL)[1], otherTs);

		// [test.js, /other.ts/] -> [test.js]
		group.closeEditor(otherTs);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.activeEditor, testJs);
		assert.ok(group.getEditors(EditorsOrder.SEQUENTIAL)[0].matches(testJs));

		// [test.js] -> /test.js/
		group.unpin(testJs);
		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.activeEditor, testJs);
		assert.ok(group.getEditors(EditorsOrder.SEQUENTIAL)[0].matches(testJs));
		assert.strictEqual(group.isPinned(testJs), false);

		// /test.js/ -> []
		group.closeEditor(testJs);
		assert.strictEqual(group.count, 0);
		assert.strictEqual(group.activeEditor, null);
		assert.strictEqual(group.previewEditor, null);
	});

	test('Single Group, Single Editor - persist', function () {
		const inst = new TestInstantiationService();

		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		const lifecycle = disposables.add(new TestLifecycleService());
		inst.stub(ILifecycleService, lifecycle);
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'right' } });
		inst.stub(IConfigurationService, config);

		inst.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		let group = createEditorGroupModel();

		const input1 = input();
		group.openEditor(input1);

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.activeEditor!.matches(input1), true);
		assert.strictEqual(group.previewEditor!.matches(input1), true);
		assert.strictEqual(group.isActive(input1), true);

		// Create model again - should load from storage
		group = disposables.add(inst.createInstance(EditorGroupModel, group.serialize()));

		assert.strictEqual(group.count, 1);
		assert.strictEqual(group.activeEditor!.matches(input1), true);
		assert.strictEqual(group.previewEditor!.matches(input1), true);
		assert.strictEqual(group.isActive(input1), true);
		inst.dispose();
	});

	test('Multiple Groups, Multiple editors - persist', function () {
		const inst = new TestInstantiationService();

		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		const lifecycle = disposables.add(new TestLifecycleService());
		inst.stub(ILifecycleService, lifecycle);
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'right' } });
		inst.stub(IConfigurationService, config);

		inst.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		let group1 = createEditorGroupModel();

		const g1_input1 = input();
		const g1_input2 = input();
		const g1_input3 = input();

		group1.openEditor(g1_input1, { active: true, pinned: true });
		group1.openEditor(g1_input2, { active: true, pinned: false });
		group1.openEditor(g1_input3, { active: false, pinned: true });

		let group2 = createEditorGroupModel();

		const g2_input1 = input();
		const g2_input2 = input();
		const g2_input3 = input();

		group2.openEditor(g2_input1, { active: true, pinned: true });
		group2.openEditor(g2_input2, { active: false, pinned: false });
		group2.openEditor(g2_input3, { active: false, pinned: true });

		assert.strictEqual(group1.count, 3);
		assert.strictEqual(group2.count, 3);
		assert.strictEqual(group1.activeEditor!.matches(g1_input2), true);
		assert.strictEqual(group2.activeEditor!.matches(g2_input1), true);
		assert.strictEqual(group1.previewEditor!.matches(g1_input2), true);
		assert.strictEqual(group2.previewEditor!.matches(g2_input2), true);

		assert.strictEqual(group1.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0].matches(g1_input2), true);
		assert.strictEqual(group1.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[1].matches(g1_input3), true);
		assert.strictEqual(group1.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[2].matches(g1_input1), true);

		assert.strictEqual(group2.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0].matches(g2_input1), true);
		assert.strictEqual(group2.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[1].matches(g2_input3), true);
		assert.strictEqual(group2.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[2].matches(g2_input2), true);

		// Create model again - should load from storage
		group1 = disposables.add(inst.createInstance(EditorGroupModel, group1.serialize()));
		group2 = disposables.add(inst.createInstance(EditorGroupModel, group2.serialize()));

		assert.strictEqual(group1.count, 3);
		assert.strictEqual(group2.count, 3);
		assert.strictEqual(group1.activeEditor!.matches(g1_input2), true);
		assert.strictEqual(group2.activeEditor!.matches(g2_input1), true);
		assert.strictEqual(group1.previewEditor!.matches(g1_input2), true);
		assert.strictEqual(group2.previewEditor!.matches(g2_input2), true);

		assert.strictEqual(group1.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0].matches(g1_input2), true);
		assert.strictEqual(group1.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[1].matches(g1_input3), true);
		assert.strictEqual(group1.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[2].matches(g1_input1), true);

		assert.strictEqual(group2.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0].matches(g2_input1), true);
		assert.strictEqual(group2.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[1].matches(g2_input3), true);
		assert.strictEqual(group2.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[2].matches(g2_input2), true);
		inst.dispose();
	});

	test('Single group, multiple editors - persist (some not persistable)', function () {
		const inst = new TestInstantiationService();

		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		const lifecycle = disposables.add(new TestLifecycleService());
		inst.stub(ILifecycleService, lifecycle);
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'right' } });
		inst.stub(IConfigurationService, config);

		inst.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		let group = createEditorGroupModel();

		const serializableInput1 = input();
		const nonSerializableInput2 = input('3', true);
		const serializableInput2 = input();

		group.openEditor(serializableInput1, { active: true, pinned: true });
		group.openEditor(nonSerializableInput2, { active: true, pinned: false });
		group.openEditor(serializableInput2, { active: false, pinned: true });

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.activeEditor!.matches(nonSerializableInput2), true);
		assert.strictEqual(group.previewEditor!.matches(nonSerializableInput2), true);

		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0].matches(nonSerializableInput2), true);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[1].matches(serializableInput2), true);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[2].matches(serializableInput1), true);

		// Create model again - should load from storage
		group = disposables.add(inst.createInstance(EditorGroupModel, group.serialize()));

		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.activeEditor!.matches(serializableInput2), true);
		assert.strictEqual(group.previewEditor, null);

		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[0].matches(serializableInput2), true);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)[1].matches(serializableInput1), true);
		inst.dispose();
	});

	test('Single group, multiple editors - persist (some not persistable, sticky editors)', function () {
		const inst = new TestInstantiationService();

		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		const lifecycle = disposables.add(new TestLifecycleService());
		inst.stub(ILifecycleService, lifecycle);
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'right' } });
		inst.stub(IConfigurationService, config);

		inst.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		let group = createEditorGroupModel();

		const serializableInput1 = input();
		const nonSerializableInput2 = input('3', true);
		const serializableInput2 = input();

		group.openEditor(serializableInput1, { active: true, pinned: true });
		group.openEditor(nonSerializableInput2, { active: true, pinned: true, sticky: true });
		group.openEditor(serializableInput2, { active: false, pinned: true });

		assert.strictEqual(group.count, 3);
		assert.strictEqual(group.stickyCount, 1);

		// Create model again - should load from storage
		group = disposables.add(inst.createInstance(EditorGroupModel, group.serialize()));

		assert.strictEqual(group.count, 2);
		assert.strictEqual(group.stickyCount, 0);
		inst.dispose();
	});

	test('Multiple groups, multiple editors - persist (some not persistable, causes empty group)', function () {
		const inst = new TestInstantiationService();

		inst.stub(IStorageService, disposables.add(new TestStorageService()));
		inst.stub(IWorkspaceContextService, new TestContextService());
		const lifecycle = disposables.add(new TestLifecycleService());
		inst.stub(ILifecycleService, lifecycle);
		inst.stub(ITelemetryService, NullTelemetryService);

		const config = new TestConfigurationService();
		config.setUserConfiguration('workbench', { editor: { openPositioning: 'right' } });
		inst.stub(IConfigurationService, config);

		inst.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		let group1 = createEditorGroupModel();
		let group2 = createEditorGroupModel();

		const serializableInput1 = input();
		const serializableInput2 = input();
		const nonSerializableInput = input('2', true);

		group1.openEditor(serializableInput1, { pinned: true });
		group1.openEditor(serializableInput2);

		group2.openEditor(nonSerializableInput);

		// Create model again - should load from storage
		group1 = disposables.add(inst.createInstance(EditorGroupModel, group1.serialize()));
		group2 = disposables.add(inst.createInstance(EditorGroupModel, group2.serialize()));

		assert.strictEqual(group1.count, 2);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[0].matches(serializableInput1), true);
		assert.strictEqual(group1.getEditors(EditorsOrder.SEQUENTIAL)[1].matches(serializableInput2), true);
		inst.dispose();
	});

	test('Multiple Editors - Editor Dispose', function () {
		const group1 = createEditorGroupModel();
		const group2 = createEditorGroupModel();

		const group1Listener = groupListener(group1);
		const group2Listener = groupListener(group2);

		const input1 = input();
		const input2 = input();
		const input3 = input();

		group1.openEditor(input1, { pinned: true, active: true });
		group1.openEditor(input2, { pinned: true, active: true });
		group1.openEditor(input3, { pinned: true, active: true });

		group2.openEditor(input1, { pinned: true, active: true });
		group2.openEditor(input2, { pinned: true, active: true });

		input1.dispose();

		assert.strictEqual(group1Listener.disposed.length, 1);
		assert.strictEqual(group1Listener.disposed[0].editorIndex, 0);
		assert.strictEqual(group2Listener.disposed.length, 1);
		assert.strictEqual(group2Listener.disposed[0].editorIndex, 0);
		assert.ok(group1Listener.disposed[0].editor.matches(input1));
		assert.ok(group2Listener.disposed[0].editor.matches(input1));

		input3.dispose();
		assert.strictEqual(group1Listener.disposed.length, 2);
		assert.strictEqual(group1Listener.disposed[1].editorIndex, 2);
		assert.strictEqual(group2Listener.disposed.length, 1);
		assert.ok(group1Listener.disposed[1].editor.matches(input3));
	});

	test('Preview tab does not have a stable position (https://github.com/microsoft/vscode/issues/8245)', function () {
		const group1 = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();

		group1.openEditor(input1, { pinned: true, active: true });
		group1.openEditor(input2, { active: true });
		group1.setActive(input1);

		group1.openEditor(input3, { active: true });
		assert.strictEqual(group1.indexOf(input3), 1);
	});

	test('Multiple Editors - Editor Emits Dirty and Label Changed', function () {
		const group1 = createEditorGroupModel();
		const group2 = createEditorGroupModel();

		const input1 = input();
		const input2 = input();

		group1.openEditor(input1, { pinned: true, active: true });
		group2.openEditor(input2, { pinned: true, active: true });

		let dirty1Counter = 0;
		disposables.add(group1.onDidModelChange((e) => {
			if (e.kind === GroupModelChangeKind.EDITOR_DIRTY) {
				dirty1Counter++;
			}
		}));

		let dirty2Counter = 0;
		disposables.add(group2.onDidModelChange((e) => {
			if (e.kind === GroupModelChangeKind.EDITOR_DIRTY) {
				dirty2Counter++;
			}
		}));

		let label1ChangeCounter = 0;
		disposables.add(group1.onDidModelChange((e) => {
			if (e.kind === GroupModelChangeKind.EDITOR_LABEL) {
				label1ChangeCounter++;
			}
		}));

		let label2ChangeCounter = 0;
		disposables.add(group2.onDidModelChange((e) => {
			if (e.kind === GroupModelChangeKind.EDITOR_LABEL) {
				label2ChangeCounter++;
			}
		}));

		(<TestEditorInput>input1).setDirty();
		(<TestEditorInput>input1).setLabel();

		assert.strictEqual(dirty1Counter, 1);
		assert.strictEqual(label1ChangeCounter, 1);

		(<TestEditorInput>input2).setDirty();
		(<TestEditorInput>input2).setLabel();

		assert.strictEqual(dirty2Counter, 1);
		assert.strictEqual(label2ChangeCounter, 1);

		closeAllEditors(group2);

		(<TestEditorInput>input2).setDirty();
		(<TestEditorInput>input2).setLabel();

		assert.strictEqual(dirty2Counter, 1);
		assert.strictEqual(label2ChangeCounter, 1);
		assert.strictEqual(dirty1Counter, 1);
		assert.strictEqual(label1ChangeCounter, 1);
	});

	test('Sticky Editors', function () {
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();
		const input4 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		assert.strictEqual(group.stickyCount, 0);

		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL).length, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true }).length, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).length, 3);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 3);

		// Stick last editor should move it first and pin
		group.stick(input3);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true }).length, 2);
		assert.strictEqual(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: false }).length, 3);
		assert.strictEqual(group.isSticky(input1), false);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), true);
		assert.strictEqual(group.isPinned(input3), true);
		assert.strictEqual(group.indexOf(input1), 1);
		assert.strictEqual(group.indexOf(input2), 2);
		assert.strictEqual(group.indexOf(input3), 0);

		let sequentialAllEditors = group.getEditors(EditorsOrder.SEQUENTIAL);
		assert.strictEqual(sequentialAllEditors.length, 3);
		let sequentialEditorsExcludingSticky = group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true });
		assert.strictEqual(sequentialEditorsExcludingSticky.length, 2);
		assert.ok(sequentialEditorsExcludingSticky.indexOf(input1) >= 0);
		assert.ok(sequentialEditorsExcludingSticky.indexOf(input2) >= 0);
		let mruAllEditors = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mruAllEditors.length, 3);
		let mruEditorsExcludingSticky = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true });
		assert.strictEqual(mruEditorsExcludingSticky.length, 2);
		assert.ok(mruEditorsExcludingSticky.indexOf(input1) >= 0);
		assert.ok(mruEditorsExcludingSticky.indexOf(input2) >= 0);

		// Sticking same editor again is a no-op
		group.stick(input3);
		assert.strictEqual(group.isSticky(input3), true);

		// Sticking last editor now should move it after sticky one
		group.stick(input2);
		assert.strictEqual(group.stickyCount, 2);
		assert.strictEqual(group.isSticky(input1), false);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), true);
		assert.strictEqual(group.indexOf(input1), 2);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 0);

		sequentialAllEditors = group.getEditors(EditorsOrder.SEQUENTIAL);
		assert.strictEqual(sequentialAllEditors.length, 3);
		sequentialEditorsExcludingSticky = group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true });
		assert.strictEqual(sequentialEditorsExcludingSticky.length, 1);
		assert.ok(sequentialEditorsExcludingSticky.indexOf(input1) >= 0);
		mruAllEditors = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mruAllEditors.length, 3);
		mruEditorsExcludingSticky = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true });
		assert.strictEqual(mruEditorsExcludingSticky.length, 1);
		assert.ok(mruEditorsExcludingSticky.indexOf(input1) >= 0);

		// Sticking remaining editor also works
		group.stick(input1);
		assert.strictEqual(group.stickyCount, 3);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), true);
		assert.strictEqual(group.indexOf(input1), 2);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 0);

		sequentialAllEditors = group.getEditors(EditorsOrder.SEQUENTIAL);
		assert.strictEqual(sequentialAllEditors.length, 3);
		sequentialEditorsExcludingSticky = group.getEditors(EditorsOrder.SEQUENTIAL, { excludeSticky: true });
		assert.strictEqual(sequentialEditorsExcludingSticky.length, 0);
		mruAllEditors = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		assert.strictEqual(mruAllEditors.length, 3);
		mruEditorsExcludingSticky = group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE, { excludeSticky: true });
		assert.strictEqual(mruEditorsExcludingSticky.length, 0);

		// Unsticking moves editor after sticky ones
		group.unstick(input3);
		assert.strictEqual(group.stickyCount, 2);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 1);
		assert.strictEqual(group.indexOf(input2), 0);
		assert.strictEqual(group.indexOf(input3), 2);

		// Unsticking all works
		group.unstick(input1);
		group.unstick(input2);
		assert.strictEqual(group.stickyCount, 0);
		assert.strictEqual(group.isSticky(input1), false);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), false);

		group.moveEditor(input1, 0);
		group.moveEditor(input2, 1);
		group.moveEditor(input3, 2);

		// Opening a new editor always opens after sticky editors
		group.stick(input1);
		group.stick(input2);
		group.setActive(input1);

		const events = groupListener(group);

		group.openEditor(input4, { pinned: true, active: true });
		assert.strictEqual(group.indexOf(input4), 2);
		group.closeEditor(input4);

		assert.strictEqual(events.closed[0].sticky, false);

		group.setActive(input2);

		group.openEditor(input4, { pinned: true, active: true });
		assert.strictEqual(group.indexOf(input4), 2);
		group.closeEditor(input4);

		assert.strictEqual(events.closed[1].sticky, false);

		// Reset
		assert.strictEqual(group.stickyCount, 2);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 0);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 2);

		// Moving a sticky editor works
		group.moveEditor(input1, 1); // still moved within sticky range
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 1);
		assert.strictEqual(group.indexOf(input2), 0);
		assert.strictEqual(group.indexOf(input3), 2);

		group.moveEditor(input1, 0); // still moved within sticky range
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 0);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 2);

		group.moveEditor(input1, 2); // moved out of sticky range//
		assert.strictEqual(group.isSticky(input1), false);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 2);
		assert.strictEqual(group.indexOf(input2), 0);
		assert.strictEqual(group.indexOf(input3), 1);

		group.moveEditor(input2, 2); // moved out of sticky range
		assert.strictEqual(group.isSticky(input1), false);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 1);
		assert.strictEqual(group.indexOf(input2), 2);
		assert.strictEqual(group.indexOf(input3), 0);

		// Reset
		group.moveEditor(input1, 0);
		group.moveEditor(input2, 1);
		group.moveEditor(input3, 2);
		group.stick(input1);
		group.unstick(input2);
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 0);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 2);

		// Moving a unsticky editor in works
		group.moveEditor(input3, 1); // still moved within unsticked range
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 0);
		assert.strictEqual(group.indexOf(input2), 2);
		assert.strictEqual(group.indexOf(input3), 1);

		group.moveEditor(input3, 2); // still moved within unsticked range
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.indexOf(input1), 0);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 2);

		group.moveEditor(input3, 0); // moved into sticky range//
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), false);
		assert.strictEqual(group.isSticky(input3), true);
		assert.strictEqual(group.indexOf(input1), 1);
		assert.strictEqual(group.indexOf(input2), 2);
		assert.strictEqual(group.indexOf(input3), 0);

		group.moveEditor(input2, 0); // moved into sticky range
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), true);
		assert.strictEqual(group.indexOf(input1), 2);
		assert.strictEqual(group.indexOf(input2), 0);
		assert.strictEqual(group.indexOf(input3), 1);

		// Closing a sticky editor updates state properly
		group.stick(input1);
		group.stick(input2);
		group.unstick(input3);
		assert.strictEqual(group.stickyCount, 2);
		group.closeEditor(input1);
		assert.strictEqual(events.closed[2].sticky, true);
		assert.strictEqual(group.stickyCount, 1);
		group.closeEditor(input2);
		assert.strictEqual(events.closed[3].sticky, true);
		assert.strictEqual(group.stickyCount, 0);

		closeAllEditors(group);
		assert.strictEqual(group.stickyCount, 0);

		// Open sticky
		group.openEditor(input1, { sticky: true });
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.isSticky(input1), true);

		group.openEditor(input2, { pinned: true, active: true });
		assert.strictEqual(group.stickyCount, 1);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), false);

		group.openEditor(input2, { sticky: true });
		assert.strictEqual(group.stickyCount, 2);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);

		group.openEditor(input3, { pinned: true, active: true });
		group.openEditor(input4, { pinned: false, active: true, sticky: true });
		assert.strictEqual(group.stickyCount, 3);
		assert.strictEqual(group.isSticky(input1), true);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.isSticky(input4), true);
		assert.strictEqual(group.isPinned(input4), true);

		assert.strictEqual(group.indexOf(input1), 0);
		assert.strictEqual(group.indexOf(input2), 1);
		assert.strictEqual(group.indexOf(input3), 3);
		assert.strictEqual(group.indexOf(input4), 2);
	});

	test('Sticky/Unsticky Editors sends correct editor index', function () {
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		const input3 = input();

		group.openEditor(input1, { pinned: true, active: true });
		group.openEditor(input2, { pinned: true, active: true });
		group.openEditor(input3, { pinned: false, active: true });

		assert.strictEqual(group.stickyCount, 0);

		const events = groupListener(group);

		group.stick(input3);

		assert.strictEqual(events.sticky[0].editorIndex, 0);
		assert.strictEqual(group.isSticky(input3), true);
		assert.strictEqual(group.stickyCount, 1);

		group.stick(input2);

		assert.strictEqual(events.sticky[1].editorIndex, 1);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.stickyCount, 2);

		group.unstick(input3);
		assert.strictEqual(events.unsticky[0].editorIndex, 1);
		assert.strictEqual(group.isSticky(input3), false);
		assert.strictEqual(group.isSticky(input2), true);
		assert.strictEqual(group.stickyCount, 1);
	});

	test('onDidMoveEditor Event', () => {
		const group1 = createEditorGroupModel();
		const group2 = createEditorGroupModel();

		const input1group1 = input();
		const input2group1 = input();
		const input1group2 = input();
		const input2group2 = input();

		// Open all the editors
		group1.openEditor(input1group1, { pinned: true, active: true, index: 0 });
		group1.openEditor(input2group1, { pinned: true, active: false, index: 1 });
		group2.openEditor(input1group2, { pinned: true, active: true, index: 0 });
		group2.openEditor(input2group2, { pinned: true, active: false, index: 1 });

		const group1Events = groupListener(group1);
		const group2Events = groupListener(group2);

		group1.moveEditor(input1group1, 1);
		assert.strictEqual(group1Events.moved[0].editor, input1group1);
		assert.strictEqual(group1Events.moved[0].oldEditorIndex, 0);
		assert.strictEqual(group1Events.moved[0].editorIndex, 1);

		group2.moveEditor(input1group2, 1);
		assert.strictEqual(group2Events.moved[0].editor, input1group2);
		assert.strictEqual(group2Events.moved[0].oldEditorIndex, 0);
		assert.strictEqual(group2Events.moved[0].editorIndex, 1);
	});

	test('onDidOpeneditor Event', () => {
		const group1 = createEditorGroupModel();
		const group2 = createEditorGroupModel();

		const group1Events = groupListener(group1);
		const group2Events = groupListener(group2);

		const input1group1 = input();
		const input2group1 = input();
		const input1group2 = input();
		const input2group2 = input();

		// Open all the editors
		group1.openEditor(input1group1, { pinned: true, active: true, index: 0 });
		group1.openEditor(input2group1, { pinned: true, active: false, index: 1 });
		group2.openEditor(input1group2, { pinned: true, active: true, index: 0 });
		group2.openEditor(input2group2, { pinned: true, active: false, index: 1 });

		assert.strictEqual(group1Events.opened.length, 2);
		assert.strictEqual(group1Events.opened[0].editor, input1group1);
		assert.strictEqual(group1Events.opened[0].editorIndex, 0);
		assert.strictEqual(group1Events.opened[1].editor, input2group1);
		assert.strictEqual(group1Events.opened[1].editorIndex, 1);

		assert.strictEqual(group2Events.opened.length, 2);
		assert.strictEqual(group2Events.opened[0].editor, input1group2);
		assert.strictEqual(group2Events.opened[0].editorIndex, 0);
		assert.strictEqual(group2Events.opened[1].editor, input2group2);
		assert.strictEqual(group2Events.opened[1].editorIndex, 1);
	});

	test('moving editor sends sticky event when sticky changes', () => {
		const group1 = createEditorGroupModel();

		const input1group1 = input();
		const input2group1 = input();
		const input3group1 = input();

		// Open all the editors
		group1.openEditor(input1group1, { pinned: true, active: true, index: 0, sticky: true });
		group1.openEditor(input2group1, { pinned: true, active: false, index: 1 });
		group1.openEditor(input3group1, { pinned: true, active: false, index: 2 });

		const group1Events = groupListener(group1);

		group1.moveEditor(input2group1, 0);
		assert.strictEqual(group1Events.sticky[0].editor, input2group1);
		assert.strictEqual(group1Events.sticky[0].editorIndex, 0);

		const group2 = createEditorGroupModel();

		const input1group2 = input();
		const input2group2 = input();
		const input3group2 = input();

		// Open all the editors
		group2.openEditor(input1group2, { pinned: true, active: true, index: 0, sticky: true });
		group2.openEditor(input2group2, { pinned: true, active: false, index: 1 });
		group2.openEditor(input3group2, { pinned: true, active: false, index: 2 });

		const group2Events = groupListener(group2);

		group2.moveEditor(input1group2, 1);
		assert.strictEqual(group2Events.unsticky[0].editor, input1group2);
		assert.strictEqual(group2Events.unsticky[0].editorIndex, 1);
	});

	function assertSelection(group: EditorGroupModel, activeEditor: EditorInput, selectedEditors: EditorInput[]): void {
		assert.strictEqual(group.activeEditor, activeEditor);
		assert.strictEqual(group.selectedEditors.length, selectedEditors.length);
		for (let i = 0; i < selectedEditors.length; i++) {
			assert.strictEqual(group.selectedEditors[i], selectedEditors[i]);
		}
	}

	test('editor selection: selectedEditors', () => {
		const group = createEditorGroupModel();

		const activeEditor = group.activeEditor;
		const selectedEditors = group.selectedEditors;
		assert.strictEqual(activeEditor, null);
		assert.strictEqual(selectedEditors.length, 0);

		// active editor: input1, selection: [input1]
		const input1 = input();
		group.openEditor(input1, { pinned: true, active: true, index: 0 });
		assertSelection(group, input1, [input1]);

		// active editor: input3, selection: [input3]
		const input2 = input();
		const input3 = input();
		group.openEditor(input2, { pinned: true, active: true, index: 1 });
		group.openEditor(input3, { pinned: true, active: true, index: 2 });
		assertSelection(group, input3, [input3]);

		// active editor: input2, selection: [input1, input2] (in sequential order)
		group.setSelection(input2, [input1]);
		assertSelection(group, input2, [input1, input2]);
	});

	test('editor selection: openEditor with inactive selection', () => {
		const group = createEditorGroupModel();

		// active editor: input3, selection: [input3]
		const input1 = input();
		const input2 = input();
		const input3 = input();
		group.openEditor(input1, { pinned: true, active: true, index: 0 });
		group.openEditor(input2, { pinned: true, active: true, index: 1 });
		group.openEditor(input3, { pinned: true, active: true, index: 2 });

		// active editor: input2, selection: [input1, input2, input3] (in sequential order)
		group.openEditor(input2, { active: true, inactiveSelection: [input3, input1] });
		assertSelection(group, input2, [input1, input2, input3]);

		// active editor: input1, selection: [input1, input3] (in sequential order)
		// test duplicate entries
		group.openEditor(input1, { active: true, inactiveSelection: [input3, input1, input3] });
		assertSelection(group, input1, [input1, input3]);

		// active editor: input1, selection: [input1, input2] (in sequential order)
		// open new Editor as inactive with selection
		const input4 = input();
		group.openEditor(input4, { pinned: true, active: false, inactiveSelection: [input2], index: 3 });
		assertSelection(group, input1, [input1, input2]);

		// active editor: input5, selection: [input4, input5] (in sequential order)
		// open new Editor as active with selection
		const input5 = input();
		group.openEditor(input5, { pinned: true, active: true, inactiveSelection: [input4], index: 4 });
		assertSelection(group, input5, [input4, input5]);
	});

	test('editor selection: closeEditor keeps selection', () => {
		const group = createEditorGroupModel();

		// active editor: input3, selection: [input3]
		const input1 = input();
		const input2 = input();
		const input3 = input();
		group.openEditor(input1, { pinned: true, active: true, index: 0 });
		group.openEditor(input2, { pinned: true, active: true, index: 1 });
		group.openEditor(input3, { pinned: true, active: true, index: 2 });

		group.setSelection(input2, [input3, input1]);
		group.closeEditor(input3);
		assertSelection(group, input2, [input1, input2]);
	});

	test('editor selection: setSeletion', () => {
		const group = createEditorGroupModel();

		// active editor: input3, selection: [input3]
		const input1 = input();
		const input2 = input();
		const input3 = input();
		group.openEditor(input1, { pinned: true, active: true, index: 0 });
		group.openEditor(input2, { pinned: true, active: true, index: 1 });
		group.openEditor(input3, { pinned: true, active: true, index: 2 });

		// active editor: input2, selection: [input1, input2, input3] (in sequential order)
		group.setSelection(input2, [input3, input1]);
		assertSelection(group, input2, [input1, input2, input3]);

		// active editor: input3, selection: [input3]
		group.setSelection(input3, []);
		assertSelection(group, input3, [input3]);

		// active editor: input2, selection: [input1, input2]
		// test duplicate entries
		group.setSelection(input2, [input1, input2, input1]);
		assertSelection(group, input2, [input1, input2]);
	});

	test('editor selection: isSelected', () => {
		const group = createEditorGroupModel();

		// active editor: input3, selection: [input3]
		const input1 = input();
		const input2 = input();
		const input3 = input();
		group.openEditor(input1, { pinned: true, active: true, index: 0 });
		group.openEditor(input2, { pinned: true, active: true, index: 1 });
		group.openEditor(input3, { pinned: true, active: true, index: 2 });

		// active editor: input2, selection: [input1, input2, input3] (in sequential order)
		group.setSelection(input2, [input3, input1]);

		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input2), true);
		assert.strictEqual(group.isSelected(input3), true);

		// active editor: input3, selection: [input3]
		group.setSelection(input3, []);

		assert.strictEqual(group.isSelected(input1), false);
		assert.strictEqual(group.isSelected(input2), false);
		assert.strictEqual(group.isSelected(input3), true);

		// use index
		assert.strictEqual(group.isSelected(0), false);
		assert.strictEqual(group.isSelected(1), false);
		assert.strictEqual(group.isSelected(2), true);
	});

	test('editor selection: select invalid editor', () => {
		const group = createEditorGroupModel();

		const input1 = input();
		const input2 = input();
		group.openEditor(input1, { pinned: true, active: true, index: 0 });

		group.setSelection(input2, [input1]);

		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.selectedEditors.length, 1);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input2), false);

		group.setSelection(input1, [input2]);

		assert.strictEqual(group.activeEditor, input1);
		assert.strictEqual(group.selectedEditors.length, 1);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input1), true);
		assert.strictEqual(group.isSelected(input2), false);
	});

	test('editor transient: basics', () => {
		const group = createEditorGroupModel();
		const events = groupListener(group);

		const input1 = input();
		const input2 = input();
		group.openEditor(input1, { pinned: true, active: true });

		assert.strictEqual(group.isTransient(input1), false);
		assert.strictEqual(events.transient.length, 0);

		group.openEditor(input2, { pinned: true, active: true, transient: true });
		assert.strictEqual(events.transient[0].editor, input2);

		assert.strictEqual(group.isTransient(input2), true);

		group.setTransient(input1, true);
		assert.strictEqual(group.isTransient(input1), true);
		assert.strictEqual(events.transient[1].editor, input1);

		group.setTransient(input2, false);
		assert.strictEqual(group.isTransient(input2), false);
		assert.strictEqual(events.transient[2].editor, input2);
	});

	//#region Tab Stacks

	interface ITabStackTestGroup {
		readonly group: EditorGroupModel;
		readonly editor: (id: string) => EditorInput;
		readonly tabStack: (letter: string) => TabStackId;
	}

	function createTabStackEditorGroupModel(serialized?: ISerializedEditorGroupModel, editorConfiguration?: object): EditorGroupModel {
		inst().invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		return createEditorGroupModel(serialized, { enableTabStacks: true, ...editorConfiguration });
	}

	function serializedTestEditor(id: string): ISerializedEditorInput {
		return { id: 'testEditorInputForGroups', value: JSON.stringify({ id }) };
	}

	function editorId(editor: EditorInput): string {
		return editor instanceof TestEditorInput || editor instanceof NonSerializableTestEditorInput ? editor.id : editor.getName();
	}

	/**
	 * Returns the state of the editors as tokens of the editor id followed by
	 * `s` when sticky, a letter per tab stack by first appearance, `^` when the
	 * tab stack is collapsed, `?` when in preview and `*` when active, such as
	 * `'0s 1a* 2a 3b^ 4?'`. Asserts the tab stack invariants on the way.
	 */
	function tabStackState(group: EditorGroupModel): string {
		const editors = group.getEditors(EditorsOrder.SEQUENTIAL);

		const letters = new Map<TabStackId, string>();
		for (const tabStack of group.tabStacks) {
			const indices = tabStack.editors.map(editor => editors.indexOf(editor));
			assert.deepStrictEqual(indices, indices.map((_, i) => indices[0] + i), 'the editors of a tab stack are adjacent');
			assert.ok(tabStack.editors.every(editor => !group.isSticky(editor) && group.isPinned(editor)), 'sticky and preview editors are never in a tab stack');
			assert.ok(!tabStack.collapsed || group.activeEditor === null || !tabStack.editors.includes(group.activeEditor), 'a collapsed tab stack never contains the active editor');
			assert.ok(!tabStack.collapsed || tabStack.editors.every(editor => !group.isSelected(editor)), 'an editor hidden in a collapsed tab stack is never selected');

			letters.set(tabStack.id, String.fromCharCode('a'.charCodeAt(0) + letters.size));
		}

		return editors.map(editor => {
			const tabStack = group.getTabStack(editor);

			return [
				editorId(editor),
				group.isSticky(editor) ? 's' : '',
				tabStack ? letters.get(tabStack.id) : '',
				tabStack?.collapsed ? '^' : '',
				group.isPinned(editor) ? '' : '?',
				group.isActive(editor) ? '*' : ''
			].join('');
		}).join(' ');
	}

	/**
	 * Creates a group in the state that {@link tabStackState} describes. Tab
	 * stacks are created in order of appearance, which assigns their colors.
	 */
	function createTabStackTestGroup(state: string, editorConfiguration?: object): ITabStackTestGroup {
		const group = createTabStackEditorGroupModel(undefined, editorConfiguration);

		const editors = new Map<string, EditorInput>();
		const editorsOfTabStack = new Map<string, EditorInput[]>();
		const collapsedTabStacks = new Set<string>();
		let activeEditor: EditorInput | undefined;

		const tokens = state.split(' ');
		for (let index = 0; index < tokens.length; index++) {
			const token = /^(?<id>\d+)(?<sticky>s?)(?<tabStack>[a-r]?)(?<collapsed>\^?)(?<preview>\??)(?<active>\*?)$/.exec(tokens[index])?.groups;
			assert.ok(token, `invalid token ${tokens[index]}`);

			const editor = input(token.id);
			editors.set(token.id, editor);
			group.openEditor(editor, { pinned: !token.preview, active: true, index });

			if (token.sticky) {
				group.stick(editor);
			}

			if (token.tabStack) {
				editorsOfTabStack.set(token.tabStack, [...editorsOfTabStack.get(token.tabStack) ?? [], editor]);
				if (token.collapsed) {
					collapsedTabStacks.add(token.tabStack);
				}
			}

			if (token.active) {
				activeEditor = editor;
			}
		}

		const tabStacks = new Map<string, TabStackId>();
		for (const [letter, tabStackEditors] of editorsOfTabStack) {
			const tabStack = group.addEditorsToTabStack(tabStackEditors).tabStack;
			assert.ok(tabStack);
			tabStacks.set(letter, tabStack.id);
		}

		if (activeEditor) {
			group.setActive(activeEditor);
		}

		for (const letter of collapsedTabStacks) {
			const tabStack = tabStacks.get(letter);
			assert.ok(tabStack);
			group.updateTabStack(tabStack, { collapsed: true });
		}

		assert.strictEqual(tabStackState(group), state, 'the test group is created in the requested state');

		return {
			group,
			editor: id => {
				const editor = editors.get(id);
				assert.ok(editor);

				return editor;
			},
			tabStack: letter => {
				const tabStack = tabStacks.get(letter);
				assert.ok(tabStack);

				return tabStack;
			}
		};
	}

	function tabStackStateAfter(state: string, operation: (testGroup: ITabStackTestGroup) => void, editorConfiguration?: object): string {
		const testGroup = createTabStackTestGroup(state, editorConfiguration);

		operation(testGroup);

		return tabStackState(testGroup.group);
	}

	function recordEventKinds(group: EditorGroupModel): GroupModelChangeKind[] {
		const kinds: GroupModelChangeKind[] = [];
		disposables.add(group.onDidModelChange(e => kinds.push(e.kind)));

		return kinds;
	}

	test('tab stacks: adding to a new tab stack gathers the editors after the first one', () => {
		assert.deepStrictEqual({
			inPlace: tabStackStateAfter('0 1 2 3*', ({ group, editor }) => group.addEditorsToTabStack([editor('1'), editor('2')])),
			reorders: tabStackStateAfter('0 1 2*', ({ group, editor }) => group.addEditorsToTabStack([editor('0'), editor('2')])),
			fromMiddleOfTabStack: tabStackStateAfter('0a 1a 2a 3a*', ({ group, editor }) => group.addEditorsToTabStack([editor('1'), editor('2')])),
		}, {
			inPlace: '0 1a 2a 3*',
			reorders: '0a 2a* 1',
			fromMiddleOfTabStack: '0a 3a* 1b 2b',
		});
	});

	test('tab stacks: adding to a new tab stack skips sticky editors and pins preview editors', () => {
		const { group, editor } = createTabStackTestGroup('0s 1 2?*');

		const result = group.addEditorsToTabStack([editor('0'), editor('2')]);

		assert.deepStrictEqual({
			state: tabStackState(group),
			pinned: result.pinned.map(editorId),
			tabStack: result.tabStack?.editors.map(editorId),
		}, {
			state: '0s 1 2a*',
			pinned: ['2'],
			tabStack: ['2'],
		});
	});

	test('tab stacks: new tab stacks get the least used preset color', () => {
		const { group, editor, tabStack } = createTabStackTestGroup('0a 1b 2 3*');

		group.updateTabStack(tabStack('a'), { color: '#123456' });
		group.addEditorsToTabStack([editor('2')]);

		assert.deepStrictEqual({
			state: tabStackState(group),
			colors: group.tabStacks.map(tabStack => tabStack.color),
		}, {
			state: '0a 1b 2c 3*',
			colors: ['#123456', 'purple', 'blue'],
		});
	});

	test('tab stacks: adding to an existing tab stack moves editors to its nearer edge', () => {
		assert.deepStrictEqual({
			nearerEdge: tabStackStateAfter('0 1 2a 3a 4*', ({ group, editor, tabStack }) => group.addEditorsToTabStack([editor('0'), editor('4')], tabStack('a'))),
			expandsForActiveEditor: tabStackStateAfter('0a^ 1 2*', ({ group, editor, tabStack }) => group.addEditorsToTabStack([editor('2')], tabStack('a'))),
		}, {
			nearerEdge: '1 0a 2a 3a 4a*',
			expandsForActiveEditor: '0a 2a* 1',
		});
	});

	test('tab stacks: removing from a tab stack moves editors out through the nearer edge', () => {
		const all = createTabStackTestGroup('0a 1a 2a 3a*');
		const allResult = all.group.removeEditorsFromTabStack(['0', '1', '2', '3'].map(id => all.editor(id)));
		const allState = tabStackState(all.group);

		// A tab stack state left behind would still count as a used color
		const newTabStackColor = all.group.addEditorsToTabStack([all.editor('0')]).tabStack?.color;

		assert.deepStrictEqual({
			left: tabStackStateAfter('0a 1a 2a 3a*', ({ group, editor }) => group.removeEditorsFromTabStack([editor('1')])),
			right: tabStackStateAfter('0a 1a 2a 3a*', ({ group, editor }) => group.removeEditorsFromTabStack([editor('2')])),
			middleGoesToEnd: tabStackStateAfter('0a 1a 2a*', ({ group, editor }) => group.removeEditorsFromTabStack([editor('1')])),
			all: { state: allState, moves: allResult.moves.length, newTabStackColor },
		}, {
			left: '1 0a 2a 3a*',
			right: '0a 1a 3a* 2',
			middleGoesToEnd: '0a 2a* 1',
			all: { state: '0 1 2 3*', moves: 0, newTabStackColor: 'blue' },
		});
	});

	test('tab stacks: new editors open at the edge of a tab stack instead of joining it', () => {
		assert.deepStrictEqual({
			rightOfMiddleMember: tabStackStateAfter('0a 1a* 2a 3', ({ group }) => group.openEditor(input('4'), { pinned: true, active: true })),
			rightOfLastMember: tabStackStateAfter('0a 1a 2a* 3', ({ group }) => group.openEditor(input('4'), { pinned: true, active: true })),
			leftOfMiddleMember: tabStackStateAfter('0a 1a* 2a 3', ({ group }) => group.openEditor(input('4'), { pinned: true, active: true }), { openPositioning: 'left' }),
			indexInsideTabStack: tabStackStateAfter('0a 1a 2a 3*', ({ group }) => group.openEditor(input('4'), { pinned: true, active: true, index: 1 })),
			indexAtTabStackStart: tabStackStateAfter('0a 1a 2a 3*', ({ group }) => group.openEditor(input('4'), { pinned: true, active: true, index: 0 })),
			replacingPreview: tabStackStateAfter('0a 1a* 2a 3?', ({ group }) => group.openEditor(input('4'), { pinned: false, active: true })),
		}, {
			rightOfMiddleMember: '0a 1a 2a 4* 3',
			rightOfLastMember: '0a 1a 2a 4* 3',
			leftOfMiddleMember: '4* 0a 1a 2a 3',
			indexInsideTabStack: '0a 1a 2a 4* 3',
			indexAtTabStackStart: '4* 0a 1a 2a 3',
			replacingPreview: '0a 1a 2a 4?*',
		});
	});

	test('tab stacks: turning tab stacks off removes every tab stack and keeps the editors', () => {
		const { group } = createTabStackTestGroup('0 1a* 2a 3b^ 4b^ 5');
		const configuration = testInstService?.get(IConfigurationService);
		assert.ok(configuration instanceof TestConfigurationService);
		const kinds = recordEventKinds(group);

		configuration.setUserConfiguration('workbench', { editor: { openPositioning: 'right', focusRecentEditorAfterClose: true, enableTabStacks: false } });
		configuration.onDidChangeConfigurationEmitter.fire({
			source: ConfigurationTarget.USER,
			affectedKeys: new Set(['workbench.editor.enableTabStacks']),
			change: { keys: ['workbench.editor.enableTabStacks'], overrides: [] },
			affectsConfiguration: section => section === 'workbench.editor.enableTabStacks',
		});

		const state = tabStackState(group);
		const kindsWhenTurnedOff = [...kinds];
		group.openEditor(input('6'), { pinned: true, active: true });

		assert.deepStrictEqual({ state, kinds: kindsWhenTurnedOff, afterOpen: tabStackState(group) }, { state: '0 1* 2 3 4 5', kinds: [GroupModelChangeKind.TAB_STACKS], afterOpen: '0 1 6* 2 3 4 5' });
	});

	test('tab stacks: while tab stacks are disabled no tab stack is created or restored', () => {
		const serialized = createTabStackTestGroup('0a 1a* 2').group.serialize();

		const restoredGroup = createTabStackEditorGroupModel(serialized, { enableTabStacks: false });
		const restored = tabStackState(restoredGroup);
		restoredGroup.openEditor(input('6'), { pinned: true, active: true, index: 1 });

		assert.deepStrictEqual({
			added: tabStackStateAfter('0 1 2?*', ({ group, editor }) => group.addEditorsToTabStack([editor('0'), editor('2')]), { enableTabStacks: false }),
			serializedTabStacks: serialized.tabStacks?.length,
			restored,
			restoredAfterOpen: tabStackState(restoredGroup),
		}, {
			added: '0 1 2?*',
			serializedTabStacks: 1,
			restored: '0 1* 2',
			restoredAfterOpen: '0 6* 1 2',
		});
	});

	test('tab stacks: new editors opened with the tabStack option join it next to its editors', () => {
		assert.deepStrictEqual({
			insideTabStack: tabStackStateAfter('0a 1a 2a 3*', ({ group, tabStack }) => group.openEditor(input('4'), { pinned: true, active: true, index: 1, tabStack: tabStack('a') })),
			atTabStackStart: tabStackStateAfter('0a 1a 2a 3*', ({ group, tabStack }) => group.openEditor(input('4'), { pinned: true, active: true, index: 0, tabStack: tabStack('a') })),
			awayFromTabStack: tabStackStateAfter('0a 1a 2 3*', ({ group, tabStack }) => group.openEditor(input('4'), { pinned: true, active: true, index: 3, tabStack: tabStack('a') })),
			insideOtherTabStack: tabStackStateAfter('0a 1a 2a 3b 4*', ({ group, tabStack }) => group.openEditor(input('5'), { pinned: true, active: true, index: 1, tabStack: tabStack('b') })),
		}, {
			insideTabStack: '0a 4a* 1a 2a 3',
			atTabStackStart: '4a* 0a 1a 2a 3',
			awayFromTabStack: '0a 1a 2 4* 3',
			insideOtherTabStack: '0a 1a 2a 5* 3b 4',
		});
	});

	test('tab stacks: moving an editor keeps, joins or leaves tab stacks by where it lands', () => {
		assert.deepStrictEqual({
			toStartOfOwnTabStack: tabStackStateAfter('0 1a 2a 3a 4*', ({ group, editor }) => group.moveEditor(editor('3'), 1)),
			toMiddleOfOwnTabStack: tabStackStateAfter('0 1a 2a 3a 4*', ({ group, editor }) => group.moveEditor(editor('1'), 2)),
			toEndOfOwnTabStack: tabStackStateAfter('0 1a 2a 3a 4*', ({ group, editor }) => group.moveEditor(editor('1'), 3)),
			betweenNonMembers: tabStackStateAfter('0 1 2a 3a 4*', ({ group, editor }) => group.moveEditor(editor('2'), 1)),
			betweenTabStacks: tabStackStateAfter('0 1a 2a 3b 4b*', ({ group, editor }) => group.moveEditor(editor('0'), 2)),
			singleMemberTabStack: tabStackStateAfter('0a 1 2 3b 4*', ({ group, editor }) => group.moveEditor(editor('0'), 2)),
			intoTabStack: tabStackStateAfter('0 1a 2a 3*', ({ group, editor }) => group.moveEditor(editor('0'), 1)),
			intoOtherTabStack: tabStackStateAfter('0a 1a 2b 3b 4*', ({ group, editor }) => group.moveEditor(editor('0'), 2)),
			intoStickyEditors: tabStackStateAfter('0s 1 2a 3a 4*', ({ group, editor }) => group.moveEditor(editor('2'), 0)),
		}, {
			toStartOfOwnTabStack: '0 3a 1a 2a 4*',
			toMiddleOfOwnTabStack: '0 2a 1a 3a 4*',
			toEndOfOwnTabStack: '0 2a 3a 1a 4*',
			betweenNonMembers: '0 2 1 3a 4*',
			betweenTabStacks: '1a 2a 0 3b 4b*',
			singleMemberTabStack: '1 2 0a 3b 4*',
			intoTabStack: '1a 0a 2a 3*',
			intoOtherTabStack: '1a 2b 0b 3b 4*',
			intoStickyEditors: '2s 0s 1 3a 4*',
		});
	});

	test('tab stacks: moving editors within the group honors the target tab stack when it keeps tab stacks adjacent', () => {
		assert.deepStrictEqual({
			joinsTargetTabStack: tabStackStateAfter('0a 1a 2 3*', ({ group, editor, tabStack }) => group.moveEditorsWithinGroup([editor('2')], 2, tabStack('a'))),
			leavesForNull: tabStackStateAfter('0a 1a 2a 3*', ({ group, editor }) => group.moveEditorsWithinGroup([editor('2')], 2, null)),
			nullInsideTabStackFallsBack: tabStackStateAfter('0a 1a 2a 3*', ({ group, editor }) => group.moveEditorsWithinGroup([editor('3')], 1, null)),
			distantTargetFallsBack: tabStackStateAfter('0a 1a 2 3 4*', ({ group, editor, tabStack }) => group.moveEditorsWithinGroup([editor('3')], 3, tabStack('a'))),
			wholeTabStackStaysTogether: tabStackStateAfter('0 1a 2a 3 4*', ({ group, editor }) => group.moveEditorsWithinGroup([editor('1'), editor('2')], 3)),
		}, {
			joinsTargetTabStack: '0a 1a 2a 3*',
			leavesForNull: '0a 1a 2 3*',
			nullInsideTabStackFallsBack: '0a 3a* 1a 2a',
			distantTargetFallsBack: '0a 1a 2 3 4*',
			wholeTabStackStaysTogether: '0 3 4* 1a 2a',
		});
	});

	test('tab stacks: preview editors that join a tab stack by moving are pinned', () => {
		const testGroup = createTabStackTestGroup('0a 1a 2?*');

		const result = testGroup.group.moveEditorsWithinGroup([testGroup.editor('2')], 1);

		assert.deepStrictEqual({
			state: tabStackState(testGroup.group),
			pinned: result.pinned.map(editorId),
			singleMove: tabStackStateAfter('0a 1a 2?*', ({ group, editor }) => group.moveEditor(editor('2'), 1)),
		}, {
			state: '0a 2a* 1a',
			pinned: ['2'],
			singleMove: '0a 2a* 1a',
		});
	});

	test('tab stacks: moving a tab stack moves all of its editors and never lands inside another tab stack', () => {
		assert.deepStrictEqual({
			right: tabStackStateAfter('1 2a 3a 4 5*', ({ group, tabStack }) => group.moveTabStack(tabStack('a'), 2)),
			left: tabStackStateAfter('1 2 3a 4a 5*', ({ group, tabStack }) => group.moveTabStack(tabStack('a'), 0)),
			rightIntoTabStack: tabStackStateAfter('0a 1a 2b 3b 4*', ({ group, tabStack }) => group.moveTabStack(tabStack('a'), 1)),
			leftIntoTabStack: tabStackStateAfter('0 1a 2a 3b 4b*', ({ group, tabStack }) => group.moveTabStack(tabStack('b'), 2)),
			beforeStickyEditors: tabStackStateAfter('0s 1 2a 3a*', ({ group, tabStack }) => group.moveTabStack(tabStack('a'), 0)),
		}, {
			right: '1 4 2a 3a 5*',
			left: '3a 4a 1 2 5*',
			rightIntoTabStack: '2a 3a 0b 1b 4*',
			leftIntoTabStack: '0 3a 4a* 1b 2b',
			beforeStickyEditors: '0s 2a 3a* 1',
		});
	});

	test('tab stacks: EDITOR_MOVE events and returned moves of tab stack operations replay to the final order', () => {
		type TabStackOperationResult = ReturnType<EditorGroupModel['removeEditorsFromTabStack']>;

		function replayMove(editors: EditorInput[], editor: EditorInput, from: number, to: number): void {
			editors.splice(from, 1);
			editors.splice(to, 0, editor);
		}

		function replay(state: string, operation: (testGroup: ITabStackTestGroup) => TabStackOperationResult | void): { replayedEvents: string[]; replayedMoves?: string[]; actual: string[] } {
			const testGroup = createTabStackTestGroup(state);
			const initialOrder = testGroup.group.getEditors(EditorsOrder.SEQUENTIAL);

			const replayedEvents = initialOrder.slice(0);
			disposables.add(testGroup.group.onDidModelChange(e => {
				if (isGroupEditorMoveEvent(e)) {
					replayMove(replayedEvents, replayedEvents[e.oldEditorIndex], e.oldEditorIndex, e.editorIndex);
				}
			}));

			const result = operation(testGroup);

			const actual = testGroup.group.getEditors(EditorsOrder.SEQUENTIAL).map(editorId);
			if (!result) {
				return { replayedEvents: replayedEvents.map(editorId), actual };
			}

			const replayedMoves = initialOrder.slice(0);
			for (const move of result.moves) {
				replayMove(replayedMoves, move.editor, move.from, move.to);
			}

			return { replayedEvents: replayedEvents.map(editorId), replayedMoves: replayedMoves.map(editorId), actual };
		}

		assert.deepStrictEqual({
			addToNewTabStack: replay('0 1 2 3 4*', ({ group, editor }) => group.addEditorsToTabStack([editor('0'), editor('2'), editor('4')])),
			addToTabStack: replay('0 1 2a 3a 4 5*', ({ group, editor, tabStack }) => group.addEditorsToTabStack([editor('0'), editor('1'), editor('5')], tabStack('a'))),
			removeFromTabStack: replay('0a 1a 2a 3a 4*', ({ group, editor }) => group.removeEditorsFromTabStack([editor('1'), editor('2')])),
			moveEditor: replay('0 1a 2a 3*', ({ group, editor }) => { group.moveEditor(editor('0'), 2); }),
			moveTabStack: replay('0a 1a 2 3 4*', ({ group, tabStack }) => group.moveTabStack(tabStack('a'), 2)),
			moveEditorsWithinGroup: replay('0 1 2 3 4*', ({ group, editor }) => group.moveEditorsWithinGroup([editor('0'), editor('2'), editor('4')], 1)),
		}, {
			addToNewTabStack: { replayedEvents: ['0', '2', '4', '1', '3'], replayedMoves: ['0', '2', '4', '1', '3'], actual: ['0', '2', '4', '1', '3'] },
			addToTabStack: { replayedEvents: ['0', '1', '2', '3', '5', '4'], replayedMoves: ['0', '1', '2', '3', '5', '4'], actual: ['0', '1', '2', '3', '5', '4'] },
			removeFromTabStack: { replayedEvents: ['1', '0', '3', '2', '4'], replayedMoves: ['1', '0', '3', '2', '4'], actual: ['1', '0', '3', '2', '4'] },
			moveEditor: { replayedEvents: ['1', '2', '0', '3'], actual: ['1', '2', '0', '3'] },
			moveTabStack: { replayedEvents: ['2', '3', '0', '1', '4'], replayedMoves: ['2', '3', '0', '1', '4'], actual: ['2', '3', '0', '1', '4'] },
			moveEditorsWithinGroup: { replayedEvents: ['1', '0', '2', '4', '3'], replayedMoves: ['1', '0', '2', '4', '3'], actual: ['1', '0', '2', '4', '3'] },
		});
	});

	test('tab stacks: sticking an editor removes it from its tab stack and closing the last editor deletes the tab stack', () => {
		const closeLast = createTabStackTestGroup('0a 1 2*');
		closeLast.group.closeEditor(closeLast.editor('0'));
		const closeLastState = tabStackState(closeLast.group);

		// A tab stack state left behind would still count as a used color
		const newTabStackColor = closeLast.group.addEditorsToTabStack([closeLast.editor('1')]).tabStack?.color;

		assert.deepStrictEqual({
			stick: tabStackStateAfter('0 1a 2a 3*', ({ group, editor }) => group.stick(editor('2'))),
			closeLastEditor: { state: closeLastState, newTabStackColor },
		}, {
			stick: '2s 0 1a 3*',
			closeLastEditor: { state: '1 2*', newTabStackColor: 'blue' },
		});
	});

	test('tab stacks: editors of a tab stack cannot be unpinned', () => {
		assert.deepStrictEqual(tabStackStateAfter('0a 1a*', ({ group, editor }) => group.unpin(editor('0'))), '0a 1a*');
	});

	test('tab stacks: closing the active editor activates an editor that is not hidden in a collapsed tab stack', () => {
		assert.deepStrictEqual({
			mostRecentlyActive: tabStackStateAfter('0 1a^ 2a^ 3*', ({ group, editor }) => group.closeEditor(editor('3'))),
			nextToTheRight: tabStackStateAfter('0 1* 2a^ 3a^ 4', ({ group, editor }) => group.closeEditor(editor('1')), { focusRecentEditorAfterClose: false }),
			onlyHiddenEditorsLeft: tabStackStateAfter('0a^ 1*', ({ group, editor }) => group.closeEditor(editor('1'))),
		}, {
			mostRecentlyActive: '0* 1a^ 2a^',
			nextToTheRight: '0 2a^ 3a^ 4*',
			onlyHiddenEditorsLeft: '0a*',
		});
	});

	test('tab stacks: collapsing the tab stack of the active editor activates the nearest visible editor', () => {
		const collapse = ({ group, tabStack }: ITabStackTestGroup) => group.updateTabStack(tabStack('a'), { collapsed: true });

		assert.deepStrictEqual({
			right: tabStackStateAfter('0 1a 2a* 3 4', collapse),
			left: tabStackStateAfter('0 1 2 3a* 4a', collapse),
			noVisibleEditor: tabStackStateAfter('0a 1a*', collapse),
		}, {
			right: '0 1a^ 2a^ 3* 4',
			left: '0 1 2* 3a^ 4a^',
			noVisibleEditor: '0a 1a*',
		});
	});

	test('tab stacks: collapsing a tab stack removes its editors from the selection', () => {
		function selectionAfterCollapse(state: string, activeId: string): string[] {
			const { group, editor, tabStack } = createTabStackTestGroup(state);
			group.setSelection(editor(activeId), ['0', '1', '2', '3'].filter(id => id !== activeId).map(editor));

			group.updateTabStack(tabStack('a'), { collapsed: true });
			tabStackState(group); // asserts the tab stack invariants

			return group.selectedEditors.map(selectedEditor => `${editorId(selectedEditor)}${group.isActive(selectedEditor) ? '*' : ''}`);
		}

		assert.deepStrictEqual({
			inactiveTabStack: selectionAfterCollapse('0 1a 2a 3*', '3'),
			activeTabStack: selectionAfterCollapse('0 1a 2a* 3', '2'),
		}, {
			inactiveTabStack: ['0', '3*'],
			activeTabStack: ['0', '3*'],
		});
	});

	test('tab stacks: selected editors that end up hidden in a collapsed tab stack leave the selection', () => {
		function afterJoining(state: string, selectedIds: string[], operation: (testGroup: ITabStackTestGroup) => void): string {
			const testGroup = createTabStackTestGroup(state);
			const [activeId, ...inactiveIds] = selectedIds;
			testGroup.group.setSelection(testGroup.editor(activeId), inactiveIds.map(testGroup.editor));

			operation(testGroup);

			return `${tabStackState(testGroup.group)} | ${testGroup.group.selectedEditors.map(editorId).join(' ')}`;
		}

		assert.deepStrictEqual({
			added: afterJoining('0* 1 2a^ 3', ['0', '1', '3'], ({ group, editor, tabStack }) => group.addEditorsToTabStack([editor('1')], tabStack('a'))),
			moved: afterJoining('0* 1 2a^ 3a^ 4', ['0', '1', '4'], ({ group, editor }) => group.moveEditor(editor('4'), 3)),
			addedWithActiveEditor: afterJoining('0 1* 2a^', ['1', '0'], ({ group, editor, tabStack }) => group.addEditorsToTabStack([editor('0'), editor('1')], tabStack('a'))),
		}, {
			added: '0* 1a^ 2a^ 3 | 0 3',
			moved: '0* 1 2a^ 4a^ 3a^ | 0 1',
			addedWithActiveEditor: '0a 1a* 2a | 0 1',
		});
	});

	test('tab stacks: activating a hidden editor expands its tab stack before the editor becomes active', () => {
		const testGroup = createTabStackTestGroup('0 1a^ 2a^ 3*');
		const kinds = recordEventKinds(testGroup.group);

		testGroup.group.setActive(testGroup.editor('1'));

		assert.deepStrictEqual({
			state: tabStackState(testGroup.group),
			events: kinds,
			openExisting: tabStackStateAfter('0 1a^ 2a^ 3*', ({ group, editor }) => group.openEditor(editor('2'), { active: true })),
		}, {
			state: '0 1a* 2a 3',
			events: [GroupModelChangeKind.TAB_STACKS, GroupModelChangeKind.EDITOR_ACTIVE, GroupModelChangeKind.EDITORS_SELECTION],
			openExisting: '0 1a 2a* 3',
		});
	});

	test('tab stacks: parseTabStackColor accepts presets and #rgb or #rrggbb colors', () => {
		const values: unknown[] = ['blue', 'gray', '#ABC', '#AbCdEf', '#abcd', '#aabbccdd', '#ggg', 'red1', 'grey', '', 42];

		assert.deepStrictEqual(values.map(value => [value, parseTabStackColor(value)]), [
			['blue', 'blue'],
			['gray', 'gray'],
			['#ABC', '#aabbcc'],
			['#AbCdEf', '#abcdef'],
			['#abcd', undefined],
			['#aabbccdd', undefined],
			['#ggg', undefined],
			['red1', undefined],
			['grey', undefined],
			['', undefined],
			[42, undefined],
		]);
	});

	test('tab stacks: updating a tab stack changes its label and color and ignores an invalid color', () => {
		const { group, tabStack } = createTabStackTestGroup('0a 1a*');

		group.updateTabStack(tabStack('a'), { label: 'Auth', color: '#1A2B3C' });
		group.updateTabStack(tabStack('a'), { color: '#abcd' });

		assert.deepStrictEqual({
			state: tabStackState(group),
			tabStacks: group.tabStacks.map(({ label, color }) => ({ label, color })),
		}, {
			state: '0a 1a*',
			tabStacks: [{ label: 'Auth', color: '#1a2b3c' }],
		});
	});

	test('tab stacks: clone copies tab stacks without sharing their state', () => {
		const { group, tabStack } = createTabStackTestGroup('0 1a 2a 3b^ 4*');
		group.updateTabStack(tabStack('a'), { label: 'Auth', color: '#123456' });

		const clone = disposables.add(group.clone());
		clone.updateTabStack(tabStack('a'), { label: 'Changed' });

		assert.deepStrictEqual({
			state: tabStackState(clone),
			clone: clone.tabStacks.map(({ label, color }) => ({ label, color })),
			original: group.tabStacks.map(({ label, color }) => ({ label, color })),
		}, {
			state: '0 1a 2a 3b^ 4*',
			clone: [{ label: 'Changed', color: '#123456' }, { label: '', color: 'purple' }],
			original: [{ label: 'Auth', color: '#123456' }, { label: '', color: 'purple' }],
		});
	});

	test('tab stacks: serialize and restore keep tab stacks', () => {
		const { group, tabStack } = createTabStackTestGroup('0 1a 2a 3b^ 4*');
		group.updateTabStack(tabStack('a'), { label: 'Auth' });
		group.updateTabStack(tabStack('b'), { color: '#1a2b3c' });

		const serialized = group.serialize();
		const restored = createTabStackEditorGroupModel(serialized);

		assert.deepStrictEqual({
			serialized: JSON.parse(JSON.stringify(serialized.tabStacks)),
			state: tabStackState(restored),
			tabStacks: restored.tabStacks.map(({ label, color }) => ({ label, color })),
		}, {
			serialized: [
				{ label: 'Auth', color: 'blue', editors: [1, 2] },
				{ label: '', color: '#1a2b3c', collapsed: true, editors: [3] },
			],
			state: '0 1a 2a 3b^ 4*',
			tabStacks: [{ label: 'Auth', color: 'blue' }, { label: '', color: '#1a2b3c' }],
		});
	});

	test('tab stacks: serialize skips editors that cannot be serialized', () => {
		const group = createTabStackEditorGroupModel();
		const editors = [input('0'), input('1', true), input('2'), input('3', true), input('4'), input('5')];
		for (const editor of editors) {
			group.openEditor(editor, { pinned: true, active: true });
		}
		group.addEditorsToTabStack([editors[2], editors[3], editors[4]]);

		const serialized = group.serialize();

		assert.deepStrictEqual({
			serialized: serialized.tabStacks?.map(tabStack => tabStack.editors),
			restored: tabStackState(createTabStackEditorGroupModel(serialized)),
		}, {
			serialized: [[1, 2]],
			restored: '0 2a 4a 5*',
		});
	});

	test('tab stacks: restore drops members and tab stacks that are invalid', () => {
		const data: ISerializedEditorGroupModel = {
			id: 1,
			editors: [serializedTestEditor('0'), serializedTestEditor('1'), { id: 'unknownEditorType', value: '' }, serializedTestEditor('3'), serializedTestEditor('4'), serializedTestEditor('5'), serializedTestEditor('6'), serializedTestEditor('7')],
			mru: [0, 1, 2, 3, 4, 5, 6],
			sticky: 0,
			tabStacks: [
				{ label: 'with sticky editor', color: 'blue', editors: [0, 1] },
				{ label: 'with missing editor', color: 'not a color', collapsed: true, editors: [2, 3] },
				{ label: 'with claimed editor', color: 'red', editors: [3, 4] },
				{ label: 'not adjacent', color: 'green', editors: [5, 7] },
				{ label: 'with invalid indices', color: 'pink', editors: [6, 99, -1, 1.5] },
			]
		};
		const tabStacksBeforeRestore = JSON.stringify(data.tabStacks);

		const restored = createTabStackEditorGroupModel(data);

		assert.deepStrictEqual({
			state: tabStackState(restored),
			tabStacks: restored.tabStacks.map(({ label, color }) => ({ label, color })),
			dataUnchanged: JSON.stringify(data.tabStacks) === tabStacksBeforeRestore,
		}, {
			state: '0s* 1a 3b^ 4c 5 6d 7',
			tabStacks: [
				{ label: 'with sticky editor', color: 'blue' },
				{ label: 'with missing editor', color: 'gray' },
				{ label: 'with claimed editor', color: 'red' },
				{ label: 'with invalid indices', color: 'pink' },
			],
			dataUnchanged: true,
		});
	});

	test('tab stacks: restore expands the tab stack of the active editor', () => {

		const restored = createTabStackEditorGroupModel({
			id: 1,
			editors: [serializedTestEditor('0'), serializedTestEditor('1'), serializedTestEditor('2')],
			mru: [0, 1, 2],
			tabStacks: [{ label: '', color: 'blue', collapsed: true, editors: [0, 1] }]
		});

		assert.deepStrictEqual(tabStackState(restored), '0a* 1a 2');
	});

	test('tab stacks: restore keeps a preview editor in its tab stack and pins it', () => {
		const restored = createTabStackEditorGroupModel({
			id: 1,
			editors: [serializedTestEditor('0'), serializedTestEditor('1'), serializedTestEditor('2')],
			mru: [0, 1, 2],
			preview: 2,
			tabStacks: [{ label: '', color: 'blue', editors: [1, 2] }]
		});

		assert.deepStrictEqual(tabStackState(restored), '0* 1a 2a');
	});

	test('tab stacks: serialize omits tab stacks when there are none and older state restores without them', () => {
		const group = createTabStackEditorGroupModel();
		group.openEditor(input('0'), { pinned: true, active: true });

		const serialized = group.serialize();

		assert.deepStrictEqual({
			stored: JSON.stringify(serialized).includes('tabStacks'),
			restored: createTabStackEditorGroupModel(serialized).tabStacks.length,
		}, {
			stored: false,
			restored: 0,
		});
	});

	test('tab stacks: operations that change tab stacks fire one TAB_STACKS event', () => {
		const { group, editor, tabStack } = createTabStackTestGroup('0 1a 2a 3 4*');
		const kinds = recordEventKinds(group);
		const countTabStacksEvents = (operation: () => void) => {
			const before = kinds.filter(kind => kind === GroupModelChangeKind.TAB_STACKS).length;
			operation();
			tabStackState(group); // asserts the tab stack invariants

			return kinds.filter(kind => kind === GroupModelChangeKind.TAB_STACKS).length - before;
		};

		assert.deepStrictEqual({
			rename: countTabStacksEvents(() => group.updateTabStack(tabStack('a'), { label: 'Auth' })),
			renameToSameLabel: countTabStacksEvents(() => group.updateTabStack(tabStack('a'), { label: 'Auth' })),
			moveWithinTabStack: countTabStacksEvents(() => group.moveEditor(editor('2'), 1)),
			moveTabStack: countTabStacksEvents(() => group.moveTabStack(tabStack('a'), 2)),
			openOutsideTabStacks: countTabStacksEvents(() => group.openEditor(input('5'), { pinned: true, active: true })),
			addToNewTabStack: countTabStacksEvents(() => group.addEditorsToTabStack([editor('0'), editor('3')])),
			removeFromTabStack: countTabStacksEvents(() => group.removeEditorsFromTabStack([editor('1')])),
			closeLastEditorOfTabStack: countTabStacksEvents(() => group.closeEditor(editor('2'))),
			closeEditorOutsideTabStacks: countTabStacksEvents(() => group.closeEditor(editor('4'))),
		}, {
			rename: 1,
			renameToSameLabel: 0,
			moveWithinTabStack: 0,
			moveTabStack: 0,
			openOutsideTabStacks: 0,
			addToNewTabStack: 1,
			removeFromTabStack: 1,
			closeLastEditorOfTabStack: 1,
			closeEditorOutsideTabStacks: 0,
		});
	});

	//#endregion

	ensureNoDisposablesAreLeakedInTestSuite();
});
