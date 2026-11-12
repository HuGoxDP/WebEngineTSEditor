import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Quaternion, Transform, Vector3 } from 'WebEngineTS';
import { enginePointToThree, engineQuatToThree, threeDirToEngine, threeQuatToEngine } from './space';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * The transform handles — Unity's move / rotate / scale gizmos (B1 phase 4; D-6).
 *
 * Three's `TransformControls` mutates whatever `Object3D` it is attached to, and
 * the object the editor must change is the engine's `Transform`, whose values are
 * engine-space and whose scene is handedness-mirrored. Attaching the controls to
 * the engine object directly (what phase 1 did) therefore cannot express more
 * than one object, a Pivot/Centre switch or a Local/Global switch: the mirror
 * decomposes a rotated parent as a 180° Y rotation with scale (−1, 1, 1).
 *
 * So the handles drive a **proxy**: a plain `Object3D` in the editor's overlay
 * scene, placed in three space at the position the Unity semantics ask for and
 * rotated to the orientation they ask for. Each frame of a drag the proxy's
 * current TRS is compared with the one it started from, and that delta — once,
 * here — is written to every selected engine Transform through `space.ts`.
 * Everything below the delta is ordinary engine-space arithmetic, which is what
 * the Inspector shows and what Unity parity is defined in.
 *
 * Three controls, one proxy: `Y` shows all three handle sets at once, and three
 * instances is the only way three's controls can do that (one instance picks and
 * drags a single mode). With `Y` active they can overlap, so a press is given a
 * single owner before three sees the event — see {@link claimPointer}.
 *
 * Undo is one entry per drag: the scene is serialized on the handle press and
 * pushed only if something actually moved, exactly as the pre-proxy code did.
 */

/** The three handle modes. */
export type ToolMode = 'translate' | 'rotate' | 'scale';
/** The Scene view's tools: Q view, W/E/R the three modes, Y all of them. */
export type Tool = 'view' | ToolMode | 'combined';

/** Where the handle sits: the active object's pivot, or the selection's centre. */
export type PivotMode = 'pivot' | 'center';

/** Which axes the handle is drawn along. */
export type HandleSpace = 'world' | 'local';

/** One selected object, as the handles need to see it. */
export interface HandleTarget {
    transform: Transform;
    /** The three object the engine renders this Transform with. */
    object3D: THREE.Object3D;
}

/** The proxy's TRS at one moment, in three space. */
interface Pose {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
}

/** One target's engine-space pose at the press, so the write-back is absolute. */
interface StartPose {
    transform: Transform;
    position: Vector3;
    rotation: Quaternion;
    scale: Vector3;
}

const MODES: ToolMode[] = ['translate', 'rotate', 'scale'];
const ANGLE_EPS = 1e-6;
const SCALE_EPS = 1e-9;

export class TransformHandles {

    /** The tool in use; `view` leaves no handles at all. */
    public mode: Tool = 'translate';
    public pivotMode: PivotMode = 'pivot';
    public space: HandleSpace = 'world';

    /** Called after a drag wrote to the engine, so the Inspector can re-read. */
    public onTargetsChanged: (() => void) | null = null;

    private readonly _controls: Record<ToolMode, TransformControls>;
    private readonly _helpers: Record<ToolMode, THREE.Object3D>;
    private readonly _proxy = new THREE.Object3D();
    private readonly _renderer: SceneViewRenderer;
    private _targets: HandleTarget[] = [];
    /** The instance that owns a press while `combined` shows all three sets. */
    private _owner: TransformControls | null = null;
    private _dragStart: Pose | null = null;
    private _startPose: Pose | null = null;
    private _dragTargets: StartPose[] = [];
    private _pendingSnapshot: unknown = null;
    /** The live snap steps; null turns each off. */
    private _translationSnap: number | null = null;
    private _rotationSnap: number | null = null;
    private _scaleSnap: number | null = null;
    private _takeSnapshot: (() => unknown) | null = null;
    private _pushUndo: ((label: string, snapshot: unknown) => void) | null = null;
    private _onDragStart: (() => void) | null = null;

    constructor(renderer: SceneViewRenderer, canvas: HTMLCanvasElement, camera: THREE.Camera) {
        this._renderer = renderer;
        const controls = {} as Record<ToolMode, TransformControls>;
        const helpers = {} as Record<ToolMode, THREE.Object3D>;
        for (const mode of MODES) {
            const control = new TransformControls(camera, canvas);
            // Each instance drives one mode: a fresh TransformControls is always a
            // translate gizmo, and the mode is what tells it which handles to draw,
            // pick and drag.
            control.setMode(mode);
            control.setSize(0.8);
            // Three.js r169+ draws the gizmo from a helper object rather than the
            // controls themselves; either way what lands in the overlay is an Object3D.
            const helper: THREE.Object3D = (control as unknown as { getHelper?: () => THREE.Object3D })
                .getHelper?.() ?? (control as unknown as THREE.Object3D);
            renderer.addOverlayLayer('above-scene', helper);
            controls[mode] = control;
            helpers[mode] = helper;
            // The proxy must be part of a scene graph: TransformControls walks
            // its parent's world matrix every frame and refuses a detached object.
            renderer.addOverlayLayer('above-scene', this._proxy);
            control.attach(this._proxy);
            this._listen(mode, control);
        }
        this._controls = controls;
        this._helpers = helpers;
        this._applyMode();
    }

