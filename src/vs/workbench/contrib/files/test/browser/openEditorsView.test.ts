/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventType } from '../../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ExternalElementsDragAndDropData, ListViewTargetSector } from '../../../../../base/browser/ui/list/listView.js';
import { List } from '../../../../../base/browser/ui/list/listWidget.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { fillEditorsDragData } from '../../../../browser/dnd.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../common/editor/sideBySideEditorInput.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { Extensions as DragAndDropExtensions, IDragAndDropContributionRegistry } from '../../../../../platform/dnd/browser/dnd.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { WorkspaceTrustUriResponse } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorGroupView } from '../../../../browser/parts/editor/editor.js';
import { EditorService } from '../../../../services/editor/browser/editorService.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService } from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { OpenEditor } from '../../common/files.js';
import { findFirstDirtyEditor, OpenEditorsDragAndDrop } from '../../browser/views/openEditorsView.js';
import { createEditorPart, registerTestFileEditor, TestEditorGroupView, TestEditorInput, TestFileEditorInput, TestServiceAccessor, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';

suite('Files - OpenEditorsView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class TestDirtyEditorInput extends TestEditorInput {
		override isDirty(): boolean {
			return true;
		}
	}

	const delegate: IListVirtualDelegate<OpenEditor> = {
		getHeight: () => 20,
		getTemplateId: () => 'openEditor'
	};
	const renderer: IListRenderer<OpenEditor, void> = {
		templateId: 'openEditor',
		renderTemplate: () => undefined,
		renderElement: () => undefined,
		disposeTemplate: () => undefined
	};

	function createList(): List<OpenEditor> {
		const editorIds = new WeakMap<object, number>();
		let editorIdPool = 0;

		return store.add(new List<OpenEditor>('OpenEditors', document.createElement('div'), delegate, [renderer], {
			identityProvider: {
				getId: openEditor => {
					let editorId = editorIds.get(openEditor.editor);
					if (editorId === undefined) {
						editorId = editorIdPool++;
						editorIds.set(openEditor.editor, editorId);
					}

					return `openeditor:${openEditor.groupId}:${editorId}`;
				}
			}
		}));
	}

	test('preserves multi-selection when an editor is refreshed', () => {
		const group = new TestEditorGroupView(1);
		const firstEditor = store.add(new TestEditorInput(URI.parse('test:/first'), 'testEditor'));
		const secondEditor = store.add(new TestEditorInput(URI.parse('test:/second'), 'testEditor'));
		const list = createList();

		list.splice(0, 0, [new OpenEditor(firstEditor, group), new OpenEditor(secondEditor, group)]);
		list.setSelection([0, 1]);
		list.splice(1, 1, [new OpenEditor(secondEditor, group)]);

		assert.deepStrictEqual(list.getSelection(), [0, 1]);
	});

	test('preserves multi-selection when editors are resorted', () => {
		const group = new TestEditorGroupView(1);
		const firstEditor = store.add(new TestEditorInput(URI.parse('test:/first'), 'testEditor'));
		const secondEditor = store.add(new TestEditorInput(URI.parse('test:/second'), 'testEditor'));
		const thirdEditor = store.add(new TestEditorInput(URI.parse('test:/third'), 'testEditor'));
		const list = createList();

		list.splice(0, 0, [new OpenEditor(firstEditor, group), new OpenEditor(secondEditor, group), new OpenEditor(thirdEditor, group)]);
		list.setSelection([0, 1]);
		list.splice(0, list.length, [new OpenEditor(thirdEditor, group), new OpenEditor(firstEditor, group), new OpenEditor(secondEditor, group)]);

		assert.deepStrictEqual(list.getSelection(), [1, 2]);
	});

	test('finds the first unsaved editor in index order', () => {
		const firstGroup = new TestEditorGroupView(1);
		const secondGroup = new TestEditorGroupView(2);
		const savedEditor = store.add(new TestEditorInput(URI.parse('test:/saved'), 'testEditor'));
		const firstDirtyEditor = store.add(new TestDirtyEditorInput(URI.parse('test:/firstDirty'), 'testEditor'));
		const secondDirtyEditor = store.add(new TestDirtyEditorInput(URI.parse('test:/secondDirty'), 'testEditor'));

		firstGroup.editors = [savedEditor];
		secondGroup.editors = [savedEditor, firstDirtyEditor, secondDirtyEditor];

		const firstDirty = findFirstDirtyEditor([firstGroup, secondGroup]);

		assert.deepStrictEqual({ editor: firstDirty?.editor, group: firstDirty?.group }, { editor: firstDirtyEditor, group: secondGroup });
	});

	test('finds no unsaved editor when all editors are saved', () => {
		const group = new TestEditorGroupView(1);
		const savedEditor = store.add(new TestEditorInput(URI.parse('test:/saved'), 'testEditor'));

		group.editors = [savedEditor];

		assert.strictEqual(findFirstDirtyEditor([group]), undefined);
	});

	/**
	 * Creates an editor part with two groups that have a file editor for each
	 * name of their fixture, drops on an editor of the first group in the Open
	 * Editors view, and describes the drop and the editors of both groups
	 * afterwards, with an `s` after each pinned editor and a letter per tab
	 * stack after each of its editors.
	 *
	 * @param drop drops on the editor of the first group with the name, and
	 * resolves once the drop opened or moved the editors that it drops.
	 * @param editorConfiguration the `workbench.editor` settings, if not the
	 * defaults.
	 */
	async function dropOnFixture(fixtures: readonly [string, string], description: string, drop: (dnd: OpenEditorsDragAndDrop, groups: readonly [IEditorGroupView, IEditorGroupView], openEditorOf: (group: IEditorGroup, name: string) => OpenEditor, instantiationService: IInstantiationService) => Promise<void>, editorConfiguration?: object): Promise<string> {
		const disposables = store.add(new DisposableStore());
		disposables.add(registerTestFileEditor());
		const instantiationService = workbenchInstantiationService(editorConfiguration ? {
			configurationService: () => {
				const configurationService = new TestConfigurationService({ workbench: { editor: editorConfiguration } });
				disposables.add(configurationService.onDidChangeConfigurationEmitter);

				return configurationService;
			}
		} : undefined, disposables);
		const part = await createEditorPart(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, part);
		const editorService = disposables.add(instantiationService.createInstance(EditorService, undefined));
		instantiationService.stub(IEditorService, editorService);

		const groups = [part.activeGroup, part.addGroup(part.activeGroup, GroupDirection.RIGHT)] as const;
		for (const [index, fixture] of fixtures.entries()) {
			for (const name of fixture.split(' ').filter(name => !!name)) {
				await editorService.openEditor({ resource: URI.file(name), options: { pinned: true } }, groups[index]);
			}
		}

		const openEditorOf = (group: IEditorGroup, name: string) => new OpenEditor(group.getEditors(EditorsOrder.SEQUENTIAL).find(editor => editor.getName() === name)!, group);
		await drop(new OpenEditorsDragAndDrop('editorOrder', instantiationService, part, instantiationService.get(IEditorResolverService)), groups, openEditorOf, instantiationService);
		// A split editor and an editor of another kind than a file editor show their kind after the name of their file, and a pinned editor shows an `s` after it
		const describeEditor = (editor: EditorInput) => editor instanceof SideBySideEditorInput ? `${editor.getName()}(split)` : editor instanceof TestFileEditorInput ? `${basename(editor.resource)}(${editor.typeId})` : editor.getName();
		const describeTabStack = (group: IEditorGroup, editor: EditorInput) => {
			const index = group.tabStacks.findIndex(tabStack => tabStack.id === group.getTabStack(editor)?.id);

			return index >= 0 ? String.fromCharCode('a'.charCodeAt(0) + index) : '';
		};
		const describe = (group: IEditorGroup) => group.getEditors(EditorsOrder.SEQUENTIAL).map(editor => `${describeEditor(editor)}${group.isSticky(editor) ? 's' : ''}${describeTabStack(group, editor)}`).join(' ');
		const result = `${description}: ${describe(groups[0])} | ${describe(groups[1])}`;

		await workbenchTeardown(instantiationService);

		return result;
	}

	/**
	 * What makes a drop of files open none of them: a registered drop handler
	 * that takes them, or their trust prompt, cancelled.
	 */
	type DropRefusal = 'dropHandler' | 'trust';

	function describeDropRefusal(refusal: DropRefusal): string {
		return refusal === 'dropHandler' ? 'taken by a drop handler' : 'with trust cancelled';
	}

	/**
	 * Drops the files with the space-separated names, in order, from the
	 * Explorer on the Open Editors view before the target, an editor of the
	 * group, and resolves once the group opened the files, or once the drop
	 * finished if `refusal` refuses it. The first file must not be the active
	 * editor of the group.
	 */
	async function dropFilesFromExplorer(dnd: OpenEditorsDragAndDrop, group: IEditorGroupView, target: OpenEditor, names: string, instantiationService: IInstantiationService, refusal?: DropRefusal): Promise<void> {
		const droppedNames = names.split(' ');
		const dataTransfer = new DataTransfer();
		instantiationService.invokeFunction(accessor => fillEditorsDragData(accessor, droppedNames.map(name => ({ resource: URI.file(name), isDirectory: false })), new DragEvent(EventType.DRAG_START, { dataTransfer })));

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

		// The group opens the first dropped file active once the drop resolved it, and then the others after it
		const opened = refusal ? refused.p : Promise.all([
			Event.toPromise(group.onDidActiveEditorChange),
			Event.toPromise(Event.filter(group.onWillOpenEditor, e => e.editor.getName() === droppedNames.at(-1)))
		]);
		dnd.drop(new ExternalElementsDragAndDropData([]), target, 0, ListViewTargetSector.TOP, new DragEvent(EventType.DROP, { dataTransfer }));
		await opened;

		// A refused drop finishes right after it is refused
		dropHandler?.dispose();
		if (refusal) {
			await timeout(0);
		}
	}

	test('editors dropped on an editor land where the drop shows, also an editor from another group that the group has already', async () => {
		const drops = [];
		for (const [fixtures, dragged, target, sector] of [
			[['1 2 3 4', ''], '1', '3', ListViewTargetSector.TOP],
			[['1 2 3 4', ''], '1', '3', ListViewTargetSector.BOTTOM],
			[['1 2 3 4 5', ''], '1 2', '4', ListViewTargetSector.TOP],
			[['1 2 3 4 5', ''], '4 1', '3', ListViewTargetSector.TOP],
			[['1 2 3 4', '1'], '1', '3', ListViewTargetSector.TOP],
			[['1 2 3 4', '1 5'], '1 5', '3', ListViewTargetSector.TOP],
			[['1 2 3 4', '9 1'], '9 1', '3', ListViewTargetSector.TOP],
			[['1 2 3 4', '1 2'], '1 2', '4', ListViewTargetSector.TOP],
			[['1 2 3 4', '5'], '5', '3', ListViewTargetSector.TOP],
		] as const) {
			const source = fixtures[1] ? 1 : 0;
			const description = `${fixtures.join(' | ')}, ${dragged} of group ${source + 1} ${sector === ListViewTargetSector.TOP ? 'before' : 'after'} ${target}`;

			// The editors move while the drop is handled
			drops.push(await dropOnFixture(fixtures, description, async (dnd, groups, openEditorOf) => {
				dnd.drop(new ElementsDragAndDropData(dragged.split(' ').map(name => openEditorOf(groups[source], name))), openEditorOf(groups[0], target), 0, sector, new DragEvent(EventType.DROP));
			}));
		}

		assert.deepStrictEqual(drops, [
			'1 2 3 4 | , 1 of group 1 before 3: 2 1 3 4 | ',
			'1 2 3 4 | , 1 of group 1 after 3: 2 3 1 4 | ',
			'1 2 3 4 5 | , 1 2 of group 1 before 4: 3 1 2 4 5 | ',
			'1 2 3 4 5 | , 4 1 of group 1 before 3: 2 4 1 3 5 | ',
			'1 2 3 4 | 1, 1 of group 2 before 3: 2 1 3 4 | ',
			'1 2 3 4 | 1 5, 1 5 of group 2 before 3: 2 1 5 3 4 | ',
			'1 2 3 4 | 9 1, 9 1 of group 2 before 3: 2 9 1 3 4 | ',
			'1 2 3 4 | 1 2, 1 2 of group 2 before 4: 3 1 2 4 | ',
			'1 2 3 4 | 5, 5 of group 2 before 3: 1 2 5 3 4 | ',
		]);
	});

	test('a file dropped from the Explorer on an editor lands where the drop shows, also a file that the group has already', async () => {
		const drops = [];
		for (const [dropped, target] of [['1', '3'], ['2', '1'], ['9', '3']]) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `${dropped} before ${target}`, (dnd, groups, openEditorOf, instantiationService) => {
				return dropFilesFromExplorer(dnd, groups[0], openEditorOf(groups[0], target), dropped, instantiationService);
			}));
		}

		assert.deepStrictEqual(drops, [
			'1 before 3: 2 1 3 4 | ',
			'2 before 1: 2 1 3 4 | ',
			'9 before 3: 1 2 9 3 4 | ',
		]);
	});

	test('files dropped together from the Explorer on an editor land next to each other in drop order where the drop shows, also files that the group has already before or after the drop', async () => {
		const drops = [];
		for (const [dropped, target] of [['9 1', '3'], ['1 2', '4'], ['1 9 2', '4'], ['3 1', '2'], ['9 3', '2']]) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `${dropped} before ${target}`, (dnd, groups, openEditorOf, instantiationService) => {
				return dropFilesFromExplorer(dnd, groups[0], openEditorOf(groups[0], target), dropped, instantiationService);
			}));
		}

		assert.deepStrictEqual(drops, [
			'9 1 before 3: 2 9 1 3 4 | ',
			'1 2 before 4: 3 1 2 4 | ',
			'1 9 2 before 4: 3 1 9 2 4 | ',
			'3 1 before 2: 3 1 2 4 | ',
			'9 3 before 2: 1 9 3 2 4 | ',
		]);
	});

	test('files dropped together from the Explorer right after the pinned editors stay pinned only before a file that the group does not have yet or an editor that is not pinned, as entries dragged there do', async () => {
		const drops = [];
		for (const [dropped, source] of [['9 2', 'files'], ['9 2', 'entries'], ['4 2', 'files'], ['4 2', 'entries'], ['1 2', 'files'], ['1 2', 'entries']] as const) {
			drops.push(await dropOnFixture(['1 2 3 4 5', '9'], `${dropped} as ${source} before 3`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				group.stickEditor(openEditorOf(group, '1').editor);
				group.stickEditor(openEditorOf(group, '2').editor);

				// The entry of 9 comes from the second group, and the entries move while the drop is handled
				if (source === 'files') {
					await dropFilesFromExplorer(dnd, group, openEditorOf(group, '3'), dropped, instantiationService);
				} else {
					dnd.drop(new ElementsDragAndDropData(dropped.split(' ').map(name => openEditorOf(name === '9' ? groups[1] : group, name))), openEditorOf(group, '3'), 0, ListViewTargetSector.TOP, new DragEvent(EventType.DROP));
				}
			}));
		}

		assert.deepStrictEqual(drops, [
			'9 2 as files before 3: 1s 9 2 3 4 5 | 9',
			'9 2 as entries before 3: 1s 9 2 3 4 5 | ',
			'4 2 as files before 3: 1s 4 2 3 5 | 9',
			'4 2 as entries before 3: 1s 4 2 3 5 | 9',
			'1 2 as files before 3: 1s 2s 3 4 5 | 9',
			'1 2 as entries before 3: 1s 2s 3 4 5 | 9',
		]);
	});

	test('files dropped from the Explorer on an editor that a registered drop handler takes, or whose trust is cancelled, move and unpin no editor', async () => {
		const drops = [];
		for (const [dropped, refusal] of [['9 4', 'dropHandler'], ['9 4', 'trust'], ['9 2', 'trust']] as const) {
			drops.push(await dropOnFixture(['1 2 3 4 5', ''], `${dropped} before 3 with 1 2 pinned, ${describeDropRefusal(refusal)}`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				group.stickEditor(openEditorOf(group, '1').editor);
				group.stickEditor(openEditorOf(group, '2').editor);

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, '3'), dropped, instantiationService, refusal);
			}));
		}

		assert.deepStrictEqual(drops, [
			'9 4 before 3 with 1 2 pinned, taken by a drop handler: 1s 2s 3 4 5 | ',
			'9 4 before 3 with 1 2 pinned, with trust cancelled: 1s 2s 3 4 5 | ',
			'9 2 before 3 with 1 2 pinned, with trust cancelled: 1s 2s 3 4 5 | ',
		]);
	});

	test('a file dropped from the Explorer on an editor lands before that editor, also when an editor closes while the drop waits for trust', async () => {
		const drops = [];
		for (const closed of ['1', '3']) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `9 before 3 with ${closed} closed on the trust prompt`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				const closedEditor = openEditorOf(group, closed).editor;
				instantiationService.createInstance(TestServiceAccessor).workspaceTrustRequestService.requestOpenUrisHandler = async () => {
					await group.closeEditor(closedEditor);
					return WorkspaceTrustUriResponse.Open;
				};

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, '3'), '9', instantiationService);
			}));
		}

		assert.deepStrictEqual(drops, [
			'9 before 3 with 1 closed on the trust prompt: 2 9 3 4 | ',
			'9 before 3 with 3 closed on the trust prompt: 1 2 9 4 | ',
		]);
	});

	test('tab stacks - files dropped together from the Explorer before a tab stack land next to each other outside of it, so none joins it', async () => {
		const drop = await dropOnFixture(['1 2 3 4', ''], '9 1 before 3 with 3 4 in a tab stack', async (dnd, groups, openEditorOf, instantiationService) => {
			const [group] = groups;
			group.addEditorsToTabStack([openEditorOf(group, '3').editor, openEditorOf(group, '4').editor]);

			await dropFilesFromExplorer(dnd, group, openEditorOf(group, '3'), '9 1', instantiationService);
		}, { enableTabStacks: true });

		assert.deepStrictEqual(drop, '9 1 before 3 with 3 4 in a tab stack: 2 9 1 3a 4a | ');
	});

	test('tab stacks - files dropped from the Explorer that the group has already leave their tab stack, as on the tabs, unless they are all of its editors and no file opens between them', async () => {
		const drops = [];
		for (const [dropped, target] of [['2 9 3', '4'], ['2', '4'], ['2 3', '4'], ['2 3', '1'], ['3 2', '1']]) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `${dropped} before ${target} with 2 3 in a tab stack`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				group.addEditorsToTabStack([openEditorOf(group, '2').editor, openEditorOf(group, '3').editor]);

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, target), dropped, instantiationService);
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'2 9 3 before 4 with 2 3 in a tab stack: 1 2 9 3 4 | ',
			'2 before 4 with 2 3 in a tab stack: 1 3a 2 4 | ',
			'2 3 before 4 with 2 3 in a tab stack: 1 2a 3a 4 | ',
			'2 3 before 1 with 2 3 in a tab stack: 2a 3a 1 4 | ',
			'3 2 before 1 with 2 3 in a tab stack: 3a 2a 1 4 | ',
		]);
	});

	test('tab stacks - files dropped from the Explorer that a registered drop handler takes, or whose trust is cancelled, take no editor out of its tab stack', async () => {
		const drops = [];
		for (const refusal of ['dropHandler', 'trust'] as const) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `2 before 4 with 2 3 in a tab stack, ${describeDropRefusal(refusal)}`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				group.addEditorsToTabStack([openEditorOf(group, '2').editor, openEditorOf(group, '3').editor]);

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, '4'), '2', instantiationService, refusal);
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'2 before 4 with 2 3 in a tab stack, taken by a drop handler: 1 2a 3a 4 | ',
			'2 before 4 with 2 3 in a tab stack, with trust cancelled: 1 2a 3a 4 | ',
		]);
	});

	test('tab stacks - entries of a whole tab stack dropped in their group keep it, and inside another tab stack land after it', async () => {
		const drops = [];
		for (const tabStacks of [['2 3'], ['2 3', '4 5']]) {
			drops.push(await dropOnFixture(['1 2 3 4 5', ''], `2 3 before 5 with ${tabStacks.join(' and ')} in tab stacks`, async (dnd, groups, openEditorOf) => {
				const [group] = groups;
				for (const names of tabStacks) {
					group.addEditorsToTabStack(names.split(' ').map(name => openEditorOf(group, name).editor));
				}

				dnd.drop(new ElementsDragAndDropData(['2', '3'].map(name => openEditorOf(group, name))), openEditorOf(group, '5'), 0, ListViewTargetSector.TOP, new DragEvent(EventType.DROP));
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'2 3 before 5 with 2 3 in tab stacks: 1 4 2a 3a 5 | ',
			'2 3 before 5 with 2 3 and 4 5 in tab stacks: 1 4a 5a 2b 3b | ',
		]);
	});

	test('tab stacks - the files of a whole tab stack dropped among the pinned editors are pinned and leave it, and the tabs show them pinned', async () => {
		let tabs = '';
		const drop = await dropOnFixture(['1 2 3 4 5', ''], '3 4 before 2 with 1 2 pinned and 3 4 in a tab stack', async (dnd, groups, openEditorOf, instantiationService) => {
			const [group] = groups;
			group.stickEditor(openEditorOf(group, '1').editor);
			group.stickEditor(openEditorOf(group, '2').editor);
			group.addEditorsToTabStack([openEditorOf(group, '3').editor, openEditorOf(group, '4').editor]);

			await dropFilesFromExplorer(dnd, group, openEditorOf(group, '2'), '3 4', instantiationService);
			tabs = Array.from(group.element.querySelectorAll('.tabs-container'), tabsContainer => Array.from(tabsContainer.querySelectorAll(':scope > .tab'), tab => tab.getAttribute('data-resource-name')).join(' ')).join(' | ');
		}, { enableTabStacks: true, pinnedTabsOnSeparateRow: true });

		assert.deepStrictEqual({ drop, tabs }, {
			drop: '3 4 before 2 with 1 2 pinned and 3 4 in a tab stack: 1s 3s 4s 2s 5 | ',
			tabs: '1 3 4 2 | 5'
		});
	});

	test('tab stacks - a pinned file dropped from the Explorer past the pinned editors is unpinned and lands outside of tab stacks, also together with an editor of a tab stack', async () => {
		const drops = [];
		for (const [dropped, target] of [['1', '3'], ['1 3', '4'], ['2 1', '2']]) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `${dropped} before ${target} with 1 pinned and 2 3 in a tab stack`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				group.stickEditor(openEditorOf(group, '1').editor);
				group.addEditorsToTabStack([openEditorOf(group, '2').editor, openEditorOf(group, '3').editor]);

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, target), dropped, instantiationService);
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'1 before 3 with 1 pinned and 2 3 in a tab stack: 2a 3a 1 4 | ',
			'1 3 before 4 with 1 pinned and 2 3 in a tab stack: 2a 1 3 4 | ',
			'2 1 before 2 with 1 pinned and 2 3 in a tab stack: 2 1 3a 4 | ',
		]);
	});

	test('tab stacks - files dropped from the Explorer among or right after the pinned editors leave their tab stack, as on the tabs, also next to a pinned file that stays pinned', async () => {
		const drops = [];
		for (const [pinned, tabStack, dropped, target] of [['1', '2 3', '1 3', '2'], ['1 2', '3 4', '2 3', '2']]) {
			drops.push(await dropOnFixture(['1 2 3 4 5', ''], `${dropped} before ${target} with ${pinned} pinned and ${tabStack} in a tab stack`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				for (const name of pinned.split(' ')) {
					group.stickEditor(openEditorOf(group, name).editor);
				}
				group.addEditorsToTabStack(tabStack.split(' ').map(name => openEditorOf(group, name).editor));

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, target), dropped, instantiationService);
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'1 3 before 2 with 1 pinned and 2 3 in a tab stack: 1s 3 2a 4 5 | ',
			'2 3 before 2 with 1 2 pinned and 3 4 in a tab stack: 1s 2s 3 4a 5 | ',
		]);
	});

	test('tab stacks - a file that the group has already, dropped inside a tab stack, lands after it without joining it, unless the drop is the whole tab stack', async () => {
		const drops = [];
		for (const dropped of ['1', '2 3', '9']) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `${dropped} before 3 with 2 3 in a tab stack`, async (dnd, groups, openEditorOf, instantiationService) => {
				const [group] = groups;
				group.addEditorsToTabStack([openEditorOf(group, '2').editor, openEditorOf(group, '3').editor]);

				await dropFilesFromExplorer(dnd, group, openEditorOf(group, '3'), dropped, instantiationService);
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'1 before 3 with 2 3 in a tab stack: 2a 3a 1 4 | ',
			'2 3 before 3 with 2 3 in a tab stack: 1 2a 3a 4 | ',
			'9 before 3 with 2 3 in a tab stack: 1 2a 3a 9 4 | ',
		]);
	});

	test('tab stacks - an entry dropped inside a tab stack lands after it without joining it, and an entry of that tab stack stays in it', async () => {
		const drops = [];
		for (const [dragged, target, sector] of [['1', '3', ListViewTargetSector.TOP], ['4', '3', ListViewTargetSector.TOP], ['2', '5', ListViewTargetSector.BOTTOM]] as const) {
			drops.push(await dropOnFixture(['1 2 3 4 5', ''], `${dragged} ${sector === ListViewTargetSector.TOP ? 'before' : 'after'} ${target} with 2 3 4 in a tab stack`, async (dnd, groups, openEditorOf) => {
				const [group] = groups;
				group.addEditorsToTabStack(['2', '3', '4'].map(name => openEditorOf(group, name).editor));

				dnd.drop(new ElementsDragAndDropData([openEditorOf(group, dragged)]), openEditorOf(group, target), 0, sector, new DragEvent(EventType.DROP));
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'1 before 3 with 2 3 4 in a tab stack: 2a 3a 4a 1 5 | ',
			'4 before 3 with 2 3 4 in a tab stack: 1 2a 4a 3a 5 | ',
			'2 after 5 with 2 3 4 in a tab stack: 1 3a 4a 5 2 | ',
		]);
	});

	test('tab stacks - entries from another group dropped around a tab stack land in drop order', async () => {
		const drop = await dropOnFixture(['1 2 3 4', '5 6'], '5 6 of group 2 before 3 with 2 3 in a tab stack', async (dnd, groups, openEditorOf) => {
			const [group, otherGroup] = groups;
			group.addEditorsToTabStack([openEditorOf(group, '2').editor, openEditorOf(group, '3').editor]);

			dnd.drop(new ElementsDragAndDropData(['5', '6'].map(name => openEditorOf(otherGroup, name))), openEditorOf(group, '3'), 0, ListViewTargetSector.TOP, new DragEvent(EventType.DROP));
		}, { enableTabStacks: true });

		assert.deepStrictEqual(drop, '5 6 of group 2 before 3 with 2 3 in a tab stack: 1 2a 3a 5 6 4 | ');
	});

	test('tab stacks - entries dragged together land next to each other in drop order, and stay in their tab stack only when all of them are its editors', async () => {
		const drops = [];
		for (const [pinned, tabStack, dragged, target] of [
			['', '2 3 4', '3 5', '2'],
			['', '2 3 4', '5 3', '2'],
			['', '2 3 4', '3 9', '2'],
			['', '2 3', '2 3 5', '1'],
			['', '2 3', '2 3 5', '4'],
			['', '2 3 4', '4 1', '3'],
			['', '2 3 4', '3', '2'],
			['', '2 3 4', '3 4', '2'],
			['', '2 3 4', '1 4', '3'],
			['1 2', '3 4', '2 3', '5'],
		]) {
			drops.push(await dropOnFixture(['1 2 3 4 5', '9'], `${dragged} before ${target} with ${tabStack} in a tab stack${pinned ? ` and ${pinned} pinned` : ''}`, async (dnd, groups, openEditorOf) => {
				const [group, otherGroup] = groups;
				for (const name of pinned.split(' ').filter(name => !!name)) {
					group.stickEditor(openEditorOf(group, name).editor);
				}
				group.addEditorsToTabStack(tabStack.split(' ').map(name => openEditorOf(group, name).editor));

				dnd.drop(new ElementsDragAndDropData(dragged.split(' ').map(name => openEditorOf(name === '9' ? otherGroup : group, name))), openEditorOf(group, target), 0, ListViewTargetSector.TOP, new DragEvent(EventType.DROP));
			}, { enableTabStacks: true }));
		}

		assert.deepStrictEqual(drops, [
			'3 5 before 2 with 2 3 4 in a tab stack: 1 3 5 2a 4a | 9',
			'5 3 before 2 with 2 3 4 in a tab stack: 1 5 3 2a 4a | 9',
			'3 9 before 2 with 2 3 4 in a tab stack: 1 3 9 2a 4a 5 | ',
			'2 3 5 before 1 with 2 3 in a tab stack: 2 3 5 1 4 | 9',
			'2 3 5 before 4 with 2 3 in a tab stack: 1 2 3 5 4 | 9',
			'4 1 before 3 with 2 3 4 in a tab stack: 2a 3a 4 1 5 | 9',
			'3 before 2 with 2 3 4 in a tab stack: 1 3a 2a 4a 5 | 9',
			'3 4 before 2 with 2 3 4 in a tab stack: 1 3a 4a 2a 5 | 9',
			'1 4 before 3 with 2 3 4 in a tab stack: 2a 3a 1 4 5 | 9',
			'2 3 before 5 with 3 4 in a tab stack and 1 2 pinned: 1s 4a 2 3 5 | 9',
		]);
	});

	test('a file dropped from the Explorer on an editor lands where the drop shows, also a file that the group has only in a split editor, which the drop opens again, or in an editor of another kind, which it does not', async () => {
		const drops = [];
		for (const kind of ['split', 'otherKind']) {
			drops.push(await dropOnFixture(['1 2 3 4', ''], `1 before 3 with 1 as ${kind}`, async (dnd, groups, openEditorOf, instantiationService) => {

				// Splitting an editor in its group and reopening it with another editor replace it
				const editor = openEditorOf(groups[0], '1').editor;
				const replacement = kind === 'split' ? instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, editor, editor) : store.add(new TestFileEditorInput(URI.file('1'), kind));
				await groups[0].replaceEditors([{ editor, replacement }]);

				await dropFilesFromExplorer(dnd, groups[0], openEditorOf(groups[0], '3'), '1', instantiationService);
			}));
		}

		assert.deepStrictEqual(drops, [
			'1 before 3 with 1 as split: 2 1(split) 3 4 | ',
			'1 before 3 with 1 as otherKind: 1(otherKind) 2 1 3 4 | ',
		]);
	});
});
