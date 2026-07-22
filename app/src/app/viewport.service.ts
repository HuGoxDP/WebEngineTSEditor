import { EffectRef, Injectable, Injector, NgZone, effect, signal } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
    GameObject,
    Quaternion,
    SceneManager,
    Transform,
    Vector3,
} from 'WebEngineTS';
import { SelectionService } from './services/selection.service';

/** Current mode of the transform gizmo. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Owns the Three.js renderer, the editor camera, and the animation loop.
 *
 * Renders the engine's active Scene (`SceneManager.activeScene._internalThreeScene`)
 * plus an editor-only overlay scene with the grid and axes helpers.
 * Dirty transforms are flushed before each draw via `Transform._syncAllDirty`.
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {

    private _renderer: THREE.WebGLRenderer | null = null;
    private _camera: THREE.PerspectiveCamera | null = null;
    private _controls: OrbitControls | null = null;
    private _overlay: THREE.Scene | null = null;
    private _rafId: number = 0;
    private _resizeObs: ResizeObserver | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private _raycaster: THREE.Raycaster = new THREE.Raycaster();
    private _ndc: THREE.Vector2 = new THREE.Vector2();
    private _pointerDown: { x: number; y: number } | null = null;
    private _gizmo: TransformControls | null = null;
    private _gizmoHelper: THREE.Object3D | null = null;
    private _selectionEffect: EffectRef | null = null;
    private _outline: THREE.BoxHelper | null = null;

    /** Rolling FPS sample, updated each second. */
    public readonly fps = signal(0);
    /** Last frame time in milliseconds. */
    public readonly frameMs = signal(0);
    private _frames: number = 0;
    private _fpsLastT: number = 0;
    private _lastT: number = 0;

    constructor(
        private readonly _zone: NgZone,
        private readonly _selection: SelectionService,
        private readonly _injector: Injector,
    ) {}

    /** Initializes the viewport on the given canvas. Idempotent. */
    public attach(canvas: HTMLCanvasElement): void {
        if (this._renderer) return;
        this._canvas = canvas;

        this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this._renderer.setPixelRatio(window.devicePixelRatio);
        this._renderer.autoClear = false;

        // ── Pointer selection (click vs. drag detection) ──
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointerup',   this._onPointerUp);

        // ── Editor overlay (grid + axes) ──
        const overlay = new THREE.Scene();
        const grid = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
        overlay.add(grid);
        const axes = new THREE.AxesHelper(2);
        overlay.add(axes);
        this._overlay = overlay;

        // ── Editor camera ──
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
        camera.position.set(6, 6, 10);
        camera.lookAt(0, 0, 0);
        this._camera = camera;

        // ── Orbit controls ──
        const controls = new OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        this._controls = controls;

        // ── Lights live in the editor scene, not the engine scene ──
        // Users can add their own lights via GameObjects.
        const hemi = new THREE.HemisphereLight(0xffffff, 0x303030, 1.0);
        overlay.add(hemi);
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(5, 10, 5);
        overlay.add(dir);

        // ── Transform gizmo ──
        const gizmo = new TransformControls(camera, canvas);
        gizmo.setSize(0.8);
        gizmo.addEventListener('dragging-changed', e => {
            // Lock the orbit camera while dragging a gizmo handle.
            controls.enabled = !(e as unknown as { value: boolean }).value;
        });
        gizmo.addEventListener('change', () => this._syncGizmoToEngine());
        // Three.js r169+ uses getHelper(); older versions used the gizmo itself.
        const helper: THREE.Object3D = (gizmo as unknown as { getHelper?: () => THREE.Object3D })
            .getHelper?.() ?? (gizmo as unknown as THREE.Object3D);
        overlay.add(helper);
        this._gizmo = gizmo;
        this._gizmoHelper = helper;

        // Selection outline — a BoxHelper we re-attach on each selection change.
        // Lives in the overlay so it always renders on top of the engine scene.
        this._selectionEffect = effect(() => {
            const go = this._selection.selected();
            this._selection.revision();

            // Gizmo
            if (this._gizmo) {
                if (go) this._gizmo.attach(go.transform._internalObject3D);
                else    this._gizmo.detach();
            }

            // Outline
            if (this._outline) {
                overlay.remove(this._outline);
                this._outline.dispose();
                this._outline = null;
            }
            if (go) {
                const helper = new THREE.BoxHelper(go.transform._internalObject3D, 0x4ade80);
                // Recompute the box every frame in _loop so it tracks transform changes.
                this._outline = helper;
                overlay.add(helper);
            }
        }, { injector: this._injector });

        this._resize(canvas);
        this._resizeObs = new ResizeObserver(() => this._resize(canvas));
        this._resizeObs.observe(canvas);

        this._zone.runOutsideAngular(() => this._loop());
    }

    /** Releases GPU resources and stops the loop. */
    public detach(): void {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;
        this._resizeObs?.disconnect();
        this._resizeObs = null;
        if (this._canvas) {
            this._canvas.removeEventListener('pointerdown', this._onPointerDown);
            this._canvas.removeEventListener('pointerup',   this._onPointerUp);
        }
        this._canvas = null;
        if (this._gizmo) {
            this._gizmo.detach();
            this._gizmo.dispose();
            this._gizmo = null;
        }
        this._gizmoHelper = null;
        this._selectionEffect?.destroy();
        this._selectionEffect = null;
        this._outline?.dispose();
        this._outline = null;
        this._controls?.dispose();
        this._controls = null;
        this._renderer?.dispose();
        this._renderer = null;
        this._overlay = null;
        this._camera = null;
    }

    /** Sets the gizmo mode. Keyboard shortcuts: W translate, E rotate, R scale. */
    public setGizmoMode(mode: GizmoMode): void {
        this._gizmo?.setMode(mode);
    }

    /** The editor camera. Used by selection raycasting in later milestones. */
    public get camera(): THREE.PerspectiveCamera | null { return this._camera; }

    private _loop = (): void => {
        if (!this._renderer || !this._camera || !this._overlay) return;
        this._rafId = requestAnimationFrame(this._loop);
        this._controls?.update();

        // Flush dirty engine transforms before we render the engine scene.
        Transform._syncAllDirty();

        // Keep the selection outline in sync with the target's current bounds.
        this._outline?.update();

        const engineScene = SceneManager.activeScene._internalThreeScene;

        this._renderer.clear();
        this._renderer.render(this._overlay, this._camera);
        this._renderer.render(engineScene, this._camera);

        // ── FPS / frame time bookkeeping (zone-free signal updates) ──
        const now = performance.now();
        if (this._lastT) this.frameMs.set(+(now - this._lastT).toFixed(1));
        this._lastT = now;
        this._frames++;
        if (now - this._fpsLastT >= 1000) {
            const elapsed = now - this._fpsLastT || 1;
            this.fps.set(Math.round((this._frames / elapsed) * 1000));
            this._frames = 0;
            this._fpsLastT = now;
        }
    };

    /**
     * Frames the orbit camera on the given GameObject — moves the orbit
     * target to the object's bounding-box center and steps the camera
     * back to a sensible distance so the whole object is visible.
     */
    public frameOnObject(obj3d: THREE.Object3D): void {
        if (!this._camera || !this._controls) return;
        const box = new THREE.Box3().setFromObject(obj3d);
        if (box.isEmpty()) {
            // Fallback to the object's local origin.
            obj3d.updateMatrixWorld(true);
            const p = new THREE.Vector3();
            p.setFromMatrixPosition(obj3d.matrixWorld);
            this._controls.target.copy(p);
            this._controls.update();
            return;
        }
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const radius = Math.max(size.x, size.y, size.z) * 0.6 || 1;
        // Distance fitted to vertical FOV with a small padding.
        const fov = (this._camera.fov * Math.PI) / 180;
        const dist = (radius / Math.tan(fov / 2)) * 1.2;

        const dir = this._camera.position.clone().sub(this._controls.target).normalize();
        if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.5, 1).normalize();
        this._camera.position.copy(center).addScaledVector(dir, dist);
        this._controls.target.copy(center);
        this._controls.update();
    }

    private _resize(canvas: HTMLCanvasElement): void {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0 || !this._renderer || !this._camera) return;
        this._renderer.setSize(w, h, false);
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
    }

    // ── Click-to-select ──────────────────────────────────────────────

    private readonly _onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        this._pointerDown = { x: e.clientX, y: e.clientY };
    };

    private readonly _onPointerUp = (e: PointerEvent): void => {
        const down = this._pointerDown;
        this._pointerDown = null;
        if (!down || e.button !== 0) return;
        // If the pointer moved more than a few pixels, treat as orbit, not click.
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (dx * dx + dy * dy > 16) return;
        this._pickAt(e);
    };

    private _pickAt(e: PointerEvent): void {
        if (!this._camera || !this._canvas) return;

        const rect = this._canvas.getBoundingClientRect();
        this._ndc.set(
            ((e.clientX - rect.left) / rect.width)  * 2 - 1,
            -((e.clientY - rect.top)  / rect.height) * 2 + 1,
        );
        this._raycaster.setFromCamera(this._ndc, this._camera);

        Transform._syncAllDirty();
        const scene = SceneManager.activeScene._internalThreeScene;
        const hits = this._raycaster.intersectObjects(scene.children, true);

        // Build Object3D → GameObject map across the current scene.
        const o2g = ViewportService._buildObjectMap();

        this._zone.run(() => {
            for (const hit of hits) {
                let obj: THREE.Object3D | null = hit.object;
                while (obj) {
                    const go = o2g.get(obj);
                    if (go) {
                        this._selection.select(go);
                        return;
                    }
                    obj = obj.parent;
                }
            }
            this._selection.clear();
        });
    }

    /**
     * @internal
     * The gizmo mutates the Three.js Object3D directly. Write those values
     * back into the engine's Transform via its setters, which updates its
     * cached values and re-triggers dirty flagging. Also bumps the
     * SelectionService revision so the Inspector reflects the new values.
     */
    private _syncGizmoToEngine(): void {
        const go = this._selection.selected();
        if (!go) return;
        const obj = go.transform._internalObject3D;
        go.transform.localPosition = new Vector3(obj.position.x, obj.position.y, obj.position.z);
        go.transform.localRotation = new Quaternion(
            obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w,
        );
        go.transform.localScale = new Vector3(obj.scale.x, obj.scale.y, obj.scale.z);
        this._zone.run(() => this._selection.notifyChanged());
    }

    /** @internal Walks the engine scene once and maps each Object3D to its GameObject. */
    private static _buildObjectMap(): Map<THREE.Object3D, GameObject> {
        const map = new Map<THREE.Object3D, GameObject>();
        const roots = SceneManager.activeScene.getRootGameObjects();
        const walk = (go: GameObject): void => {
            map.set(go.transform._internalObject3D, go);
            const t = go.transform;
            for (let i = 0; i < t.childCount; i++) {
                walk(t.getChild(i).gameObject);
            }
        };
        for (const r of roots) walk(r);
        return map;
    }
}
