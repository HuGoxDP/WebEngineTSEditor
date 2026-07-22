import { Injectable, signal } from '@angular/core';
import {
    GameObject,
    SceneManager,
    SceneSerializer,
    type SerializedScene,
} from 'WebEngineTS';

/**
 * Editor-side wrapper over the engine's scene.
 *
 * Exposes a revision signal that bumps whenever the scene structure
 * changes (GameObjects added / removed / re-parented). Components that
 * render the hierarchy subscribe via `effect` on this signal.
 */
@Injectable({ providedIn: 'root' })
export class SceneService {

    /** Bumped whenever the hierarchy changes. Pure integer counter. */
    public readonly revision = signal(0);

    /** Current list of root GameObjects (captured on each revision). */
    public readonly roots = signal<GameObject[]>([]);

    constructor() {
        this._refresh();
    }

    /** Creates a new empty GameObject at the scene root. */
    public createEmpty(name: string = 'GameObject'): GameObject {
        const go = new GameObject(name);
        this._refresh();
        return go;
    }

    /** Removes a GameObject from the scene. */
    public destroy(go: GameObject): void {
        go.destroy();
        this._refresh();
    }

    /** Renames a GameObject and refreshes the hierarchy. */
    public rename(go: GameObject, name: string): void {
        go.name = name;
        this._refresh();
    }

    /** Call after external mutations so panels refresh. */
    public notify(): void {
        this._refresh();
    }

    /** Removes every GameObject from the active scene. */
    public clear(): void {
        for (const go of [...SceneManager.activeScene.getRootGameObjects()]) {
            go.destroy();
        }
        this._refresh();
    }

    /** Serializes the active scene to a JSON snapshot. */
    public serialize(): SerializedScene {
        return SceneSerializer.serializeScene(SceneManager.activeScene);
    }

    /** Replaces the active scene contents with the given snapshot. */
    public loadFromJSON(json: SerializedScene): void {
        this.clear();
        SceneSerializer.deserializeScene(json);
        this._refresh();
    }

    private _refresh(): void {
        this.roots.set([...SceneManager.activeScene.getRootGameObjects()]);
        this.revision.update(n => n + 1);
    }
}
