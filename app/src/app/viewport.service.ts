import { EffectRef, Injectable, Injector, NgZone, effect, inject, signal } from '@angular/core';
import * as THREE from 'three';
import { SceneViewController } from './scene-view/scene-view-controller';
import { OrientationGizmo } from './scene-view/orientation-gizmo';
import { ComponentGizmos, type GizmoKind, type GizmoSettings,
    loadGizmoSettings, saveGizmoSettings } from './scene-view/component-gizmos';
import { GizmoIcons } from './scene-view/gizmo-icons';
import { ScenePicker } from './scene-view/scene-picker';
import { SelectionOutline } from './scene-view/selection-outline';
import { TransformHandles, type HandleSpace, type PivotMode, type ToolMode } from './scene-view/transform-handles';
import {
    GameObject,
    SceneManager,
    Transform,
    type SerializedScene,
} from 'WebEngineTS';
import { HistoryService } from './services/history.service';
import { I18nService, type MessageKey } from './i18n/i18n.service';
import { SceneService } from './services/scene.service';
import { SelectionService } from './services/selection.service';
import { SettingsService } from './services/settings.service';
import { SceneViewRenderer } from './scene-view/scene-view-renderer';
import { installProbe, probeEnabled } from './scene-view/debug-probe';

/** The Scene view's tools: Q view, W/E/R the three handle modes, Y all of them. */
export type { Tool, PivotMode, HandleSpace } from './scene-view/transform-handles';
import type { Tool } from './scene-view/transform-handles';

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
    private _nav: SceneViewController | null = null;
    private _gizmoOri: OrientationGizmo | null = null;
    private _handles: TransformHandles | null = null;
    private _selectionEffect: EffectRef | null = null;
    private _snapEffect: EffectRef | null = null;
    private _outline: SelectionOutline | null = null;
    private _picker: ScenePicker | null = null;
    private _componentGizmos: ComponentGizmos | null = null;
    private _icons: GizmoIcons | null = null;
    /** The Gizmos menu's switches: view state, kept in the browser (D-11). */
    public readonly gizmoSettings = signal<GizmoSettings>(loadGizmoSettings());
    /** The rectangle draft, in canvas pixels, while the left button drags. */
    private _rect: { x: number; y: number; endX: number; endY: number } | null = null;
    /** The rectangle's div, created on the first draft (D-10). */
    private _rectEl: HTMLDivElement | null = null;
    private _lastShift = false;
    private _lastCtrl = false;
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
    /**
     * Whether the Scene view is currently orthographic (the orientation cube's
     * centre click, D-5). Set only on a change — the cube draws every frame.
     */
    public readonly orthographic = signal(false);

    constructor(
        private readonly _zone: NgZone,
        private readonly _selection: SelectionService,
        private readonly _injector: Injector,
        private readonly _settings: SettingsService,
        private readonly _sceneService: SceneService,
        private readonly _history: HistoryService,
        private readonly _i18n: I18nService,
    ) {}

    /** Initializes the viewport on the given canvas. Idempotent. */
    public attach(canvas: HTMLCanvasElement): void {
        if (this._canvas) return;
        this._canvas = canvas;

        canvas.addEventListener('pointerdown', this._onClaimDown, true);
        canvas.addEventListener('pointerup', this._onClaimUp, true);
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointerup',   this._onPointerUp);
        canvas.addEventListener('pointermove', this._onPointerMove);

        this._renderer.attach(canvas, () => this._tick());

        const overlay = this._renderer.aboveScene;
        const camera = this._renderer.camera;
        if (!overlay || !camera) return;

        // ── Navigation (B1 phase 2): the controller owns the camera pose ──
        const nav = new SceneViewController();
        nav.attach(canvas, camera as unknown as import('./scene-view/scene-view-controller').CameraTarget);
        this._nav = nav;

        // ── Picking and the outline (B1 phase 5): click and rectangle
        // selection (D-10), the screen-space silhouette (D-9).
        this._picker = new ScenePicker(this._renderer);
        this._outline = new SelectionOutline(this._renderer);
        // Component gizmos and their billboard icons (D-11): rebuilt per frame
        // from the components' fields, drawn in the depth-tested and on-top
        // layers respectively.
        this._componentGizmos = new ComponentGizmos(this._renderer);
        this._icons = new GizmoIcons(this._renderer);
        this._icons.mount();
        this._componentGizmos.setSettings(this.gizmoSettings());

        // ── Grid: depth-tested against the engine scene (D-2 step 3) ──
        const grid = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
        this._renderer.addOverlayLayer('grid', grid);

        // ── Orientation cube (B1 phase 3) ──
        const orientation = new OrientationGizmo(this._renderer);
        orientation.onLookAlong = axis => this._nav?.lookAlong(axis);
        orientation.onToggleProjection = () => this._nav?.toggleProjection();
        orientation.mount();
        this._gizmoOri = orientation;
        this._canvas.addEventListener('pointerdown', this._onOrientationDown);
        // Ctrl's state is global (the canvas is not focusable) and toggles snapping
        // live, mid-drag included.
        window.addEventListener('keydown', this._onCtrlKey, true);
        window.addEventListener('keyup', this._onCtrlKey, true);
        window.addEventListener('blur', this._onCtrlBlur);

        // ── Transform handles (B1 phase 4): a proxy in the overlay, the engine
        // Transform written back from its delta (transform-handles.ts, D-6).
        const handles = new TransformHandles(this._renderer, canvas, camera);
        handles.bindDrag({
            onDragStart: () => {
                // A handle drag owns the camera: cancel any navigation gesture and
                // stop following so the handle stays under the cursor.
                this._nav?.cancelGestures();
                this._nav?.stopFollow();
            },
            takeSnapshot: () => this._sceneService.serialize(),
            pushUndo: (label, snapshot) => this._history.pushSnapshot(label, snapshot as SerializedScene),
        });
        handles.onTargetsChanged = () => this._zone.run(() => this._selection.notifyChanged());
        this._handles = handles;

        // Snap steps come from Preferences and apply while the magnet is on or
        // Ctrl is held (D-6's snapping rules; the controller's Ctrl state is read
        // live, so a key pressed mid-drag takes effect on the next handle).
        this._snapEffect = effect(() => {
            const s = this._settings;
            void s.gridSnap(); void s.rotateSnap(); void s.scaleSnap();
            this._writeSnap();
        }, { injector: this._injector });

        // The selection outline (D-9) follows the whole selection: the silhouette
        // pass for meshes, a dim box for objects without any. The handles are
        // seated here too, but through the frame loop rather than an effect —
        // touching the controls where Angular watches every signal read re-queued
        // the effect in a tight loop (see _reseatHandles).
        this._selectionEffect = effect(() => {
            this._selection.selected();
            this._selection.revision();
            this._outline?.setTargets([...this._selection.selectedSet()].map(o => o.transform._internalObject3D));
        }, { injector: this._injector });

        // The debug probe (D-13) exists only when the flag is set.
        if (probeEnabled()) {
            installProbe(this._renderer, {
                selection: this._selection,
                canvas: () => this._canvas,
                nav: nav.state,
                orientation: () => {
                    const s = orientation.draw();
                    return { targets: s.targets, label: this._projectionLabel(s.orthographic) };
                },
                orientationClick: (x, y) => orientation.handleClick(x, y),
                hoverAxis: () => this.hoverAxis,
                hoverAll: () => this.hoverAll,
                handlePoint: (axis, t) => this.handlePoint(axis, t),
                objectScreenRect: name => this._picker?.screenRect(name) ?? null,
                gizmoCounts: () => this.gizmoCounts,
                gizmoExtent: (name, kind) => this.gizmoExtent(name, kind),
                gizmoSettings: () => this.gizmoSettings(),
            });
        }
    }

    /** Releases GPU resources and stops the loop. */
    public detach(): void {
        if (this._canvas) {
            this._canvas.removeEventListener('pointerdown', this._onPointerDown);
            this._canvas.removeEventListener('pointerup',   this._onPointerUp);
        }
        this._canvas?.removeEventListener('pointerdown', this._onOrientationDown);
        this._canvas?.removeEventListener('pointerdown', this._onClaimDown, true);
        this._canvas?.removeEventListener('pointerup', this._onClaimUp, true);
        this._canvas = null;
        this._gizmoOri?.dispose();
        this._gizmoOri = null;
        this._nav?.detach();
        this._nav = null;
        this._handles?.dispose();
        this._handles = null;
        this._handlesRevision = -1;
        window.removeEventListener('keydown', this._onCtrlKey, true);
        window.removeEventListener('keyup', this._onCtrlKey, true);
        window.removeEventListener('blur', this._onCtrlBlur);
        this._selectionEffect?.destroy();
        this._selectionEffect = null;
        this._snapEffect?.destroy();
        this._snapEffect = null;
        this._outline?.dispose();
        this._outline = null;
        this._picker = null;
        this._componentGizmos?.dispose();
        this._componentGizmos = null;
        this._icons?.dispose();
        this._icons = null;
        this._rectEl?.remove();
        this._rectEl = null;
        this._renderer.detach();
    }

    /**
     * Active tool — drives the toolbar toggle and the handles. `view` (Q) leaves
     * no handles at all: the Scene view becomes a pan surface.
     */
    public readonly tool = signal<Tool>('translate');

    /** Where the handles sit: the active object's pivot, or the selection's centre. */
    public readonly pivotMode = signal<PivotMode>('pivot');
    /** Which axes the handles are drawn along. */
    public readonly handleSpace = signal<HandleSpace>('world');
    /** The magnet: snapping on without holding Ctrl. */
    public readonly snapOn = signal(false);

    /** Switches tool: the signal for the UI, and the handles themselves. */
    public setTool(tool: Tool): void {
        this.tool.set(tool);
        const handles = this._handles;
        if (handles) {
            handles.mode = tool;
            handles.applyMode();
        }
        if (this._nav) this._nav.viewTool = tool === 'view';
        this._reseatHandles();
    }

    public setPivotMode(mode: PivotMode): void {
        this.pivotMode.set(mode);
        const handles = this._handles;
        if (!handles) return;
        handles.pivotMode = mode;
        this._reseatHandles();
    }

    public setHandleSpace(space: HandleSpace): void {
        this.handleSpace.set(space);
        const handles = this._handles;
        if (!handles) return;
        handles.space = space;
        // The controls have to be told too: the proxy's rotation aims the handle
        // at the object's own axes, but only a Local-space control drags along them.
        handles.applyMode();
        this._reseatHandles();
    }

    public toggleSnap(): void {
        this.snapOn.set(!this.snapOn());
        this._writeSnap();
    }

    /** Whether snapping is live right now (the magnet, or Ctrl held). */
    public get snapping(): boolean { return this.snapOn() || this._ctrl; }

    /** The selection revision the handles were last seated for. */
    private _handlesRevision = -1;

    /** Ctrl's live state — D-6's held-to-snap, watched on the window so a key
     * pressed mid-drag takes effect without a fresh event on the canvas. */
    public set ctrl(down: boolean) {
        if (down === this._ctrl) return;
        this._ctrl = down;
        this._writeSnap();
    }
    private _ctrl = false;

    /** The handle axes under the pointer, for the probe (null when none). */
    public get hoverAxis(): string | null { return this._handles?.hoverAxis ?? null; }

    /** Every handle set's axis under the pointer — the sets overlap on screen. */
    public get hoverAll(): Record<string, string | null> { return this._handles ? this._handles.hoverAll() : {}; }

    /** The handle's position and axes in engine space, for the probe. */
    public handlePoint(axis: 'X' | 'Y' | 'Z', t: number): { x: number; y: number; z: number } | null {
        const handles = this._handles;
        if (!handles) return null;
        const p = handles.handlePosition;
        const d = handles.handleAxis(axis);
        return { x: p.x + d.x * t, y: p.y + d.y * t, z: p.z + d.z * t };
    }

    /** Re-places the proxy for the current selection and toggles. */
    private _reseatHandles(): void {
        this._handlesRevision = this._selection.revision();
        const handles = this._handles;
        if (!handles) return;
        // The active object FIRST: the Pivot and Local toggles take the handle's
        // position and axes from it, and Unity's active object is the one the
        // user toggled last, not the first in the selection set.
        const primary = this._selection.selected();
        const ordered = primary ? [primary, ...[...this._selection.selectedSet()].filter(o => o !== primary)] : [];
        const targets = ordered.map(o => ({
            transform: o.transform,
            object3D: o.transform._internalObject3D,
        }));
        handles.setTargets(targets.length > 0 ? targets : []);
    }

    private _writeSnap(): void {
        const s = this._settings;
        const on = this.snapping;
        this._handles?.setSnap(
            on ? s.gridSnap() : null,
            on ? s.rotateSnap() : null,
            on ? s.scaleSnap() : null,
        );
    }

    /** The editor camera. Used by selection raycasting in later milestones. */
    public get camera(): THREE.PerspectiveCamera | null { return this._renderer.camera; }

    /** Whether the Scene view is flying (RMB + WASD/QE) — the toolbar keys stand down. */
    public get flying(): boolean { return this._nav?.flying ?? false; }

    /** The Scene-view pivot in engine space — where root creates land (D-3). */
    public get pivot(): { x: number; y: number; z: number } {
        return this._nav ? { ...this._nav.state.pivot } : { x: 0, y: 0, z: 0 };
    }

    /** One frame's bookkeeping, run by the renderer's loop before it draws. */
    private _tick(): void {
        // Flush dirty engine transforms before we render the engine scene.
        Transform._syncAllDirty();

        // The handles must not outlive their objects: undo, loading and closing a
        // project rebuild the scene, and the proxy can carry a stale pose for a
        // frame. A target whose engine object has left the scene graph is gone.
        // A drag bumps the revision every frame (the Inspector follows the
        // write-back), and re-seating the proxy then would undo the drag: only
        // a *selection* change re-places the handle, and never mid-drag.
        if (!this._handles?.dragging && this._selection.revision() !== this._handlesRevision) this._reseatHandles();
        this._handles?.dropDestroyed(() => this._reseatHandles());

        // Component gizmos: rebuilt from the components' fields each frame
        // (D-11), and the icons follow the same objects.
        this._componentGizmos?.update();
        this._placeIcons();

        // The orientation cube, drawn after the frame in its own corner viewport.
        const ori = this._gizmoOri?.draw();
        if (ori && ori.orthographic !== this.orthographic()) this.orthographic.set(ori.orthographic);

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

    /** The corner label for a projection mode (Unity's own "Iso"/"Persp"). */
    private _projectionLabel(orthographic: boolean): string {
        return this._i18n.t(orthographic ? 'vp.iso' : 'vp.persp');
    }

    /** Frames and then follows the primary selection (Shift+F, D-4). */
    public frameAndFollowSelection(): void {        this._nav?.frameAndFollow(() => {
            const go = this._selection.selected();
            return go ? { ...go.transform.position } : null;
        });
    }

    /**
     * Frames the orbit camera on the given GameObject — moves the orbit
     * target to the object's bounding-box center and steps the camera
     * back to a sensible distance so the whole object is visible.
     */
    public frameOnObject(obj3d: THREE.Object3D): void {
        const nav = this._nav;
        if (!nav) return;
        const box = new THREE.Box3().setFromObject(obj3d);
        if (box.isEmpty()) {
            // Fallback to the object's local origin.
            obj3d.updateMatrixWorld(true);
            const p = new THREE.Vector3();
            p.setFromMatrixPosition(obj3d.matrixWorld);
            nav.frame({ x: p.x, y: p.y, z: -p.z }, 1);
            return;
        }
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const radius = (Math.max(size.x, size.y, size.z) * 0.6) || 1;
        // Engine-space centre (the box is in three space, z mirrored).
        nav.frame({ x: center.x, y: center.y, z: -center.z }, radius);
    }

    // ── Click-to-select ──────────────────────────────────────────────

    /** The corner gizmo owns its clicks before the canvas sees them. */
    private readonly _onOrientationDown = (e: PointerEvent): void => {
        if (this._gizmoOri?.handleClick(e.clientX, e.clientY)) e.stopPropagation();
    };

    /**
     * The capture-phase pair that hands one handle set the press. A press on
     * nothing is left alone, so the selection pick and the camera keep it; a
     * press on a handle is owned, and the release gives every set back.
     */
    private readonly _onClaimDown = (e: PointerEvent): void => {
        const canvas = this._canvas;
        const camera = this._renderer.camera;
        if (!canvas || !camera || e.button !== 0) return;
        const rect = canvas.getBoundingClientRect();
        this._ndc.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this._handles?.claimPointer(this._ndc);
    };

    private readonly _onClaimUp = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        this._handles?.releasePointer();
    };

    /** Ctrl and Cmd both count for held-to-snap. */
    private readonly _onCtrlKey = (e: KeyboardEvent): void => {
        this.ctrl = e.ctrlKey || e.metaKey;
    };

    /** A window blur releases the hold: an alt-tab mid-drag must not snap on. */
    private readonly _onCtrlBlur = (): void => { this.ctrl = false; };

    /**
     * The left button does three things (D-10): on a handle it drags it, on empty
     * space it may start a rectangle, anywhere else it is a click. A rectangle
     * that never grows past a few pixels is a click (an empty-space one clears).
     */
    private readonly _onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        // The canvas owns its presses: without this, a Shift+click starts the
        // browser's native text selection, which then keeps every later mouse
        // event until the user clicks elsewhere.
        e.preventDefault();
        // A press that starts on a handle belongs to the handles. Treated as a
        // click on the canvas it would pick whatever is behind the handle — nothing,
        // for an empty object — and deselect the object being moved.
        if (this._handles?.hoverAxis != null) return;
        const canvas = this._canvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        this._pointerDown = { x: e.clientX, y: e.clientY };
        this._lastShift = e.shiftKey;
        this._lastCtrl = e.ctrlKey || e.metaKey;
        this._rect = null;
        // A drag that starts on empty space draws a rectangle; one that starts on
        // an object is a click. Shift and Ctrl change what the release does
        // (add / remove), not whether the rectangle is drawn. Under the View tool
        // (Q) the left button is a pan, as Unity's hand is — no marquee.
        if (!e.altKey && this.tool() !== 'view' && this._picker?.pick(e.clientX, e.clientY) == null) {
            this._rect = {
                x: e.clientX - rect.left, y: e.clientY - rect.top,
                endX: e.clientX - rect.left, endY: e.clientY - rect.top,
            };
            this._showRect();
        }
    };

    private readonly _onPointerUp = (e: PointerEvent): void => {
        this._handles?.releasePointer();
        const down = this._pointerDown;
        const draft = this._rect;
        this._pointerDown = null;
        this._rect = null;
        this._hideRect();
        if (!down || e.button !== 0) return;

        if (draft) {
            const area = Math.abs(draft.endX - draft.x) * Math.abs(draft.endY - draft.y);
            if (area < 16) {
                // No rectangle was drawn: treat it as a click on empty space.
                this._pickAt(e);
                return;
            }
            // The draft is in canvas pixels; the picker works in client pixels.
            const origin = this._canvas!.getBoundingClientRect();
            this._rectSelect({
                left: Math.min(draft.x, draft.endX) + origin.left,
                top: Math.min(draft.y, draft.endY) + origin.top,
                right: Math.max(draft.x, draft.endX) + origin.left,
                bottom: Math.max(draft.y, draft.endY) + origin.top,
            });
            return;
        }
        // If the pointer moved more than a few pixels, treat as orbit, not click.
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (dx * dx + dy * dy > 16) return;
        this._pickAt(e);
    };

    /** The rectangle move handler: keeps the draft's far corner painted. */
    private readonly _onPointerMove = (e: PointerEvent): void => {
        const draft = this._rect;
        if (!draft || !this._canvas) return;
        // A selection drag must not turn into a native text selection either.
        e.preventDefault();
        const rect = this._canvas.getBoundingClientRect();
        draft.endX = e.clientX - rect.left;
        draft.endY = e.clientY - rect.top;
        this._paintRect();
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

        const hit = this._firstOwner(hits, o2g);
        const shift = this._lastShift;
        const ctrl = this._lastCtrl;
        this._zone.run(() => {
            if (!hit) { this._selection.clear(); return; }
            if (ctrl) { this._selection.toggle(hit); return; }   // remove (or put back)
            if (shift) { this._selection.toggle(hit); return; }  // add (or remove)
            this._selection.select(hit);
        });
    }

    /** The GameObject that owns the nearest hit's object, if any. */
    private _firstOwner(hits: THREE.Intersection[], o2g: Map<THREE.Object3D, GameObject>): GameObject | null {
        for (const hit of hits) {
            let obj: THREE.Object3D | null = hit.object;
            while (obj) {
                const go = o2g.get(obj);
                if (go) return go;
                obj = obj.parent;
            }
        }
        return null;
    }

    /** @internal Walks the engine scene once and maps each Object3D to its GameObject. */
    /** One Gizmos menu switch (D-11): stored for the next session too. */
    public setGizmoSetting(key: 'enabled' | 'camera' | 'lights' | 'colliders' | 'audio', value: boolean): void {
        const next = { ...this.gizmoSettings(), [key]: value };
        this.gizmoSettings.set(next);
        saveGizmoSettings(next);
        this._componentGizmos?.setSettings(next);
        this._icons?.setVisibleIf(next.enabled);
    }

    public setIconSize(size: number): void {
        const next = { ...this.gizmoSettings(), iconSize: size };
        this.gizmoSettings.set(next);
        saveGizmoSettings(next);
        if (this._icons) this._icons.size = size;
    }

    /** The gizmos one kind reached over the selection, for the probe (D-11). */
    public get gizmoCounts(): Record<string, number> {
        const out: Record<string, number> = {};
        const gizmos = this._componentGizmos;
        if (!gizmos) return out;
        for (const go of this._selection.selectedSet()) {
            for (const drawn of gizmos.drawnFor(go.transform._internalObject3D)) {
                out[drawn.kind] = (out[drawn.kind] ?? 0) + 1;
            }
        }
        return out;
    }

    /** How far one object's gizmo of a kind reaches, in engine units. */
    public gizmoExtent(name: string, kind: GizmoKind | string): number | null {
        const gizmos = this._componentGizmos;
        if (!gizmos) return null;
        for (const go of this._selection.selectedSet()) {
            if (go.name !== name) continue;
            const drawn = gizmos.drawnFor(go.transform._internalObject3D).find(d => d.kind === kind);
            return drawn ? drawn.extent : null;
        }
        return null;
    }

    /**
     * Places the billboard icons over the objects carrying the gizmos'
     * components: one per object, just above it (D-11).
     */
    private _placeIcons(): void {
        const icons = this._icons;
        if (!icons) return;
        const place: Record<string, { x: number; y: number; z: number }[]> = { camera: [], light: [], audio: [] };
        for (const go of this._selection.selectedSet()) {
            const position = go.transform.position;
            for (const component of go.getAllComponents()) {
                const name = component.constructor.name;
                if (name === 'Camera') place.camera.push({ ...position });
                else if (name.endsWith('Light')) place.light.push({ ...position });
                else if (name === 'AudioSource') place.audio.push({ ...position });
            }
        }
        icons.place('camera', place.camera);
        icons.place('light', place.light);
        icons.place('audio', place.audio);
    }

    /** Applies a rectangle's selection (D-10: clear unless Shift/Ctrl). */
    private _rectSelect(rect: { left: number; top: number; right: number; bottom: number }): void {
        const picker = this._picker;
        if (!picker) return;
        const found = picker.pickRect(rect);
        const shift = this._lastShift;
        const ctrl = this._lastCtrl;
        this._zone.run(() => {
            if (!shift && !ctrl) this._selection.clear();
            for (const go of found) {
                if (ctrl && this._selection.isSelected(go)) continue;   // remove
                if (shift && this._selection.isSelected(go)) continue;  // already in
                this._selection.toggle(go);
            }
        });
    }

    private _showRect(): void {
        const canvas = this._canvas;
        if (!canvas) return;
        const el = this._rectEl ?? (this._rectEl = document.createElement('div'));
        el.className = 'vp-rect';
        if (!el.parentNode) canvas.parentElement?.appendChild(el);
        this._paintRect();
    }

    private _paintRect(): void {
        const draft = this._rect;
        const el = this._rectEl;
        if (!draft || !el) return;
        el.style.display = 'block';
        el.style.left = `${Math.min(draft.x, draft.endX)}px`;
        el.style.top = `${Math.min(draft.y, draft.endY)}px`;
        el.style.width = `${Math.abs(draft.endX - draft.x)}px`;
        el.style.height = `${Math.abs(draft.endY - draft.y)}px`;
    }

    private _hideRect(): void {
        if (this._rectEl) this._rectEl.style.display = 'none';
    }

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