    // ── The public surface ────────────────────────────────────────────

    /**
     * What is under the pointer, as `set:axis` — the sets overlap on screen with
     * the `combined` tool, so the probe (and a reader) can only tell "a translate
     * arrow" from "a rotate ring" if the set is named. Null when nothing is.
     */
    public get hoverAxis(): string | null {
        const all = this.hoverAll();
        for (const mode of MODES) {
            if (!this._visible(mode)) continue;
            if (all[mode]) return `${mode}:${all[mode]}`;
        }
        return null;
    }

    /** Every set's axis under the pointer, for the probe and for debugging. */
    public hoverAll(): Record<string, string | null> {
        const out: Record<string, string | null> = {};
        for (const mode of MODES) out[mode] = this._controls[mode].axis ?? null;
        return out;
    }

    /** Whether a handle is being dragged. */
    public get dragging(): boolean { return this._dragStart !== null; }

    /** The proxy's position in engine space — where the handle sits. */
    public get handlePosition(): { x: number; y: number; z: number } {
        return threeDirToEngine(this._proxy.position);
    }

    /** A unit axis of the handle in engine space, for the probe's read-back. */
    public handleAxis(axis: 'X' | 'Y' | 'Z'): { x: number; y: number; z: number } {
        const v = new THREE.Vector3(
            axis === 'X' ? 1 : 0,
            axis === 'Y' ? 1 : 0,
            axis === 'Z' ? 1 : 0,
        ).applyQuaternion(this._proxy.quaternion);
        return threeDirToEngine(v);
    }

    /** Installs the undo plumbing (kept out of the constructor for readability). */
    public bindDrag(options: {
        /** Cancels any camera gesture — the handle owns the pointer while dragging. */
        onDragStart: () => void;
        /** Asks for one snapshot to restore on undo. */
        takeSnapshot: () => unknown;
        /** Records the undo entry once, when the drag actually moved something. */
        pushUndo: (label: string, snapshot: unknown) => void;
    }): void {
        this._takeSnapshot = options.takeSnapshot;
        this._pushUndo = options.pushUndo;
        this._onDragStart = options.onDragStart;
    }

    /** Replaces the selection the handles work on (empty detaches them). */
    public setTargets(targets: readonly HandleTarget[]): void {
        // An object whose ancestor is also selected is moved by that ancestor, so
        // it is dropped: Unity moves the parent once.
        const selected = new Set(targets.map(t => t.object3D));
        this._targets = targets.filter(t => {
            let p = t.object3D.parent;
            while (p) {
                if (selected.has(p)) return false;
                p = p.parent;
            }
            return true;
        });

        if (this._targets.length === 0) {
            for (const mode of MODES) this._controls[mode].detach();
            return;
        }
        this._placeHandle();
        for (const mode of MODES) this._controls[mode].attach(this._proxy);
        // three's attach() shows the root again, so the tool's choice of visible
        // sets is re-applied after it.
        this._applyMode();
    }

    /** Sets the snap steps; null (or 0) turns a step off. */
    public setSnap(translation: number | null, rotation: number | null, scale: number | null): void {
        this._translationSnap = translation && translation > 0 ? translation : null;
        this._rotationSnap = rotation && rotation > 0 ? rotation : null;
        this._scaleSnap = scale && scale > 0 ? scale : null;
        for (const mode of MODES) {
            this._controls[mode].setTranslationSnap(this._translationSnap);
            this._controls[mode].setRotationSnap(this._rotationSnap === null ? null : this._rotationSnap * Math.PI / 180);
            this._controls[mode].setScaleSnap(this._scaleSnap);
        }
    }

    /**
     * Gives one controls instance the press, before three's own (bubble-phase)
     * pointerdown handler sees it: with all three handle sets on screen only one
     * may drag, and the one under the pointer is the one the user meant.
     */
    public claimPointer(ndc: THREE.Vector2): void {
        this._owner = null;
        this._restoreEnabled();
        if (this.mode !== 'combined') return;
        // pointerHover takes three's own pointer shape: an NDC point.
        const pointer = new THREE.Vector2(ndc.x, ndc.y);
        for (const mode of MODES) {
            if (!this._visible(mode)) continue;
            this._controls[mode].pointerHover(pointer as unknown as PointerEvent);
            if (this._controls[mode].axis) { this._owner = this._controls[mode]; break; }
        }
        if (this._owner) {
            for (const mode of MODES) {
                if (this._controls[mode] !== this._owner) this._controls[mode].enabled = false;
            }
        }
    }

