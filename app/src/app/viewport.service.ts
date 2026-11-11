import { EffectRef, Injectable, Injector, NgZone, effect, inject, signal } from '@angular/core';
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
    GameObject,
    Quaternion,
    SceneManager,
    Transform,
    Vector3,
    type SerializedScene,
} from 'WebEngineTS';
import { HistoryService } from './services/history.service';
import { SceneService } from './services/scene.service';
import { SelectionService } from './services/selection.service';
import { SettingsService } from './services/settings.service';
import { SceneViewRenderer } from './scene-view/scene-view-renderer';
import { installProbe, probeEnabled } from './scene-view/debug-probe';

/** Current mode of the transform gizmo. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * The Scene view, as the rest of the editor sees it (B1 phase 1).
 *
 * A thin facade over {@link SceneViewRenderer} (the frame, the D-2 layers, the
 * probe) that owns what is editor *behaviour* rather than drawing: the
 * transform gizmo and its engine write-back, the selection outline, click
 * picking, and the orbits. The renderer owns the WebGLRenderer, the camera, the
 * OrbitControls and the overlay scenes; the plan's B1 phases build on that
 * split (navigation controller, tools, selection, gizmos, lighting).
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {

    private readonly _renderer = inject(SceneViewRenderer);
    private _gizmo: TransformControls | null = null;
    private _gizmoHelper: THREE.Object3D | null = null;
    private _selectionEffect: EffectRef | null = null;
    private _snapEffect: EffectRef | null = null;
    private _dragSnapshot: SerializedScene | null = null;
    private _outline: THREE.BoxHelper | null = null;
    private _raycaster: THREE.Raycaster = new THREE.Raycaster();
    private _ndc: THREE.Vector2 = new THREE.Vector2();
    private _pointerDown: { x: number; y: number } | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private _frames: number = 0;
    private _fpsLastT: number = 0;
    private _lastT: number = 0;

    /** Rolling FPS sample, updated each second. */
    public readonly fps = signal(0);
    /** Last frame time in milliseconds. */
    public readonly frameMs = signal(0);

    constructor(
        private readonly _zone: NgZone,
        private readonly _selection: SelectionService,
        private readonly _injector: Injector,
        private readonly _settings: SettingsService,
        private readonly _sceneService: SceneService,
        private readonly _history: HistoryService,
    ) {}

    /** Initializes the viewport on the given canvas. Idempotent. */
    public attach(canvas: HTMLCanvasElement): void {
        if (this._canvas) return;
        this._canvas = canvas;

        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointerup',   this._onPointerUp);

        this._renderer.attach(canvas, () => this._tick());

        const overlay = this._renderer.aboveScene;
        const controls = this._renderer.controls;
        if (!overlay || !controls) return;

        // ── Grid: depth-tested against the engine scene (D-2 step 3) ──
        const grid = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
        this._renderer.addOverlayLayer('grid', grid);

        // ── Transform gizmo ──
        const camera = this._renderer.camera!;
        const gizmo = new TransformControls(camera, canvas);
        gizmo.setSize(0.8);
        gizmo.addEventListener('dragging-changed', e => {
            // Lock the orbit camera while dragging a gizmo handle.
            controls.enabled = !(e as unknown as { value: boolean }).value;
        });
        // A drag mutates the Three.js object directly, outside History.record, so it
        // has to be given an undo entry — and a "changed" mark — by hand. The
        // snapshot is taken when the handle is pressed, before anything moves, and
        // only becomes an entry once the object actually moves: pressing a handle
        // without dragging changes nothing and must not make the scene "unsaved".
        gizmo.addEventListener('mouseDown', () => { this._dragSnapshot = this._sceneService.serialize(); });
        gizmo.addEventListener('mouseUp', () => { this._dragSnapshot = null; });
        gizmo.addEventListener('change', () => {
            if (this._dragSnapshot && this._gizmoMovedObject()) {
                this._history.pushSnapshot('Transform', this._dragSnapshot);
                this._dragSnapshot = null;
            }
            this._syncGizmoToEngine();
        });
        // Three.js r169+ uses getHelper(); older versions used the gizmo itself.
        const helper: THREE.Object3D = (gizmo as unknown as { getHelper?: () => THREE.Object3D })
            .getHelper?.() ?? (gizmo as unknown as THREE.Object3D);
        this._renderer.addOverlayLayer('above-scene', helper);
        this._gizmo = gizmo;
        this._gizmoHelper = helper;

        // Snap step from Preferences; 0 means off.
        this._snapEffect = effect(() => {
            const step = this._settings.gridSnap();
            gizmo.setTranslationSnap(step > 0 ? step : null);
        }, { injector: this._injector });

        // Selection outline — a BoxHelper we re-attach on each selection change.
        // Lives in the on-top layer so it always renders over the engine scene.
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
                this._renderer.removeOverlayLayer(this._outline);
                this._outline.dispose();
                this._outline = null;
            }
            if (go) {
                const helper = new THREE.BoxHelper(go.transform._internalObject3D, 0x4ade80);
                // Recompute the box every frame in _tick so it tracks transform changes.
                this._outline = helper;
                this._renderer.addOverlayLayer('above-scene', helper);
            }
        }, { injector: this._injector });

        // The debug probe (D-13) exists only when the flag is set.
        if (probeEnabled()) {
            installProbe(this._renderer, {
                selection: this._selection,
                canvas: () => this._canvas,
            });
        }
    }

    /** Releases GPU resources and stops the loop. */
    public detach(): void {
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
        this._snapEffect?.destroy();
        this._snapEffect = null;
        this._outline?.dispose();
        this._outline = null;
        this._renderer.detach();
    }

    /** Active gizmo tool — drives the toolbar toggle and the viewport overlay. */
    public readonly tool = signal<GizmoMode>('translate');

    /** Sets the gizmo mode. Keyboard shortcuts: W translate, E rotate, R scale. */
    public setGizmoMode(mode: GizmoMode): void {
        this._gizmo?.setMode(mode);
    }

    /** Switches tool: the signal for the UI, and the gizmo itself. */
    public setTool(mode: GizmoMode): void {
        this.tool.set(mode);
        this.setGizmoMode(mode);
    }

    /** The editor camera. Used by selection raycasting in later milestones. */
    public get camera(): THREE.PerspectiveCamera | null { return this._renderer.camera; }

    /** The Scene-view pivot in engine space — where root creates land (D-3). */
    public get pivot(): { x: number; y: number; z: number } {
        const target = this._renderer.controls?.target ?? new THREE.Vector3();
        return { x: target.x, y: target.y, z: -target.z };
    }

    /** One frame's bookkeeping, run by the renderer's loop before it draws. */
    private _tick(): void {
        // Flush dirty engine transforms before we render the engine scene.
        Transform._syncAllDirty();

        // The gizmo must not outlive the object it is attached to. Undo, loading and
        // closing a project rebuild the scene, and the selection effect that detaches
        // the gizmo runs after this loop has already drawn a frame with the old
        // object — three logs an error for every one of those frames. Checked after
        // the flush, because that is where a destroyed object leaves the scene.
        const attached = this._gizmo?.object;
        if (attached && attached.parent === null) this._gizmo!.detach();

        // Keep the selection outline in sync with the target's current bounds.
        this._outline?.update();

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
    }

    /**
     * Frames the orbit camera on the given GameObject — moves the orbit
     * target to the object's bounding-box center and steps the camera
     * back to a sensible distance so the whole object is visible.
     */
    public frameOnObject(obj3d: THREE.Object3D): void {
        const camera = this._renderer.camera;
        const controls = this._renderer.controls;
        if (!camera || !controls) return;
        const box = new THREE.Box3().setFromObject(obj3d);
        if (box.isEmpty()) {
            // Fallback to the object's local origin.
            obj3d.updateMatrixWorld(true);
            const p = new THREE.Vector3();
            p.setFromMatrixPosition(obj3d.matrixWorld);
            controls.target.copy(p);
            controls.update();
            return;
        }
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const radius = Math.max(size.x, size.y, size.z) * 0.6 || 1;
        // Distance fitted to vertical FOV with a small padding.
        const fov = (camera.fov * Math.PI) / 180;
        const dist = (radius / Math.tan(fov / 2)) * 1.2;

        const dir = camera.position.clone().sub(controls.target).normalize();
        if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.5, 1).normalize();
        camera.position.copy(center).addScaledVector(dir, dist);
        controls.target.copy(center);
        controls.update();
    }

    // ── Click-to-select ──────────────────────────────────────────────

    private readonly _onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        // A press that starts on a gizmo handle belongs to the gizmo. Treated as a
        // click on the canvas it would pick whatever is behind the handle — nothing,
        // for an empty object — and deselect the object being moved. The gizmo knows
        // which handle is under the pointer from the hover before the press.
        if (this._gizmo?.axis != null) return;
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
        const camera = this._renderer.camera;
        if (!camera || !this._canvas) return;

        const rect = this._canvas.getBoundingClientRect();
        this._ndc.set(
            ((e.clientX - rect.left) / rect.width)  * 2 - 1,
            -((e.clientY - rect.top)  / rect.height) * 2 + 1,
        );
        this._raycaster.setFromCamera(this._ndc, camera);

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
     * Whether the gizmo has moved the selected object away from what the engine's
     * Transform still holds. TransformControls reports `change` for more than
     * movement — pressing a handle is enough — and only movement is an edit.
     */
    private _gizmoMovedObject(): boolean {
        const go = this._selection.selected();
        if (!go) return false;
        const o = go.transform._internalObject3D;
        const p = go.transform.localPosition;
        const q = go.transform.localRotation;
        const s = go.transform.localScale;
        const EPS = 1e-6;
        return Math.abs(o.position.x - p.x) > EPS || Math.abs(o.position.y - p.y) > EPS || Math.abs(o.position.z - p.z) > EPS
            || Math.abs(o.quaternion.x - q.x) > EPS || Math.abs(o.quaternion.y - q.y) > EPS
            || Math.abs(o.quaternion.z - q.z) > EPS || Math.abs(o.quaternion.w - q.w) > EPS
            || Math.abs(o.scale.x - s.x) > EPS || Math.abs(o.scale.y - s.y) > EPS || Math.abs(o.scale.z - s.z) > EPS;
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
