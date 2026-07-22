import { Injectable, signal } from '@angular/core';
import {
    GameObject,
    SceneSerializer,
    type SerializedGameObject,
} from 'WebEngineTS';

/**
 * Editor clipboard for GameObjects.
 *
 * @remarks
 * Stores serialized snapshots so paste produces independent deep copies
 * (matching Unity behavior). Lives in memory only — no OS clipboard
 * integration yet.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardService {

    /** Current copied snapshots, in original selection order. Null when empty. */
    public readonly snapshots = signal<readonly SerializedGameObject[] | null>(null);

    /** Whether something is currently in the clipboard. */
    public hasContent(): boolean {
        const s = this.snapshots();
        return !!s && s.length > 0;
    }

    /** Copies the given GameObjects' snapshots into the clipboard. */
    public copy(gos: ReadonlyArray<GameObject>): void {
        if (gos.length === 0) {
            this.snapshots.set(null);
            return;
        }
        const snaps = gos.map(g => SceneSerializer.serializeGameObject(g));
        this.snapshots.set(snaps);
    }

    /**
     * Reconstructs the clipboard contents and returns the new GameObjects.
     * Each pasted root gets " (Clone)" appended to its name (Unity convention).
     */
    public paste(): GameObject[] {
        const snaps = this.snapshots();
        if (!snaps || snaps.length === 0) return [];
        const out: GameObject[] = [];
        for (const snap of snaps) {
            const cloned = { ...snap, name: `${snap.name} (Clone)` };
            out.push(SceneSerializer.deserializeGameObject(cloned));
        }
        return out;
    }
}
