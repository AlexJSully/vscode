/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../base/common/event.js';
import { IEditorFactoryRegistry, GroupIdentifier, EditorsOrder, EditorExtensions, IUntypedEditorInput, SideBySideEditor, EditorCloseContext, IMatchEditorOptions, GroupModelChangeKind } from '../editor.js';
import { EditorInput } from './editorInput.js';
import { SideBySideEditorInput } from './sideBySideEditorInput.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { dispose, Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { coalesce } from '../../../base/common/arrays.js';
import { Color } from '../../../base/common/color.js';
import { generateUuid } from '../../../base/common/uuid.js';

const EditorOpenPositioning = {
	LEFT: 'left',
	RIGHT: 'right',
	FIRST: 'first',
	LAST: 'last'
};

/**
 * Identifies a tab stack within its editor group. Identifiers are not kept
 * across restarts.
 */
export type TabStackId = string;

/**
 * The preset colors of tab stacks. A new tab stack gets the least used one, the earliest on ties.
 */
export const TAB_STACK_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'cyan', 'gray'] as const;

export type TabStackPresetColor = typeof TAB_STACK_COLORS[number];

/**
 * The color of a tab stack: a preset, or a custom color written as a
 * lowercase `#rrggbb` string that looks the same in every theme.
 */
export type TabStackColor = TabStackPresetColor | `#${string}`;

function isTabStackPresetColor(value: string): value is TabStackPresetColor {
	return (TAB_STACK_COLORS as readonly string[]).includes(value);
}

/**
 * Returns whether the color is a custom hex color rather than a preset.
 */
export function isCustomTabStackColor(color: TabStackColor): color is `#${string}` {
	return !isTabStackPresetColor(color);
}

/**
 * Returns the tab stack color that the value describes: a preset name, or a `#rgb` or `#rrggbb`
 * hex color normalized to lowercase `#rrggbb`.
 */
export function parseTabStackColor(value: unknown): TabStackColor | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	if (isTabStackPresetColor(value)) {
		return value;
	}

	if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
		return undefined;
	}

	const color = Color.Format.CSS.parseHex(value);

	return color ? Color.Format.CSS.formatHex(color) as TabStackColor : undefined;
}

/**
 * A snapshot of a tab stack: a named, colored run of adjacent editors in an
 * editor group whose editors can be hidden by collapsing it.
 */
export interface ITabStack {

	readonly id: TabStackId;

	/**
	 * The name of the tab stack, empty when it has no name.
	 */
	readonly label: string;

	readonly color: TabStackColor;

	/**
	 * Whether the editors of the tab stack are hidden. The tab stack of the
	 * active editor is never collapsed.
	 */
	readonly collapsed: boolean;

	/**
	 * The editors of the tab stack in sequential order. There is at least one,
	 * they are adjacent in the group, and none of them is sticky or a preview.
	 */
	readonly editors: readonly EditorInput[];
}

/**
 * Changes to the name, color or collapsed state of a tab stack.
 */
export interface ITabStackUpdate {

	/**
	 * An empty string removes the name.
	 */
	readonly label?: string;

	/**
	 * A value that {@link parseTabStackColor} rejects is ignored.
	 */
	readonly color?: TabStackColor;

	readonly collapsed?: boolean;
}

/**
 * A single move of an editor within its group, with indices that are valid at
 * the time of the move.
 */
export interface ITabStackEditorMove {
	readonly editor: EditorInput;
	readonly from: number;
	readonly to: number;
}

/**
 * What an explicit tab stack operation did to the editors of the group.
 */
export interface ITabStackOperationResult {

	/**
	 * The moves in the order they happened. Replaying them one after the
	 * other on the previous order of editors gives the new order.
	 */
	readonly moves: readonly ITabStackEditorMove[];

	/**
	 * The preview editors that were pinned because they joined a tab stack.
	 */
	readonly pinned: readonly EditorInput[];
}

/**
 * The result of adding editors to a tab stack, with the tab stack they are in afterwards.
 */
export interface IAddEditorsToTabStackResult extends ITabStackOperationResult {
	readonly tabStack: ITabStack | undefined;
}

/**
 * A tab stack without its identity, used to hide tab stacks and to add them to
 * another editor group.
 */
export interface ITabStackRecord {
	readonly editors: readonly EditorInput[];
	readonly label: string;
	readonly color: TabStackColor;
	readonly collapsed: boolean;
}

/**
 * The order of the editors of a group with their tab stacks, which {@link EditorGroupModel.restoreTabStackSnapshot} restores.
 */
export interface ITabStackUndoSnapshot {
	readonly editors: readonly EditorInput[];
	readonly tabStackOfEditor: ReadonlyMap<EditorInput, TabStackId>;
	readonly tabStackStates: ReadonlyMap<TabStackId, { readonly label: string; readonly color: TabStackColor; readonly collapsed: boolean }>;
}

interface ITabStackState {
	label: string;
	color: TabStackColor;
	collapsed: boolean;
	size: number;
}

interface ITabStacksSnapshot {
	readonly list: readonly ITabStack[];
	readonly byId: ReadonlyMap<TabStackId, ITabStack>;
}

interface ISerializedTabStack {
	readonly label: string;
	readonly color: string;
	readonly collapsed?: true;
	readonly editors: number[]; // indices into `ISerializedEditorGroupModel.editors`
}

export interface IEditorOpenOptions {
	readonly pinned?: boolean;
	readonly sticky?: boolean;
	readonly transient?: boolean;
	active?: boolean;
	readonly inactiveSelection?: EditorInput[];
	readonly index?: number;
	readonly supportSideBySide?: SideBySideEditor.ANY | SideBySideEditor.BOTH;

	/**
	 * The tab stack a new editor joins when one of its editors is next to the index, unless the
	 * editor opens sticky. Otherwise a new editor joins no tab stack and never opens inside one.
	 */
	readonly tabStack?: TabStackId;
}

export interface IEditorOpenResult {
	readonly editor: EditorInput;
	readonly isNew: boolean;
}

export interface ISerializedEditorInput {
	readonly id: string;
	readonly value: string;
}

export interface ISerializedEditorGroupModel {
	readonly id: number;
	readonly locked?: boolean;
	readonly editors: ISerializedEditorInput[];
	readonly mru: number[];
	readonly preview?: number;
	sticky?: number;
	readonly tabStacks?: ISerializedTabStack[];
}

export function isSerializedEditorGroupModel(group?: unknown): group is ISerializedEditorGroupModel {
	const candidate = group as ISerializedEditorGroupModel | undefined;

	return !!(candidate && typeof candidate === 'object' && Array.isArray(candidate.editors) && Array.isArray(candidate.mru));
}

export interface IGroupModelChangeEvent {

	/**
	 * The kind of change that occurred in the group model.
	 */
	readonly kind: GroupModelChangeKind;

	/**
	 * Only applies when editors change providing
	 * access to the editor the event is about.
	 */
	readonly editor?: EditorInput;

	/**
	 * Only applies when editors change providing
	 * access to the index of the editor the event
	 * is about.
	 */
	readonly editorIndex?: number;
}

export interface IGroupEditorChangeEvent extends IGroupModelChangeEvent {
	readonly editor: EditorInput;
	readonly editorIndex: number;
}

export function isGroupEditorChangeEvent(e: IGroupModelChangeEvent): e is IGroupEditorChangeEvent {
	const candidate = e as IGroupEditorOpenEvent;

	return candidate.editor && candidate.editorIndex !== undefined;
}

export interface IGroupEditorOpenEvent extends IGroupEditorChangeEvent {

	readonly kind: GroupModelChangeKind.EDITOR_OPEN;
}

export function isGroupEditorOpenEvent(e: IGroupModelChangeEvent): e is IGroupEditorOpenEvent {
	const candidate = e as IGroupEditorOpenEvent;

	return candidate.kind === GroupModelChangeKind.EDITOR_OPEN && candidate.editorIndex !== undefined;
}

export interface IGroupEditorMoveEvent extends IGroupEditorChangeEvent {

	readonly kind: GroupModelChangeKind.EDITOR_MOVE;

	/**
	 * Signifies the index the editor is moving from.
	 * `editorIndex` will contain the index the editor
	 * is moving to.
	 */
	readonly oldEditorIndex: number;
}

export function isGroupEditorMoveEvent(e: IGroupModelChangeEvent): e is IGroupEditorMoveEvent {
	const candidate = e as IGroupEditorMoveEvent;

	return candidate.kind === GroupModelChangeKind.EDITOR_MOVE && candidate.editorIndex !== undefined && candidate.oldEditorIndex !== undefined;
}

export interface IGroupEditorCloseEvent extends IGroupEditorChangeEvent {

	readonly kind: GroupModelChangeKind.EDITOR_CLOSE;

	/**
	 * Signifies the context in which the editor
	 * is being closed. This allows for understanding
	 * if a replace or reopen is occurring
	 */
	readonly context: EditorCloseContext;

	/**
	 * Signifies whether or not the closed editor was
	 * sticky. This is necessary becasue state is lost
	 * after closing.
	 */
	readonly sticky: boolean;
}

export function isGroupEditorCloseEvent(e: IGroupModelChangeEvent): e is IGroupEditorCloseEvent {
	const candidate = e as IGroupEditorCloseEvent;

	return candidate.kind === GroupModelChangeKind.EDITOR_CLOSE && candidate.editorIndex !== undefined && candidate.context !== undefined && candidate.sticky !== undefined;
}

interface IEditorCloseResult {
	readonly editor: EditorInput;
	readonly context: EditorCloseContext;
	readonly editorIndex: number;
	readonly sticky: boolean;
}

export interface IReadonlyEditorGroupModel {

	readonly onDidModelChange: Event<IGroupModelChangeEvent>;

