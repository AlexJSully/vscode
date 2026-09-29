/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { openFixture } from './utils.js';

for (const theme of ['DarkHighContrast', 'LightHighContrast']) {
	test(`connected tab actions respect disabled hover state in ${theme}`, async ({ page }) => {
		await openFixture(page, `editor/editorTabBar/editorTabBar/ConnectedSurface/SingleTab/${theme}`, '.tabs-container > .tab');
		const action = page.locator('.tab-actions .action-label');

		await action.hover();
		await expect(action).toHaveCSS('outline-style', 'dashed');

		await page.keyboard.down('Alt');
		try {
			await expect(action).toHaveAttribute('aria-disabled', 'true');
			await expect(action).toHaveCSS('outline-style', 'none');
		} finally {
			await page.keyboard.up('Alt');
		}

		await expect(action).not.toHaveClass(/\bdisabled\b/);
		await action.hover();
		await expect(action).toHaveCSS('outline-style', 'dashed');
		await action.focus();
		await expect(action).toHaveCSS('outline-style', 'solid');
		await expect(action).toHaveCSS('outline-width', '1px');
	});
}

test('clicking a tab stack header expands and collapses its tab stack', async ({ page }) => {
	await openFixture(page, 'editor/editorTabBar/editorTabBar/ModernUIOn/TabStacksCollapsed/Dark', '.tabs-container > .tab.active');
	const header = page.locator('.tabs-container > .tab-stack-header', { hasText: 'Auth' });
	const tabs = page.locator('.tabs-container > .tab');

	await expect(header).toHaveAttribute('aria-expanded', 'false');
	await expect(tabs).toHaveCount(2);

	await header.click();
	await expect(header).toHaveAttribute('aria-expanded', 'true');
	await expect(tabs).toHaveCount(4);

	await header.click();
	await expect(header).toHaveAttribute('aria-expanded', 'false');
	await expect(tabs).toHaveCount(2);
});
