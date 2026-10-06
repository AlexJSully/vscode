/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon, themeColorFromId } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { isCustomTabStackColor, ITabStack, parseTabStackColor, TAB_STACK_COLORS, TabStackColor, TabStackId, TabStackPresetColor } from '../../../common/editor/editorGroupModel.js';
import { TAB_STACK_COLOR_IDS } from '../../../common/theme.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { setTabStackCollapsed } from './editor.js';

/**
 * A quick pick item for a tab stack color.
 */
export interface ITabStackColorPickItem extends IQuickPickItem {

	/**
	 * The color the item applies, or `undefined` for the item that asks for a custom color.
	 */
	readonly color: TabStackColor | undefined;
}

/**
 * The color quick pick items of a tab stack and the item of its current color.
 */
export interface ITabStackColorPicks {
	readonly items: QuickPickInput<ITabStackColorPickItem>[];
	readonly activeItem: ITabStackColorPickItem;
}

/**
 * A quick pick item for a tab stack, or for a new tab stack.
 */
export interface ITabStackPickItem extends IQuickPickItem {

	/**
	 * The tab stack the item adds editors to, or `undefined` for a new tab stack.
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

export const TAB_STACK_CUSTOM_COLOR_LABEL = localize('tabStackCustomColor', "Custom Color...");

type TabStackCommandsGroup = Pick<IEditorGroup, 'addEditorsToTabStack' | 'updateTabStack' | 'editTabStack'>;

/**
 * Returns the label of a tab stack color: the localized preset name, or the custom hex color.
 */
export function getTabStackColorLabel(color: TabStackColor): string {
	return isCustomTabStackColor(color) ? color : TAB_STACK_COLOR_LABELS[color];
}

/**
 * Returns the quick pick icon of a tab stack color, an SVG image for a custom color, which is not a
 * theme color.
 */
function getTabStackColorIcon(color: TabStackColor): Pick<IQuickPickItem, 'iconClass' | 'iconColor' | 'iconPath'> {
	if (isCustomTabStackColor(color)) {
		const swatch = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="${color}"/></svg>`;

		return { iconPath: { dark: URI.parse(`data:image/svg+xml;utf8,${encodeURIComponent(swatch)}`) } };
	}

	return { iconClass: ThemeIcon.asClassName(Codicon.circleFilled), iconColor: themeColorFromId(TAB_STACK_COLOR_IDS[color]) };
}

/**
 * Returns the color picks with `currentColor` active. A custom current color is listed after the
 * presets so that it can be kept.
 */
export function getTabStackColorPicks(currentColor: TabStackColor): ITabStackColorPicks {
	const colorItems: ITabStackColorPickItem[] = TAB_STACK_COLORS.map(color => ({
		color,
		label: getTabStackColorLabel(color),
		...getTabStackColorIcon(color)
	}));

	if (isCustomTabStackColor(currentColor)) {
		colorItems.push({ color: currentColor, label: getTabStackColorLabel(currentColor), ...getTabStackColorIcon(currentColor) });
	}

	const customColorItem: ITabStackColorPickItem = { color: undefined, label: TAB_STACK_CUSTOM_COLOR_LABEL };

	return {
		items: [...colorItems, { type: 'separator' }, customColorItem],
		activeItem: colorItems.find(item => item.color === currentColor) ?? customColorItem
	};
}

/**
 * Returns the custom tab stack color that the trimmed value describes as a hex color, never a
 * preset name.
 */
export function parseCustomTabStackColor(value: string): TabStackColor | undefined {
	const trimmedValue = value.trim();

	return trimmedValue.startsWith('#') ? parseTabStackColor(trimmedValue) : undefined;
}

/**
 * Returns the quick pick items to add editors to a new tab stack or to a tab stack that does not already hold all of them.
 */
export function getTabStackPicks(tabStacks: readonly ITabStack[], editors: readonly EditorInput[]): QuickPickInput<ITabStackPickItem>[] {
	const newTabStackItem: ITabStackPickItem = {
		tabStack: undefined,
		label: localize('newTabStack', "New Tab Stack"),
		iconClass: ThemeIcon.asClassName(Codicon.add)
	};

	const targetTabStacks = tabStacks.filter(tabStack => editors.some(editor => !tabStack.editors.includes(editor)));
	if (targetTabStacks.length === 0) {
		return [newTabStackItem];
	}

	return [newTabStackItem, { type: 'separator' }, ...targetTabStacks.map(getTabStackPick)];
}

function getTabStackPick(tabStack: ITabStack): ITabStackPickItem {
	return {
		tabStack: tabStack.id,
		label: tabStack.label || localize('unnamedTabStack', "Unnamed Tab Stack"),
		description: tabStack.editors.map(editor => editor.getName()).join(', '),
		...getTabStackColorIcon(tabStack.color)
	};
}

/**
 * Returns a quick pick item for each collapsed tab stack.
 */
export function getCollapsedTabStackPicks(tabStacks: readonly ITabStack[]): ITabStackPickItem[] {
	return tabStacks.filter(tabStack => tabStack.collapsed).map(getTabStackPick);
}

/**
 * Expands the only collapsed tab stack of the group, or asks which one to
 * expand when it has several, and announces it while a screen reader is in use.
 */
export async function expandTabStack(group: Pick<IEditorGroup, 'tabStacks' | 'updateTabStack'>, quickInputService: IQuickInputService, accessibilityService: IAccessibilityService): Promise<void> {
	const picks = getCollapsedTabStackPicks(group.tabStacks);
	let pick = picks.at(0);
	if (picks.length > 1) {
		pick = await quickInputService.pick(picks, {
			placeHolder: localize('pickTabStackToExpand', "Select a tab stack to expand"),
			matchOnDescription: true
		});
	}

	if (pick?.tabStack) {
		setTabStackCollapsed(group, pick.tabStack, false, accessibilityService);
	}
}

/**
 * Asks which tab stack to add the editors to.
 */
export function pickTabStack(quickInputService: IQuickInputService, tabStacks: readonly ITabStack[], editors: readonly EditorInput[]): Promise<ITabStackPickItem | undefined> {
	return quickInputService.pick(getTabStackPicks(tabStacks, editors), {
		placeHolder: localize('pickTabStack', "Select a tab stack to add the editors to"),
		matchOnDescription: true
	});
}

/**
 * Asks for a tab stack color, and for a hex color when "Custom Color..." is picked.
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

	return pick.color ?? inputCustomTabStackColor(quickInputService, currentColor);
}

export async function inputCustomTabStackColor(quickInputService: IQuickInputService, currentColor: TabStackColor): Promise<TabStackColor | undefined> {
	const customColor = await quickInputService.input({
		value: isCustomTabStackColor(currentColor) ? currentColor : '',
		prompt: localize('tabStackCustomColorPrompt', "Enter a color as a hex value such as #1a2b3c or #fff"),
		validateInput: async value => parseCustomTabStackColor(value) ? undefined : localize('tabStackCustomColorInvalid', "The color must be a hex value such as #1a2b3c or #fff.")
	});

	return customColor !== undefined ? parseCustomTabStackColor(customColor) : undefined;
}

export async function inputTabStackLabel(quickInputService: IQuickInputService, currentLabel: string): Promise<string | undefined> {
	const value = await quickInputService.input({
		value: currentLabel,
		prompt: localize('tabStackLabelPrompt', "Enter a name for the tab stack, or leave it empty to remove the name")
	});

	return value?.trim();
}

/**
 * Adds editors to a tab stack, or to a new one whose name and color bubble then opens, as Chromium
 * does for a new tab group.
 */
export function addEditorsToTabStackAndEditNew(group: TabStackCommandsGroup, editors: readonly EditorInput[], tabStack?: TabStackId): ITabStack | undefined {
	const result = group.addEditorsToTabStack(editors, tabStack);
	if (result && tabStack === undefined) {
		group.editTabStack(result.id);
	}

	return result;
}

/**
 * Asks for the name of a tab stack in its bubble, or with a quick input when the tab bar does not
 * show its header.
 */
export async function renameTabStack(group: TabStackCommandsGroup, tabStack: ITabStack, quickInputService: IQuickInputService): Promise<void> {
	if (group.editTabStack(tabStack.id)) {
		return;
	}

	const label = await inputTabStackLabel(quickInputService, tabStack.label);
	if (label !== undefined) {
		group.updateTabStack(tabStack.id, { label });
	}
}

/**
 * Asks for the color of a tab stack in its bubble, or with a quick pick when the tab bar does not
 * show its header.
 */
export async function changeTabStackColor(group: TabStackCommandsGroup, tabStack: ITabStack, quickInputService: IQuickInputService): Promise<void> {
	if (group.editTabStack(tabStack.id, 'color')) {
		return;
	}

	const color = await pickTabStackColor(quickInputService, tabStack.color);
	if (color) {
		group.updateTabStack(tabStack.id, { color });
	}
}