    /**
     * Gives every instance back after a press that did **not** become a drag (the
     * capture-phase pointerup). A drag clears its own owner in its release event,
     * so this must not touch it: the undo entry and the enabled flags depend on
     * three still seeing a drag in progress.
     */
    public releasePointer(): void {
        if (!this._owner) this._restoreEnabled();
    }

    /** Releases the GL resources and the overlay slot. */
    public dispose(): void {
        for (const mode of MODES) {
            this._controls[mode].detach();
            this._controls[mode].dispose();
            this._renderer.removeOverlayLayer(this._helpers[mode]);
        }
        this._renderer.removeOverlayLayer(this._proxy);
        this._targets = [];
    }

    /**
     * Drops targets whose engine object has left the scene graph (a destroy, an
     * undo that reloads, a project close) and re-seats the handle if any went.
     * A removed object's three object loses its parent, which is the tell.
     */
    public dropDestroyed(reseat: () => void): void {
        if (this._targets.length === 0) return;
        const alive = this._targets.filter(t => t.object3D.parent !== null);
        if (alive.length === this._targets.length) return;
        this._targets = alive;
        if (alive.length === 0) for (const mode of MODES) this._controls[mode].detach();
        else this._placeHandle();
        reseat();
    }

    /** Shows the handle sets the current tool asks for. */
    /** Re-shows the handle sets and re-aims them after a tool or space change. */
    public applyMode(): void { this._applyMode(); }

    // ── The handle's placement ────────────────────────────────────────

    /**
     * Places the proxy where Unity's Pivot/Centre and Local/Global toggles put
     * the handle. Both are engine-space decisions rendered into the overlay's
     * three space: the position through `enginePointToThree`, the rotation
     * through the mirror's conjugation (`engineQuatToThree`), so the handle's
     * axes line up with the object's engine axes as they are drawn.
     */
    private _placeHandle(): void {
        const primary = this._targets[0];
        const box = new THREE.Box3();
        for (const t of this._targets) box.expandByObject(t.object3D);
        const empty = box.isEmpty();

        if (this.pivotMode === 'pivot' || empty) {
            // Pivot: the active object's own origin. (An empty bounds box means
            // there is nothing to centre on, so the pivots are the points there are.)
            this._proxy.position.copy(enginePointToThree(primary.transform.position));
        } else {
            this._proxy.position.copy(box.getCenter(new THREE.Vector3()));
        }

        if (this.space === 'local') {
            // Local: the handle's axes are the active object's world axes, which
            // under the mirror read as the conjugate of its engine rotation.
            this._proxy.quaternion.copy(engineQuatToThree(primary.transform.rotation));
        } else {
            this._proxy.quaternion.identity();
        }
        this._proxy.scale.set(1, 1, 1);
        this._proxy.updateMatrixWorld(true);
    }

    /** Shows the handle sets the current tool asks for, and aims them. */
    private _applyMode(): void {
        for (const mode of MODES) {
            const on = this.mode === mode || this.mode === 'combined';
            this._helpers[mode].visible = on;
            this._controls[mode].enabled = on;
            // The proxy's quaternion aims the handle at the object's own axes;
            // telling the controls that it is in Local space is what makes the
            // drag move *along* them (three takes the offset's component in the
            // object's frame rather than the world's).
            this._controls[mode].space = this.space === 'local' ? 'local' : 'world';
        }
    }

    private _visible(mode: ToolMode): boolean {
        return this.mode === mode || this.mode === 'combined';
    }

    // ── The drag ──────────────────────────────────────────────────────

    /** Wires one instance's events; `change` only counts from the owner. */
    private _listen(mode: ToolMode, control: TransformControls): void {
        control.addEventListener('dragging-changed', event => {
            if ((event as unknown as { value: boolean }).value) {
                if (this._owner && this._owner !== control) return;
                this._owner = control;
                this._onDragStart?.();
                this._dragStart = this._readPose();
                this._startPose = this._readPose();
                // The engine pose each target starts from: the write-back below
                // writes absolute values (start + the proxy's delta), so it does
                // not accumulate the delta frame by frame.
                this._dragTargets = this._targets.map(t => ({
                    transform: t.transform,
                    position: t.transform.position,
                    rotation: t.transform.rotation,
                    scale: t.transform.localScale,
                }));
                this._pendingSnapshot = this._takeSnapshot?.() ?? null;
                return;
            }
            // Release: one undo entry if the drag moved anything.
            const pending = this._pendingSnapshot;
            const start = this._startPose;
            this._dragStart = null;
            this._startPose = null;
            this._dragTargets = [];
            this._pendingSnapshot = null;
            if (this._owner === control) {
                this._owner = null;
                this._restoreEnabled();
                if (pending !== null && start && this._movedBetween(start)) {
                    this._pushUndo?.('Transform', pending);
                    this.onTargetsChanged?.();
                }
            }
        });
        control.addEventListener('change', () => {
            if (this._owner && this._owner !== control) return;
            this._applyDelta();
        });
        void mode;
    }

