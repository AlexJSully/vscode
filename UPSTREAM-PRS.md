# Upstream PRs for Tab Stacks

This is the plan for sending fork PR [AlexJSully/vscode#1](https://github.com/AlexJSully/vscode/pull/1) to `microsoft/vscode`. It is split into narrow pull requests:

- **Track A:** 15 standalone fixes for bugs that exist on `main`. They go first, each on its own.
- **Track B:** the Tab Stacks feature as a stack of 6 pull requests. It starts once the check-in on microsoft/vscode#100335 gets a go-ahead.

This file is fork-only, like `FOLLOW-UP-BUGS.md`. Neither file goes into an upstream pull request.

## How to use this doc

- **Remotes:** `origin` is AlexJSully/vscode and `upstream` is microsoft/vscode.
- **Branching:** every PR branch starts from the latest `upstream/main`.
- **What a PR is built from:** each PR is cut from the final state of the fork branch `alexjsully-260925-group-tabs`. Fork commits are never replayed, because the fork history iterated. Port only the lines the PR needs, and rebuild the "entangled" fixes against the code of `main`.
- **Who does what:**
  - Claude makes the working-tree edits and tests on the branch you created, runs the checks, and drafts the PR text.
  - You review, commit, push and open the PR. Claude never runs git or gh writes.
- **Stacking from a fork:**
  - Upstream PRs can only target `microsoft/vscode:main`.
  - So each stacked PR also carries the commits of the PRs below it until those merge.
  - Its description says "Depends on #N. Please review only the last commit(s)."
  - After a merge, rebase the next branch onto `upstream/main`.
- **Evidence:** every Track A row has an entry under "Fixed as part of Tab Stacks" in `FOLLOW-UP-BUGS.md`. That entry has the evidence on `main` at `e5f3c4cdf79`, the tests, and the "Upstream PR" port note.

### Per-PR checklist

- [ ] Narrow scope: every changed line is needed for the PR's goal, with no unrelated edits.
- [ ] A test that fails without the fix, in the right suite, with one snapshot `assert.deepStrictEqual` where it fits.
- [ ] Targeted suites pass: `env -u ELECTRON_RUN_AS_NODE ./scripts/test.sh --grep "<suites>"`.
- [ ] `npm run typecheck-client`, eslint on the changed files, and `node build/stylelint.ts` when CSS changed.
- [ ] Hygiene: `{ git diff --name-only; git ls-files --others --exclude-standard; } | xargs node --experimental-strip-types build/hygiene.ts`.
- [ ] `npm run valid-layers-check` and `npm run define-class-fields-check`.
- [ ] Follows `.github/instructions`: comment limits, no new `!important`, design tokens.
- [ ] A PR description from `.github/pull_request_template.md`, with "Fixes #…" or "Refs #100335" and a test plan.
- [ ] Copilot review comments resolved before asking for human review.

## Track A: standalone bug-fix PRs

These go against `main` now, in this order. "Entangled" means the fork's fix lives inside Tab Stacks code, so the PR rebuilds it for `main`. Each entry's port note in `FOLLOW-UP-BUGS.md` says what changes.

| # | PR | Main files | Depends on | Port |
| --- | --- | --- | --- | --- |
| A1 | Pill-mode sticky mask covers the gutter below the pills | `contrib/modernUI/browser/media/tabs.css`, test in `modernUI.contribution.test.ts` | none | independent |
| A2 | A drag over the tabs scrolls only sideways, not up by a pixel | `media/multieditortabscontrol.css` (the `scroll` rule) | none | independent; adds the test helpers `dispatchDrag`, `tabsChild` and `describeTabsChild` |
| A3 | The reveal block is cleared while tabs wrap | `multiEditorTabsControl.ts` (`doLayoutTabs`, wrapping branch) | none | independent; needs a new failing test that clicks no tab stack header |
| A4 | FB-13: a drop marker could stay visible after a drop | `base/browser/dom.ts` (`DragAndDropObserver.reset`), `multiEditorTabsControl.ts` | A2 (test helpers) | independent; adds `classicGroup`, `dragEditors` and `dropFeedback` |
| A5 | FB-15: Open Editors drop lands one slot past the drop | `contrib/files/browser/views/openEditorsView.ts`, `workbench/browser/dnd.ts` (`findEditorOfDroppedEditor`) | none | independent |
| A6 | FB-19: Open Editors files dropped together land apart | `workbench/browser/dnd.ts` (`moveEditorsOfDroppedEditors`, `anchorDropIndex`, `beforeOpen`), `services/editor/common/editorService.ts` and `browser/editorService.ts` (`IOpenEditorsOptions.beforeOpen`), `openEditorsView.ts` | A5 | independent |
| A7 | FB-4: "pinned" in the accessible name with pinned tabs on a separate row | `multiEditorTabsControl.ts` (`computeTabAriaLabel`) | none | independent; adds the test helper `createNamedEditor` |
| A8 | FB-16: the accessible name keeps its old pinned state | `multiEditorTabsControl.ts` (`updateTabLabelsUnlessTabsPending`) | A7 | independent; adds `tabAriaLabels` and `editorGroupCount` |
| A9 | FB-18: the accessible name keeps "preview" after the preview is kept | `multiEditorTabsControl.ts` (`pinEditor`) | A7, A8 | independent |
| A10 | Editors opened together after a file split open at the start of the group | `editorGroupView.ts` (`openEditors`, one line on `main`) | none | entangled |
| A11 | FB-14: no drop marker on the empty space of the tabs in the Agents window | `multiEditorTabsControl.ts` (`getLastTab`), `contrib/modernUI/browser/media/tabs.css` | A2, A4 (test helpers) | entangled; adds `dragOver` and `strip` |
| A12 | FB-20: dragging over the Add Tab control keeps the drop marker | `multiEditorTabsControl.ts` (tabs container drag enter) | A11 | independent |
| A13 | FB-12: Modern UI tabs keep wrapping once they fit on one row | `multiEditorTabsControl.ts` (`doLayoutTabsWrapping`, with `getLastTab` in place of `getLastShownSlot`) | A7 (test helper) | independent, with that substitution |
| A14 | Tab bar: an editor the group already has lands one slot past the marker | `multiEditorTabsControl.ts` (`onDrop`) | A5 | entangled |
| A15 | Tab bar: files dropped together land apart | `multiEditorTabsControl.ts` (`onDrop`, calls `moveEditorsOfDroppedEditors`) | A6, A14 | entangled |

Suggested branch names: `fix/a1-pill-sticky-mask`, `fix/a2-drag-scroll`, `fix/a3-wrap-reveal-block`, `fix/a4-stale-drop-marker`, `fix/a5-open-editors-drop-index`, `fix/a6-open-editors-drop-order`, `fix/a7-pinned-row-aria`, `fix/a8-pin-change-aria`, `fix/a9-preview-aria`, `fix/a10-split-editor-open-index`, `fix/a11-agents-empty-space-marker`, `fix/a12-add-tab-marker`, `fix/a13-wrap-one-row`, `fix/a14-tab-drop-index`, `fix/a15-tab-drop-order`.

The deferred `main` bugs (FB-1 to FB-3, FB-5 to FB-11, FB-17, FB-21 and FB-22) are not in this track. See "Later tracks".

## Track B: the Tab Stacks feature stack

### B0: check in on microsoft/vscode#100335

Post this before B1 and wait for a maintainer reply. Claude drafts it with you; you post it.

> I've built Chrome-style tab groups for editor tabs as an experimental setting (`workbench.editor.enableTabStacks`, off by default). The name is "Tab Stack" because the `tabGroups` API already means editor groups. Here's a demo: <video link>. It keeps Chromium's tab strip rules (stacks are contiguous, pinned and preview tabs are never members, new tabs never join), and hides stacks without deleting them while the setting is off. I'd like to upstream it as 6 small PRs: model, group API, tab bar rendering, naming and colors, drag and drop, and keyboard and screen reader. Would the team take this, and is there anything you'd want shaped differently first?

### The stack

Each PR depends on the one above it.

| # | PR | Scope (main files) | Tests (suites) |
| --- | --- | --- | --- |
| B1 | Tab stack model | `common/editor/editorGroupModel.ts`: membership, Chromium rules, hide/show records, serialization, the snapshot restore. `common/editor.ts`: `GroupModelChangeKind.TAB_STACKS`. `common/editor/filteredEditorGroupModel.ts`. The no-op in `api/browser/mainThreadEditorTabs.ts`. No user-visible change. | `EditorGroupModel`, `FilteredEditorGroupModel`, `MainThreadEditorTabs` |
| B2 | Setting, group API and view wiring, no UI | The setting (experimental, off) in `browser/workbench.contribution.ts` and `common/editor.ts`, with `isTabStacksEnabled`. The 7 tab stack members of `IEditorGroup` in `services/editor/common/editorGroupsService.ts`. `editorGroupView.ts`: hide/show, replace, collapse, the new-stack cancel record, and editors that open past a stack. `editorPart.ts`: `mergeGroup` keeps stacks. The `editorsObserver.ts` limit exemption. `common/contextkeys.ts`. Test services. | `EditorGroupsService`, `EditorsObserver`, `Workbench editor utils` |
| B3 | Tab bar rendering and basic commands | First commit, behavior-neutral: the tab slot-array refactor in `multiEditorTabsControl.ts`. Then `tabStacksControl.ts`: headers, collapse on click and the member indicator. `updateTabStacks` in the tab-control interfaces (`editorTabsControl.ts`, `editorTitleControl.ts`, `multiRowEditorTabsControl.ts`, `noEditorTabsControl.ts`, `singleEditorTabsControl.ts`). CSS: `multieditortabscontrol.css`, `contrib/modernUI/browser/media/tabs.css`, `connectedEditorTabs.css`, `sessions/browser/parts/media/editorPart.css`. 9 theme colors in `common/theme.ts`, plus `build/lib/stylelint/vscode-known-variables.json`. Accessible names. The header menu. Commands in `editorCommands.ts`, `editor.contribution.ts`, `editorCommandsContext.ts` and `editor.ts`: Add to New Tab Stack, Remove from Tab Stack, Collapse, Expand, Remove Tab Stack, Close Tab Stack. The flat tab context menu items. | `MultiEditorTabsControl`, `ModernUIContribution`, `Sessions - EditorPart`, `Resolving Editor Commands Context`, component fixtures |
| B4 | Naming and colors | `tabStackEditor.ts` (the naming bubble) and `media/tabstackeditor.css`. `editTabStack` in the tab controls. Rename... and Change Color.... Add to Tab Stack.... `tabStackPickers.ts`. Enter and clicking elsewhere keep the changes. Escape cancels a new stack, putting the tabs and other stacks back exactly as they were, or reverts a rename or color change. Custom `#rrggbb` colors stay isolated so they can be dropped as a unit if review asks. | `TabStackEditor`, `TabStackPickers`, the bubble cases in `EditorGroupsService` |
| B5 | Drag and drop | `tabsDropHandler.ts`. Header drags. The drop rules, including the end of a stack. The inside-marker CSS. The drop space after a stack that ends the tab bar. Cross-group hints. Stack integrity in the Open Editors view. Tab-bar `beforeOpen` anchoring in `workbench/browser/dnd.ts`. Needs A5, A6, A14 and A15 merged first. | The `EditorGroupsService` drop tables, `MultiEditorTabsControl`, `Files - OpenEditorsView` |
| B6 | Keyboard moves and screen reader announcements | `moveEditorsByTabWithTabStacks` and Chrome-style Move Editor Left/Right/First/Last. The `setTabStackCollapsed` announcements through `IAccessibilityService.status`. | The `EditorGroupsService` move table, announcement tests |

Each B PR carries:

- the matching screenshots from `/Users/joohyun/Documents/code/vscode-tab-stacks-pr-screenshots/` (light, dark and high contrast);
- a note that the setting is experimental and off by default;
- why the feature is called "Tab Stack";
- for B3 and B6, a request for an accessibility review.

Suggested branch names: `feat/b1-tab-stack-model`, `feat/b2-tab-stack-group-api`, `feat/b3-tab-stack-rendering`, `feat/b4-tab-stack-naming`, `feat/b5-tab-stack-dnd`, `feat/b6-tab-stack-keyboard`.

## Later tracks

- **Track C, deferred `main` bugs:** FB-1 to FB-3, FB-5 to FB-11, FB-17, FB-21 and FB-22 become more standalone PRs, in the order in `FOLLOW-UP-BUGS.md`. FB-1 and FB-2 can share one. FB-23 waits on microsoft/vscode#339489.
- **Track D, features left out of scope:**
  - dragging a whole stack to another group or window;
  - reopening a closed stack;
  - grouping in the Open Editors view;
  - tab stacks in the extension API;
  - keyboard navigation of stack headers.

## Command templates

Claude never runs these. Start a PR branch:

```sh
git fetch upstream
git switch -c <branch> upstream/main
```

Finish it:

```sh
git add <files>
git commit
git push -u origin <branch>
gh pr create --repo microsoft/vscode --base main --head AlexJSully:<branch> --body-file <file>
```

Rebase a stacked branch after the PR below it merges:

```sh
git fetch upstream
git switch <branch>
git rebase upstream/main
git push --force-with-lease
```

## Status

Status values: not started, in progress, open, changes requested, merged.

| # | Branch | Upstream PR | Status | Notes |
| --- | --- | --- | --- | --- |
| A1 | | | not started | |
| A2 | | | not started | |
| A3 | | | not started | |
| A4 | | | not started | |
| A5 | | | not started | |
| A6 | | | not started | |
| A7 | | | not started | |
| A8 | | | not started | |
| A9 | | | not started | |
| A10 | | | not started | |
| A11 | | | not started | |
| A12 | | | not started | |
| A13 | | | not started | |
| A14 | | | not started | |
| A15 | | | not started | |
| B0 | | microsoft/vscode#100335 | not started | check-in comment |
| B1 | | | not started | |
| B2 | | | not started | |
| B3 | | | not started | |
| B4 | | | not started | |
| B5 | | | not started | |
| B6 | | | not started | |
