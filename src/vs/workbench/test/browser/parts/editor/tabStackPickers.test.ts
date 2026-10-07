/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getActiveElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IInputOptions, IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorGroupView } from '../../../../browser/parts/editor/editor.js';
import { addEditorsToTabStackAndEditNew, changeTabStackColor, expandTabStack, getCollapsedTabStackPicks, getTabStackColorPicks, getTabStackPicks, inputTabStackLabel, ITabStackColorPickItem, parseCustomTabStackColor, pickTabStack, pickTabStackColor, renameTabStack } from '../../../../browser/parts/editor/tabStackPickers.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ITabStack } from '../../../../common/editor/editorGroupModel.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { createEditorPart, getShownTabStackEditor, registerTestEditor, TestEditorInput, TestFileEditorInput, workbenchInstantiationService, workbenchTeardown } from '../../workbenchTestServices.js';

/**
 * Stands in for the quick input UI, which waits for the user to pick or type:
 * picks the item with a given label, which dismisses the pick when no item has
 * it, and answers every input with a given value, recording the active item of
 * each pick and the options of each input.
 */
class TestQuickInputService extends mock<IQuickInputService>() {

	readonly activeItems: (IQuickPickItem | undefined)[] = [];
	readonly inputOptions: IInputOptions[] = [];

	constructor(private readonly pickLabel: string, private readonly inputValue: string | undefined) {
		super();
	}

	override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T>): Promise<T | undefined> {
		this.activeItems.push(await options?.activeItem);

		return (await picks).find((pick): pick is T => pick.type !== 'separator' && pick.label === this.pickLabel);
	}

	override async input(options: IInputOptions): Promise<string | undefined> {
		this.inputOptions.push(options);

		return this.inputValue;
	}
}

