import { Injectable, inject, signal } from '@angular/core';
import { SceneSerializer, type SerializedScene } from 'WebEngineTS';
import { SceneService } from './scene.service';
import { SelectionService } from './selection.service';

interface HistoryEntry {
    label: string;
    snapshot: SerializedScene;
    /** performance.now() when this entry was last (re-)created. */
    time: number;
}

/**
 * Editor undo/redo stack based on whole-scene snapshots.
 *
 * @remarks
 * Every mutating editor action wraps itself in {@link record} which takes
 * a snapshot BEFORE the action runs and pushes it onto the undo stack.
 * Calling {@link undo} rewinds to the previous snapshot by reloading it;
 * {@link redo} moves forward again.
 *
 * **Coalescing:** consecutive `record(label, action)` calls with the same
 * label inside a 500 ms window do NOT push a new snapshot — they only run
 * the action. The first edit's pre-state stays the undo target, so
 * dragging a slider or typing into an input produces a single undo step
 * for the whole edit "session" instead of one per keystroke.
 *
 * Snapshot-based history is coarser than a command pattern but handles
 * every possible mutation uniformly (create, delete, rename, transform,
 * component add/remove, field edits) without per-action bookkeeping.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {

    /** Maximum retained snapshots (oldest are discarded). */
    public static readonly MAX = 30;

    /** Window in ms — same-label `record` calls within this window coalesce. */
    public static readonly COALESCE_MS = 500;

    private readonly _scene = inject(SceneService);
    private readonly _selection = inject(SelectionService);

    private _undoStack: HistoryEntry[] = [];
    private _redoStack: HistoryEntry[] = [];

    /** True if an undo is available. Drives toolbar button state. */
    public readonly canUndo = signal(false);
    /** True if a redo is available. */
    public readonly canRedo = signal(false);

    /**
     * Captures the current scene, runs `action`, clears redo.
     *
     * Consecutive calls with the same `label` within {@link COALESCE_MS}
     * don't push a new snapshot — they extend the previous edit session.
     */
    public record(label: string, action: () => void): void {
        const now = performance.now();
        const last = this._undoStack[this._undoStack.length - 1];
        const coalesce = !!last
            && last.label === label
            && (now - last.time) < HistoryService.COALESCE_MS;

        let snapshotPushed = false;
        if (!coalesce) {
            const snap = this._scene.serialize();
            this._push(label, snap, now);
            snapshotPushed = true;
        } else {
            // Refresh the timestamp so further edits keep coalescing.
            last.time = now;
        }
        try {
            action();
        } catch (err) {
            if (snapshotPushed) {
                this._undoStack.pop();
                this._refreshFlags();
            }
            throw err;
        }
    }

    /**
     * Forces the next `record(label, …)` to start a fresh undo entry
     * even if it lands within the coalesce window.
     *
     * Call this from blur / pointer-up / selection-change events to end
     * the current "edit session" cleanly.
     */
    public commitPendingEdit(): void {
        const last = this._undoStack[this._undoStack.length - 1];
        if (last) last.time = 0;
    }

    /** Rewinds one step. No-op if the stack is empty. */
    public undo(): void {
        const entry = this._undoStack.pop();
        if (!entry) return;
        const current = this._scene.serialize();
        this._redoStack.push({ label: entry.label, snapshot: current, time: performance.now() });
        this._applySnapshot(entry.snapshot);
        this._refreshFlags();
    }

    /** Re-applies the last undone action. No-op if nothing to redo. */
    public redo(): void {
        const entry = this._redoStack.pop();
        if (!entry) return;
        const current = this._scene.serialize();
        this._undoStack.push({ label: entry.label, snapshot: current, time: performance.now() });
        this._applySnapshot(entry.snapshot);
        this._refreshFlags();
    }

    /** Drops all history (used on New / Open). */
    public clear(): void {
        this._undoStack = [];
        this._redoStack = [];
        this._refreshFlags();
    }

    // ── internal ─────────────────────────────────────────────────────

    private _push(label: string, snap: SerializedScene, time: number): void {
        this._undoStack.push({ label, snapshot: snap, time });
        if (this._undoStack.length > HistoryService.MAX) {
            this._undoStack.shift();
        }
        this._redoStack = [];
        this._refreshFlags();
    }

    private _applySnapshot(snap: SerializedScene): void {
        this._selection.clear();
        this._scene.loadFromJSON(snap);
    }

    private _refreshFlags(): void {
        this.canUndo.set(this._undoStack.length > 0);
        this.canRedo.set(this._redoStack.length > 0);
    }
}