	readonly id: GroupIdentifier;
	readonly count: number;
	readonly stickyCount: number;
	readonly isLocked: boolean;
	readonly activeEditor: EditorInput | null;
	readonly previewEditor: EditorInput | null;
	readonly selectedEditors: EditorInput[];

	getEditors(order: EditorsOrder, options?: { excludeSticky?: boolean }): EditorInput[];
	getEditorByIndex(index: number): EditorInput | undefined;
	indexOf(editor: EditorInput | IUntypedEditorInput | null, editors?: EditorInput[], options?: IMatchEditorOptions): number;
	isActive(editor: EditorInput | IUntypedEditorInput): boolean;
	isPinned(editorOrIndex: EditorInput | number): boolean;
	isSticky(editorOrIndex: EditorInput | number): boolean;
	isSelected(editorOrIndex: EditorInput | number): boolean;
	isTransient(editorOrIndex: EditorInput | number): boolean;
	isFirst(editor: EditorInput, editors?: EditorInput[]): boolean;
	isLast(editor: EditorInput, editors?: EditorInput[]): boolean;
	findEditor(editor: EditorInput | null, options?: IMatchEditorOptions): [EditorInput, number /* index */] | undefined;
	contains(editor: EditorInput | IUntypedEditorInput, options?: IMatchEditorOptions): boolean;

	/**
	 * Returns the tab stack of the editor, which is compared by identity.
	 */
	getTabStack(editor: EditorInput): ITabStack | undefined;
}

interface IEditorGroupModel extends IReadonlyEditorGroupModel {
	openEditor(editor: EditorInput, options?: IEditorOpenOptions): IEditorOpenResult;
	closeEditor(editor: EditorInput, context?: EditorCloseContext, openNext?: boolean): IEditorCloseResult | undefined;
	moveEditor(editor: EditorInput, toIndex: number): EditorInput | undefined;
	setActive(editor: EditorInput | undefined): EditorInput | undefined;
	setSelection(activeSelectedEditor: EditorInput, inactiveSelectedEditors: EditorInput[]): void;
}

export class EditorGroupModel extends Disposable implements IEditorGroupModel {

	private static IDS = 0;

	//#region events

	private readonly _onDidModelChange = this._register(new Emitter<IGroupModelChangeEvent>({ leakWarningThreshold: 500, leakWarningName: 'EditorGroupModel._onDidModelChange' /* increased for users with hundreds of inputs opened */ }));
	readonly onDidModelChange = this._onDidModelChange.event;

	//#endregion

	private _id: GroupIdentifier;
	get id(): GroupIdentifier { return this._id; }

	private editors: EditorInput[] = [];
	private mru: EditorInput[] = [];

	private readonly editorListeners = new Set<DisposableStore>();

	private locked = false;

	private selection: EditorInput[] = [];					// editors in selected state, first one is active

	private get active(): EditorInput | null {
		return this.selection[0] ?? null;
	}

	private preview: EditorInput | null = null; 			// editor in preview state
	private sticky = -1;									// index of first editor in sticky state
	private readonly transient = new Set<EditorInput>(); 	// editors in transient state

	private readonly tabStackOfEditor = new Map<EditorInput, TabStackId>();
	private readonly tabStackStates = new Map<TabStackId, ITabStackState>();	// tab stacks with at least one editor
	private tabStacksSnapshot: ITabStacksSnapshot | undefined;							// cached result of getTabStacksSnapshot()
	private tabStacksChanged = false;											// a TAB_STACKS event is pending
	private tabStackOperationDepth = 0;										// nesting of public operations that fire TAB_STACKS when done
	private tabStacksEnabled = false;
	private hiddenTabStacks: readonly ITabStackRecord[] = [];					// tab stacks kept while tab stacks are off

	private editorOpenPositioning: ('left' | 'right' | 'first' | 'last') | undefined;
	private focusRecentEditorAfterClose: boolean | undefined;

