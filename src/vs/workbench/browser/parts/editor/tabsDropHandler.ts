/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce, distinct } from '../../../../base/common/arrays.js';
import { IDraggedResourceEditorInput, LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import { EditorsOrder, GroupIdentifier } from '../../../common/editor.js';
import { IReadonlyEditorGroupModel, ITabStack, TabStackId } from '../../../common/editor/editorGroupModel.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { StickyEditorGroupModel, UnstickyEditorGroupModel } from '../../../common/editor/filteredEditorGroupModel.js';
import { IEditorResolverService } from '../../../services/editor/common/editorResolverService.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier, findEditorOfDroppedEditor, moveEditorsOfDroppedEditors } from '../../dnd.js';
import { IEditorGroupsView, IEditorGroupView, isTabStacksEnabled, isWholeTabStack, opensEditorBetweenEditorsOfDroppedEditors } from './editor.js';

/**
 * A tab or a tab stack header that a drag is over.
 */
export type TabsDropSlot =
	| { readonly kind: 'tab'; readonly element: HTMLElement; readonly tabIndex: number }
	| { readonly kind: 'tabStackHeader'; readonly element: HTMLElement; readonly tabStack: TabStackId };

/**
 * What is dragged over the tabs: the header of a tab stack, editors of a
 * group, or anything else, such as files, tree items or an editor group.
 */
type TabsDrag =
	| { readonly kind: 'tabStack'; readonly groupId: GroupIdentifier; readonly tabStackId: TabStackId }
	| { readonly kind: 'editors'; readonly groupId: GroupIdentifier; readonly editors: readonly EditorInput[] }
	| { readonly kind: 'other' };

/**
 * The tabs or tab stack headers on both sides of where a drag drops, which
 * show the drop.
 */
interface ITabsDropFeedback {

	/**
	 * The tab or tab stack header before the drop position, if any, which is
	 * the last one shown for a drop on the empty space of the tabs.
	 */
	readonly leftElement: HTMLElement | undefined;

	/**
	 * The tab or tab stack header after the drop position, if any.
	 */
	readonly rightElement: HTMLElement | undefined;
}

/**
 * An edge of a tab stack: its start, right after its header, or its end,
 * right after its last tab.
 */
type TabStackEdge = 'start' | 'end';

/**
 * Where a drag over the tabs drops, and the drop feedback that shows it.
 */
export interface ITabsDropTarget extends ITabsDropFeedback {

	/**
	 * The index of the tab that the drop inserts before, counted before anything
	 * moves. An editor group dropped after the last tab gets the number of
	 * editors of the group.
	 */
	readonly tabIndex: number;

	/**
	 * The edge of an expanded tab stack that a drop of editors is on the inner
	 * side of, if any: the start for the right half of its header or the left
	 * half of its first tab, and the end for the right half of its last tab.
	 * A drop of anything else, such as files, is never on the inner side of an
	 * edge, since the editors that it opens never join a tab stack.
	 */
	readonly edge?: TabStackEdge;

	/**
	 * The tab stack that dropped editors belong to afterwards: `null` for
	 * none, and `undefined` when where they land decides. Editors, of this
	 * group or another one, belong to a tab stack afterwards when dropped
	 * between its tabs or on the inner side of one of its edges, and the drop
	 * feedback then shows a drop inside of it.
	 */
	readonly tabStack?: TabStackId | null;
}

/**
 * The tabs of a tab bar, as the drop logic of the tabs reads them.
 */
interface ITabsDropHandlerDelegate {

	/**
	 * The tab of each editor by index, including the tabs of collapsed tab
	 * stacks, which are detached from the tabs container.
	 */
	readonly tabs: readonly HTMLElement[];

	/**
	 * Returns whether the tab is in the tabs container.
	 */
	isTabShown(tab: HTMLElement): boolean;

	/**
	 * Returns the last tab or tab stack header in the tabs container.
	 */
	getLastShownSlot(): HTMLElement | undefined;
}

/**
 * The tab stack whose header is dragged.
 */
export interface IDraggedTabStack {

	/**
	 * The group of the tab stack, whose tabs are the only ones that take it.
	 */
	readonly groupId: GroupIdentifier;

	/**
	 * The id of the tab stack.
	 */
	readonly tabStackId: TabStackId;
}

/**
 * The tab stacks of a tab bar, as the drop logic of the tabs reads them.
 */
export interface ITabsDropHandlerTabStacks {

	/**
	 * Returns the tab stack of the editor when tab stacks are shown.
	 */
	getShownTabStack(editor: EditorInput): ITabStack | undefined;

	/**
	 * Returns the tab stack of the group with the id, if any.
	 */
	findTabStack(tabStackId: TabStackId): ITabStack | undefined;

	/**
	 * Returns the header of the tab stack with the id, if it has one.
	 */
	findTabStackHeader(tabStackId: TabStackId): HTMLElement | undefined;

	/**
	 * Returns the tab stack whose header is dragged, if any.
	 */
	getDraggedTabStack(): IDraggedTabStack | undefined;
}

/**
 * Returns which half of the tab or tab stack header a drag is over.
 */
function getTabDragOverLocation(e: DragEvent, tab: HTMLElement): 'left' | 'right' {
	const rect = tab.getBoundingClientRect();
	const offsetXRelativeToParent = e.clientX - rect.left;

	return offsetXRelativeToParent <= rect.width / 2 ? 'left' : 'right';
}

/**
 * The drop logic of the tabs of a tab bar, aware of tab stacks: it tells
 * what a drag carries, computes where a drag over a tab, a tab stack header
 * or the empty space of the tabs drops and which tabs or headers show the
 * drop, and moves the editors of the group that a drop needs to move.
 */
export class TabsDropHandler {

	private readonly editorTransfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
	private readonly groupTransfer = LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>();

	constructor(
		private readonly groupView: IEditorGroupView,
		private readonly groupsView: IEditorGroupsView,
		private readonly tabsModel: IReadonlyEditorGroupModel,
		private readonly delegate: ITabsDropHandlerDelegate,
		private readonly tabStacks: ITabsDropHandlerTabStacks,
		private readonly editorResolverService: IEditorResolverService
	) { }

	/**
	 * Returns whether a tab stack header of the group can drop on these tabs,
	 * which it can only on the tabs of its group that show tab stacks.
	 */
	acceptsTabStack(groupId: GroupIdentifier): boolean {
		return groupId === this.groupView.id && isTabStacksEnabled(this.groupsView.partOptions) && !(this.tabsModel instanceof StickyEditorGroupModel);
	}

	/**
	 * Returns what is dragged, as far as the tabs tell drags apart.
	 */
	getTabsDrag(): TabsDrag {
		const draggedTabStack = this.tabStacks.getDraggedTabStack();
		if (draggedTabStack) {
			return { kind: 'tabStack', groupId: draggedTabStack.groupId, tabStackId: draggedTabStack.tabStackId };
		}

		const draggedEditors = this.editorTransfer.getData(DraggedEditorIdentifier.prototype) ?? [];
		if (draggedEditors.length > 0) {
			return { kind: 'editors', groupId: draggedEditors[0].identifier.groupId, editors: draggedEditors.map(draggedEditor => draggedEditor.identifier.editor) };
		}

		return { kind: 'other' };
	}

	/**
	 * Computes where a drag over a tab, over a tab stack header or, without a
	 * slot, over the empty space of the tabs drops. Returns `undefined` for a
	 * tab stack header that cannot drop there or would not move.
	 */
	computeTabsDropTarget(e: DragEvent, slot?: TabsDropSlot): ITabsDropTarget | undefined {
		const drag = this.getTabsDrag();
		if (drag.kind === 'tabStack') {
			return this.acceptsTabStack(drag.groupId) ? this.computeTabStackDropTarget(e, drag.tabStackId, slot) : undefined;
		}

		// After the last tab, which is outside of any tab stack
		if (!slot) {
			return {
				tabIndex: this.groupTransfer.hasData(DraggedEditorGroupIdentifier.prototype) ? this.groupView.count : this.tabsModel.count,
				tabStack: drag.kind === 'editors' ? this.getTabStackOfDroppedEditors(drag, this.tabsModel.count, undefined) : undefined,
				leftElement: this.delegate.getLastShownSlot(),
				rightElement: undefined
			};
		}

		// The left half of the first tab of a tab stack and the right half of its last tab are on the inner side of its edges
		const isLeft = getTabDragOverLocation(e, slot.element) === 'left';
		if (slot.kind === 'tab') {
			if (isLeft) {
				return this.computeDropTargetBefore(drag, slot.tabIndex, this.isFirstTabOfTabStack(slot.tabIndex) ? 'start' : undefined);
			}

			return this.computeDropTargetBefore(drag, slot.tabIndex + 1, this.isLastTabOfTabStack(slot.tabIndex) ? 'end' : undefined);
		}

		// The right half of a header is the start slot of an expanded tab stack, or after a collapsed one
		const tabStack = this.tabStacks.findTabStack(slot.tabStack);
		if (!tabStack) {
			return undefined;
		}

		if (isLeft || !tabStack.collapsed) {
			return this.computeDropTargetBefore(drag, this.getFirstTabIndexOfTabStack(tabStack), isLeft ? undefined : 'start');
		}

		return this.computeDropTargetBefore(drag, this.getTabIndexAfterTabStack(tabStack), undefined);
	}

	/**
	 * Computes the drop target of editors, or of anything else that opens
	 * editors, before the tab at the index and on the inner side of the edge
	 * of a tab stack there, if any. Editors that open, such as files, never
	 * join a tab stack, so a drop between the tabs of a tab stack moves after
	 * it, and one on the inner side of its edges is outside of it.
	 */
	private computeDropTargetBefore(drag: TabsDrag, tabIndex: number, edge: TabStackEdge | undefined): ITabsDropTarget {
		if (drag.kind !== 'editors') {
			const tabStackBefore = this.getShownTabStackAt(tabIndex - 1);
			if (tabStackBefore && tabStackBefore.id === this.getShownTabStackAt(tabIndex)?.id) {
				tabIndex = this.getTabIndexAfterTabStack(tabStackBefore);
			}

			return { tabIndex, ...this.getDropFeedback(tabIndex, undefined) };
		}

		return { tabIndex, edge, tabStack: this.getTabStackOfDroppedEditors(drag, tabIndex, edge), ...this.getDropFeedback(tabIndex, edge) };
	}

	/**
	 * Returns the tab stack that editors dropped before the tab at the index,
	 * on the inner side of the edge of a tab stack there, if any, belong to
	 * afterwards: the tab stack whose tabs are on both sides of the drop or
	 * whose edge it is, `null` for none, or `undefined` to let where they land
	 * decide.
	 */
	private getTabStackOfDroppedEditors(drag: Extract<TabsDrag, { kind: 'editors' }>, tabIndex: number, edge: TabStackEdge | undefined): TabStackId | null | undefined {
		const tabStackBefore = this.getShownTabStackAt(tabIndex - 1);
		const tabStackAfter = this.getShownTabStackAt(tabIndex);
		if (edge === 'start') {
			return tabStackAfter?.id;
		}

		if (edge === 'end' || (tabStackBefore && tabStackBefore.id === tabStackAfter?.id)) {
			return tabStackBefore?.id;
		}

		// A whole tab stack moves as one, as when its header is dragged
		if (drag.groupId === this.groupView.id && isWholeTabStack(this.tabsModel, drag.editors)) {
			return undefined;
		}

		return tabStackBefore || tabStackAfter ? null : undefined;
	}

	/**
	 * Computes where a dragged tab stack header drops: before or after another
	 * tab stack, depending on which half of that tab stack the drag is over,
	 * after the sticky tabs, next to any other tab, or after the last tab.
	 * Returns `undefined` over the tab stack itself and where it would not move.
	 */
	private computeTabStackDropTarget(e: DragEvent, tabStackId: TabStackId, slot: TabsDropSlot | undefined): ITabsDropTarget | undefined {
		const tabStack = this.tabStacks.findTabStack(tabStackId);
		if (!tabStack) {
			return undefined;
		}

		let tabIndex = this.tabsModel.count;
		if (slot) {
			const otherTabStack = slot.kind === 'tabStackHeader' ? this.tabStacks.findTabStack(slot.tabStack) : this.getShownTabStackAt(slot.tabIndex);
			if (otherTabStack) {
				tabIndex = this.isBeforeMiddleOfTabStack(e, slot.element, otherTabStack) ? this.getFirstTabIndexOfTabStack(otherTabStack) : this.getTabIndexAfterTabStack(otherTabStack);
			} else if (slot.kind === 'tabStackHeader') {
				return undefined;
			} else if (this.tabsModel.isSticky(slot.tabIndex)) {
				tabIndex = this.tabsModel.stickyCount;
			} else {
				tabIndex = getTabDragOverLocation(e, slot.element) === 'left' ? slot.tabIndex : slot.tabIndex + 1;
			}
		}

		const start = this.getFirstTabIndexOfTabStack(tabStack);
		if (tabIndex >= start && tabIndex <= start + tabStack.editors.length) {
			return undefined;
		}

		return { tabIndex, ...this.getDropFeedback(tabIndex, undefined) };
	}

	/**
	 * Returns whether a drag over the header or a tab of the tab stack is over
	 * its first half: by position on one row, and by the order of its header and
	 * shown tabs when they wrap onto more rows.
	 */
	private isBeforeMiddleOfTabStack(e: DragEvent, element: HTMLElement, tabStack: ITabStack): boolean {
		const header = this.tabStacks.findTabStackHeader(tabStack.id);
		if (!header) {
			return true;
		}

		const slots = [header, ...this.delegate.tabs.slice(this.getFirstTabIndexOfTabStack(tabStack), this.getTabIndexAfterTabStack(tabStack)).filter(tab => this.delegate.isTabShown(tab))];
		const lastSlot = slots[slots.length - 1];
		const index = slots.indexOf(element);
		if (header.offsetTop === lastSlot.offsetTop || index < 0) {
			return e.clientX < (header.getBoundingClientRect().left + lastSlot.getBoundingClientRect().right) / 2;
		}

		const middle = (slots.length - 1) / 2;

		return index < middle || (index === middle && getTabDragOverLocation(e, element) === 'left');
	}

	/**
	 * Returns the tabs or tab stack headers on both sides of a drop before the
	 * tab at the index and on the inner side of the edge of a tab stack there,
	 * if any. Before the first tab of a tab stack, that is before its header
	 * unless the drop is on its start, and after the tabs of a collapsed tab
	 * stack, that is after its header.
	 */
	private getDropFeedback(tabIndex: number, edge: TabStackEdge | undefined): ITabsDropFeedback {
		const tabStackAfter = this.getShownTabStackAt(tabIndex);
		const headerAfter = tabStackAfter ? this.tabStacks.findTabStackHeader(tabStackAfter.id) : undefined;
		const tabAfter = this.delegate.tabs.at(tabIndex);
		if (edge === 'start') {
			return { leftElement: headerAfter, rightElement: tabAfter };
		}

		const tabStackBefore = this.getShownTabStackAt(tabIndex - 1);
		const tabBefore = tabIndex > 0 ? this.delegate.tabs.at(tabIndex - 1) : undefined;

		return {
			leftElement: tabBefore && !this.delegate.isTabShown(tabBefore) && tabStackBefore ? this.tabStacks.findTabStackHeader(tabStackBefore.id) : tabBefore,
			rightElement: tabStackAfter && this.isFirstTabOfTabStack(tabIndex) ? headerAfter : tabAfter
		};
	}

	/**
	 * Returns the shown tab stack of the editor of the tab at the index.
	 */
	private getShownTabStackAt(tabIndex: number): ITabStack | undefined {
		const editor = tabIndex >= 0 ? this.tabsModel.getEditorByIndex(tabIndex) : undefined;

		return editor ? this.tabStacks.getShownTabStack(editor) : undefined;
	}

	/**
	 * Returns whether the tab at the index is the first tab of a shown tab
	 * stack.
	 */
	private isFirstTabOfTabStack(tabIndex: number): boolean {
		const tabStack = this.getShownTabStackAt(tabIndex);

		return !!tabStack && tabStack.editors[0] === this.tabsModel.getEditorByIndex(tabIndex);
	}

	/**
	 * Returns whether the tab at the index is the last tab of a shown tab
	 * stack.
	 */
	private isLastTabOfTabStack(tabIndex: number): boolean {
		const tabStack = this.getShownTabStackAt(tabIndex);

		return !!tabStack && tabStack.editors[tabStack.editors.length - 1] === this.tabsModel.getEditorByIndex(tabIndex);
	}

	/**
	 * Returns the index of the first tab of the tab stack.
	 */
	private getFirstTabIndexOfTabStack(tabStack: ITabStack): number {
		return this.tabsModel.indexOf(tabStack.editors[0]);
	}

	/**
	 * Returns the index of the tab right after the tabs of the tab stack.
	 */
	private getTabIndexAfterTabStack(tabStack: ITabStack): number {
		return this.tabsModel.indexOf(tabStack.editors[tabStack.editors.length - 1]) + 1;
	}

	/**
	 * Moves editors of this group dropped before the editor at the index,
	 * counted before anything moves, together into the tab stack that the drop
	 * decided, after unsticking them where the drop unsticks them. Returns
	 * whether they moved, which they do not where they move one by one
	 * instead, such as without tab stacks or on or among the sticky tabs.
	 */
	moveEditorsOfGroupTogether(editors: readonly EditorInput[], dropTarget: ITabsDropTarget, editorIndex: number): boolean {
		if (this.isUnstickingTabStackDrop(editorIndex, dropTarget.edge)) {
			for (const editor of editors) {
				this.groupView.unstickEditor(editor);
			}
		}

		if (!this.canMoveEditorsWithinGroup(editors, editorIndex)) {
			return false;
		}

		const editorsBefore = editors.filter(editor => {
			const index = this.groupView.getIndexOfEditor(editor);
			return index >= 0 && index < editorIndex;
		});
		this.groupView.moveEditorsWithinGroup(editors, editorIndex - editorsBefore.length, dropTarget.tabStack);

		return true;
	}

	/**
	 * Moves the editors that the group has already for dropped editors, such as
	 * files, next to each other in drop order to the drop before the editor at
	 * the index, counted before anything moves, the way a drop of their tabs
	 * moves them. Returns the index to open the dropped editors at: the group
	 * opens the first of them at that index and the others after it, so that
	 * the editors that it does not have yet open between them in drop order.
	 * Otherwise, such as without tab stacks, on or among the sticky tabs, or
	 * with sticky editors that stay sticky, the group moves the first dropped
	 * editor itself when it opens it.
	 *
	 * @param sticky whether the dropped editors open as pinned tabs.
	 */
	moveDroppedEditorsOfGroup(droppedEditors: readonly IDraggedResourceEditorInput[], dropTarget: ITabsDropTarget, editorIndex: number, sticky?: boolean): number {
		const editorsOfDroppedEditors = droppedEditors.map(droppedEditor => findEditorOfDroppedEditor(this.groupView, droppedEditor, this.editorResolverService));
		const editors = distinct(coalesce(editorsOfDroppedEditors));
		if (editors.length === 0) {
			return editorIndex;
		}

		const tabStack = this.getTabStackOfDroppedEditorsOfGroup(editors, editorsOfDroppedEditors, dropTarget);

		// The editors land before the first other editor at or after the index, which unpinning editors does not move
		const editorAfter = this.groupView.getEditors(EditorsOrder.SEQUENTIAL).slice(editorIndex).find(editor => !editors.includes(editor));

		// Sticky editors dropped on the other tabs are unstuck: always on the row of the other tabs,
		// and otherwise where a drop of their tabs unsticks them too
		if (this.tabsModel instanceof UnstickyEditorGroupModel || this.isUnstickingTabStackDrop(editorIndex)) {
			for (const editor of editors) {
				this.groupView.unstickEditor(editor);
			}
		}

		const otherEditors = this.groupView.getEditors(EditorsOrder.SEQUENTIAL).filter(editor => !editors.includes(editor));
		const index = editorAfter ? otherEditors.indexOf(editorAfter) : otherEditors.length;
		if (this.canMoveEditorsWithinGroup(editors, index)) {
			this.groupView.moveEditorsWithinGroup(editors, index, tabStack);

			// Editors move in the order of their tabs, and moving them into drop order within their run keeps their tab stack
			for (const [offset, editor] of editors.entries()) {
				if (this.groupView.getIndexOfEditor(editor) !== index + offset) {
					this.groupView.moveEditorsWithinGroup([editor], index + offset);
				}
			}

			return index;
		}

		// Otherwise the editors move one at a time before the same editor, which unsticking editors does not move
		return moveEditorsOfDroppedEditors(this.groupView, droppedEditors, editorIndex, this.editorResolverService, sticky);
	}

	/**
	 * Returns the tab stack that the editors of the group for dropped editors
	 * belong to afterwards, as for a drop of their tabs outside of tab stacks,
	 * from the tabs before anything moves. The drop of editors that open, such
	 * as files, is always outside of tab stacks, so the editors leave their tab
	 * stack unless they are all of its editors, which move as one. Editors
	 * that the group does not have yet open outside of tab stacks, so the
	 * editors also leave their tab stack where one of those opens between
	 * them.
	 *
	 * @param editorsOfDroppedEditors the editor of the group for each dropped
	 * editor in drop order, if the group has it already.
	 */
	private getTabStackOfDroppedEditorsOfGroup(editors: readonly EditorInput[], editorsOfDroppedEditors: readonly (EditorInput | undefined)[], dropTarget: ITabsDropTarget): TabStackId | null | undefined {
		const tabStack = this.getTabStackOfDroppedEditors({ kind: 'editors', groupId: this.groupView.id, editors }, dropTarget.tabIndex, undefined);

		return tabStack !== null && opensEditorBetweenEditorsOfDroppedEditors(editorsOfDroppedEditors) ? null : tabStack;
	}

	/**
	 * Moves a tab stack to right before the editor at the index of the group,
	 * counted before the move, or to the end for the number of editors.
	 */
	moveTabStackBefore(tabStackId: TabStackId, editorIndex: number): void {
		const tabStack = this.tabStacks.findTabStack(tabStackId);
		if (!tabStack) {
			return;
		}

		// The group takes the index of the first editor of the tab stack after the move
		const start = this.groupView.getIndexOfEditor(tabStack.editors[0]);
		this.groupView.moveTabStack(tabStackId, editorIndex > start ? editorIndex - tabStack.editors.length : editorIndex);
	}

	/**
	 * Returns whether sticky editors of this group dropped before the editor at
	 * the index, on the inner side of the edge of a tab stack there, if any, are
	 * unstuck before they move, so that they move together with the others
	 * into the tab stack that the drop decides: while the group shows tab
	 * stacks, on the row of the other tabs, and on a single row past the slot
	 * right after the sticky tabs or on the start slot of a tab stack there.
	 */
	private isUnstickingTabStackDrop(editorIndex: number, edge?: TabStackEdge): boolean {
		return isTabStacksEnabled(this.groupsView.partOptions)
			&& this.groupView.tabStacks.length > 0
			&& (this.tabsModel instanceof UnstickyEditorGroupModel || (!(this.tabsModel instanceof StickyEditorGroupModel) && (editorIndex > this.groupView.stickyCount || edge === 'start')));
	}

	/**
	 * Returns whether editors of this group dropped before the editor at the
	 * index move together, which they do while the group shows tab stacks,
	 * unless the drop is on or among the sticky editors or moves one of them.
	 */
	private canMoveEditorsWithinGroup(editors: readonly EditorInput[], editorIndex: number): boolean {
		return isTabStacksEnabled(this.groupsView.partOptions)
			&& this.groupView.tabStacks.length > 0
			&& !(this.tabsModel instanceof StickyEditorGroupModel)
			&& editorIndex >= this.groupView.stickyCount
			&& editors.every(editor => !this.groupView.isSticky(editor));
	}
}
