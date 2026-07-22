import { Injectable, computed, signal } from '@angular/core';
import { GameObject } from 'WebEngineTS';

/**
 * Tracks the editor's selection.
 *
 * @remarks
 * Supports multi-selection. The {@link selected} primary signal drives the
 * Inspector and gizmo (it always points at the last toggled GO so the
 * "active" object behaves predictably). The full {@link selectedSet} is
 * what the Hierarchy uses to render highlights, what Delete acts on, etc.
 */
@Injectable({ providedIn: 'root' })
export class SelectionService {

    /** The primary / "active" GameObject — the inspector and gizmo follow this. */
    public readonly selected = signal<GameObject | null>(null);

    /** Every GameObject that's part of the current selection. */
    public readonly selectedSet = signal<ReadonlySet<GameObject>>(new Set());

    /** Bumped when the selection mutates or when the primary's properties change. */
    public readonly revision = signal(0);

    /** Convenience reactive count — for status bars / inspector header. */
    public readonly count = computed(() => this.selectedSet().size);

    /** Replaces the selection with a single GameObject (or clears it). */
    public select(go: GameObject | null): void {
        const set = new Set<GameObject>();
        if (go) set.add(go);
        this.selectedSet.set(set);
        this.selected.set(go);
        this.revision.update(n => n + 1);
    }

    /** Toggles a GameObject in or out of the selection. */
    public toggle(go: GameObject): void {
        const next = new Set(this.selectedSet());
        if (next.has(go)) {
            next.delete(go);
            const remaining = [...next];
            this.selected.set(remaining.length > 0 ? remaining[remaining.length - 1] : null);
        } else {
            next.add(go);
            this.selected.set(go);
        }
        this.selectedSet.set(next);
        this.revision.update(n => n + 1);
    }

    /** Adds a list of GameObjects to the existing selection. */
    public addToSelection(gos: ReadonlyArray<GameObject>): void {
        if (gos.length === 0) return;
        const next = new Set(this.selectedSet());
        for (const g of gos) next.add(g);
        this.selected.set(gos[gos.length - 1]);
        this.selectedSet.set(next);
        this.revision.update(n => n + 1);
    }

    /** Clears the selection entirely. */
    public clear(): void {
        this.selectedSet.set(new Set());
        this.selected.set(null);
        this.revision.update(n => n + 1);
    }

    /** True if `go` is in the current selection. */
    public isSelected(go: GameObject): boolean {
        return this.selectedSet().has(go);
    }

    /** Snapshot of the current selection as an array (preserves insertion order). */
    public toArray(): GameObject[] {
        return [...this.selectedSet()];
    }

    /** Bump the revision so observers (Inspector, etc.) re-read live values. */
    public notifyChanged(): void {
        this.revision.update(n => n + 1);
    }
}
