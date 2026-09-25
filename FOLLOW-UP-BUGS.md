# Follow-up Bugs

These are existing bugs found while building Tab Stacks (Chrome-style tab grouping). Each is outside that work's scope and none has been fixed yet. Each entry can become its own small pull request.

- **Evidence commit:** line references are to `e5f3c4cdf79` (`main`).
- **Status values:**
  - `Confirmed by reading`: the defect is visible in the code, but no test demonstrates it yet.
  - `Needs repro test`: probably a real defect, but its impact is unproven until a failing test exists.
  - `Confirmed by test`, `PR open`, `Fixed`.
- **Workflow:** write the failing test first, in the suite named in the entry. Then fix, then update the status here.
- **Adding entries:** whenever work on Tab Stacks finds another bug that is out of scope, add it here instead of fixing it in place.
- **Scope:** this file is for the fork and does not belong in the upstream Tab Stacks pull request.

**Suggested PR order** (smallest and safest first): FB-3, FB-5, FB-6, FB-1, FB-2, FB-4.

An upstream search on 2026-09-25 (`gh search issues`) found no existing microsoft/vscode issue for any of them.

## Summary

| ID | Bug | Status |
| --- | --- | --- |
| [FB-1](#fb-1-restored-mru-and-preview-point-at-the-wrong-editors) | Restored MRU and preview point at the wrong editors | Confirmed by reading |
| [FB-2](#fb-2-deserialize-mutates-its-input-and-can-lose-sticky-editors-on-re-apply) | `deserialize` mutates its input and can lose sticky editors on re-apply | Needs repro test |
| [FB-3](#fb-3-the-comment-on-sticky-names-the-wrong-editor) | The comment on `sticky` names the wrong editor | Confirmed by reading |
| [FB-4](#fb-4-unsticky-row-tabs-may-be-announced-as-pinned) | Unsticky-row tabs may be announced as "pinned" | Needs repro test |
| [FB-5](#fb-5-an-out-of-range-move-index-reaches-the-tab-bar) | An out-of-range move index reaches the tab bar | Confirmed by reading; impact needs a test |
| [FB-6](#fb-6-the-transient-event-fires-with-an-index-the-editor-does-not-occupy) | The transient event (`EDITOR_TRANSIENT`) fires with an index the editor does not occupy | Confirmed by reading |

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
- **Tab Stacks interaction:** the shifted preview index can land on a tab stack member. Tab Stacks restores that editor in its stack and restores the group with no preview editor, because members are never previews. Once FB-1 is fixed, that fallback only runs for genuinely inconsistent data.
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

## FB-4: unsticky-row tabs may be announced as "pinned"

- **Area:**
  - `MultiEditorTabsControl.computeTabLabels` (`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts:1577-1584`);
  - `computeEditorAriaLabel` (`src/vs/workbench/browser/editor.ts:275-293`).
- **Evidence:** `computeTabLabels` passes the tab index from `this.tabsModel`, which is a filtered model (`UnstickyEditorGroupModel`) when `workbench.editor.pinnedTabsOnSeparateRow` is on. `computeEditorAriaLabel` then calls `group.isSticky(index)` against the full editor group, which treats the filtered index as a full-model index.
- **Impact (probable):** with pinned tabs on a separate row, the first *N* tabs of the unpinned row (*N* = number of pinned tabs) get the ", pinned" suffix in their accessible names.
- **How found:** by reading the code.
- **Confirming test** (suite `MultiEditorTabsControl`, `src/vs/workbench/test/browser/parts/editor/multiEditorTabsControl.test.ts`): use a group with 2 sticky and 3 unsticky editors under `pinnedTabsOnSeparateRow`, and snapshot the unsticky row's `aria-label`s.
- **Suggested fix:** pass the editor rather than the filtered index, or translate to the full-model index before calling `isSticky`.
- **PR grouping:** alone, with an accessibility label on the upstream PR.

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
