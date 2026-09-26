/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon, themeColorFromId } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { ITabStack, isTabStackPresetColor, parseTabStackColor, TAB_STACK_COLORS, TabStackColor, TabStackId, TabStackPresetColor } from '../../../common/editor/editorGroupModel.js';
import { TAB_STACK_COLOR_IDS } from '../../../common/theme.js';

/**
 * An item of the quick pick that picks the color of a tab stack.
 */
export interface ITabStackColorPickItem extends IQuickPickItem {

	/**
	 * The color the item applies, or `undefined` for the item that asks for a
	 * custom color.
	 */
	readonly color: TabStackColor | undefined;
}

/**
 * The items of the quick pick that picks the color of a tab stack, and the
 * item that is active when it opens.
 */
export interface ITabStackColorPicks {

	/**
	 * The preset colors, the current color when it is custom, a separator and
	 * the item that asks for a custom color.
	 */
	readonly items: QuickPickInput<ITabStackColorPickItem>[];

	/**
	 * The item of the current color.
	 */
	readonly activeItem: ITabStackColorPickItem;
}

/**
 * An item of the quick pick that picks the tab stack to add editors to.
 */
export interface ITabStackPickItem extends IQuickPickItem {

	/**
	 * The tab stack the item adds editors to, or `undefined` for the item that
	 * adds them to a new tab stack.
	 */
	readonly tabStack: TabStackId | undefined;
}

const TAB_STACK_COLOR_LABELS: { readonly [color in TabStackPresetColor]: string } = {
	blue: localize('tabStackColorBlue', "Blue"),
	purple: localize('tabStackColorPurple', "Purple"),
	pink: localize('tabStackColorPink', "Pink"),
	red: localize('tabStackColorRed', "Red"),
	orange: localize('tabStackColorOrange', "Orange"),
	yellow: localize('tabStackColorYellow', "Yellow"),
	green: localize('tabStackColorGreen', "Green"),
	cyan: localize('tabStackColorCyan', "Cyan"),
	gray: localize('tabStackColorGray', "Gray")
};

/**
 * Returns the icon that shows a tab stack color in a quick pick: a filled
 * circle in the theme color of a preset color, or an SVG image of a circle
 * filled with a custom color, which is not a theme color.
 */
function getTabStackColorIcon(color: TabStackColor): Pick<IQuickPickItem, 'iconClass' | 'iconColor' | 'iconPath'> {
	if (isTabStackPresetColor(color)) {
		return { iconClass: ThemeIcon.asClassName(Codicon.circleFilled), iconColor: themeColorFromId(TAB_STACK_COLOR_IDS[color]) };
	}

	const swatch = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="${color}"/></svg>`;

	return { iconPath: { dark: URI.parse(`data:image/svg+xml;utf8,${encodeURIComponent(swatch)}`) } };
}

/**
 * Returns the items of the quick pick that picks the color of a tab stack
 * whose color is `currentColor`, which is the active item. A custom current
 * color is listed after the preset colors so that it can be kept.
 */
export function getTabStackColorPicks(currentColor: TabStackColor): ITabStackColorPicks {
	const colorItems: ITabStackColorPickItem[] = TAB_STACK_COLORS.map(color => ({
		color,
		label: TAB_STACK_COLOR_LABELS[color],
		...getTabStackColorIcon(color)
	}));

	if (!isTabStackPresetColor(currentColor)) {
		colorItems.push({ color: currentColor, label: currentColor, ...getTabStackColorIcon(currentColor) });
	}

	const customColorItem: ITabStackColorPickItem = { color: undefined, label: localize('tabStackCustomColor', "Custom Color...") };

	return {
		items: [...colorItems, { type: 'separator' }, customColorItem],
		activeItem: colorItems.find(item => item.color === currentColor) ?? customColorItem
	};
}

/**
 * Returns the custom tab stack color that the value describes, ignoring
 * surrounding whitespace, normalized to lowercase `#rrggbb`, or `undefined`
 * when it describes none. Only hex colors in the `#rgb` and `#rrggbb` forms
 * are custom colors, not the names of the preset colors.
 */
export function parseCustomTabStackColor(value: string): TabStackColor | undefined {
	const trimmedValue = value.trim();

	return trimmedValue.startsWith('#') ? parseTabStackColor(trimmedValue) : undefined;
}

/**
 * Returns the items of the quick pick that picks the tab stack to add editors
 * to: an item for a new tab stack and, when there are tab stacks, a separator
 * and an item per tab stack, which shows its name, its color and the names of
 * its editors.
 */
export function getTabStackPicks(tabStacks: readonly ITabStack[]): QuickPickInput<ITabStackPickItem>[] {
	const newTabStackItem: ITabStackPickItem = {
		tabStack: undefined,
		label: localize('newTabStack', "New Tab Stack"),
		iconClass: ThemeIcon.asClassName(Codicon.add)
	};

	if (tabStacks.length === 0) {
		return [newTabStackItem];
	}

	return [
		newTabStackItem,
		{ type: 'separator' },
		...tabStacks.map(tabStack => ({
			tabStack: tabStack.id,
			label: tabStack.label || localize('unnamedTabStack', "Unnamed Tab Stack"),
			description: tabStack.editors.map(editor => editor.getName()).join(', '),
			...getTabStackColorIcon(tabStack.color)
		}))
	];
}

/**
 * Asks for a tab stack to add editors to.
 *
 * @returns the picked item, whose `tabStack` is `undefined` for a new tab
 * stack, or `undefined` when the quick pick was dismissed.
 */
export function pickTabStack(quickInputService: IQuickInputService, tabStacks: readonly ITabStack[]): Promise<ITabStackPickItem | undefined> {
	return quickInputService.pick(getTabStackPicks(tabStacks), {
		placeHolder: localize('pickTabStack', "Select a tab stack to add the editors to"),
		matchOnDescription: true
	});
}

/**
 * Asks for the color of a tab stack whose color is `currentColor`. Picking
 * "Custom Color..." then asks for a hex color.
 *
 * @returns the picked color, or `undefined` when the quick pick or the input
 * was dismissed.
 */
export async function pickTabStackColor(quickInputService: IQuickInputService, currentColor: TabStackColor): Promise<TabStackColor | undefined> {
	const { items, activeItem } = getTabStackColorPicks(currentColor);
	const pick = await quickInputService.pick(items, {
		placeHolder: localize('pickTabStackColor', "Select a color for the tab stack"),
		activeItem
	});
	if (!pick) {
		return undefined;
	}

	if (pick.color) {
		return pick.color;
	}

	const customColor = await quickInputService.input({
		value: isTabStackPresetColor(currentColor) ? '' : currentColor,
		prompt: localize('tabStackCustomColorPrompt', "Enter a color as a hex value such as #1a2b3c or #fff"),
		validateInput: async value => parseCustomTabStackColor(value) ? undefined : localize('tabStackCustomColorInvalid', "The color must be a hex value such as #1a2b3c or #fff.")
	});

	return customColor !== undefined ? parseCustomTabStackColor(customColor) : undefined;
}

/**
 * Asks for the name of a tab stack whose name is `currentLabel`.
 *
 * @returns the trimmed name, which is empty to remove the name, or `undefined`
 * when the input was dismissed.
 */
export async function inputTabStackLabel(quickInputService: IQuickInputService, currentLabel: string): Promise<string | undefined> {
	const value = await quickInputService.input({
		value: currentLabel,
		prompt: localize('tabStackLabelPrompt', "Enter a name for the tab stack, or leave it empty to remove the name")
	});

	return value?.trim();
}
