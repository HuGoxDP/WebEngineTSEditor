import * as THREE from 'three';
import { GameObject, SceneManager } from 'WebEngineTS';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * Picking and rectangle selection for the Scene view (B1 phase 5; D-10).
 *
 * Click = select the nearest hit, empty = clear, Shift = toggle in, Ctrl =
 * toggle out; an LMB drag on empty space draws a rectangle and selects every
 * object whose projected world bounds **intersect** it. Both work in engine
 * space in the sense that matters to the user — the raycast runs in three
 * space, where the engine scene is rendered, and the answers are engine
 * GameObjects.
 *
 * The projection uses the renderer bounds' eight corners (the same box the
 * inspector and the camera's `frame` use), which makes "the cube is inside the
 * rectangle" mean what it looks like; objects behind the camera are dropped
 * first, because a behind-the-camera point projects to nonsense.
 */

/** What a pointer press on the canvas means. */
export type PickModifier = 'set' | 'toggle' | 'remove';

export class ScenePicker {

    private readonly _renderer: SceneViewRenderer;
    private readonly _raycaster = new THREE.Raycaster();
    private readonly _ndc = new THREE.Vector2();

    constructor(renderer: SceneViewRenderer) {
        this._renderer = renderer;
    }

    /** The GameObject nearest the ray through this client pixel, or null. */
    public pick(clientX: number, clientY: number): GameObject | null {
        const camera = this._renderer.camera;
        const rect = this._renderer.canvasRect;
        if (!camera || !rect || rect.width === 0) return null;
        this._ndc.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        this._raycaster.setFromCamera(this._ndc, camera);
        const scene = SceneManager.activeScene._internalThreeScene;
        const hits = this._raycaster.intersectObjects(scene.children, true);
        for (const hit of hits) {
            const go = this._ownerOf(hit.object);
            if (go) return go;
        }
        return null;
    }

    /**
     * Every GameObject whose projected bounds intersect this rectangle (client
     * pixels), or whose pivot lies inside when it has no renderer bounds.
     */
    public pickRect(rect: { left: number; top: number; right: number; bottom: number }): GameObject[] {
        const found: GameObject[] = [];
        for (const go of this._allObjects()) {
            const object = go.transform._internalObject3D;
            if (!this._inFront(object)) continue;
            const box = new THREE.Box3().setFromObject(object);
            if (box.isEmpty()) {
                // No bounds: the pivot is the only point there is.
                if (this._pointInside(this._project(object), rect)) found.push(go);
                continue;
            }
            const corners: THREE.Vector3[] = [];
            for (const sx of [box.min.x, box.max.x]) {
                for (const sy of [box.min.y, box.max.y]) {
                    for (const sz of [box.min.z, box.max.z]) {
                        corners.push(this._projectPoint(new THREE.Vector3(sx, sy, sz), object));
                    }
                }
            }
            if (corners.some(c => this._pointInside(c, rect))
                || this._rectHitsBox(corners, rect)) {
                found.push(go);
            }
        }
        return found;
    }

    /** The screen-space bounds of an object, for the probe's read-back. */
    public screenRect(name: string): { left: number; top: number; right: number; bottom: number } | null {
        for (const go of this._allObjects()) {
            if (go.name !== name) continue;
            const object = go.transform._internalObject3D;
            if (!this._inFront(object)) return null;
            const box = new THREE.Box3().setFromObject(object);
            if (box.isEmpty()) {
                const p = this._projectPoint(object.getWorldPosition(new THREE.Vector3()), object);
                return { left: p.x, top: p.y, right: p.x, bottom: p.y };
            }
            let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
            for (const sx of [box.min.x, box.max.x]) {
                for (const sy of [box.min.y, box.max.y]) {
                    for (const sz of [box.min.z, box.max.z]) {
                        const c = this._projectPoint(new THREE.Vector3(sx, sy, sz), object);
                        left = Math.min(left, c.x); top = Math.min(top, c.y);
                        right = Math.max(right, c.x); bottom = Math.max(bottom, c.y);
                    }
                }
            }
            return { left, top, right, bottom };
        }
        return null;
    }

    // ── Internals ──────────────────────────────────────────────────────

    /** The GameObject whose tree owns this three object, if any. */
    private _ownerOf(object: THREE.Object3D): GameObject | null {
        const map = ScenePicker._objectMap();
        let target: THREE.Object3D | null = object;
        while (target) {
            const go = map.get(target);
            if (go) return go;
            target = target.parent;
        }
        return null;
    }

    /** The object→GameObject map for the live scene, cached per frame. */
    private static _objectMap(): Map<THREE.Object3D, GameObject> {
        const scene = SceneManager.activeScene;
        const cache = ScenePicker._cache;
        if (cache.scene === scene) return cache.map;
        const map = new Map<THREE.Object3D, GameObject>();
        const walk = (go: GameObject): void => {
            map.set(go.transform._internalObject3D, go);
            const t = go.transform;
            for (let i = 0; i < t.childCount; i++) walk(t.getChild(i).gameObject);
        };
        for (const root of scene.getRootGameObjects()) walk(root);
        ScenePicker._cache = { scene, map };
        return map;
    }
    private static _cache: { scene: unknown; map: Map<THREE.Object3D, GameObject> } = { scene: null, map: new Map() };

    private _allObjects(): GameObject[] {
        const out: GameObject[] = [];
        const walk = (go: GameObject): void => {
            out.push(go);
            const t = go.transform;
            for (let i = 0; i < t.childCount; i++) walk(t.getChild(i).gameObject);
        };
        for (const root of SceneManager.activeScene.getRootGameObjects()) walk(root);
        return out;
    }

    /** Whether the object is in front of the editor camera. */
    private _inFront(object: THREE.Object3D): boolean {
        const camera = this._renderer.camera;
        if (!camera) return false;
        const p = object.getWorldPosition(new THREE.Vector3());
        const toPoint = p.clone().sub(camera.position);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        return toPoint.dot(forward) > 0;
    }

    /** A world point → client pixels (the probe's read-back and the rect hit). */
    private _projectPoint(world: THREE.Vector3, object?: THREE.Object3D): THREE.Vector3 {
        object?.updateWorldMatrix(true, false);
        const camera = this._renderer.camera!;
        camera.updateMatrixWorld();
        const p = world.clone().project(camera);
        const rect = this._renderer.canvasRect!;
        return new THREE.Vector3(
            rect.left + ((p.x + 1) / 2) * rect.width,
            rect.top + ((1 - p.y) / 2) * rect.height,
            0,
        );
    }

    private _project(object: THREE.Object3D): THREE.Vector3 {
        return this._projectPoint(object.getWorldPosition(new THREE.Vector3()), object);
    }

    private _pointInside(p: THREE.Vector3, rect: { left: number; top: number; right: number; bottom: number }): boolean {
        return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
    }

    /**
     * Whether a box's projected corners surround the rectangle's edges — the
     * "partially inside" case, where no corner is inside but an edge crosses.
     */
    private _rectHitsBox(corners: readonly THREE.Vector3[], rect: { left: number; top: number; right: number; bottom: number }): boolean {
        const minX = Math.min(...corners.map(c => c.x));
        const maxX = Math.max(...corners.map(c => c.x));
        const minY = Math.min(...corners.map(c => c.y));
        const maxY = Math.max(...corners.map(c => c.y));
        // The rectangles overlap on both axes.
        return maxX >= rect.left && minX <= rect.right && maxY >= rect.top && minY <= rect.bottom;
    }
}