suite('TabStackPickers', () => {

	const disposables = new DisposableStore();
	let partInstantiationService: TestInstantiationService | undefined;

	teardown(async () => {
		if (partInstantiationService) {
			await workbenchTeardown(partInstantiationService);
			partInstantiationService = undefined;
		}

		disposables.clear();
	});

	/**
	 * Shows an editor part with tab stacks enabled in the window, with a pinned
	 * editor per name in its group.
	 */
	async function createTabStacksGroup(...names: string[]): Promise<{ group: IEditorGroupView; editors: EditorInput[]; partContainer: HTMLElement }> {
		const configurationService = new TestConfigurationService({ workbench: { editor: { enableTabStacks: true } } });
		disposables.add(configurationService.onDidChangeConfigurationEmitter);
		const instantiationService = partInstantiationService = workbenchInstantiationService({ configurationService: () => configurationService }, disposables);
		disposables.add(registerTestEditor('tabStackPickersTestEditor', [new SyncDescriptor(TestFileEditorInput)], 'tabStackPickersTestEditorInput'));
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const part = await createEditorPart(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, part);
		const partContainer = part.getContainer()!;
		mainWindow.document.body.appendChild(partContainer);
		disposables.add(toDisposable(() => partContainer.remove()));

		const editors = names.map(name => disposables.add(new TestFileEditorInput(URI.file(`/path/${name}`), 'tabStackPickersTestEditorInput')));
		for (const editor of editors) {
			await part.activeGroup.openEditor(editor, { pinned: true });
		}

		return { group: part.activeGroup, editors, partContainer };
	}

	/**
	 * Returns the name in the shown editor of a tab stack, or `undefined` when
	 * none is shown.
	 */
	function shownTabStackEditorName(): string | undefined {
		return getShownTabStackEditor(partInstantiationService!.get(IContextViewService))?.querySelector('input')?.value;
	}

	function hideTabStackEditor(): void {
		partInstantiationService!.get(IContextViewService).hideContextView();
	}

	/**
	 * Describes the icon of an item as the media type and the fill of its SVG
	 * image, or as its icon class followed by the identifier of its color.
	 */
	function describeIcon(item: IQuickPickItem): string {
		if (item.iconPath) {
			const imageUri = `${item.iconPath.dark.scheme}:${item.iconPath.dark.path}`;
			const fill = /fill="(?<fill>[^"]*)"/.exec(imageUri)?.groups?.fill;

			return `${imageUri.split(';')[0]} fill=${fill}`;
		}

		return [item.iconClass, item.iconColor?.id].filter(part => !!part).join(' ');
	}

	/**
	 * Describes each item as its label, description and icon, and a separator
	 * as `---`.
	 */
	function describePicks(items: readonly QuickPickInput<IQuickPickItem>[]): string[] {
		return items.map(item => item.type === 'separator' ? '---' : [item.label, item.description, describeIcon(item)].filter(part => !!part).join(' | '));
	}

	function describeColorPicks(items: readonly QuickPickInput<ITabStackColorPickItem>[]): string[] {
		const descriptions = describePicks(items);

		return items.map((item, index) => item.type === 'separator' ? descriptions[index] : `${item.color ?? 'custom'}: ${descriptions[index]}`);
	}

	test('color picks list the preset colors, a separator and the custom color, with the current color active', () => {
		const { items, activeItem } = getTabStackColorPicks('green');

		assert.deepStrictEqual({ items: describeColorPicks(items), activeItem: activeItem.color }, {
			items: [
				'blue: Blue | codicon codicon-circle-filled tabStack.blue',
				'purple: Purple | codicon codicon-circle-filled tabStack.purple',
				'pink: Pink | codicon codicon-circle-filled tabStack.pink',
				'red: Red | codicon codicon-circle-filled tabStack.red',
				'orange: Orange | codicon codicon-circle-filled tabStack.orange',
				'yellow: Yellow | codicon codicon-circle-filled tabStack.yellow',
				'green: Green | codicon codicon-circle-filled tabStack.green',
				'cyan: Cyan | codicon codicon-circle-filled tabStack.cyan',
				'gray: Gray | codicon codicon-circle-filled tabStack.gray',
				'---',
				'custom: Custom Color...'
			],
			activeItem: 'green'
		});
	});

	test('a custom current color is listed after the preset colors with a swatch and is active', () => {
		const { items, activeItem } = getTabStackColorPicks('#1a2b3c');

		assert.deepStrictEqual({ items: describeColorPicks(items).slice(8), activeItem: activeItem.color }, {
			items: [
				'gray: Gray | codicon codicon-circle-filled tabStack.gray',
				'#1a2b3c: #1a2b3c | data:image/svg+xml fill=#1a2b3c',
				'---',
				'custom: Custom Color...'
			],
			activeItem: '#1a2b3c'
		});
	});

	test('tab stack picks list a new tab stack, a separator and each tab stack with its name, editors and color', () => {
		const [authEditor, loginEditor, logEditor, docsEditor] = ['auth', 'login', 'log', 'docs'].map(name => disposables.add(new TestEditorInput(URI.file(`/${name}`), name)));
		const tabStacks: ITabStack[] = [
			{ id: 'named', label: 'Auth', color: 'blue', collapsed: false, editors: [authEditor, loginEditor] },
			{ id: 'unnamed', label: '', color: '#ff0000', collapsed: true, editors: [logEditor] }
		];

		const items = getTabStackPicks(tabStacks, [docsEditor]);

		assert.deepStrictEqual({
			items: describePicks(items),
			tabStacks: items.map(item => item.type === 'separator' ? '---' : item.tabStack),
			withoutTabStacks: describePicks(getTabStackPicks([], [docsEditor]))
		}, {
			items: [
				'New Tab Stack | codicon codicon-add',
				'---',
				'Auth | Editor auth, Editor login | codicon codicon-circle-filled tabStack.blue',
				'Unnamed Tab Stack | Editor log | data:image/svg+xml fill=#ff0000'
			],
			tabStacks: [undefined, '---', 'named', 'unnamed'],
			withoutTabStacks: ['New Tab Stack | codicon codicon-add']
		});
	});

	test('tab stack picks leave out a tab stack that already holds every editor to add', () => {
		const [authEditor, loginEditor, logEditor] = ['auth', 'login', 'log'].map(name => disposables.add(new TestEditorInput(URI.file(`/${name}`), name)));
		const authTabStack: ITabStack = { id: 'auth', label: 'Auth', color: 'blue', collapsed: false, editors: [authEditor, loginEditor] };
		const logTabStack: ITabStack = { id: 'log', label: 'Log', color: 'green', collapsed: false, editors: [logEditor] };
		const labels = (items: readonly QuickPickInput<IQuickPickItem>[]) => items.map(item => item.type === 'separator' ? '---' : item.label);

		assert.deepStrictEqual({
			editorOfOneTabStack: labels(getTabStackPicks([authTabStack, logTabStack], [authEditor])),
			editorsOfBothTabStacks: labels(getTabStackPicks([authTabStack, logTabStack], [authEditor, logEditor])),
			editorOfTheOnlyTabStack: labels(getTabStackPicks([authTabStack], [authEditor]))
		}, {
			editorOfOneTabStack: ['New Tab Stack', '---', 'Log'],
			editorsOfBothTabStacks: ['New Tab Stack', '---', 'Auth', 'Log'],
			editorOfTheOnlyTabStack: ['New Tab Stack']
		});
	});

	test('collapsed tab stack picks list each collapsed tab stack with its name, editors and color', () => {
		const [docsEditor, authEditor, loginEditor, logEditor] = ['docs', 'auth', 'login', 'log'].map(name => disposables.add(new TestEditorInput(URI.file(`/${name}`), name)));
		const tabStacks: ITabStack[] = [
			{ id: 'expanded', label: 'Docs', color: 'green', collapsed: false, editors: [docsEditor] },
			{ id: 'named', label: 'Auth', color: 'blue', collapsed: true, editors: [authEditor, loginEditor] },
			{ id: 'unnamed', label: '', color: '#ff0000', collapsed: true, editors: [logEditor] }
		];

		const items = getCollapsedTabStackPicks(tabStacks);

		assert.deepStrictEqual({ items: describePicks(items), tabStacks: items.map(item => item.tabStack) }, {
			items: [
				'Auth | Editor auth, Editor login | codicon codicon-circle-filled tabStack.blue',
				'Unnamed Tab Stack | Editor log | data:image/svg+xml fill=#ff0000'
			],
			tabStacks: ['named', 'unnamed']
		});
	});

	test('expanding a tab stack expands the only collapsed tab stack without asking, asks which one when there are several, and announces it while a screen reader is in use', async () => {
		const { group, editors: [a, , c] } = await createTabStacksGroup('a', 'b', 'c', 'd');
		group.updateTabStack(group.addEditorsToTabStack([a])!.id, { label: 'Auth', collapsed: true });
		group.updateTabStack(group.addEditorsToTabStack([c])!.id, { collapsed: true });
		const announcements: string[] = [];
		// The screen reader is the boundary: it speaks what the command announces
		const accessibilityService = new class extends TestAccessibilityService {
			override isScreenReaderOptimized(): boolean { return true; }
			override status(message: string): void { announcements.push(message); }
		};
		const collapsedTabStacks = () => group.tabStacks.filter(tabStack => tabStack.collapsed).map(tabStack => tabStack.label || 'unnamed');
		const dismissing = new TestQuickInputService('', undefined);
		const picking = new TestQuickInputService('Auth', undefined);
		const notAsked = new TestQuickInputService('', undefined);

		await expandTabStack(group, dismissing, accessibilityService);
		const afterDismissing = collapsedTabStacks();
		await expandTabStack(group, picking, accessibilityService);
		const afterPicking = collapsedTabStacks();
		await expandTabStack(group, notAsked, accessibilityService);
		const afterTheOnlyOne = collapsedTabStacks();
		await expandTabStack(group, notAsked, accessibilityService);

		assert.deepStrictEqual({
			afterDismissing,
			afterPicking,
			afterTheOnlyOne,
			picks: { dismissing: dismissing.activeItems.length, picking: picking.activeItems.length, notAsked: notAsked.activeItems.length },
			announcements
		}, {
			afterDismissing: ['Auth', 'unnamed'],
			afterPicking: ['unnamed'],
			afterTheOnlyOne: [],
			picks: { dismissing: 1, picking: 1, notAsked: 0 },
			announcements: ['Expanded tab stack Auth', 'Expanded unnamed tab stack']
		});
	});

	test('custom colors are hex colors, normalized to lowercase #rrggbb', () => {
		const values = ['#1a2b3c', ' #1a2b3c ', '#FFF', '#AbCdEf', 'blue', 'blue1', '#abcd', '#aabbccdd', ''];

		assert.deepStrictEqual(Object.fromEntries(values.map(value => [value, parseCustomTabStackColor(value)])), {
			'#1a2b3c': '#1a2b3c',
			' #1a2b3c ': '#1a2b3c',
			'#FFF': '#ffffff',
			'#AbCdEf': '#abcdef',
			'blue': undefined,
			'blue1': undefined,
			'#abcd': undefined,
			'#aabbccdd': undefined,
			'': undefined
		});
	});

	test('picking the custom color asks for a hex color, starting from the current custom color', async () => {
		const quickInputService = new TestQuickInputService('Custom Color...', '#ABC');

		const color = await pickTabStackColor(quickInputService, '#1a2b3c');
		const [inputOptions] = quickInputService.inputOptions;

		assert.deepStrictEqual({
			color,
			value: inputOptions.value,
			rejected: {
				blue: !!(await inputOptions.validateInput?.('blue')),
				'#fff': !!(await inputOptions.validateInput?.('#fff'))
			}
		}, {
			color: '#aabbcc',
			value: '#1a2b3c',
			rejected: { blue: true, '#fff': false }
		});
	});

	test('picking a preset color returns it without asking for a custom color, starting at the current color', async () => {
		const presetQuickInputService = new TestQuickInputService('Red', '#000000');
		const dismissedQuickInputService = new TestQuickInputService('', '#000000');

		const preset = await pickTabStackColor(presetQuickInputService, 'green');
		const dismissed = await pickTabStackColor(dismissedQuickInputService, 'green');

		assert.deepStrictEqual({
			preset,
			activeItem: presetQuickInputService.activeItems[0]?.label,
			inputs: presetQuickInputService.inputOptions.length,
			dismissed,
			inputsWhenDismissed: dismissedQuickInputService.inputOptions.length
		}, {
			preset: 'red',
			activeItem: 'Green',
			inputs: 0,
			dismissed: undefined,
			inputsWhenDismissed: 0
		});
	});

	test('picking a tab stack returns its item, and a tab stack name is trimmed', async () => {
		const tabStacks: ITabStack[] = [{ id: 'named', label: 'Auth', color: 'blue', collapsed: false, editors: [] }];
		const editors = [disposables.add(new TestEditorInput(URI.file('/auth'), 'auth'))];

		const picked = await pickTabStack(new TestQuickInputService('Auth', undefined), tabStacks, editors);
		const dismissed = await pickTabStack(new TestQuickInputService('', undefined), tabStacks, editors);
		const label = await inputTabStackLabel(new TestQuickInputService('', '  Auth  '), 'Old');
		const dismissedLabel = await inputTabStackLabel(new TestQuickInputService('', undefined), 'Old');

		assert.deepStrictEqual({ picked: picked?.tabStack, dismissed, label, dismissedLabel }, {
			picked: 'named',
			dismissed: undefined,
			label: 'Auth',
			dismissedLabel: undefined
		});
	});

	test('adding editors to a new tab stack opens the editor of the new tab stack, and adding them to a tab stack does not', async () => {
		const { group, editors: [a, b] } = await createTabStacksGroup('a', 'b', 'c');

		const created = addEditorsToTabStackAndEditNew(group, [a])!;
		const createdEditorName = shownTabStackEditorName();
		hideTabStackEditor();
		const joined = addEditorsToTabStackAndEditNew(group, [b], created.id);

		assert.deepStrictEqual({ createdEditorName, joinedSameTabStack: joined?.id === created.id, joinedEditorName: shownTabStackEditorName(), members: group.tabStacks.map(tabStack => tabStack.editors.map(editor => editor.resource?.path)) }, {
			createdEditorName: '',
			joinedSameTabStack: true,
			joinedEditorName: undefined,
			members: [['/path/a', '/path/b']]
		});
	});

	test('renaming or recoloring a tab stack opens its editor, focused on the name or the color, while its header is shown, and otherwise asks with a quick input', async () => {
		const { group, editors: [a], partContainer } = await createTabStacksGroup('a', 'b');
		const tabStack = group.addEditorsToTabStack([a])!;
		const editorNameAfterCreatingWithTheGroup = shownTabStackEditorName();
		group.updateTabStack(tabStack.id, { label: 'Auth', color: 'green' });
		const quickInputService = new TestQuickInputService('Red', ' Docs ');
		const focusedLabel = () => getActiveElement()?.getAttribute('aria-label');

		await renameTabStack(group, group.tabStacks[0], quickInputService);
		const rename = { name: shownTabStackEditorName(), focused: focusedLabel() };
		hideTabStackEditor();
		await changeTabStackColor(group, group.tabStacks[0], quickInputService);
		const recolor = { name: shownTabStackEditorName(), focused: focusedLabel() };
		hideTabStackEditor();
		const askedWithHeader = { inputs: quickInputService.inputOptions.length, picks: quickInputService.activeItems.length };

		// A hidden editor part shows no header
		partContainer.style.display = 'none';
		await renameTabStack(group, group.tabStacks[0], quickInputService);
		await changeTabStackColor(group, group.tabStacks[0], quickInputService);

		assert.deepStrictEqual({
			editorNameAfterCreatingWithTheGroup,
			rename,
			recolor,
			askedWithHeader,
			withoutHeader: { editorName: shownTabStackEditorName(), inputs: quickInputService.inputOptions.length, picks: quickInputService.activeItems.length },
			tabStack: { label: group.tabStacks[0].label, color: group.tabStacks[0].color }
		}, {
			editorNameAfterCreatingWithTheGroup: undefined,
			rename: { name: 'Auth', focused: 'Name' },
			recolor: { name: 'Auth', focused: 'Green' },
			askedWithHeader: { inputs: 0, picks: 0 },
			withoutHeader: { editorName: undefined, inputs: 1, picks: 1 },
			tabStack: { label: 'Docs', color: 'red' }
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