	constructor(
		labelOrSerializedGroup: ISerializedEditorGroupModel | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		if (isSerializedEditorGroupModel(labelOrSerializedGroup)) {
			this._id = this.deserialize(labelOrSerializedGroup);
		} else {
			this._id = EditorGroupModel.IDS++;
		}

		this.onConfigurationUpdated();
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e)));
	}

	private onConfigurationUpdated(e?: IConfigurationChangeEvent): void {
		if (e && !e.affectsConfiguration('workbench.editor.openPositioning') && !e.affectsConfiguration('workbench.editor.focusRecentEditorAfterClose')) {
			return;
		}

		this.editorOpenPositioning = this.configurationService.getValue('workbench.editor.openPositioning');
		this.focusRecentEditorAfterClose = this.configurationService.getValue('workbench.editor.focusRecentEditorAfterClose');
	}

	get count(): number {
		return this.editors.length;
	}

	get stickyCount(): number {
		return this.sticky + 1;
	}

	getEditors(order: EditorsOrder, options?: { excludeSticky?: boolean }): EditorInput[] {
		const editors = order === EditorsOrder.MOST_RECENTLY_ACTIVE ? this.mru.slice(0) : this.editors.slice(0);

		if (options?.excludeSticky) {

			// MRU: need to check for index on each
			if (order === EditorsOrder.MOST_RECENTLY_ACTIVE) {
				return editors.filter(editor => !this.isSticky(editor));
			}

			// Sequential: simply start after sticky index
			return editors.slice(this.sticky + 1);
		}

		return editors;
	}

	getEditorByIndex(index: number): EditorInput | undefined {
		return this.editors[index];
	}

	get activeEditor(): EditorInput | null {
		return this.active;
	}

	isActive(candidate: EditorInput | IUntypedEditorInput): boolean {
		return this.matches(this.active, candidate);
	}

	get previewEditor(): EditorInput | null {
		return this.preview;
	}

	openEditor(candidate: EditorInput, options?: IEditorOpenOptions): IEditorOpenResult {
		return this.withTabStacksChangeEvent(() => this.doOpenEditor(candidate, options));
	}

	private doOpenEditor(candidate: EditorInput, options?: IEditorOpenOptions): IEditorOpenResult {
		const makeSticky = options?.sticky || (typeof options?.index === 'number' && this.isSticky(options.index));
		const makePinned = options?.pinned || options?.sticky;
		const makeTransient = !!options?.transient;
		const makeActive = options?.active || !this.activeEditor || (!makePinned && this.preview === this.activeEditor);

		const existingEditorAndIndex = this.findEditor(candidate, options);

		// New editor
		if (!existingEditorAndIndex) {
			const newEditor = candidate;
			const indexOfActive = this.indexOf(this.active);

			// Insert into specific position
			let targetIndex: number;
			if (options && typeof options.index === 'number') {
				targetIndex = options.index;
			}

			// Insert to the BEGINNING
			else if (this.editorOpenPositioning === EditorOpenPositioning.FIRST) {
				targetIndex = 0;

				// Always make sure targetIndex is after sticky editors
				// unless we are explicitly told to make the editor sticky
				if (!makeSticky && this.isSticky(targetIndex)) {
					targetIndex = this.sticky + 1;
				}
			}

			// Insert to the END
			else if (this.editorOpenPositioning === EditorOpenPositioning.LAST) {
				targetIndex = this.editors.length;
			}

			// Insert to LEFT or RIGHT of active editor
			else {

				// Insert to the LEFT of active editor
				if (this.editorOpenPositioning === EditorOpenPositioning.LEFT) {
					if (indexOfActive === 0 || !this.editors.length) {
						targetIndex = 0; // to the left becoming first editor in list
					} else {
						targetIndex = indexOfActive; // to the left of active editor
					}
				}

				// Insert to the RIGHT of active editor
				else {
					targetIndex = indexOfActive + 1;
				}

				// Always make sure targetIndex is after sticky editors
				// unless we are explicitly told to make the editor sticky
				if (!makeSticky && this.isSticky(targetIndex)) {
					targetIndex = this.sticky + 1;
				}
			}

			// If the editor becomes sticky, increment the sticky index and adjust
			// the targetIndex to be at the end of sticky editors unless already.
			if (makeSticky) {
				this.sticky++;

				if (!this.isSticky(targetIndex)) {
					targetIndex = this.sticky;
				}
			}

			// Insert into our list of editors if pinned or we have no preview editor
			let tabStack: TabStackId | undefined;
			if (makePinned || !this.preview) {
				if (!makeSticky) {
					({ index: targetIndex, tabStack } = this.computeTabStackInsertion(this.editors, targetIndex, options));
				}

				this.splice(targetIndex, false, newEditor);
			}

			// Handle transient
			if (makeTransient) {
				this.doSetTransient(newEditor, targetIndex, true);
			}

			// Handle preview
			if (!makePinned) {

				// Replace existing preview with this editor if we have a preview
				if (this.preview) {
					const indexOfPreview = this.indexOf(this.preview);
					if (targetIndex > indexOfPreview) {
						targetIndex--; // accommodate for the fact that the preview editor closes
					}

					if (!makeSticky) {
						const preview = this.preview;
						({ index: targetIndex, tabStack } = this.computeTabStackInsertion(this.editors.filter(editor => editor !== preview), targetIndex, options));
					}

					this.replaceEditor(this.preview, newEditor, targetIndex, !makeActive);
				}

				this.preview = newEditor;
			}

			// Listeners
			this.registerEditorListeners(newEditor);

			// Event
			const event: IGroupEditorOpenEvent = {
				kind: GroupModelChangeKind.EDITOR_OPEN,
				editor: newEditor,
				editorIndex: targetIndex
			};
			this._onDidModelChange.fire(event);

			// Join only after the open event and the preview handling, since joining pins the editor
			if (tabStack !== undefined) {
				this.setTabStack(newEditor, tabStack);
			}

			// Handle active editor / selected editors
			this.setSelection(makeActive ? newEditor : this.activeEditor, options?.inactiveSelection ?? []);

			return {
				editor: newEditor,
				isNew: true
			};
		}

		// Existing editor
		else {
			const [existingEditor, existingEditorIndex] = existingEditorAndIndex;

			// Update transient (existing editors do not turn transient if they were not before)
			this.doSetTransient(existingEditor, existingEditorIndex, makeTransient === false ? false : this.isTransient(existingEditor));

			// Pin it
			if (makePinned) {
				this.doPin(existingEditor, existingEditorIndex);
			}

			// Handle active editor / selected editors
			this.setSelection(makeActive ? existingEditor : this.activeEditor, options?.inactiveSelection ?? []);

			// Respect index
			if (options && typeof options.index === 'number') {
				this.moveEditor(existingEditor, options.index);
			}

			// Stick it (intentionally after the moveEditor call in case
			// the editor was already moved into the sticky range)
			if (makeSticky) {
				this.doStick(existingEditor, this.indexOf(existingEditor));
			}

			return {
				editor: existingEditor,
				isNew: false
			};
		}
	}

	private registerEditorListeners(editor: EditorInput): void {
		const listeners = new DisposableStore();
		this.editorListeners.add(listeners);

		// Re-emit disposal of editor input as our own event
		listeners.add(Event.once(editor.onWillDispose)(() => {
			const editorIndex = this.editors.indexOf(editor);
			if (editorIndex >= 0) {
				const event: IGroupEditorChangeEvent = {
					kind: GroupModelChangeKind.EDITOR_WILL_DISPOSE,
					editor,
					editorIndex
				};
				this._onDidModelChange.fire(event);
			}
		}));

		// Re-Emit dirty state changes
		listeners.add(editor.onDidChangeDirty(() => {
			const event: IGroupEditorChangeEvent = {
				kind: GroupModelChangeKind.EDITOR_DIRTY,
				editor,
				editorIndex: this.editors.indexOf(editor)
			};
			this._onDidModelChange.fire(event);
		}));

		// Re-Emit label changes
		listeners.add(editor.onDidChangeLabel(() => {
			const event: IGroupEditorChangeEvent = {
				kind: GroupModelChangeKind.EDITOR_LABEL,
				editor,
				editorIndex: this.editors.indexOf(editor)
			};
			this._onDidModelChange.fire(event);
		}));

		// Re-Emit capability changes
		listeners.add(editor.onDidChangeCapabilities(() => {
			const event: IGroupEditorChangeEvent = {
				kind: GroupModelChangeKind.EDITOR_CAPABILITIES,
				editor,
				editorIndex: this.editors.indexOf(editor)
			};
			this._onDidModelChange.fire(event);
		}));

		// Clean up dispose listeners once the editor gets closed
		listeners.add(this.onDidModelChange(event => {
			if (event.kind === GroupModelChangeKind.EDITOR_CLOSE && event.editor?.matches(editor)) {
				dispose(listeners);
				this.editorListeners.delete(listeners);
			}
		}));
	}

	private replaceEditor(toReplace: EditorInput, replaceWith: EditorInput, replaceIndex: number, openNext = true): void {
		const closeResult = this.doCloseEditor(toReplace, EditorCloseContext.REPLACE, openNext); // optimization to prevent multiple setActive() in one call

		// We want to first add the new editor into our model before emitting the close event because
		// firing the close event can trigger a dispose on the same editor that is now being added.
		// This can lead into opening a disposed editor which is not what we want.
		this.splice(replaceIndex, false, replaceWith);

		if (closeResult) {
			const event: IGroupEditorCloseEvent = {
				kind: GroupModelChangeKind.EDITOR_CLOSE,
				...closeResult
			};
			this._onDidModelChange.fire(event);
		}
	}

	closeEditor(candidate: EditorInput, context = EditorCloseContext.UNKNOWN, openNext = true): IEditorCloseResult | undefined {
		return this.withTabStacksChangeEvent(() => this.doCloseEditorAndFireEvent(candidate, context, openNext));
	}

	private doCloseEditorAndFireEvent(candidate: EditorInput, context: EditorCloseContext, openNext: boolean): IEditorCloseResult | undefined {
		const closeResult = this.doCloseEditor(candidate, context, openNext);

		if (closeResult) {
			const event: IGroupEditorCloseEvent = {
				kind: GroupModelChangeKind.EDITOR_CLOSE,
				...closeResult
			};
			this._onDidModelChange.fire(event);

			return closeResult;
		}

		return undefined;
	}

	private doCloseEditor(candidate: EditorInput, context: EditorCloseContext, openNext: boolean): IEditorCloseResult | undefined {
		const index = this.indexOf(candidate);
		if (index === -1) {
			return undefined; // not found
		}

		const editor = this.editors[index];
		const sticky = this.isSticky(index);

		// Active editor closed
		const isActiveEditor = this.active === editor;
		if (openNext && isActiveEditor) {

			// More than one editor
			if (this.mru.length > 1) {
				let newActive: EditorInput;
				if (this.focusRecentEditorAfterClose) {
					newActive = this.mru.find((mruEditor, mruIndex) => mruIndex > 0 && !this.isHiddenInTabStack(mruEditor)) ?? this.mru[1]; // active editor is always first in MRU, so pick from the editors after it
				} else {
					const visibleEditor = this.findVisibleEditor(index + 1, index - 1);
					if (visibleEditor) {
						newActive = visibleEditor;
					} else if (index === this.editors.length - 1) {
						newActive = this.editors[index - 1]; // last editor is closed, pick previous as new active
					} else {
						newActive = this.editors[index + 1]; // pick next editor as new active
					}
				}

				// Select editor as active
				const newInactiveSelectedEditors = this.selection.filter(selected => selected !== editor && selected !== newActive);
				this.doSetSelection(newActive, this.editors.indexOf(newActive), newInactiveSelectedEditors);
			}

			// Last editor closed: clear selection
			else {
				this.doSetSelection(null, undefined, []);
			}
		}

		// Inactive editor closed
		else if (!isActiveEditor) {

			// Remove editor from inactive selection
			if (this.doIsSelected(editor)) {
				const newInactiveSelectedEditors = this.selection.filter(selected => selected !== editor && selected !== this.activeEditor);
				this.doSetSelection(this.activeEditor, this.indexOf(this.activeEditor), newInactiveSelectedEditors);
			}
		}

		// Preview Editor closed
		if (this.preview === editor) {
			this.preview = null;
		}

		// Remove from transient
		this.transient.delete(editor);

		// Remove from tab stack
		this.setTabStack(editor, undefined);
		this.removeFromHiddenTabStacks(editor);

		// Remove from arrays
		this.splice(index, true);

		// Event
		return { editor, sticky, editorIndex: index, context };
	}

	moveEditor(candidate: EditorInput, toIndex: number): EditorInput | undefined {
		return this.withTabStacksChangeEvent(() => this.doMoveEditorAndAssignTabStack(candidate, toIndex));
	}

	private doMoveEditorAndAssignTabStack(candidate: EditorInput, toIndex: number): EditorInput | undefined {

		// Ensure toIndex is in bounds of our model
		if (toIndex >= this.editors.length) {
			toIndex = this.editors.length - 1;
		} else if (toIndex < 0) {
			toIndex = 0;
		}

		const index = this.indexOf(candidate);
		if (index < 0 || toIndex === index) {
			return;
		}

		const editor = this.editors[index];
		const tabStacksBeforeMove = new Map([[editor, this.tabStackOfEditor.get(editor)]]);

		this.doMoveEditor(editor, index, toIndex);

		// Keep, join or leave a tab stack depending on where the editor lands
		this.assignTabStacksAfterMove(tabStacksBeforeMove, undefined, []);

		return editor;
	}

	private doMoveEditor(editor: EditorInput, index: number, toIndex: number): void {
		const sticky = this.sticky;

		// Adjust sticky index: editor moved out of sticky state into unsticky state
		if (this.isSticky(index) && toIndex > this.sticky) {
			this.sticky--;
		}

		// ...or editor moved into sticky state from unsticky state
		else if (!this.isSticky(index) && toIndex <= this.sticky) {
			this.sticky++;
		}

		// Move
		this.editors.splice(index, 1);
		this.editors.splice(toIndex, 0, editor);
		if (this.tabStackOfEditor.has(editor)) {
			this.tabStacksSnapshot = undefined;
		}

		// Move Event
		const event: IGroupEditorMoveEvent = {
			kind: GroupModelChangeKind.EDITOR_MOVE,
			editor,
			oldEditorIndex: index,
			editorIndex: toIndex
		};
		this._onDidModelChange.fire(event);

		// Sticky Event (if sticky changed as part of the move)
		if (sticky !== this.sticky) {
			const event: IGroupEditorChangeEvent = {
				kind: GroupModelChangeKind.EDITOR_STICKY,
				editor,
				editorIndex: toIndex
			};
			this._onDidModelChange.fire(event);
		}
	}

	setActive(candidate: EditorInput | undefined): EditorInput | undefined {
		let result: EditorInput | undefined;

		if (!candidate) {
			this.setGroupActive();
		} else {
			result = this.setEditorActive(candidate);
		}

		return result;
	}

	private setGroupActive(): void {
		// We do not really keep the `active` state in our model because
		// it has no special meaning to us here. But for consistency
		// we emit a `onDidModelChange` event so that components can
		// react.
		this._onDidModelChange.fire({ kind: GroupModelChangeKind.GROUP_ACTIVE });
	}

	private setEditorActive(candidate: EditorInput): EditorInput | undefined {
		const res = this.findEditor(candidate);
		if (!res) {
			return; // not found
		}

		const [editor, editorIndex] = res;

		this.doSetSelection(editor, editorIndex, []);

		return editor;
	}

	get selectedEditors(): EditorInput[] {
		return this.editors.filter(editor => this.doIsSelected(editor)); // return in sequential order
	}

	isSelected(editorCandidateOrIndex: EditorInput | number): boolean {
		let editor: EditorInput | undefined;
		if (typeof editorCandidateOrIndex === 'number') {
			editor = this.editors[editorCandidateOrIndex];
		} else {
			editor = this.findEditor(editorCandidateOrIndex)?.[0];
		}

		return !!editor && this.doIsSelected(editor);
	}

	private doIsSelected(editor: EditorInput): boolean {
		return this.selection.includes(editor);
	}

	setSelection(activeSelectedEditorCandidate: EditorInput, inactiveSelectedEditorCandidates: EditorInput[]): void {
		const res = this.findEditor(activeSelectedEditorCandidate);
		if (!res) {
			return; // not found
		}

		const [activeSelectedEditor, activeSelectedEditorIndex] = res;

		const inactiveSelectedEditors = new Set<EditorInput>();
		for (const inactiveSelectedEditorCandidate of inactiveSelectedEditorCandidates) {
			const res = this.findEditor(inactiveSelectedEditorCandidate);
			if (!res) {
				return; // not found
			}

			const [inactiveSelectedEditor] = res;
			if (inactiveSelectedEditor === activeSelectedEditor) {
				continue; // already selected
			}

			inactiveSelectedEditors.add(inactiveSelectedEditor);
		}

		this.doSetSelection(activeSelectedEditor, activeSelectedEditorIndex, Array.from(inactiveSelectedEditors));
	}

	private doSetSelection(activeSelectedEditor: EditorInput | null, activeSelectedEditorIndex: number | undefined, inactiveSelectedEditors: EditorInput[]): void {
		const previousActiveEditor = this.activeEditor;
		const previousSelection = this.selection;

		let newSelection: EditorInput[];
		if (activeSelectedEditor) {
			newSelection = [activeSelectedEditor, ...inactiveSelectedEditors];
		} else {
			newSelection = [];
		}

		// Update selection
		this.selection = newSelection;

		// Update active editor if it has changed
		const activeEditorChanged = activeSelectedEditor && typeof activeSelectedEditorIndex === 'number' && previousActiveEditor !== activeSelectedEditor;
		if (activeEditorChanged) {

			// Expand its tab stack before the active event, so that its tab is shown by then
			const tabStackState = this.getTabStackState(activeSelectedEditor);
			if (tabStackState?.collapsed) {
				tabStackState.collapsed = false;
				this.markTabStacksChanged();
				this.flushTabStacksChange();
			}

			// Bring to front in MRU list
			const mruIndex = this.indexOf(activeSelectedEditor, this.mru);
			this.mru.splice(mruIndex, 1);
			this.mru.unshift(activeSelectedEditor);

			// Event
			const event: IGroupEditorChangeEvent = {
				kind: GroupModelChangeKind.EDITOR_ACTIVE,
				editor: activeSelectedEditor,
				editorIndex: activeSelectedEditorIndex
			};
			this._onDidModelChange.fire(event);
		}

		// Fire event if the selection has changed
		if (
			activeEditorChanged ||
			previousSelection.length !== newSelection.length ||
			previousSelection.some(editor => !newSelection.includes(editor))
		) {
			const event: IGroupModelChangeEvent = {
				kind: GroupModelChangeKind.EDITORS_SELECTION
			};
			this._onDidModelChange.fire(event);
		}
	}

	setIndex(index: number) {
		// We do not really keep the `index` in our model because
		// it has no special meaning to us here. But for consistency
		// we emit a `onDidModelChange` event so that components can
		// react.
		this._onDidModelChange.fire({ kind: GroupModelChangeKind.GROUP_INDEX });
	}

	setLabel(label: string) {
		// We do not really keep the `label` in our model because
		// it has no special meaning to us here. But for consistency
		// we emit a `onDidModelChange` event so that components can
		// react.
		this._onDidModelChange.fire({ kind: GroupModelChangeKind.GROUP_LABEL });
	}

	pin(candidate: EditorInput): EditorInput | undefined {
		const res = this.findEditor(candidate);
		if (!res) {
			return; // not found
		}

		const [editor, editorIndex] = res;

		this.doPin(editor, editorIndex);

		return editor;
	}

	private doPin(editor: EditorInput, editorIndex: number): void {
		if (this.isPinned(editor)) {
			return; // can only pin a preview editor
		}

		// Clear Transient
		this.setTransient(editor, false);

		// Convert the preview editor to be a pinned editor
		this.preview = null;

		// Event
		const event: IGroupEditorChangeEvent = {
			kind: GroupModelChangeKind.EDITOR_PIN,
			editor,
			editorIndex
		};
		this._onDidModelChange.fire(event);
	}

	unpin(candidate: EditorInput): EditorInput | undefined {
		const res = this.findEditor(candidate);
		if (!res) {
			return; // not found
		}

		const [editor, editorIndex] = res;

		this.doUnpin(editor, editorIndex);

		return editor;
	}

	private doUnpin(editor: EditorInput, editorIndex: number): void {
		if (!this.isPinned(editor)) {
			return; // can only unpin a pinned editor
		}

		if (this.tabStackOfEditor.has(editor)) {
			return; // editors of a tab stack are never in preview
		}

		// Set new
		const oldPreview = this.preview;
		this.preview = editor;

		// Event
		const event: IGroupEditorChangeEvent = {
			kind: GroupModelChangeKind.EDITOR_PIN,
			editor,
			editorIndex
		};
		this._onDidModelChange.fire(event);

		// Close old preview editor if any
		if (oldPreview) {
			this.closeEditor(oldPreview, EditorCloseContext.UNPIN);
		}
	}

	isPinned(editorCandidateOrIndex: EditorInput | number): boolean {
		let editor: EditorInput;
		if (typeof editorCandidateOrIndex === 'number') {
			editor = this.editors[editorCandidateOrIndex];
		} else {
			editor = editorCandidateOrIndex;
		}

		return !this.matches(this.preview, editor);
	}

	stick(candidate: EditorInput): EditorInput | undefined {
		const res = this.findEditor(candidate);
		if (!res) {
			return; // not found
		}

		const [editor, editorIndex] = res;

		this.withTabStacksChangeEvent(() => this.doStick(editor, editorIndex));

		return editor;
	}

	private doStick(editor: EditorInput, editorIndex: number): void {
		if (this.isSticky(editorIndex)) {
			return; // can only stick a non-sticky editor
		}

		// Sticky editors never belong to a tab stack
		this.setTabStack(editor, undefined);

		// Pin editor
		this.pin(editor);

		// Move editor to be the last sticky editor
		const newEditorIndex = this.sticky + 1;
		this.moveEditor(editor, newEditorIndex);

		// Adjust sticky index
		this.sticky++;

		// Event
		const event: IGroupEditorChangeEvent = {
			kind: GroupModelChangeKind.EDITOR_STICKY,
			editor,
			editorIndex: newEditorIndex
		};
		this._onDidModelChange.fire(event);
	}

	unstick(candidate: EditorInput): EditorInput | undefined {
		const res = this.findEditor(candidate);
		if (!res) {
			return; // not found
		}

		const [editor, editorIndex] = res;

		this.doUnstick(editor, editorIndex);

		return editor;
	}

	private doUnstick(editor: EditorInput, editorIndex: number): void {
		if (!this.isSticky(editorIndex)) {
			return; // can only unstick a sticky editor
		}

		// Move editor to be the first non-sticky editor
		const newEditorIndex = this.sticky;
		this.moveEditor(editor, newEditorIndex);

		// Adjust sticky index
		this.sticky--;

		// Event
		const event: IGroupEditorChangeEvent = {
			kind: GroupModelChangeKind.EDITOR_STICKY,
			editor,
			editorIndex: newEditorIndex
		};
		this._onDidModelChange.fire(event);
	}

	isSticky(candidateOrIndex: EditorInput | number): boolean {
		if (this.sticky < 0) {
			return false; // no sticky editor
		}

		let index: number;
		if (typeof candidateOrIndex === 'number') {
			index = candidateOrIndex;
		} else {
			index = this.indexOf(candidateOrIndex);
		}

		if (index < 0) {
			return false;
		}

		return index <= this.sticky;
	}

	setTransient(candidate: EditorInput, transient: boolean): EditorInput | undefined {
		if (!transient && this.transient.size === 0) {
			return; // no transient editor
		}

		const res = this.findEditor(candidate);
		if (!res) {
			return; // not found
		}

		const [editor, editorIndex] = res;

		this.doSetTransient(editor, editorIndex, transient);

		return editor;
	}

	private doSetTransient(editor: EditorInput, editorIndex: number, transient: boolean): void {
		if (transient) {
			if (this.transient.has(editor)) {
				return;
			}

			this.transient.add(editor);
		} else {
			if (!this.transient.has(editor)) {
				return;
			}

			this.transient.delete(editor);
		}

		// Event
		const event: IGroupEditorChangeEvent = {
			kind: GroupModelChangeKind.EDITOR_TRANSIENT,
			editor,
			editorIndex
		};
		this._onDidModelChange.fire(event);
	}

	isTransient(editorCandidateOrIndex: EditorInput | number): boolean {
		if (this.transient.size === 0) {
			return false; // no transient editor
		}

		let editor: EditorInput | undefined;
		if (typeof editorCandidateOrIndex === 'number') {
			editor = this.editors[editorCandidateOrIndex];
		} else {
			editor = this.findEditor(editorCandidateOrIndex)?.[0];
		}

		return !!editor && this.transient.has(editor);
	}

	private splice(index: number, del: boolean, editor?: EditorInput): void {
		const editorToDeleteOrReplace = this.editors[index];

		// Perform on sticky index
		if (del && this.isSticky(index)) {
			this.sticky--;
		}

		// Perform on editors array
		if (editor) {
			this.editors.splice(index, del ? 1 : 0, editor);
		} else {
			this.editors.splice(index, del ? 1 : 0);
		}
		if ((del && this.tabStackOfEditor.has(editorToDeleteOrReplace)) || (editor && this.tabStackOfEditor.has(editor))) {
			this.tabStacksSnapshot = undefined;
		}

		// Perform on MRU
		{
			// Add
			if (!del && editor) {
				if (this.mru.length === 0) {
					// the list of most recent editors is empty
					// so this editor can only be the most recent
					this.mru.push(editor);
				} else {
					// we have most recent editors. as such we
					// put this newly opened editor right after
					// the current most recent one because it cannot
					// be the most recently active one unless
					// it becomes active. but it is still more
					// active then any other editor in the list.
					this.mru.splice(1, 0, editor);
				}
			}

			// Remove / Replace
			else {
				const indexInMRU = this.indexOf(editorToDeleteOrReplace, this.mru);

				// Remove
				if (del && !editor) {
					this.mru.splice(indexInMRU, 1); // remove from MRU
				}

				// Replace
				else if (del && editor) {
					this.mru.splice(indexInMRU, 1, editor); // replace MRU at location
				}
			}
		}
	}

	indexOf(candidate: EditorInput | IUntypedEditorInput | null, editors = this.editors, options?: IMatchEditorOptions): number {
		let index = -1;
		if (!candidate) {
			return index;
		}

		for (let i = 0; i < editors.length; i++) {
			const editor = editors[i];

			if (this.matches(editor, candidate, options)) {
				// If we are to support side by side matching, it is possible that
				// a better direct match is found later. As such, we continue finding
				// a matching editor and prefer that match over the side by side one.
				if (options?.supportSideBySide && editor instanceof SideBySideEditorInput && !(candidate instanceof SideBySideEditorInput)) {
					index = i;
				} else {
					index = i;
					break;
				}
			}
		}

		return index;
	}

	findEditor(candidate: EditorInput | null, options?: IMatchEditorOptions): [EditorInput, number /* index */] | undefined {
		const index = this.indexOf(candidate, this.editors, options);
		if (index === -1) {
			return undefined;
		}

		return [this.editors[index], index];
	}

	isFirst(candidate: EditorInput | null, editors = this.editors): boolean {
		return this.matches(editors[0], candidate);
	}

	isLast(candidate: EditorInput | null, editors = this.editors): boolean {
		return this.matches(editors[editors.length - 1], candidate);
	}

	contains(candidate: EditorInput | IUntypedEditorInput, options?: IMatchEditorOptions): boolean {
		return this.indexOf(candidate, this.editors, options) !== -1;
	}

	private matches(editor: EditorInput | null | undefined, candidate: EditorInput | IUntypedEditorInput | null, options?: IMatchEditorOptions): boolean {
		if (!editor || !candidate) {
			return false;
		}

		if (options?.supportSideBySide && editor instanceof SideBySideEditorInput && !(candidate instanceof SideBySideEditorInput)) {
			switch (options.supportSideBySide) {
				case SideBySideEditor.ANY:
					if (this.matches(editor.primary, candidate, options) || this.matches(editor.secondary, candidate, options)) {
						return true;
					}
					break;
				case SideBySideEditor.BOTH:
					if (this.matches(editor.primary, candidate, options) && this.matches(editor.secondary, candidate, options)) {
						return true;
					}
					break;
			}
		}

		const strictEquals = editor === candidate;

		if (options?.strictEquals) {
			return strictEquals;
		}

		return strictEquals || editor.matches(candidate);
	}

	get isLocked(): boolean {
		return this.locked;
	}

	lock(locked: boolean): void {
		if (this.isLocked !== locked) {
			this.locked = locked;

			this._onDidModelChange.fire({ kind: GroupModelChangeKind.GROUP_LOCKED });
		}
	}

	clone(): EditorGroupModel {
		const clone = this.instantiationService.createInstance(EditorGroupModel, undefined);

		// Copy over group properties
		clone.editors = this.editors.slice(0);
		clone.mru = this.mru.slice(0);
		clone.preview = this.preview;
		clone.selection = this.selection.slice(0);
		clone.sticky = this.sticky;

		for (const [editor, tabStack] of this.tabStackOfEditor) {
			clone.tabStackOfEditor.set(editor, tabStack);
		}

		for (const [tabStack, state] of this.tabStackStates) {
			clone.tabStackStates.set(tabStack, { ...state });
		}

		clone.tabStacksEnabled = this.tabStacksEnabled;
		clone.hiddenTabStacks = this.hiddenTabStacks.slice(0);

		// Ensure to register listeners for each editor
		for (const editor of clone.editors) {
			clone.registerEditorListeners(editor);
		}

		return clone;
	}

	serialize(): ISerializedEditorGroupModel {
		const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);

		// Serialize all editor inputs so that we can store them.
		// Editors that cannot be serialized need to be ignored
		// from mru, active, preview and sticky if any.
		const serializableEditors: EditorInput[] = [];
		const serializedEditors: ISerializedEditorInput[] = [];
		let serializablePreviewIndex: number | undefined;
		let serializableSticky = this.sticky;
		const serializableIndices = new Map<EditorInput, number>();

		for (let i = 0; i < this.editors.length; i++) {
			const editor = this.editors[i];
			let canSerializeEditor = false;

			const editorSerializer = registry.getEditorSerializer(editor);
			if (editorSerializer) {
				const value = editorSerializer.canSerialize(editor) ? editorSerializer.serialize(editor) : undefined;

				// Editor can be serialized
				if (typeof value === 'string') {
					canSerializeEditor = true;

					serializedEditors.push({ id: editor.typeId, value });
					serializableEditors.push(editor);

					if (this.preview === editor) {
						serializablePreviewIndex = serializableEditors.length - 1;
					}

					serializableIndices.set(editor, serializableEditors.length - 1);
				}

				// Editor cannot be serialized
				else {
					canSerializeEditor = false;
				}
			}

			// Adjust index of sticky editors if the editor cannot be serialized and is pinned
			if (!canSerializeEditor && this.isSticky(i)) {
				serializableSticky--;
			}
		}

		const serializableMru = this.mru.map(editor => this.indexOf(editor, serializableEditors)).filter(i => i >= 0);

		const serializableTabStacks: ISerializedTabStack[] = [];
		for (const { editors, label, color, collapsed } of this.getTabStackRecords()) {
			const indices = editors.map(editor => serializableIndices.get(editor)).filter(index => index !== undefined);
			if (indices.length > 0) {
				serializableTabStacks.push({ label, color, collapsed: collapsed ? true : undefined, editors: indices });
			}
		}

		return {
			id: this.id,
			locked: this.locked ? true : undefined,
			editors: serializedEditors,
			mru: serializableMru,
			preview: serializablePreviewIndex,
			sticky: serializableSticky >= 0 ? serializableSticky : undefined,
			tabStacks: serializableTabStacks.length > 0 ? serializableTabStacks : undefined
		};
	}

	private deserialize(data: ISerializedEditorGroupModel): number {
		const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);

		if (typeof data.id === 'number') {
			this._id = data.id;

			EditorGroupModel.IDS = Math.max(data.id + 1, EditorGroupModel.IDS); // make sure our ID generator is always larger
		} else {
			this._id = EditorGroupModel.IDS++; // backwards compatibility
		}

		if (data.locked) {
			this.locked = true;
		}

		const restoredEditors = data.editors.map((e, index) => {
			let editor: EditorInput | undefined;

			const editorSerializer = registry.getEditorSerializer(e.id);
			if (editorSerializer) {
				const deserializedEditor = editorSerializer.deserialize(this.instantiationService, e.value);
				if (deserializedEditor instanceof EditorInput) {
					editor = deserializedEditor;
					this.registerEditorListeners(editor);
				}
			}

			if (!editor && typeof data.sticky === 'number' && index <= data.sticky) {
				data.sticky--; // if editor cannot be deserialized but was sticky, we need to decrease sticky index
			}

			return editor;
		});
		this.editors = coalesce(restoredEditors);

		this.mru = coalesce(data.mru.map(i => this.editors[i]));

		this.selection = this.mru.length > 0 ? [this.mru[0]] : [];

		if (typeof data.preview === 'number') {
			this.preview = this.editors[data.preview];
		}

		if (typeof data.sticky === 'number') {
			this.sticky = data.sticky;
		}

		this.hiddenTabStacks = this.deserializeTabStacks(data.tabStacks, restoredEditors);

		return this._id;
	}

	/**
	 * Returns the records of the serialized tab stacks. Their indices point into `restoredEditors`,
	 * which keeps `undefined` for each editor that failed to restore.
	 */
	private deserializeTabStacks(serializedTabStacks: readonly ISerializedTabStack[] | undefined, restoredEditors: readonly (EditorInput | undefined)[]): ITabStackRecord[] {
		if (!Array.isArray(serializedTabStacks)) {
			return [];
		}

		const records: ITabStackRecord[] = [];
		for (const serializedTabStack of serializedTabStacks) {
			const serializedIndices: unknown[] = Array.isArray(serializedTabStack?.editors) ? serializedTabStack.editors : [];

			const editors = new Set<EditorInput>();
			for (const serializedIndex of serializedIndices) {
				const editor = typeof serializedIndex === 'number' && Number.isInteger(serializedIndex) ? restoredEditors[serializedIndex] : undefined;
				if (editor) {
					editors.add(editor);
				}
			}

			if (editors.size > 0) {
				records.push({
					editors: Array.from(editors),
					label: typeof serializedTabStack.label === 'string' ? serializedTabStack.label : '',
					color: parseTabStackColor(serializedTabStack.color) ?? 'gray',
					collapsed: serializedTabStack.collapsed === true
				});
			}
		}

		return records;
	}

	override dispose(): void {
		dispose(Array.from(this.editorListeners));
		this.editorListeners.clear();

		this.transient.clear();

		this.tabStackOfEditor.clear();
		this.tabStackStates.clear();
		this.tabStacksSnapshot = undefined;
		this.hiddenTabStacks = [];

		super.dispose();
	}

	//#region Tab Stacks

	/**
	 * The tab stacks of the group in the order of their first editor, none while
	 * tab stacks are off.
	 */
	get tabStacks(): readonly ITabStack[] {
		return this.getTabStacksSnapshot().list;
	}

	getTabStack(editor: EditorInput): ITabStack | undefined {
		const tabStack = this.tabStackOfEditor.get(editor);

		return tabStack !== undefined ? this.getTabStacksSnapshot().byId.get(tabStack) : undefined;
	}

	private getTabStacksSnapshot(): ITabStacksSnapshot {
		if (!this.tabStacksSnapshot) {
			const list: ITabStack[] = [];
			const byId = new Map<TabStackId, ITabStack>();
			for (const [id, editors] of this.groupByTabStack(this.editors)) {
				const state = this.tabStackStates.get(id);
				if (state) {
					const tabStack: ITabStack = { id, label: state.label, color: state.color, collapsed: state.collapsed, editors };
					list.push(tabStack);
					byId.set(id, tabStack);
				}
			}

			this.tabStacksSnapshot = { list, byId };
		}

		return this.tabStacksSnapshot;
	}

	/**
	 * Removes every tab stack, leaving their editors in place and pinned.
	 */
	private removeAllTabStacks(): void {
		if (this.tabStackStates.size === 0) {
			return;
		}

		this.tabStackOfEditor.clear();
		this.tabStackStates.clear();
		this.markTabStacksChanged();
	}

	/**
	 * Shows or hides the tab stacks. Hidden tab stacks have no effect and are
	 * kept, and showing them again adds them as {@link addTabStacks} does.
	 */
	setTabStacksEnabled(enabled: boolean): ITabStackOperationResult {
		return this.withTabStacksChangeEvent(() => {
			if (enabled === this.tabStacksEnabled) {
				return { moves: [], pinned: [] };
			}

			if (!enabled) {
				this.hiddenTabStacks = this.getTabStackRecords();
				this.removeAllTabStacks();
				this.tabStacksEnabled = false;

				return { moves: [], pinned: [] };
			}

			const records = this.hiddenTabStacks;
			this.hiddenTabStacks = [];
			this.tabStacksEnabled = true;

			return this.doAddTabStacks(records);
		});
	}

	/**
	 * Returns the tab stacks as records, or the hidden tab stacks while tab
	 * stacks are off.
	 */
	getTabStackRecords(): ITabStackRecord[] {
		const records: readonly ITabStackRecord[] = this.tabStacksEnabled ? this.tabStacks : this.hiddenTabStacks;

		return records.map(({ editors, label, color, collapsed }) => ({ editors: editors.slice(0), label, color, collapsed }));
	}

	/**
	 * Adds tab stacks, each as the longest run of its adjacent editors that are
	 * not sticky and in no tab stack, the leftmost on ties. While tab stacks are
	 * off, the records are kept hidden instead.
	 */
	addTabStacks(records: readonly ITabStackRecord[]): ITabStackOperationResult {
		return this.withTabStacksChangeEvent(() => {
			if (this.tabStacksEnabled) {
				return this.doAddTabStacks(records);
			}

			const hiddenTabStacks = records.map(record => ({ ...record, editors: this.resolveEditors(record.editors) })).filter(record => record.editors.length > 0);
			this.hiddenTabStacks = [...this.hiddenTabStacks, ...hiddenTabStacks];

			return { moves: [], pinned: [] };
		});
	}

	private doAddTabStacks(records: readonly ITabStackRecord[]): ITabStackOperationResult {
		const pinned: EditorInput[] = [];

		for (const { editors, label, color, collapsed } of records) {
			const run = this.getLongestRunOfAdjacentEditors(this.resolveEditors(editors).filter(editor => !this.isSticky(editor) && !this.tabStackOfEditor.has(editor)));
			if (run.length === 0) {
				continue;
			}

			const tabStack = generateUuid();
			this.tabStackStates.set(tabStack, { label, color: parseTabStackColor(color) ?? 'gray', collapsed, size: 0 });
			for (const editor of run) {
				this.setTabStack(editor, tabStack, pinned);
			}
		}

		this.deselectHiddenEditors();

		return { moves: [], pinned };
	}

	/**
	 * Returns the leftmost longest run of adjacent editors, from editors in sequential order.
	 */
	private getLongestRunOfAdjacentEditors(editors: readonly EditorInput[]): EditorInput[] {
		let longestRun: EditorInput[] = [];

		let runStart = 0;
		for (let runEnd = 1; runEnd <= editors.length; runEnd++) {
			if (runEnd === editors.length || this.editors.indexOf(editors[runEnd]) !== this.editors.indexOf(editors[runEnd - 1]) + 1) {
				if (runEnd - runStart > longestRun.length) {
					longestRun = editors.slice(runStart, runEnd);
				}

				runStart = runEnd;
			}
		}

		return longestRun;
	}

	private removeFromHiddenTabStacks(editor: EditorInput): void {
		if (this.hiddenTabStacks.some(record => record.editors.includes(editor))) {
			this.hiddenTabStacks = this.hiddenTabStacks
				.map(record => ({ ...record, editors: record.editors.filter(member => member !== editor) }))
				.filter(record => record.editors.length > 0);
		}
	}

	/**
	 * Puts the editor of the group that matches the replacement in the hidden tab stacks of the replaced editor.
	 */
	replaceInHiddenTabStacks(editor: EditorInput, replacement: EditorInput): void {
		const replacementInGroup = this.findEditor(replacement)?.[0];
		if (!replacementInGroup || replacementInGroup === editor || !this.hiddenTabStacks.some(record => record.editors.includes(editor))) {
			return;
		}

		this.hiddenTabStacks = this.hiddenTabStacks
			.map(record => {
				const editors = record.editors.filter(member => member !== replacementInGroup);

				return { ...record, editors: record.editors.includes(editor) ? [...editors, replacementInGroup] : editors };
			})
			.filter(record => record.editors.length > 0);
	}

	/**
	 * Adds editors to a tab stack, or to a new one gathered after the first editor and its tab stack.
	 * Editors left of the tab stack move to its start and those right of it to its end.
	 */
	addEditorsToTabStack(candidates: readonly EditorInput[], tabStackId?: TabStackId): IAddEditorsToTabStackResult {
		return this.withTabStacksChangeEvent(() => {
			const moves: ITabStackEditorMove[] = [];
			const pinned: EditorInput[] = [];

			if (!this.tabStacksEnabled || (tabStackId !== undefined && !this.tabStackStates.has(tabStackId))) {
				return { moves, pinned, tabStack: undefined };
			}

			const editors = this.resolveEditors(candidates).filter(editor => !this.isSticky(editor) && (tabStackId === undefined || this.tabStackOfEditor.get(editor) !== tabStackId));
			if (editors.length === 0) {
				return { moves, pinned, tabStack: tabStackId !== undefined ? this.getTabStacksSnapshot().byId.get(tabStackId) : undefined };
			}

			let targetTabStack: TabStackId;
			if (tabStackId === undefined) {
				targetTabStack = generateUuid();

				// The color is chosen before the editors leave their tab stacks
				const color = this.getLeastUsedTabStackColor();

				const firstTabStack = this.tabStackOfEditor.get(editors[0]);
				const indexAfterFirst = this.editors.indexOf(editors[0]) + 1;
				const destination = firstTabStack !== undefined ? this.getGapAfterTabStack(this.editors, indexAfterFirst, firstTabStack) : indexAfterFirst;

				this.moveEditorsBefore(editors, destination, moves);
				this.tabStackStates.set(targetTabStack, { label: '', color, collapsed: false, size: 0 });
			} else {
				targetTabStack = tabStackId;

				const members = this.getTabStackEditors(tabStackId);
				const start = this.editors.indexOf(members[0]);
				const end = start + members.length - 1;

				this.moveEditorsBefore(editors.filter(editor => this.editors.indexOf(editor) < start), start, moves);
				this.moveEditorsBefore(editors.filter(editor => this.editors.indexOf(editor) > end), end + 1, moves);
			}

			for (const editor of editors) {
				this.setTabStack(editor, targetTabStack, pinned);
			}

			this.deselectHiddenEditors();

			return { moves, pinned, tabStack: this.getTabStacksSnapshot().byId.get(targetTabStack) };
		});
	}

	/**
	 * Removes editors from their tab stacks, each through the nearer edge, the end on ties.
	 * Removing every editor of a tab stack moves nothing and deletes the tab stack.
	 */
	removeEditorsFromTabStack(candidates: readonly EditorInput[]): ITabStackOperationResult {
		return this.withTabStacksChangeEvent(() => {
			const moves: ITabStackEditorMove[] = [];

			for (const [tabStack, editors] of this.groupByTabStack(this.resolveEditors(candidates))) {
				const members = this.getTabStackEditors(tabStack);
				const start = this.editors.indexOf(members[0]);
				const end = start + members.length - 1;
				const middle = Math.floor(members.length / 2);

				this.moveEditorsBefore(editors.filter(editor => members.indexOf(editor) < middle), start, moves);
				this.moveEditorsBefore(editors.filter(editor => members.indexOf(editor) >= middle), end + 1, moves);

				for (const editor of editors) {
					this.setTabStack(editor, undefined);
				}
			}

			return { moves, pinned: [] };
		});
	}

	/**
	 * Changes the name, color or collapsed state of a tab stack. Collapsing the tab stack of the
	 * active editor first activates the nearest visible editor, or keeps it expanded without one.
	 */
	updateTabStack(tabStack: TabStackId, update: ITabStackUpdate): void {
		this.withTabStacksChangeEvent(() => {
			const state = this.tabStackStates.get(tabStack);
			if (!state) {
				return;
			}

			if (typeof update.label === 'string' && update.label !== state.label) {
				state.label = update.label;
				this.markTabStacksChanged();
			}

			const color = parseTabStackColor(update.color);
			if (color && color !== state.color) {
				state.color = color;
				this.markTabStacksChanged();
			}

			if (update.collapsed === false && state.collapsed) {
				state.collapsed = false;
				this.markTabStacksChanged();
			} else if (update.collapsed === true && !state.collapsed) {
				this.collapseTabStack(tabStack, state);
			}
		});
	}

	private collapseTabStack(tabStack: TabStackId, state: ITabStackState): void {
		const members = this.getTabStackEditors(tabStack);
		const inactiveSelectedEditors = this.selection.filter(editor => editor !== this.active && !members.includes(editor));

		if (this.active && members.includes(this.active)) {
			const start = this.editors.indexOf(members[0]);
			const nextActiveEditor = this.findVisibleEditor(start + members.length, start - 1);
			if (!nextActiveEditor) {
				return; // no other editor to show
			}

			this.doSetSelection(nextActiveEditor, this.editors.indexOf(nextActiveEditor), inactiveSelectedEditors.filter(editor => editor !== nextActiveEditor));
		} else if (inactiveSelectedEditors.length !== this.selection.length - 1) {
			this.doSetSelection(this.active, this.indexOf(this.active), inactiveSelectedEditors);
		}

		state.collapsed = true;
		this.markTabStacksChanged();
	}

	/**
	 * Moves a whole tab stack so that its first editor ends up at the index. The index stays after
	 * the sticky editors and never falls inside another tab stack.
	 */
	moveTabStack(tabStack: TabStackId, index: number): ITabStackOperationResult {
		return this.withTabStacksChangeEvent(() => {
			const moves: ITabStackEditorMove[] = [];

			const members = this.getTabStackEditors(tabStack);
			if (members.length === 0) {
				return { moves, pinned: [] };
			}

			const start = this.editors.indexOf(members[0]);
			const others = this.editors.filter(editor => this.tabStackOfEditor.get(editor) !== tabStack);

			let targetIndex = Math.min(Math.max(index, this.stickyCount), others.length);
			const surroundingTabStack = this.getSurroundingTabStack(others, targetIndex);
			if (surroundingTabStack !== undefined) {
				targetIndex = targetIndex > start ? this.getGapAfterTabStack(others, targetIndex, surroundingTabStack) : this.getGapBeforeTabStack(others, targetIndex, surroundingTabStack);
			}

			if (targetIndex !== start) {
				this.moveEditorsBefore(members, targetIndex > start ? targetIndex + members.length : targetIndex, moves);
			}

			return { moves, pinned: [] };
		});
	}

	/**
	 * Moves editors next to each other in their order, the first of them to the index among the other
	 * editors. `targetTabStack`, or `null` for none, applies only where every tab stack stays adjacent.
	 */
	moveEditorsWithinGroup(candidates: readonly EditorInput[], index: number, targetTabStack?: TabStackId | null): ITabStackOperationResult {
		return this.withTabStacksChangeEvent(() => {
			const moves: ITabStackEditorMove[] = [];
			const pinned: EditorInput[] = [];

			const editors = this.resolveEditors(candidates);
			if (editors.length === 0) {
				return { moves, pinned };
			}

			const tabStacksBeforeMove = new Map(editors.map(editor => [editor, this.tabStackOfEditor.get(editor)]));
			const others = this.editors.filter(editor => !tabStacksBeforeMove.has(editor));
			const targetIndex = Math.min(Math.max(index, 0), others.length);

			this.moveEditorsBefore(editors, targetIndex < others.length ? this.editors.indexOf(others[targetIndex]) : this.editors.length, moves);
			this.assignTabStacksAfterMove(tabStacksBeforeMove, targetTabStack, pinned);

			return { moves, pinned };
		});
	}

	/**
	 * Returns the order of the editors and their tab stacks, to undo a tab stack operation.
	 */
	getTabStackSnapshot(): ITabStackUndoSnapshot {
		return {
			editors: [...this.editors],
			tabStackOfEditor: new Map(this.tabStackOfEditor),
			tabStackStates: new Map([...this.tabStackStates].map(([id, { label, color, collapsed }]) => [id, { label, color, collapsed }]))
		};
	}

	/**
	 * Restores a snapshot while the editors and their tab stacks still equal `expected`, and returns
	 * `undefined` without changing anything otherwise.
	 */
	restoreTabStackSnapshot(snapshot: ITabStackUndoSnapshot, expected: ITabStackUndoSnapshot): ITabStackOperationResult | undefined {
		const matchesExpected = expected.editors.length === this.editors.length
			&& expected.editors.every((editor, index) => this.editors[index] === editor)
			&& expected.tabStackOfEditor.size === this.tabStackOfEditor.size
			&& [...expected.tabStackOfEditor].every(([editor, tabStack]) => this.tabStackOfEditor.get(editor) === tabStack);
		if (!this.tabStacksEnabled || !matchesExpected || snapshot.editors.length !== this.editors.length || snapshot.editors.some(editor => !this.editors.includes(editor))) {
			return undefined;
		}

		return this.withTabStacksChangeEvent(() => {
			const moves: ITabStackEditorMove[] = [];
			snapshot.editors.forEach((editor, index) => this.moveEditorForTabStacks(editor, index, moves));

			this.tabStackOfEditor.clear();
			this.tabStackStates.clear();
			for (const [tabStack, state] of snapshot.tabStackStates) {
				const holdsActiveEditor = !!this.active && snapshot.tabStackOfEditor.get(this.active) === tabStack;
				this.tabStackStates.set(tabStack, { ...state, collapsed: state.collapsed && !holdsActiveEditor, size: 0 });
			}
			for (const [editor, tabStack] of snapshot.tabStackOfEditor) {
				const state = this.tabStackStates.get(tabStack);
				if (state) {
					state.size++;
					this.tabStackOfEditor.set(editor, tabStack);
				}
			}
			this.markTabStacksChanged();

			return { moves, pinned: [] };
		});
	}

	/**
	 * Changes the tab stack of one editor, or removes it from its tab stack for `undefined`, keeping
	 * the invariants of {@link ITabStack}.
	 */
	private setTabStack(editor: EditorInput, tabStack: TabStackId | undefined, pinned?: EditorInput[]): void {
		const previousTabStack = this.tabStackOfEditor.get(editor);
		if (previousTabStack === tabStack) {
			return;
		}

		if (tabStack !== undefined) {
			const state = this.tabStackStates.get(tabStack);
			const index = this.editors.indexOf(editor);
			if (!state || index < 0 || this.isSticky(index)) {
				return;
			}

			if (!this.isPinned(editor)) {
				this.doPin(editor, index);
				pinned?.push(editor);
			}

			if (editor === this.active) {
				state.collapsed = false;
			}

			state.size++;
			this.tabStackOfEditor.set(editor, tabStack);
		} else {
			this.tabStackOfEditor.delete(editor);
		}

		if (previousTabStack !== undefined) {
			const previousState = this.tabStackStates.get(previousTabStack);
			if (previousState && --previousState.size === 0) {
				this.tabStackStates.delete(previousTabStack);
			}
		}

		this.markTabStacksChanged();
	}

	/**
	 * Decides the tab stack of each run of moved editors: the one it sits inside of, else the one
	 * all its editors had if that stays adjacent, else none. `targetTabStack` wins where it keeps
	 * every tab stack adjacent.
	 */
	private assignTabStacksAfterMove(tabStacksBeforeMove: ReadonlyMap<EditorInput, TabStackId | undefined>, targetTabStack: TabStackId | null | undefined, pinned: EditorInput[]): void {
		const assignments: [EditorInput, TabStackId | undefined][] = [];

		let runStart = -1;
		for (let index = 0; index <= this.editors.length; index++) {
			const editor = this.editors.at(index);
			const isMoved = !!editor && tabStacksBeforeMove.has(editor);
			const isInRun = isMoved && !this.isSticky(index);

			if (editor && isMoved && !isInRun) {
				assignments.push([editor, undefined]);
			}

			if (isInRun && runStart === -1) {
				runStart = index;
			} else if (!isInRun && runStart !== -1) {
				const run = this.editors.slice(runStart, index);
				const tabStack = this.getTabStackForRun(runStart, run, tabStacksBeforeMove, targetTabStack);
				for (const runEditor of run) {
					assignments.push([runEditor, tabStack]);
				}

				runStart = -1;
			}
		}

		for (const [editor, tabStack] of assignments) {
			this.setTabStack(editor, tabStack, pinned);
		}

		this.deselectHiddenEditors();
	}

	private getTabStackForRun(runStart: number, run: readonly EditorInput[], tabStacksBeforeMove: ReadonlyMap<EditorInput, TabStackId | undefined>, targetTabStack: TabStackId | null | undefined): TabStackId | undefined {
		const tabStackBefore = this.getTabStackAtIndex(runStart - 1);
		const tabStackAfter = this.getTabStackAtIndex(runStart + run.length);
		const surroundingTabStack = tabStackBefore === tabStackAfter ? tabStackBefore : undefined;

		const canKeepTabStack = (tabStack: TabStackId) => tabStackBefore === tabStack || tabStackAfter === tabStack || !this.hasTabStackEditorOutsideRun(tabStack, runStart, run.length, tabStacksBeforeMove);

		if (targetTabStack === null && surroundingTabStack === undefined) {
			return undefined;
		}

		const canJoinTargetTabStack = typeof targetTabStack === 'string' && this.tabStackStates.has(targetTabStack) && (surroundingTabStack ?? targetTabStack) === targetTabStack;
		if (canJoinTargetTabStack && canKeepTabStack(targetTabStack)) {
			return targetTabStack;
		}

		if (surroundingTabStack !== undefined) {
			return surroundingTabStack;
		}

		const previousTabStack = tabStacksBeforeMove.get(run[0]);
		if (previousTabStack !== undefined && run.every(editor => tabStacksBeforeMove.get(editor) === previousTabStack) && canKeepTabStack(previousTabStack)) {
			return previousTabStack;
		}

		return undefined;
	}

	/**
	 * Returns whether an editor outside the run and the sticky editors belongs to the tab stack, as
	 * of before the move for moved editors.
	 */
	private hasTabStackEditorOutsideRun(tabStack: TabStackId, runStart: number, runLength: number, tabStacksBeforeMove: ReadonlyMap<EditorInput, TabStackId | undefined>): boolean {
		return this.editors.some((editor, index) => {
			if ((index >= runStart && index < runStart + runLength) || this.isSticky(index)) {
				return false;
			}

			return (tabStacksBeforeMove.has(editor) ? tabStacksBeforeMove.get(editor) : this.tabStackOfEditor.get(editor)) === tabStack;
		});
	}

	/**
	 * Moves editors, sorted by index, next to each other right before the editor at `destination`, as
	 * single moves that each leave a valid state. Tab stack membership is left unchanged.
	 */
	private moveEditorsBefore(editors: readonly EditorInput[], destination: number, moves: ITabStackEditorMove[]): void {
		const editorsMovingRight = editors.filter(editor => this.editors.indexOf(editor) < destination);
		const editorsMovingLeft = editors.filter(editor => this.editors.indexOf(editor) >= destination);

		for (let i = editorsMovingRight.length - 1; i >= 0; i--) {
			this.moveEditorForTabStacks(editorsMovingRight[i], destination - editorsMovingRight.length + i, moves);
		}

		for (let i = 0; i < editorsMovingLeft.length; i++) {
			this.moveEditorForTabStacks(editorsMovingLeft[i], destination + i, moves);
		}
	}

	private moveEditorForTabStacks(editor: EditorInput, toIndex: number, moves: ITabStackEditorMove[]): void {
		const index = this.editors.indexOf(editor);
		if (index !== toIndex) {
			this.doMoveEditor(editor, index, toIndex);
			moves.push({ editor, from: index, to: toIndex });
		}
	}

	/**
	 * Returns where a new editor that would open at `index` opens, and the tab stack it joins. An index
	 * inside a tab stack moves to its start when opening left of the active editor, else to its end.
	 */
	private computeTabStackInsertion(editors: readonly EditorInput[], index: number, options: IEditorOpenOptions | undefined): { index: number; tabStack: TabStackId | undefined } {
		const tabStackBefore = index > 0 ? this.tabStackOfEditor.get(editors[index - 1]) : undefined;
		const tabStackAfter = index < editors.length ? this.tabStackOfEditor.get(editors[index]) : undefined;

		const hintedTabStack = options?.tabStack;
		const isHintedTabStackAdjacent = hintedTabStack !== undefined && this.tabStackStates.has(hintedTabStack) && (tabStackBefore === hintedTabStack || tabStackAfter === hintedTabStack);
		if (isHintedTabStackAdjacent) {
			return { index, tabStack: hintedTabStack };
		}

		const surroundingTabStack = this.getSurroundingTabStack(editors, index);
		if (surroundingTabStack === undefined) {
			return { index, tabStack: undefined };
		}

		const opensLeftOfActiveEditor = typeof options?.index !== 'number' && this.editorOpenPositioning === EditorOpenPositioning.LEFT;
		const edgeIndex = opensLeftOfActiveEditor ? this.getGapBeforeTabStack(editors, index, surroundingTabStack) : this.getGapAfterTabStack(editors, index, surroundingTabStack);

		return { index: edgeIndex, tabStack: undefined };
	}

	/**
	 * Returns the index right after the editors of the tab stack from `index` on, or `index` when the
	 * editor there is not in it.
	 */
	private getGapAfterTabStack(editors: readonly EditorInput[], index: number, tabStack: TabStackId): number {
		let gap = index;
		while (gap < editors.length && this.tabStackOfEditor.get(editors[gap]) === tabStack) {
			gap++;
		}

		return gap;
	}

	/**
	 * Returns the index of the first editor of the tab stack that ends right before `index`, or
	 * `index` when the editor before it is not in it.
	 */
	private getGapBeforeTabStack(editors: readonly EditorInput[], index: number, tabStack: TabStackId): number {
		let gap = index;
		while (gap > 0 && this.tabStackOfEditor.get(editors[gap - 1]) === tabStack) {
			gap--;
		}

		return gap;
	}

	/**
	 * Returns the tab stack that the editors on both sides of the gap before `index` share, if any.
	 */
	private getSurroundingTabStack(editors: readonly EditorInput[], index: number): TabStackId | undefined {
		if (index <= 0 || index >= editors.length) {
			return undefined;
		}

		const tabStack = this.tabStackOfEditor.get(editors[index - 1]);

		return tabStack !== undefined && this.tabStackOfEditor.get(editors[index]) === tabStack ? tabStack : undefined;
	}

	private getTabStackAtIndex(index: number): TabStackId | undefined {
		if (index < 0 || index >= this.editors.length || this.isSticky(index)) {
			return undefined;
		}

		return this.tabStackOfEditor.get(this.editors[index]);
	}

	private groupByTabStack(editors: readonly EditorInput[]): Map<TabStackId, EditorInput[]> {
		const editorsOfTabStack = new Map<TabStackId, EditorInput[]>();
		for (const editor of editors) {
			const tabStack = this.tabStackOfEditor.get(editor);
			if (tabStack === undefined) {
				continue;
			}

			let tabStackEditors = editorsOfTabStack.get(tabStack);
			if (!tabStackEditors) {
				tabStackEditors = [];
				editorsOfTabStack.set(tabStack, tabStackEditors);
			}

			tabStackEditors.push(editor);
		}

		return editorsOfTabStack;
	}

	private getTabStackEditors(tabStack: TabStackId): EditorInput[] {
		return this.editors.filter(editor => this.tabStackOfEditor.get(editor) === tabStack);
	}

	private getTabStackState(editor: EditorInput): ITabStackState | undefined {
		const tabStack = this.tabStackOfEditor.get(editor);

		return tabStack !== undefined ? this.tabStackStates.get(tabStack) : undefined;
	}

	private isHiddenInTabStack(editor: EditorInput): boolean {
		return !!this.getTabStackState(editor)?.collapsed;
	}

	private deselectHiddenEditors(): void {
		const inactiveSelectedEditors = this.selection.filter(editor => editor !== this.active);
		const visibleSelectedEditors = inactiveSelectedEditors.filter(editor => !this.isHiddenInTabStack(editor));
		if (visibleSelectedEditors.length !== inactiveSelectedEditors.length) {
			this.doSetSelection(this.active, this.indexOf(this.active), visibleSelectedEditors);
		}
	}

	private findVisibleEditor(rightFrom: number, leftFrom: number): EditorInput | undefined {
		for (let index = rightFrom; index < this.editors.length; index++) {
			if (!this.isHiddenInTabStack(this.editors[index])) {
				return this.editors[index];
			}
		}

		for (let index = leftFrom; index >= 0; index--) {
			if (!this.isHiddenInTabStack(this.editors[index])) {
				return this.editors[index];
			}
		}

		return undefined;
	}

	private getLeastUsedTabStackColor(): TabStackPresetColor {
		const usage = TAB_STACK_COLORS.map(() => 0);
		for (const { color } of this.tabStackStates.values()) {
			if (isTabStackPresetColor(color)) {
				usage[TAB_STACK_COLORS.indexOf(color)]++;
			}
		}

		return TAB_STACK_COLORS[usage.indexOf(Math.min(...usage))];
	}

	/**
	 * Returns the editors of the group that match the candidates, without duplicates and in
	 * sequential order.
	 */
	private resolveEditors(candidates: readonly EditorInput[]): EditorInput[] {
		const editors = new Set<EditorInput>();
		for (const candidate of candidates) {
			const editor = this.findEditor(candidate)?.[0];
			if (editor) {
				editors.add(editor);
			}
		}

		return this.editors.filter(editor => editors.has(editor));
	}

	private markTabStacksChanged(): void {
		this.tabStacksSnapshot = undefined;
		this.tabStacksChanged = true;
	}

	private flushTabStacksChange(): void {
		if (this.tabStacksChanged) {
			this.tabStacksChanged = false;

			this._onDidModelChange.fire({ kind: GroupModelChangeKind.TAB_STACKS });
		}
	}

	/**
	 * Runs a public operation and fires one TAB_STACKS event for its pending change once the outermost
	 * operation ends. Only expanding the tab stack of an editor that becomes active fires earlier.
	 */
	private withTabStacksChangeEvent<T>(operation: () => T): T {
		this.tabStackOperationDepth++;
		try {
			return operation();
		} finally {
			this.tabStackOperationDepth--;
			if (this.tabStackOperationDepth === 0) {
				this.flushTabStacksChange();
			}
		}
	}

	//#endregion
}
