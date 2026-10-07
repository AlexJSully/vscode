/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce, distinct } from '../../../../base/common/arrays.js';
import { IDraggedResourceEditorInput, LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import { GroupIdentifier } from '../../../common/editor.js';
import { IReadonlyEditorGroupModel, ITabStack, TabStackId } from '../../../common/editor/editorGroupModel.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { StickyEditorGroupModel, UnstickyEditorGroupModel } from '../../../common/editor/filteredEditorGroupModel.js';
import { IEditorResolverService } from '../../../services/editor/common/editorResolverService.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier, findEditorOfDroppedEditor, moveEditorsOfDroppedEditors } from '../../dnd.js';
import { anchorIndexAmongOtherEditors, IEditorGroupsView, IEditorGroupView, isTabStacksEnabled, isWholeTabStack, moveEditorsWithinGroupInOrder, opensEditorBetweenEditorsOfDroppedEditors, removeDroppedEditorsFromTabStacks } from './editor.js';

export type TabsDropSlot =
	| { readonly kind: 'tab'; readonly element: HTMLElement; readonly tabIndex: number }
	| { readonly kind: 'tabStackHeader'; readonly element: HTMLElement; readonly tabStack: TabStackId };

/**
 * What is dragged over the tabs, where `other` covers files, tree items and editor groups.
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
	readonly leftElement: HTMLElement | undefined;
	readonly rightElement: HTMLElement | undefined;
}

/**
 * An edge of a tab stack: its start, right after its header, or its end,
 * right after its last tab.
 */
type TabStackEdge = 'start' | 'end';

/**
 * Where a drop on the tabs lands and the tab stack the dropped editors belong to afterwards.
 */
export interface ITabsDropTarget extends ITabsDropFeedback {

	/**
	 * The index of the tab that the drop inserts before, counted before anything moves.
	 */
	readonly tabIndex: number;

	/**
	 * The edge of an expanded tab stack whose inner side a drop of editors is on, if any.
	 */
	readonly edge?: TabStackEdge;

	/**
	 * The tab stack that dropped editors belong to afterwards: `null` for none, and `undefined`
	 * when where they land decides.
	 */
	readonly tabStack?: TabStackId | null;
}

interface ITabsDropHandlerDelegate {

	/**
	 * The tab of each editor by index, including the tabs of collapsed tab stacks, which are
	 * detached from the tabs container.
	 */
	readonly tabs: readonly HTMLElement[];

	/**
	 * Returns whether the tab is in the tabs container.
	 */
	isTabShown(tab: HTMLElement): boolean;

	getLastShownSlot(): HTMLElement | undefined;
}

/**
 * A tab stack dragged by its header.
 */
export interface IDraggedTabStack {
	readonly groupId: GroupIdentifier;
	readonly tabStackId: TabStackId;
}

/**
 * The tab stacks of the tab bar that a drop on the tabs needs to know about.
 */
export interface ITabsDropHandlerTabStacks {

	/**
	 * Returns the tab stack of the editor when tab stacks are shown.
	 */
	getShownTabStack(editor: EditorInput): ITabStack | undefined;

	findTabStack(tabStackId: TabStackId): ITabStack | undefined;
	findTabStackHeader(tabStackId: TabStackId): HTMLElement | undefined;
	getDraggedTabStack(): IDraggedTabStack | undefined;
}

function getTabDragOverLocation(e: DragEvent, tab: HTMLElement): 'left' | 'right' {
	const rect = tab.getBoundingClientRect();
	const offsetXRelativeToParent = e.clientX - rect.left;

	return offsetXRelativeToParent <= rect.width / 2 ? 'left' : 'right';
}

/**
 * The drop logic of the tabs of a tab bar, aware of tab stacks: where a drag drops, which tabs or
 * headers show it, and which editors of the group the drop moves.
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

	acceptsTabStack(groupId: GroupIdentifier): boolean {
		return groupId === this.groupView.id && isTabStacksEnabled(this.groupsView.partOptions) && !(this.tabsModel instanceof StickyEditorGroupModel);
	}

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
	 * Computes where a drag over a slot, or over the empty space of the tabs without one, drops.
	 * Returns `undefined` for a tab stack header that cannot drop there or would not move.
	 */
	computeTabsDropTarget(e: DragEvent, slot?: TabsDropSlot): ITabsDropTarget | undefined {
		const drag = this.getTabsDrag();
		if (drag.kind === 'tabStack') {
			return this.acceptsTabStack(drag.groupId) ? this.computeTabStackDropTarget(e, drag.tabStackId, slot) : undefined;
		}

		if (!slot) {
			return {
				tabIndex: this.groupTransfer.hasData(DraggedEditorGroupIdentifier.prototype) ? this.groupView.count : this.tabsModel.count,
				tabStack: drag.kind === 'editors' ? this.getTabStackOfDroppedEditors(drag, this.tabsModel.count, undefined) : undefined,
				leftElement: this.delegate.getLastShownSlot(),
				rightElement: undefined
			};
		}

		const isLeft = getTabDragOverLocation(e, slot.element) === 'left';
		if (slot.kind === 'tab') {
			if (isLeft) {
				return this.computeDropTargetBefore(drag, slot.tabIndex, this.isFirstTabOfTabStack(slot.tabIndex) ? 'start' : undefined);
			}

			return this.computeDropTargetBefore(drag, slot.tabIndex + 1, this.isLastTabOfTabStack(slot.tabIndex) ? 'end' : undefined);
		}

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
	 * Computes the drop target before the tab at the index, on the inner side of `edge` if any. Drops
	 * that open editors, such as files, never join a tab stack, so a drop inside one moves after it.
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
	 * Returns the tab stack that editors dropped before the tab at the index belong to afterwards: the
	 * one around the drop or whose edge it is, `null` for none, or `undefined` to let where they land
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

		if (drag.groupId === this.groupView.id && isWholeTabStack(this.tabsModel, drag.editors)) {
			return undefined;
		}

		return tabStackBefore || tabStackAfter ? null : undefined;
	}

	/**
	 * Computes where a dragged tab stack header drops, which is never inside another tab stack or
	 * among the sticky tabs. Returns `undefined` over the tab stack itself and where it would not move.
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
	 * Returns whether a drag over the tab stack is over its first half, by position on one row and by
	 * the order of its header and tabs when they wrap.
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
	 * Returns the tabs or headers on both sides of a drop before the tab at the index.
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

	private getShownTabStackAt(tabIndex: number): ITabStack | undefined {
		const editor = tabIndex >= 0 ? this.tabsModel.getEditorByIndex(tabIndex) : undefined;

		return editor ? this.tabStacks.getShownTabStack(editor) : undefined;
	}

	private isFirstTabOfTabStack(tabIndex: number): boolean {
		const tabStack = this.getShownTabStackAt(tabIndex);

		return !!tabStack && tabStack.editors[0] === this.tabsModel.getEditorByIndex(tabIndex);
	}

	private isLastTabOfTabStack(tabIndex: number): boolean {
		const tabStack = this.getShownTabStackAt(tabIndex);

		return !!tabStack && tabStack.editors[tabStack.editors.length - 1] === this.tabsModel.getEditorByIndex(tabIndex);
	}

	private getFirstTabIndexOfTabStack(tabStack: ITabStack): number {
		return this.tabsModel.indexOf(tabStack.editors[0]);
	}

	private getTabIndexAfterTabStack(tabStack: ITabStack): number {
		return this.tabsModel.indexOf(tabStack.editors[tabStack.editors.length - 1]) + 1;
	}

	/**
	 * Moves editors of this group dropped before the editor at the index together into the tab stack
	 * that the drop decided. Returns `false` where they move one by one instead, such as without tab
	 * stacks.
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
	 * Moves the editors that the group has already for dropped editors together in drop order at the
	 * drop, as a drop of their tabs would. Returns the index to open the dropped editors at.
	 */
	moveDroppedEditorsOfGroup(droppedEditors: readonly IDraggedResourceEditorInput[], dropTarget: ITabsDropTarget, editorIndex: number, sticky?: boolean): number {
		const editorsOfDroppedEditors = droppedEditors.map(droppedEditor => findEditorOfDroppedEditor(this.groupView, droppedEditor, this.editorResolverService));
		const editors = distinct(coalesce(editorsOfDroppedEditors));
		if (editors.length === 0) {
			return editorIndex;
		}

		const tabStack = this.getTabStackOfDroppedEditorsOfGroup(editors, editorsOfDroppedEditors, dropTarget);
		const getIndexAmongOtherEditors = anchorIndexAmongOtherEditors(this.groupView, editors, editorIndex);

		if (this.tabsModel instanceof UnstickyEditorGroupModel || this.isUnstickingTabStackDrop(editorIndex)) {
			for (const editor of editors) {
				this.groupView.unstickEditor(editor);
			}
		}

		const index = getIndexAmongOtherEditors();
		if (this.canMoveEditorsWithinGroup(editors, index)) {
			moveEditorsWithinGroupInOrder(this.groupView, editors, index, tabStack);

			return index;
		}

		const dropIndex = moveEditorsOfDroppedEditors(this.groupView, droppedEditors, editorIndex, this.editorResolverService, sticky);
		removeDroppedEditorsFromTabStacks(this.groupView, editorsOfDroppedEditors);

		return dropIndex;
	}

	/**
	 * Returns the tab stack that the editors of the group for dropped editors belong to afterwards. They
	 * leave their tab stack unless they are all of its editors and no new editor opens between them.
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

		const start = this.groupView.getIndexOfEditor(tabStack.editors[0]);
		this.groupView.moveTabStack(tabStackId, editorIndex > start ? editorIndex - tabStack.editors.length : editorIndex);
	}

	/**
	 * Returns whether sticky editors dropped before the editor at the index are unstuck first, so that
	 * they move together with the others into the tab stack that the drop decides.
	 */
	private isUnstickingTabStackDrop(editorIndex: number, edge?: TabStackEdge): boolean {
		return isTabStacksEnabled(this.groupsView.partOptions)
			&& this.groupView.tabStacks.length > 0
			&& (this.tabsModel instanceof UnstickyEditorGroupModel || (!(this.tabsModel instanceof StickyEditorGroupModel) && (editorIndex > this.groupView.stickyCount || edge === 'start')));
	}

	private canMoveEditorsWithinGroup(editors: readonly EditorInput[], editorIndex: number): boolean {
		return isTabStacksEnabled(this.groupsView.partOptions)
			&& this.groupView.tabStacks.length > 0
			&& !(this.tabsModel instanceof StickyEditorGroupModel)
			&& editorIndex >= this.groupView.stickyCount
			&& editors.every(editor => !this.groupView.isSticky(editor));
	}
}
