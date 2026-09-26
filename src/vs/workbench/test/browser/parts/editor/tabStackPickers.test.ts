/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInputOptions, IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { getTabStackColorPicks, getTabStackPicks, inputTabStackLabel, ITabStackColorPickItem, parseCustomTabStackColor, pickTabStack, pickTabStackColor } from '../../../../browser/parts/editor/tabStackPickers.js';
import { ITabStack } from '../../../../common/editor/editorGroupModel.js';
import { TestEditorInput } from '../../workbenchTestServices.js';

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

	teardown(() => {
		disposables.clear();
	});

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
		const [authEditor, loginEditor, logEditor] = ['auth', 'login', 'log'].map(name => disposables.add(new TestEditorInput(URI.file(`/${name}`), name)));
		const tabStacks: ITabStack[] = [
			{ id: 'named', label: 'Auth', color: 'blue', collapsed: false, editors: [authEditor, loginEditor] },
			{ id: 'unnamed', label: '', color: '#ff0000', collapsed: true, editors: [logEditor] }
		];

		const items = getTabStackPicks(tabStacks);

		assert.deepStrictEqual({
			items: describePicks(items),
			tabStacks: items.map(item => item.type === 'separator' ? '---' : item.tabStack),
			withoutTabStacks: describePicks(getTabStackPicks([]))
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

		const picked = await pickTabStack(new TestQuickInputService('Auth', undefined), tabStacks);
		const dismissed = await pickTabStack(new TestQuickInputService('', undefined), tabStacks);
		const label = await inputTabStackLabel(new TestQuickInputService('', '  Auth  '), 'Old');
		const dismissedLabel = await inputTabStackLabel(new TestQuickInputService('', undefined), 'Old');

		assert.deepStrictEqual({ picked: picked?.tabStack, dismissed, label, dismissedLabel }, {
			picked: 'named',
			dismissed: undefined,
			label: 'Auth',
			dismissedLabel: undefined
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
