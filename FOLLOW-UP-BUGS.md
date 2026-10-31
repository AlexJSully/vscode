# Follow-up Bugs

These are bugs on `main` found while building Tab Stacks (Chrome-style tab grouping). Each one still open becomes its own small pull request against `main`, but only once it reproduces by hand in released VS Code; one that does not reproduce is scrapped (see `UPSTREAM-PRS.md`).

Seven of them showed up as Tab Stacks symptoms, so this tree fixes them for Tab Stacks only: each fix runs only while tab stacks are on, or only in a group that has a tab stack, so with the setting off VS Code behaves as on `main`, and its hot paths skip tab stack work (see [Fixed for Tab Stacks only](#fixed-for-tab-stacks-only)). They are FB-12, FB-13, FB-14 and FB-20, which the empty space after a tab stack that ends the tabs needs, and FB-4, FB-16 and FB-18, which announce tab stack members as pinned or as previews. Their plain fixes, for everyone, stay separate pull requests. A3, the reveal block that stayed set while tabs wrap, is fixed for everyone and is open as microsoft/vscode#340548.

- **Evidence commit:** line references are to `e5f3c4cdf79` (`main`).
- **Status values:**
  - `Confirmed by reading`: the defect is visible in the code, but no test demonstrates it yet.
  - `Needs repro test`: probably a real defect, but its impact is unproven until a failing test exists.
  - `Confirmed by test`, `PR open`, `Fixed`.
  - `Fixed for Tab Stacks only`: the defect exists on `main` and showed up as a Tab Stacks symptom, so this tree fixes it, with a test, only where tab stacks apply.
  - `Scrapped`: did not reproduce by hand, and Tab Stacks no longer needs a fix (see [Scrapped](#scrapped)).
  - `Confirmed live`: the defect was seen in the running app in this tree. `Seen in this tree`: the defect was measured in this tree, such as in a test or the running app.
  - A status can combine two parts, such as "Confirmed live; on `main` by reading", where the second part says how the defect was confirmed on `main`, or "Confirmed by reading; impact needs a test".
- **Workflow:** reproduce by hand first, then write the failing test, in the suite named in the entry. Then fix, then update the status here.
- **What goes here:** a bug found while building Tab Stacks is fixed right away, with a test, when Tab Stacks introduced it. A bug that exists on `main` is fixed here only if it breaks a Tab Stacks feature, and then only for Tab Stacks; otherwise it is added here and deferred.
- **Narrowing (2026-10-15):** the tree used to carry fixes for ten `main` bugs that changed behaviour with the setting off. The Open Editors and Explorer drop work left the tree, and with it A5, A10, FB-15 and FB-19 (scrapped). C1 and C2 left the tree as deferred fixes on their own branches. FB-4, FB-12, FB-13, FB-14, FB-16, FB-18 and FB-20 stayed, limited to tab stacks.
- **Scope:** this file is for the fork and does not belong in the upstream Tab Stacks pull requests.

Once reproduced and fixed, each deferred bug is its own pull request, except that FB-1 and FB-2 can share one, smallest and safest first: FB-3, FB-10, FB-5, FB-6, FB-11, FB-22, FB-7, FB-8, FB-21, FB-1, FB-2, FB-9, FB-17. FB-23 is left out of that order while an upstream pull request for it, microsoft/vscode#339489, is open (see its **PR grouping** line). The plain fixes of FB-4, FB-16 and FB-18 are C3 in `UPSTREAM-PRS.md`; those of FB-12, FB-13, FB-14 and FB-20 wait for a hand repro on `main`.

An upstream search on 2026-09-25 (`gh search issues`) found no existing microsoft/vscode issue for the entries that the file had then, FB-1 to FB-6 (this line came with Tab Stacks part 1, `915d53f6224`). Whether FB-7 to FB-20 were searched is not recorded. For FB-21 and FB-22, a search on 2026-09-30 found nothing, but several broad queries in it returned nothing at all, so that result is inconclusive. For FB-23, a search on 2026-10-06 found it upstream: microsoft/vscode#338171, with a fix proposed in microsoft/vscode#339489.

## Summary

| ID | Bug | Status |
| --- | --- | --- |
| [FB-1](#fb-1-restored-mru-and-preview-point-at-the-wrong-editors) | Restored MRU and preview point at the wrong editors | Confirmed by reading |
| [FB-2](#fb-2-deserialize-mutates-its-input-and-can-lose-sticky-editors-on-re-apply) | `deserialize` mutates its input and can lose sticky editors on re-apply | Needs repro test |
| [FB-3](#fb-3-the-comment-on-sticky-names-the-wrong-editor) | The comment on `sticky` names the wrong editor | Confirmed by reading |
| [FB-4](#fixed-for-tab-stacks-only) | Unsticky-row tabs are announced as "pinned" | Fixed for Tab Stacks only |
| [FB-5](#fb-5-an-out-of-range-move-index-reaches-the-tab-bar) | An out-of-range move index reaches the tab bar | Confirmed by reading; impact needs a test |
| [FB-6](#fb-6-the-transient-event-fires-with-an-index-the-editor-does-not-occupy) | The transient event (`EDITOR_TRANSIENT`) fires with an index the editor does not occupy | Confirmed by reading |
| [FB-7](#fb-7-moving-a-multi-selection-by-keyboard-can-scramble-its-order) | Moving a multi-selection by keyboard can scramble its order | Confirmed by reading |
| [FB-8](#fb-8-closing-the-active-editor-drops-the-other-selected-editors) | Closing the active editor drops the other selected editors | Confirmed by reading; impact needs a test |
| [FB-9](#fb-9-stylelint-known-variables-are-out-of-date) | Stylelint known variables are out of date with the registered colors | Confirmed by test |
| [FB-10](#fb-10-a-command-context-test-asserts-the-wrong-result) | A command-context test asserts the wrong result | Confirmed by reading |
| [FB-11](#fb-11-a-touch-long-press-on-a-tab-opens-two-menus) | A touch long-press on a tab opens two menus | Confirmed by test |
| [FB-12](#fixed-for-tab-stacks-only) | Modern UI tabs keep wrapping once they fit on one row again | Fixed for Tab Stacks only |
| [FB-13](#fixed-for-tab-stacks-only) | A drop marker can stay visible after a drop | Fixed for Tab Stacks only |
| [FB-14](#fixed-for-tab-stacks-only) | Agents window: no drop marker on empty tab-bar space | Fixed for Tab Stacks only |
| [FB-15](#scrapped) | Open Editors: an editor from another group or a file that the group has already lands one slot past the marker | Scrapped |
| [FB-16](#fixed-for-tab-stacks-only) | A tab's accessible name keeps its pinned state after a pin change | Fixed for Tab Stacks only |
| [FB-17](#fb-17-the-scrollbar-of-overflowing-tabs-covers-their-bottom-during-a-drag) | The scrollbar of overflowing tabs covers their bottom during a drag | Confirmed live; on `main` by reading |
| [FB-18](#fixed-for-tab-stacks-only) | A tab's accessible name keeps "preview" once the preview is kept open | Fixed for Tab Stacks only |
| [FB-19](#scrapped) | Open Editors: files dropped together land apart when the group has a later one already | Scrapped |
| [FB-20](#fixed-for-tab-stacks-only) | Agents window: a drag over the Add Tab control, where a drop does nothing, keeps the last drop marker | Fixed for Tab Stacks only |
| [FB-21](#fb-21-the-editor-group-in-the-accessible-name-of-a-tab-goes-stale-when-groups-change) | The editor group in the accessible name of a tab goes stale when groups are added, removed or renumbered | Confirmed live; on `main` by reading |
| [FB-22](#fb-22-drop-markers-on-the-upper-rows-of-wrapped-connected-tabs-are-shorter-than-on-the-bottom-row) | Drop markers on the upper rows of wrapped connected tabs are shorter than on the bottom row | Seen in this tree; on `main` by reading |
| [FB-23](#fb-23-a-connected-tab-with-a-short-name-loses-its-file-icon) | A connected tab with a short name loses its file icon | Confirmed live; on `main` by reading and upstream |

## FB-1: restored MRU and preview point at the wrong editors

- **Area:** `EditorGroupModel.deserialize` (`src/vs/workbench/common/editor/editorGroupModel.ts`).
- **Evidence:**
  - Lines 1233-1250 build `this.editors` with `coalesce(...)`, which drops every editor that fails to deserialize.
  - Lines 1252-1258 then map the serialized indices against the *shortened* array: `this.mru = coalesce(data.mru.map(i => this.editors[i]))` and `this.preview = this.editors[data.preview]`.
  - Sticky editors are the one case handled correctly (1245-1247).
- **Impact:** when any editor fails to restore, for example because an extension that provides its serializer is gone, every MRU entry and the preview index after it shift by one. The wrong editor can become active, or be treated as the preview and replaced on the next single-click.
- **How found:** by reading the code.
- **Confirming test** (suite `EditorGroupModel`, `src/vs/workbench/test/browser/parts/editor/editorGroupModel.test.ts`):
  1. Serialize a group of 4 editors where the second fails to deserialize (`TestEditorInputSerializer.disableDeserialize`) and the last is the preview.
  2. Restore it.
  3. Assert the active editor and the preview editor.
- **Suggested fix:** keep the un-coalesced restored array, map `mru` and `preview` through it, and only then coalesce.
- **Tab Stacks interaction:** the shifted preview index can land on a tab stack member. That editor restores as the preview. When tab stacks are shown, it joins its stack and is pinned, because members are never previews; while they are hidden, it stays the preview. Once FB-1 is fixed, that pin only happens for genuinely inconsistent data.
- **PR grouping:** alone, or together with FB-2, since both are in `deserialize`.

## FB-2: `deserialize` mutates its input and can lose sticky editors on re-apply

- **Area:** `EditorGroupModel.deserialize` (`src/vs/workbench/common/editor/editorGroupModel.ts`).
- **Evidence:**
  - Lines 1245-1247 decrement `data.sticky` on the serialized state that was passed in. The field is not `readonly` (line 49).
  - Editor working sets keep their serialized states in memory and hand the same objects to `applyState` every time a working set is applied (`src/vs/workbench/browser/parts/editor/editorParts.ts:597, 635-650`).
- **Impact (probable):** re-applying the same working set while one of its sticky editors cannot be restored could drop one more sticky editor on each apply.
- **How found:** by reading the code.
- **Confirming test** (suite `EditorGroupsService`, `src/vs/workbench/services/editor/test/browser/editorGroupsService.test.ts`): save a working set with 2 sticky editors, one of which cannot be deserialized. Apply it twice, and assert the sticky count after each apply.
- **Suggested fix:** compute a local sticky value in `deserialize` instead of writing to `data`.
- **PR grouping:** with FB-1.

## FB-3: the comment on `sticky` names the wrong editor

- **Area:** `EditorGroupModel` field declaration (`src/vs/workbench/common/editor/editorGroupModel.ts:213`).
- **Evidence:** the comment says `// index of first editor in sticky state`. The code treats the field as the index of the **last** sticky editor: `stickyCount` returns `this.sticky + 1` (253-254), and `isSticky` checks `index <= this.sticky` (948).
- **Impact:** misleading documentation for anyone changing sticky handling.
- **How found:** by reading the code.
- **Confirming test:** none, since this is a comment-only fix.
- **Suggested fix:** change the comment to say the field is the index of the last sticky editor, with -1 when none are sticky.
- **PR grouping:** alone (trivial).

## FB-5: an out-of-range move index reaches the tab bar

- **Area:** `EditorGroupView.doMoveEditorInsideGroup` (`src/vs/workbench/browser/parts/editor/editorGroupView.ts:1434-1469`).
- **Evidence:**
  - `EditorGroupModel.moveEditor` clamps `toIndex` into range and returns early when the clamped index equals the current one (`editorGroupModel.ts:592-600`).
  - `doMoveEditorInsideGroup` compares `currentIndex !== moveToIndex` against the *unclamped* value (1450). It then calls `this.model.pin(editor)` and `this.titleControl.moveEditor(editor, currentIndex, moveToIndex, ...)` with that value (1458).
- **Impact:** moving the last editor to an index beyond the end is a no-op in the model, but the view still pins the editor and asks the tab bar to move it to a non-existent slot.
- **How found:** by reading the code. The effect on the tab bar is unconfirmed.
- **Confirming test** (suite `EditorGroupsService`, plus a DOM check in `MultiEditorTabsControl`): open 3 editors, call `group.moveEditor(last, group, { index: 8 })`, and assert the pinned state and the rendered tab order.
- **Suggested fix:** clamp `moveToIndex` in the view the same way the model does, or use the model's actual result, before comparing and forwarding.
- **PR grouping:** alone.

## FB-6: the transient event fires with an index the editor does not occupy

- **Area:** `EditorGroupModel.openEditor`, new-editor branch (`src/vs/workbench/common/editor/editorGroupModel.ts`).
- **Evidence:** at `e5f3c4cdf79`, the "Handle transient" block (around line 366) calls `this.doSetTransient(newEditor, targetIndex, true)` *before* the preview-replacement block adjusts `targetIndex--` (around line 376) and calls `replaceEditor(this.preview, newEditor, targetIndex, ...)` (around line 379). When a transient editor replaces a preview editor, the `EDITOR_TRANSIENT` event carries an index the editor does not occupy yet, off by one when the preview was to the left of the target.
- **Impact:** `FilteredEditorGroupModel` routes events by `editorIndex` (`filteredEditorGroupModel.ts:22-30`), so the event can go to the wrong row, sticky or unsticky, when pinned tabs are on a separate row. Listeners that look up the editor by that index get the wrong editor.
- **How found:** by reading the code, while implementing Tab Stacks slice A.
- **Confirming test** (suite `EditorGroupModel`): open a preview editor, then open a transient preview editor to its right, so that it replaces the first one. Assert that the `EDITOR_TRANSIENT` event's `editorIndex` equals the `EDITOR_OPEN` event's `editorIndex`.
- **Suggested fix:** move the "Handle transient" block after the preview-replacement block, so that it uses the final index.
- **PR grouping:** alone.

## FB-7: moving a multi-selection by keyboard can scramble its order

- **Area:** `moveTabs` and `moveTab` in `src/vs/workbench/browser/parts/editor/editorCommands.ts` (lines 248-288 at `e5f3c4cdf79`), behind the "Move Editor Left/Right/First/Last/Center/Position" commands when several tabs are selected.
- **Evidence:** `moveTabs` reverses the selection for `first` and `right`, then moves each editor on its own. `moveTab` computes each target index and clamps it into `[0, count - 1]`.
  - When the last selected editor is already at the end, the clamp leaves it in place, and the next one is moved *after* it. Example: in `[A, B, C]` with B and C selected, "Move Editor Right" gives `[A, C, B]`.
  - `center` sends every selected editor to the same index, and so does a `position` target inside the selection. The editors then land in reverse order.
- **Impact:** the selected tabs swap places instead of moving together.
- **How found:** by reading the code, while implementing Tab Stacks slice B. In a group with tab stacks, Move Editor Left, Right, First and Last move the selection the Chrome way (`moveEditorsByTabWithTabStacks`); center, position and every move without tab stacks still use this path.
- **Confirming test:** `moveTabs` is only reachable through registered commands. Extract its index computation into a pure function (the fork had `getMoveTabIndex` and `getMoveTabsRunIndex` in `browser/parts/editor/editor.ts` before 2026-10-15, see commit `52ed5c95147`), then snapshot the resulting orders for `right` at the end, `center` and `position` in the suite `Workbench editor utils`.
- **Suggested fix:** move the selection as one contiguous run, computing one target index for the run instead of one index per editor.
- **PR grouping:** alone.

## FB-8: closing the active editor drops the other selected editors

- **Area:**
  - `EditorGroupView.doCloseActiveEditor` (`src/vs/workbench/browser/parts/editor/editorGroupView.ts:1606-1680` at `e5f3c4cdf79`);
  - `EditorGroupModel.doCloseEditor` (`src/vs/workbench/common/editor/editorGroupModel.ts`, around 554-555).
- **Evidence:**
  - When the active editor closes, the model deliberately keeps the other selected editors: `const newInactiveSelectedEditors = this.selection.filter(...)` followed by `this.doSetSelection(newActive, ..., newInactiveSelectedEditors)`.
  - The view then opens the next editor with `this.doOpenEditor(nextActiveEditor, options, ...)`, where `options` has no `inactiveSelection`.
  - `openEditor` ends in `setSelection(..., options?.inactiveSelection ?? [])`, which clears them again.
- **Impact:** after closing the active tab of a multi-selection, the rest of the selection is lost.
- **How found:** by reading the code, while implementing Tab Stacks slice B.
- **Confirming test** (suite `EditorGroupsService`): select 3 editors, close the active one, and assert `group.selectedEditors`.
- **Suggested fix:** pass the model's remaining inactive selection as `inactiveSelection` when `doCloseActiveEditor` opens the next editor.
- **PR grouping:** alone. First check that dropping the selection is not intentional.

## FB-9: stylelint known variables are out of date

- **Area:** `build/lib/stylelint/vscode-known-variables.json`.
- **Evidence:** the color registry release test (`env -u ELECTRON_RUN_AS_NODE ./scripts/test.sh --runGlob "**/colorRegistry.releaseTest.js"`) fails. Its regenerated list differs by about 122 lines:
  - 4 colors to add (`modernActivityBar`, `testing`);
  - 15 colors to remove (such as `gauge`, `gitDecoration`, `agentsMobileDiff`);
  - 7 sizes.

  None of them is a tab stack color. The 9 `tabStack.*` colors are listed and pass.
- **Impact:** stylelint may accept stale `--vscode-*` variables or reject valid new ones. The release test is not part of PR CI, so the drift goes unnoticed until the endgame.
- **How found:** by running the test during Tab Stacks slice B. The test rewrites the JSON when it fails; the rewrite was reverted.
- **Confirming test:** the release test itself.
- **Suggested fix:** run the test on `main` to regenerate the file, then review the additions and removals.
- **PR grouping:** alone. Coordinate with whoever owns the theme colors listed.

## FB-10: a command-context test asserts the wrong result

- **Area:** test `inactive edior group command context` in `src/vs/workbench/test/browser/parts/editor/editorCommandsContext.test.ts` (starts at line 148 at `e5f3c4cdf79`).
- **Evidence:** the second block builds `resolvedContext2`, but line 183 asserts `assert.strictEqual(resolvedContext1.groupedEditors[0].editors[0], input21);`, which is a copy of line 173. The resolved editor of the second context is therefore never checked. The test title also misspells "editor".
- **Impact:** a regression in how the second context resolves its editor would not be caught.
- **How found:** by reading the code, while implementing Tab Stacks slice B.
- **Confirming test:** change line 183 to assert `resolvedContext2`, which should still pass.
- **Suggested fix:** as above, and fix the title typo.
- **PR grouping:** alone (trivial).

## FB-11: a touch long-press on a tab opens two menus

- **Area:** `MultiEditorTabsControl` touch context menus (`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`).
- **Evidence:**
  - At `e5f3c4cdf79`, the tabs container listens for `TouchEventType.Contextmenu` at line 621: `this._register(addDisposableListener(tabsContainer, TouchEventType.Contextmenu, e => showContextMenu(e)));`. It does not check where the press started.
  - Each tab has its own listener at line 1181.
  - `Gesture` dispatches a long-press to every gesture target that contains the pressed element, so both fire.
  - The container's Tap handler (around line 424) does check the event target.
- **Impact:** on touch devices, a long-press on a tab opens the tab's context menu, and the tab-bar menu then opens over it.
- **How found:** while implementing Tab Stacks slice C, and confirmed with a temporary test that has since been removed. The same root cause affected the new tab stack headers, which Tab Stacks fixed with a test because that case did not exist on `main`.
- **Confirming test** (suite `MultiEditorTabsControl`): dispatch a `TouchEventType.Contextmenu` gesture on a tab, and assert that the context menu service is called once, with the tab's menu.
- **Suggested fix:** in the container listener, return unless `e.initialTarget === tabsContainer`, mirroring the Tap handler.
- **PR grouping:** alone.

## FB-17: the scrollbar of overflowing tabs covers their bottom during a drag

- **Area:** the horizontal scrollbar of the tabs: `MultiEditorTabsControl.createTabsScrollbar` (`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`), its CSS (`src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css`, `src/vs/workbench/contrib/modernUI/browser/media/tabs.css`), and `ScrollableElement` (`src/vs/base/browser/ui/scrollbar/`, unchanged in this tree).
- **Evidence** (at `e5f3c4cdf79`):
  - The tabs container scrolls with a custom `ScrollableElement` (`multiEditorTabsControl.ts:277, 325-331`). Its horizontal scrollbar follows `workbench.editor.titleScrollbarVisibility`, `auto` by default, and is as high as `workbench.editor.titleScrollbarSizing` says: 3px by default and 10px with `large` (lines 94-97, 396-410).
  - The scrollbar takes no space of its own. It is positioned absolutely at the bottom of the scrollable element (`abstractScrollbar.ts:75`, `horizontalScrollbar.ts:76-81`), over the tabs container, which it follows in the DOM (`scrollableElement.ts:254-255`).
  - The scrollbar has `z-index: 11` (`multieditortabscontrol.css:69-72`, and `tabs.css:601-603` with Modern UI), the same as the drop marker (`multieditortabscontrol.css:574-584`). The stacking order at line 31 lists both as "scrollbar / tabs dnd border". A tab that is not sticky has no z-index (lines 115-124), so its marker and the scrollbar are in one stacking context, where the scrollbar, which comes later in the DOM, is drawn over the marker. A sticky tab with compact or shrink pinned tab sizing has `z-index: 8` (lines 224-233), which puts its marker below the scrollbar too, and one with normal pinned tab sizing has no z-index, like a tab that is not sticky.
  - A drag near the ends of tabs that overflow makes the browser scroll the tabs container (class `scroll`, `multiEditorTabsControl.ts:499`, `multieditortabscontrol.css:82-84`). The scroll listener of the container passes the new position to the scrollbar (`multiEditorTabsControl.ts:414-420`), which shows the scrollbar on each scroll (`scrollableElement.ts:583-585`) and hides it 500ms after the last one (lines 22, 650-667).
  - The slider is gray at 40% opacity by default, and the contrast border at 60% or 40% opacity in high contrast (`scrollbarSlider.background`, `src/vs/platform/theme/common/colors/miscColors.ts:56-58`). So it dims what it covers but does not hide it.
- **Impact:** cosmetic. While a drag scrolls tabs that overflow, the slider covers the bottom 3px of the tabs where it lies, or 10px with `large`, and dims them and the drop marker there. With `titleScrollbarVisibility` set to `visible`, the slider lies there at all times. With `hidden`, it has no size. With Tab Stacks, the slider also dims the stack-colored foot of the marker of a drop inside a tab stack and the line under the tabs of a tab stack, both 2px high at the bottom of the tabs. They stay visible under it, so this does not block Tab Stacks.
- **How found:** live, during the round 5 check of the Tab Stacks drop marker. The code above shows the same overlay on `main`.
- **Status:** confirmed live in this tree, and confirmed by reading on `main`. Deferred, since it does not block Tab Stacks.
- **Confirming test** (suite `MultiEditorTabsControl`, with the helpers `connectedGroup` and `layoutConnectedGroup` that `main` has): lay out tabs that overflow, dispatch a drag enter on the left half of the last tab, scroll the tabs container to its end and dispatch its scroll event. What the test then asserts depends on the fix:
  - to hide the scrollbar, that the horizontal scrollbar of the tabs (`.monaco-scrollable-element > .scrollbar.horizontal`) is not shown while the tabs container has the class `scroll`: its computed `display` is `none` or its `visibility` is `hidden`;
  - to draw the drop marker above the scrollbar, that the computed `z-index` of the pseudo-element of the marker is above the one of the scrollbar, in the stacking context that they share. Both are 11, so it fails first.

  `elementFromPoint` cannot check either: the marker is a pseudo-element with `pointer-events: none`, which hit testing skips, so it returns the slider wherever the slider shows, whatever is drawn over it. The test is not written yet.
- **Suggested fix:** undecided. Either hide the scrollbar while a drag scrolls the tabs, for example with `.tabs-container.scroll ~ .scrollbar`, since the scrollbar is a later sibling of the tabs container, or draw the drop marker above the scrollbar and update the stacking order.
- **PR grouping:** alone.

## FB-21: the editor group in the accessible name of a tab goes stale when groups change

- **Area:** the accessible names of tabs in `MultiEditorTabsControl` (`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`), which come from `computeEditorAriaLabel` (`src/vs/workbench/browser/editor.ts`).
- **Evidence** (at `e5f3c4cdf79`):
  - `computeEditorAriaLabel` (`editor.ts:275-293`) appends the accessible name of the group, such as "Editor Group 1" (`editorGroupView.ts:931-937`), only when its `groupCount` is above 1 (lines 288-290).
  - `computeTabLabels` computes it once for each tab with `this.editorPartsView.count` (`multiEditorTabsControl.ts:1584`), the number of groups across all editor parts (`editorParts.ts:722-724`), and caches it. `redrawTabLabel` sets `aria-label` from that cache (lines 1822-1823).
  - `computeTabLabels` runs only when editors of the group open (line 672) or close (765), when the label of an editor changes (878), and when the label format changes (904).
  - Adding, removing or moving a group renumbers the groups (`notifyGroupIndexChange`, `editorPart.ts:646, 876, 920, 1406-1408`), which fires `GROUP_INDEX` from the model of each group (`editorGroupModel.ts:765-771`), and a new label of the groups fires `GROUP_LABEL` (773-779). `EditorGroupView.onDidGroupModelChange` re-emits both (`editorGroupView.ts:621-624`), but the tabs handle neither, and nothing tells them that the number of groups changed.
- **Impact:** a screen reader announces the wrong group for a tab, or a group where there is only one:
  - once the second of two groups closes, the tabs of the first keep ", Editor Group 1";
  - once a second group opens, the tabs of the first have no group in their names;
  - once a group is added, removed or moved before another one in the grid, the tabs of that other group keep their old group number.

  Each stays until an editor of that group opens or closes or an editor label changes.
- **How found:** live, in round 6: after group 2 was closed, the tab of `one.txt` in the remaining group was still announced as "one.txt, Editor Group 1". One observation is unexplained: right after `workbench.editor.enableTabStacks` was turned off, all four tabs carried the suffix with only one group. It was not reproduced. A possible explanation, unconfirmed: at the time, the FB-16 and FB-18 fixes had `pinEditor` and `doHandleStickyEditorChange` recompute the labels of all tabs but redraw only their own tab, so a pin, an unpin or a preview kept open while a second group existed put the group into the cached labels of the other tabs without showing it there. Once that group closed, the cache kept it, and turning the setting off, which removed every tab stack at the time and now hides them, redraws the accessible name of every tab from the cache (`updateTabStacks`, `multiEditorTabsControl.ts:917-931` in this tree), so all tabs showed it at once. That also let the tabs of one group carry different groups, which `main` never does, since there every recompute of the labels redraws the tabs whose labels changed. So the two methods now redraw every tab whose label changed too (`updateTabLabelsUnlessTabsPending`, see FB-16), and the tabs of one group always carry the same group, stale or not: a pin while two groups exist shows the group on every tab of the group, and once the second group closes, every tab keeps it, as FB-21 describes. The fix below makes the cache follow every change of the groups.
- **Status:** confirmed live in this tree, and confirmed by reading on `main`. Deferred, since it does not block Tab Stacks: the name of the tab stack that the accessible name of a member adds (`redrawTabAriaLabel` in this tree) stays right.
- **Confirming test** (suite `EditorGroupsService`, `src/vs/workbench/services/editor/test/browser/editorGroupsService.test.ts`, next to "groups index / labels"; the `MultiEditorTabsControl` suite mocks the number of groups as 1): with a real part, open `one` in the root group, then:
  1. add a group to the right, and take the accessible name of the tab of `one`: it should be "…, Editor Group 1" but has no group;
  2. open another editor in the root group, which recomputes the labels, add a group to the left of the root group, which makes it group 2, and take the name again: it should be "…, Editor Group 2" but stays "…, Editor Group 1";
  3. remove the two other groups and take the name again: it should have no group but stays "…, Editor Group 1".

  One `assert.deepStrictEqual` over the three names.
- **Suggested fix:** recompute the labels and redraw the accessible names of the tabs when the index or the label of their group changes (`GROUP_INDEX` and `GROUP_LABEL` from `groupView.onDidModelChange`) and when the number of groups changes. `IEditorPartsView` has no event for the number of groups on `main` (`src/vs/workbench/browser/parts/editor/editor.ts:193-209`), while `EditorParts` has `onDidAddGroup` and `onDidRemoveGroup` (`editorParts.ts:685-689`), so the fix exposes one there. `GROUP_INDEX` alone misses a change of the number of groups that keeps the index of the group, such as the close of the second of two groups. Like FB-16 and FB-18, the recompute skips while the tabs have yet to learn of an open or close of editors, and it redraws the tabs whose labels changed (`updateTabLabelsUnlessTabsPending`).
- **PR grouping:** alone, after the pull requests for FB-4 and FB-16, whose `computeTabAriaLabel` and `updateTabLabelsUnlessTabsPending` it reuses.

## FB-22: drop markers on the upper rows of wrapped connected tabs are shorter than on the bottom row

- **Area:** the drop marker of connected Modern UI tabs that wrap: `src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css`, `src/vs/workbench/contrib/modernUI/browser/media/tabs.css` and `src/vs/workbench/contrib/modernUI/browser/media/connectedEditorTabs.css`.
- **Evidence** (at `e5f3c4cdf79`):
  - The drop marker is a pseudo-element of the tab with `top: 0` and `height: 100%` (`multieditortabscontrol.css:574-584`), so it spans the padding box of the tab. The tab has `box-sizing: border-box` (line 121).
  - Wrapped Modern UI tabs are two gutters taller than the tab height, with a transparent border of one gutter (`--vscode-spacing-size20`, 2px) above and below (`tabs.css:89-92`). Connected tabs remove those borders on the bottom row, which joins the document (`.tab:not(.connected-tab-upper-row)`, `connectedEditorTabs.css:118-121`), but keep them on the rows above it, whose pill fill reaches over them (`inset-block`, lines 534-537).
  - So with the default tab height, every marker on an upper row, the one at its end and those between its tabs, is 24px, 4px shorter than its row, while those on the bottom row are 28px, the whole row. Other Modern UI tabs keep the borders on every row, so their markers all have one height.
- **Impact:** cosmetic. The markers of one drag change height from one row to the next, and on an upper row they leave a gutter of the row uncovered above and below. It does not block Tab Stacks: in this tree, the foot of the marker of a drop inside a tab stack sits at the bottom of the marker, on the line of the tab stack indicators of the same row, which also sit at the bottom of the padding box. A tab stack header follows the row it is on: the layout marks the headers of an upper row `connected-tab-upper-row` too (`multiEditorTabsControl.ts:2276-2281` in this tree), and only the rule for a header of the bottom row, `.wrapping .tabs-container > .tab-stack-header:not(.connected-tab-upper-row).drop-target-left::after` in `connectedEditorTabs.css`, lets its marker reach over its gutters, which the tabs of that row do not have.
- **How found:** in round 6, measuring the drop markers of wrapped connected tabs in this tree, which changes none of the rules above for tabs.
- **Status:** seen in this tree, and confirmed by reading on `main`. Deferred, since it does not block Tab Stacks.
- **Confirming test** (suite `MultiEditorTabsControl`, with `connectedGroup` and `layoutConnectedGroup`, which `main` has, and `dispatchDrag` from the pull request for the drag scroll): lay out connected tabs of fixed width that wrap onto two rows, as "only the bottom wrapped row joins the document and upper row resets when unwrapped" does, and drag over the right half of the last tab of the upper row, which shows the drop at the end of that row and at the start of the bottom row. Snapshot the computed `height` of both markers, `getComputedStyle(lastTabOfUpperRow, '::after')` and `getComputedStyle(firstTabOfBottomRow, '::before')`. They differ by 4px, so it fails first.
- **Suggested fix:** let the markers of an upper row reach over its gutters, as its fill does: in `connectedEditorTabs.css`, give `.wrapping .tabs-container > .tab.connected-tab-upper-row.drop-target-left::after` and `.drop-target-right::before` a `top` of minus one gutter and a `height` of `100%` plus two gutters. With Tab Stacks, the rule also covers `.tab-stack-header.connected-tab-upper-row`, and the foot of the marker of a drop inside a tab stack moves up by one gutter, to stay on the line of the tab stack indicators.
- **PR grouping:** alone.

## FB-23: a connected tab with a short name loses its file icon

- **Area:** the file icon of connected Modern UI tabs: `layoutConnectedTabLabels` in `MultiEditorTabsControl` (`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`) and the `connected-tab-narrow` rule in `src/vs/workbench/contrib/modernUI/browser/media/connectedEditorTabs.css`.
- **Evidence** (at `e5f3c4cdf79`):
  - Connected tabs show the extension of a file as the suffix of its label (`multiEditorTabsControl.ts:1831-1836`), so only the rest of the name can ellipsize.
  - `layoutConnectedTabLabels` (lines 2114-2158) takes as the minimum width of a tab the first letter of its name with an ellipsis, its suffix, its badge and its paddings, plus 2px for rounding (lines 2139-2145). It marks the tab `connected-tab-narrow` when the tab is narrower than that minimum plus 22px (line 2154), the width of the file icon with its gap (`.monaco-icon-label::before`, `iconlabel.css:14-21`). `connected-tab-narrow` hides the icon (`connectedEditorTabs.css:432-436`).
  - Modern UI makes a fit tab as wide as its whole label (`tabs.css:189-193`), and a shrink tab grows no wider than that (`max-width: fit-content`, `multieditortabscontrol.css:217-222`). So when the whole name is at most about 2px wider than its first letter with an ellipsis, as `six` is next to `s…` and `git` next to `g…`, the tab is narrower than the minimum plus 22px although it has room to spare, and it loses its icon.
  - The check came with `301c31b679b` (microsoft/vscode#335605), and `main` still has it. In this tree, the only change to `layoutConnectedTabLabels` skips the tabs of a collapsed tab stack, which have no layout to measure (`isTabShown`).
- **Impact:** cosmetic. A tab with a very short name of narrow letters shows no file icon, while the tabs next to it show theirs. It does not block Tab Stacks: it happens in groups without tab stacks too, and the narrow rule leaves the tab stack indicator of a member alone.
- **How found:** in the end-to-end checks of round 8, with connected tabs and the default tab sizing, fit. After Split Editor Right and opening `six.txt`, `seven.txt` and `eight.txt` in the new group, which had no tab stacks, the tab of `six.txt` had `connected-tab-narrow` and no icon. It was 75px wide without the icon, while its `--connected-tab-min-width` was 78px, more than its whole label needed. The same happened to `six.txt` in a tab stack of the first group. The first screenshot of the run still showed the icon. Why is not known, possibly because the layout that sets the class had not run yet.
- **Status:** confirmed live in this tree, and confirmed by reading on `main`. Upstream, microsoft/vscode#338171 (open, `workbench-tabs`) reports it for `git.sh` on 1.139.1, where a commenter reproduced it in a clean profile and traced it to this check. Deferred, since it does not block Tab Stacks.
- **Confirming test** (suite `MultiEditorTabsControl`, `src/vs/workbench/test/browser/parts/editor/multiEditorTabsControl.test.ts`, with `connectedGroup` and `layoutConnectedGroup`, which `main` has, and `createNamedEditor` from the pull request for FB-4): with `tabSizing: 'fit'` and `hasIcons: true`, open `a.txt` and `seventeen.txt`, lay out the group at 1200px, and snapshot whether each tab has `connected-tab-narrow`. A one-letter name is always narrower than that letter with an ellipsis, so the `a.txt` tab has the class in any font, and the test fails first. A second pass with `tabSizing: 'shrink'` covers shrink tabs. By reading, the test of microsoft/vscode#339489 uses names such as `file2.txt`, whose whole name is well wider than `f…`, so it may pass without its fix.
- **Suggested fix:** microsoft/vscode#339489 skips the check for fit tabs (`!tab.classList.contains('sizing-fit')`). By reading, that leaves shrink tabs, which also grow only as wide as their whole label. A fix for both takes the smaller of the whole name and its first letter with an ellipsis as the minimum name width, since a name that fits whole needs no ellipsis, and keeps the 2px rounding allowance from counting a tab that holds its whole label and its icon as narrow.
- **PR grouping:** track microsoft/vscode#339489 rather than open a second pull request. Open one only if it stalls, or, once it merges, for shrink tabs if the test above shows that they still lose the icon. It goes alone, after FB-22.

## Fixed for Tab Stacks only

These bugs exist on `main` and showed up as Tab Stacks symptoms, so this tree fixes them only where tab stacks apply: while tab stacks are on (`isTabStacksEnabled`), or in a group that has a tab stack. With the setting off, VS Code behaves as on `main`. The plain fix, for everyone, stays its own pull request against `main`, after a hand repro. Its plain tests, which add no tab stack, left this tree on 2026-10-15 and are in the fork history before that date (commit `52ed5c95147`). A3 is the exception: it is fixed for everyone, since it is already open upstream.

Line numbers are at `e5f3c4cdf79` unless they say "in this tree".

- **A3: a reveal block stayed set while tabs wrap.** `blockRevealActiveTabOnce()` (`multiEditorTabsControl.ts:2562`) sets a flag that only the non-wrapping layout clears (around line 2433). With `workbench.editor.wrapTabs` on, closing a tab through its close button or a middle click leaves the flag set until wrapping is turned off, and then the next reveal of the active tab is skipped. Tab stack headers set the same flag. Fixed for everyone by also clearing it in the wrapping branch of `doLayoutTabs`. Reproduced by hand in VS Code 1.141.0.
  - **Upstream PR:** open as microsoft/vscode#340548, with its own test that closes a tab with a middle click. This tree carries the same test and comment, so the two merge cleanly. B4 needs it.
- **FB-12: Modern UI tabs that wrapped kept wrapping once they fit on one row again.** `doLayoutTabsWrapping` stops wrapping only if `tabsContainer.offsetHeight === this.tabHeight` (line 2247), which one row of Modern UI tabs never matches, since they are lower when they wrap. Nothing on screen differs on `main`, but the empty space after a tab stack that ends the tabs only shows while the tabs do not wrap, so a drag over such a row never got it. Fix, in a group with a tab stack: stop wrapping once the tabs are on one row and, measured unwrapped, still fit. Test: "in a group with a tab stack, wrapped tabs stop wrapping once they fit on one row again, also as Modern UI tabs" (`MultiEditorTabsControl`), which fails without the fix. Known gap: with pinned tabs on a separate row, the row of pinned tabs can keep wrapping on one row across a band of widths; that row never shows tab stacks.
  - **Upstream PR:** ships in B10. A version for `main` drops the tab stack condition, uses `getLastTab()` where this tree has `getLastShownSlot()`, and brings back the plain tests "wrapped tabs stop wrapping once they fit on one row again, also as Modern UI tabs" and "fit-sized connected tabs settle wrapping on the first layout while the width grows and shrinks".
- **FB-13: a drop marker could stay visible after a drop.** The tabs container's `DragAndDropObserver` (line 487) counts drag enters and leaves, and resets the count only on a drop or drag end that reaches the container. A drop on a tab stops there (`EventHelper.stop`, line 2584), so the count stays one too high, and the next drag that crosses the tabs and drops elsewhere leaves its marker, the class `scroll` and, with Tab Stacks, the empty space after a tab stack behind. Did not reproduce by hand on `main` (2026-10-15). Fix: `DragAndDropObserver.reset()` in `base/browser/dom.ts`, called from a capture-phase drop listener on the tabs container while tab stacks are on. Tests: "after a drop on a tab from outside of the tabs, such as from another group, the next drag of tabs that leaves the tabs takes its drop feedback and the empty space after a tab stack that ends the tabs with it" (`MultiEditorTabsControl`) and "reset ends the drag that a child stops from dropping on the element, so the next drag that enters and leaves the element leaves it" (`dom`).
  - **Upstream PR:** ships in B10. A version for `main` calls `reset()` without the tab stack condition, with a test that checks only the marker and the class `scroll`.
- **FB-14: in the Agents window, a drag over the empty space of the tabs showed no drop marker.** A drop on that space marks the last child of the tabs container (line 1422), which there is the Add Tab control, and the Modern UI rule that hides the marker of the tab before a drop unless it ends a row or is the last child (`tabs.css:623`) also hides it on the last tab. With Tab Stacks, that space is where a drop lands outside of a tab stack that ends the tabs, and only the marker shows it. Not checked by hand, since the Agents window needs a sign-in. Fix, while tab stacks are on: the empty space marks the last tab or tab stack header (`getLastDropSlot`), the slot before a drop with nothing after it gets `drop-target-last`, and the Modern UI rule accepts that class next to `:last-child`. Tests: FB-20's Tab Stacks test fails without the last drop slot, and "the marker of a drop inside a tab stack that ends the tabs stands on a foot that reaches past its last tab into the empty space after the tabs, which the marker of a drop outside of it there does not have" fails without `drop-target-last` (`MultiEditorTabsControl`).
  - **Upstream PR:** ships in B10, with FB-20. A version for `main` drops the tab stack condition and brings back the plain test "a drag over the empty space of the tabs shows the drop after the last tab, also when the Add Tab control follows the tabs".
- **FB-20: in the Agents window, a drag that moved on from a tab over the Add Tab control kept the marker of that tab.** It only shows once FB-14 is fixed, so it does not exist on `main`. A drop on the Add Tab control does nothing, and with Tab Stacks the kept marker can be that of a drop inside a tab stack. Fix, while tab stacks are on: the drag enter handler of the tabs container clears the marker over the Add Tab control. Test: "a drag of tabs that moves on from a drop inside a tab stack that ends the tabs over the Add Tab control shows no drop there, and the empty space after the tab stack, which follows the Add Tab control, shows the drop outside of it" (`MultiEditorTabsControl`).
  - **Upstream PR:** ships in B10 with FB-14.
- **FB-4: with pinned tabs on a separate row, the first tabs of the other row were announced as pinned.** `computeTabLabels` passes the index of the tab in its tabs model (line 1584) to `computeEditorAriaLabel`, which checks `group.isSticky(index ?? input)` on the whole group (`src/vs/workbench/browser/editor.ts:281-282`). So on the row of unpinned tabs, the first N tabs, for N pinned tabs, read ", pinned", and tab stack members sit on that row. Fix, in a group with a tab stack: `computeTabAriaLabel` adds the number of sticky editors on that row. Test: "tabs name their tab stack in their aria label by editor, and none is announced as pinned, when pinned tabs are on a separate row" (`MultiEditorTabsControl`), which fails without the fix.
  - **Upstream PR:** the plain fix and its tests are C3 (`fix-alexjsully-261007-tab-aria-state`). B3 carries the part for tab stacks.
- **FB-16: a tab's accessible name kept its pinned state after a pin change.** The pinned state is part of the cached tab label, which a pin change does not recompute: `doHandleStickyEditorChange` (lines 822-835) redraws with the cached label. A drop into a tab stack unpins the pinned tabs that it moves in, which were then announced as pinned members. Fix, in a group with a tab stack: `doHandleStickyEditorChange` recomputes the labels through `updateTabLabelsUnlessTabsPending`, which skips that while an open or close of editors has yet to reach the tabs. Test: "in a group with a tab stack, a tab is announced as pinned once it is pinned and no longer once a tab stack operation unpins it" (`MultiEditorTabsControl`), which fails without the fix.
  - **Upstream PR:** C3, as FB-4.
- **FB-18: a tab's accessible name kept "preview" once the preview was kept open.** Adding a preview editor to a tab stack pins it, since members are never previews, and `pinEditor` (lines 810-812) redrew the cached label, so the member read "…, preview, in tab stack …". Fix, in a group with a tab stack: `pinEditor` recomputes the labels when the accessible name of the tab changed. Test: "tab stacks - adding a preview editor to a tab stack announces its tab as a member and no longer as a preview" (`EditorGroupsService`).
  - **Upstream PR:** C3, as FB-4.

## Deferred: fixes removed from this tree

These left the tree on 2026-10-15, since Tab Stacks does not need them (see `UPSTREAM-PRS.md`, Track C). Each is prepared on its own branch and waits for a hand repro.

- **C1: the pill-mode sticky mask did not cover the gutter below the pills.** `.sticky-tabs-background` (`src/vs/workbench/contrib/modernUI/browser/media/tabs.css:590-599`) is only one tab height tall, so with compact or shrink pinned tabs scrolled, content shows through the 8px gutter under the pills. It shows only with a non-transparent `modernEditorTab.inactiveBackground`. Fix: `bottom: 0`. Prepared on `alexjsully-fix-pill-mode-sticky`.
- **C2: a drag over the tabs could scroll them up by a pixel.** The class `scroll` (`multiEditorTabsControl.ts:499`) sets `overflow: scroll !important` on both axes (`media/multieditortabscontrol.css:82-84`), although the tabs only scroll sideways. A drag held near the bottom of the tabs leaves the container at `scrollTop` 1, which clips the top pixel of every tab until a tab is clicked. With Tab Stacks, that pixel is the colored top edge of the active member of a tab stack. Fix: `overflow-x: scroll !important`. Prepared on `alexjsully-261006-drag-over-tabs`, with `a2.patch`. Can share a pull request with FB-17.

## Scrapped

These did not reproduce by hand on `main` (2026-10-15), and Tab Stacks no longer needs their fixes since the Open Editors and Explorer drop work left the tree. Their notes, code and tests are in the fork history before that date (commit `52ed5c95147`).

- **A5:** an editor dropped into a group that already has it landed one slot past the drop marker.
- **A10:** editors opened together after a Split in Group editor opened at the start of the group.
- **FB-15:** in the Open Editors view, an editor from another group, or a file that the group had already, landed one slot past the drop.
- **FB-19:** in the Open Editors view, files dropped together landed apart when the group already had a later one of them before the drop.
- **The tab bar version of FB-19:** files dropped together on the tabs landed apart.

## Tab Stacks bugs to check by hand

These may be bugs that Tab Stacks introduced. Each is fixed only if it reproduces by hand in a build of this tree with `"workbench.editor.enableTabStacks": true`, and then right away, since Tab Stacks causes it.

- **A file that the group has already, dropped right before a tab stack from its left, joins it.** Open the files a, b, c and d, each pinned (double-click). Right-click c, choose Add to New Tab Stack, and press Enter; then right-click d and choose Add to Tab Stack... with that tab stack. Drag a from the Explorer onto the right half of the tab b: the drop marker shows before the header, outside of the tab stack. Expected: a lands outside of it, right before the header. Suspected: a lands between c and d and joins the tab stack, since without the scrapped A5 fix it lands one slot past the marker. A drop from the Open Editors view does the same.
- **Escape on a new tab stack leaves a preview pinned.** Single-click a file so that it opens as a preview (italic). Right-click its tab, choose Add to New Tab Stack, and press Escape. Expected: the tab is back to a preview. Suspected: it stays pinned, since the undo snapshot restores the order and the tab stacks but not the preview.
- **Connected tabs with a tab stack at the start of a row.** With Modern UI connected tabs, put the first tabs in a tab stack and check that the rounded left edge of the row looks right (`connectedEditorTabs.css:388, 713, 721` in this tree).