    private _restoreEnabled(): void {
        for (const mode of MODES) this._controls[mode].enabled = this._visible(mode);
    }

    private _readPose(): Pose {
        return {
            position: this._proxy.position.clone(),
            quaternion: this._proxy.quaternion.clone(),
            scale: this._proxy.scale.clone(),
        };
    }

    /** Whether anything moved between the press and now (a press alone is not an edit). */
    private _movedBetween(start: Pose): boolean {
        const now = this._readPose();
        return !now.position.equals(start.position)
            || !now.quaternion.equals(start.quaternion)
            || !now.scale.equals(start.scale);
    }

    /**
     * Writes the proxy's movement to the engine. The proxy's own TRS delta is
     * taken in three space and converted once; every object then gets the same
     * engine-space delta, which is what Unity does to a multi-selection.
     */
    private _applyDelta(): void {
        const start = this._dragStart;
        if (!start || this._dragTargets.length === 0) return;
        const mode: ToolMode = MODES.find(m => this._controls[m] === this._owner) ?? 'translate';

        if (mode === 'translate') {
            // A world-space offset: three space to engine space, then added to
            // each target's start pose.
            const delta = threeDirToEngine(this._proxy.position.clone().sub(start.position));
            for (const t of this._dragTargets) {
                t.transform.position = new Vector3(
                    t.position.x + delta.x, t.position.y + delta.y, t.position.z + delta.z,
                );
            }
            this._changed();
            return;
        }

        if (mode === 'rotate') {
            // The proxy's rotation delta in three space, conjugated into engine
            // space: a rotation about the mirrored axis (three +Z, engine −Z)
            // reads the other way round, which is exactly the D-6 mirror trap.
            const delta = threeQuatToEngine(
                this._proxy.quaternion.clone().multiply(start.quaternion.clone().invert()),
            );
            const sin = Math.hypot(delta.x, delta.y, delta.z);
            const angle = 2 * Math.atan2(sin, delta.w);
            if (Math.abs(angle) < ANGLE_EPS || sin < ANGLE_EPS) return;
            const dq = new Quaternion(delta.x, delta.y, delta.z, delta.w);
            const point = this.handlePosition;
            for (const t of this._dragTargets) {
                // Both pivot and centre drags turn about the handle's position —
                // that is what the Pivot/Centre switch chooses it to be. Position
                // and rotation are written from the start pose, absolutely.
                const rel = new Vector3(
                    t.position.x - point.x, t.position.y - point.y, t.position.z - point.z,
                );
                const turned = rel.applyQuaternion(dq);
                t.transform.position = new Vector3(point.x + turned.x, point.y + turned.y, point.z + turned.z);
                t.transform.rotation = Quaternion.multiply(dq, t.rotation);
            }
            this._changed();
            return;
        }

        // Scale: the proxy's scale ratio, applied to each target's start scale.
        // The mirror does not affect a ratio, so the components carry over as-is.
        const ratio = {
            x: this._proxy.scale.x / Math.max(start.scale.x, SCALE_EPS),
            y: this._proxy.scale.y / Math.max(start.scale.y, SCALE_EPS),
            z: this._proxy.scale.z / Math.max(start.scale.z, SCALE_EPS),
        };
        if (Math.abs(ratio.x - 1) < SCALE_EPS && Math.abs(ratio.y - 1) < SCALE_EPS && Math.abs(ratio.z - 1) < SCALE_EPS) return;
        const point = this.handlePosition;
        for (const t of this._dragTargets) {
            t.transform.localScale = new Vector3(t.scale.x * ratio.x, t.scale.y * ratio.y, t.scale.z * ratio.z);
            if (this.pivotMode === 'center') {
                // Scaling about the handle also moves the objects towards or away
                // from it, component-wise in the axes being scaled.
                t.transform.position = new Vector3(
                    point.x + (t.position.x - point.x) * ratio.x,
                    point.y + (t.position.y - point.y) * ratio.y,
                    point.z + (t.position.z - point.z) * ratio.z,
                );
            }
        }
        this._changed();
    }

    private _changed(): void {
        // The proxy keeps its place while the write-back happens: the handle must
        // not jump when the engine object moves under it.
        this._proxy.updateMatrixWorld(true);
        this.onTargetsChanged?.();
    }
}
