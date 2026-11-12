import * as THREE from 'three';
import { engineDirToThree, enginePointToThree, threeDirToEngine } from './space';

/**
 * Unity's Scene-view navigation (B1 phase 2; D-4).
 *
 * One class that owns the editor camera's *intent* — a pivot in engine space, a
 * yaw/pitch, a distance, an orthographic flag and a fly speed — and writes the
 * three camera through `space.ts`. No Angular, no DOM queries beyond the canvas
 * it is handed: the viewport facade wires the pointer events, this one decides
 * what they mean, and the e2e probe asserts the result in engine space.
 *
 * Gestures (exactly D-4): **Alt+LMB orbit** (0.3°/px, pitch clamped ±89.9°),
 * **wheel zoom** toward the pivot (a step proportional to distance; the pivot
 * never gets crossed), **Alt+RMB dolly** (the same dolly as the wheel, in
 * vertical pixels), **Shift+RMB orbit** (the same orbit as Alt+LMB, for a
 * right-hand start), **MMB / Alt+MMB pan** (the world point under the cursor
 * stays under it), **RMB look** (the position is untouched), **RMB + WASDQE
 * fly** (Shift ×4, the wheel during a fly scales the speed ×1.2 per notch
 * clamped to [0.01, 99]), **F frame** (animated 250 ms), **Shift+F** frame and
 * follow. No damping — Unity has none. LMB is left to selection; this
 * controller never selects.
 *
 * The camera is derived, never incremental: every state change re-derives the
 * position from pivot/yaw/pitch/distance, so a pan and a fly cannot drift.
 */

/** The controller's state, in engine space. */
export interface NavState {
    pivot: { x: number; y: number; z: number };
    /** Yaw in radians, around the engine +Y. */
    yaw: number;
    /** Pitch in radians, clamped ±89.9°. */
    pitch: number;
    distance: number;
    orthographic: boolean;
    flySpeed: number;
}

/** The bits of the camera the controller needs; a test double can supply them. */
export interface CameraTarget {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    fov: number;
    forward(): THREE.Vector3;
    /** Aims at the target; the optional up covers the poles (see applyPose). */
    lookAt(target: THREE.Vector3, up?: THREE.Vector3): void;
    updateProjectionMatrix?(): void;
    /** Switches the camera between perspective and orthographic for the current pose. */
    setOrthographic?(orthographic: boolean, orthoSize: number): void;
}

const DEG = Math.PI / 180;
const ORBIT_PER_PIXEL = 0.3 * DEG;
const PITCH_LIMIT = 89.9 * DEG;
const MIN_DISTANCE = 0.01;
const MAX_FLY = 99;
const MIN_FLY = 0.01;
const FRAME_MS = 250;
/** How close to ±90° counts as the pole (an orbit's clamp stays outside it). */
const POLE_EPS = 1e-9;

/**
 * The camera's basis in engine space from a yaw/pitch: the direction *from the
 * pivot to the camera* (so forward = −that). `sin(yaw)` lands on x and
 * `cos(yaw)` on z, so yaw is `atan2(x, z)` of the offset — the inverse of
 * {@link lookAlong}'s conversion, and the reason the plan's frozen pose
 * converts the way it does.
 */
function basisFromAngles(yaw: number, pitch: number): THREE.Vector3 {
    return new THREE.Vector3(
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.cos(yaw),
    );
}

/**
 * The controller's starting state: the pose the renderer placed the camera at
 * before the controller existed — engine `(6, 6, −10)` from the origin, the
 * Unity default octant — converted to pivot/yaw/pitch/distance. Written from
 * the offset rather than as literals, so the derivation is visible and a
 * changed default stays one edit.
 */
function initialNavState(): NavState {
    const offset = { x: 6, y: 6, z: -10 };
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    return {
        pivot: { x: 0, y: 0, z: 0 },
        yaw: Math.atan2(offset.x, offset.z),
        pitch: Math.asin(offset.y / distance),
        distance,
        orthographic: false,
        flySpeed: 5,
    };
}

/** The camera's forward direction in three space (its -Z basis vector). */
function forwardOf(camera: CameraTarget): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
}

/**
 * Applies the derived pose to a CameraTarget (the engine's mirror included).
 *
 * At the poles — the orientation cube's +Y and −Y snaps, where the view
 * direction is parallel to world +Y — the roll is undefined and three picks one
 * arbitrarily (a 180° one, which put engine +Z down the screen in the Top view).
 * Unity's Top view keeps engine +Z up the screen, so the pose then aims with
 * that axis as its up; the limit of the ordinary orbit roll at yaw 0 is the
 * same vector, so an orbit up to the pitch limit never jumps.
 */
function applyPose(camera: CameraTarget, s: NavState): void {
    const dir = basisFromAngles(s.yaw, s.pitch);
    // Everything here is engine space; the conversion to three happens once, at
    // the end (space.ts): the pivot and the direction are both mirrored.
    const pivotThree = enginePointToThree(s.pivot);
    const offset = engineDirToThree(dir).multiplyScalar(s.distance);
    camera.position.copy(pivotThree).add(offset);
    const atPole = dir.y >= 1 - POLE_EPS || dir.y <= -1 + POLE_EPS;
    camera.lookAt(pivotThree, atPole
        ? engineDirToThree({ x: 0, y: 0, z: dir.y > 0 ? 1 : -1 })
        : undefined);
}

export class SceneViewController {

    private _s: NavState;
    private _camera: CameraTarget | null = null;
    private _canvas: HTMLCanvasElement | null = null;

    /** Active gesture, if any — the facade only picks while nothing is dragging. */
    private _mode: 'none' | 'orbit' | 'look' | 'fly' | 'pan' | 'dolly' = 'none';
    private _pointerId: number | null = null;
    private _lastX = 0;
    private _lastY = 0;
    private _downX = 0;
    private _downY = 0;
    /** World units per pixel for panning, recomputed per distance/FOV. */
    private _panPerPixel = 0.01;
    /** Keys held during a fly, so a blur mid-hold releases them. */
    private _keys = new Set<string>();
    private _shift = false;
    /** Set while a frame animation runs, so a user gesture cancels it. */
    private _framing: { from: NavState; to: NavState; t: number } | null = null;
    private _follow: { go: () => { x: number; y: number; z: number } | null; hasLast: boolean } | null = null;
    private _listeners: Array<[string, EventListener, boolean?]> = [];
    private _raf = 0;
    private _lastFrameT = 0;

    /** A gesture or an animation marks the camera "touched" — ends follow. */
    public onCameraGesture: (() => void) | null = null;

    /**
     * Whether the View tool (Q) is active: the left button then pans instead of
     * selecting, as Unity's hand tool does.
     */
    public set viewTool(active: boolean) {
        if (active === this._viewTool) return;
        this._viewTool = active;
        if (active && this._mode === 'look') this._mode = 'none';
    }
    private _viewTool = false;

    constructor(initial?: Partial<NavState>) {
        // The frozen pose the plan requires: engine (6, 6, −10) from the origin,
        // which is where the renderer left the camera before the controller
        // existed (placeAt(6, 6, 10) in three space). Overridable for tests.
        const start = initialNavState();
        this._s = {
            pivot: initial?.pivot ?? start.pivot,
            yaw: initial?.yaw ?? start.yaw,
            pitch: initial?.pitch ?? start.pitch,
            distance: initial?.distance ?? start.distance,
            orthographic: initial?.orthographic ?? start.orthographic,
            flySpeed: initial?.flySpeed ?? start.flySpeed,
        };
    }

    /** The state as the probe reads it (engine space). */
    public get state(): Readonly<NavState> { return this._s; }

    public get isBusy(): boolean { return this._mode !== 'none'; }

    /** Whether the view is mid-flight (RMB held with movement keys). */
    public get flying(): boolean { return this._mode === 'fly'; }

    /** Attaches to a canvas + camera. Idempotent. */
    public attach(canvas: HTMLCanvasElement, camera: CameraTarget): void {
        this.detach();
        this._canvas = canvas;
        this._camera = camera;

        const on = (type: string, fn: EventListener, opts?: AddEventListenerOptions): void => {
            canvas.addEventListener(type, fn, opts);
            this._listeners.push([type, fn, typeof opts === 'object' ? opts.capture : undefined]);
        };

        on('pointerdown', this._onPointerDown as EventListener);
        on('pointermove', this._onPointerMove as EventListener);
        on('pointerup', this._onPointerUp as EventListener);
        on('pointercancel', this._onPointerUp as EventListener);
        on('wheel', this._onWheel as EventListener, { passive: false });
        on('contextmenu', this._onContextMenu as EventListener);
        // Keys on the canvas (the browser menu suppression has to be there too),
        // plus a window blur to release a mid-flight hold.
        // Keys are global — the canvas is not focusable, and a fly key held
        // before the RMB press must still count. Registered in the capture
        // phase: while flying, the app's own shortcuts (Undo, W/E/R) must not
        // see the key, and a capture listener can stop it on the way down.
        window.addEventListener('keydown', this._onKeyDown as EventListener, true);
        this._listeners.push(['keydown', this._onKeyDown as EventListener, true]);
        window.addEventListener('keyup', this._onKeyUp as EventListener, true);
        this._listeners.push(['keyup', this._onKeyUp as EventListener, true]);
        window.addEventListener('blur', this._onBlur as EventListener);
        this._listeners.push(['blur', this._onBlur as EventListener, undefined]);

        const tick = (t: number): void => {
            this._raf = requestAnimationFrame(tick);
            const dt = this._lastFrameT ? Math.min((t - this._lastFrameT) / 1000, 0.1) : 0;
            this._lastFrameT = t;
            this._tick(dt);
        };
        this._lastFrameT = 0;
        this._raf = requestAnimationFrame(tick);

        this._write();
    }

    public detach(): void {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        for (const [type, fn, capture] of this._listeners) {
            (this._canvas ?? window).removeEventListener(type, fn, capture);
        }
        this._listeners = [];
        this._keys.clear();
        this._mode = 'none';
        this._framing = null;
        this._follow = null;
        this._canvas = null;
        this._camera = null;
    }

    // ── Commands (from the shortcuts service and the toolbar) ──────────

    /**
     * Looks along an engine-space axis (the orientation cube's cones): the
     * camera moves to the axis side and the forward becomes −axis. Animated,
     * as three's ViewHelper is — the cube click always eases.
     */
    public lookAlong(axis: { x: number; y: number; z: number }): void {
        const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
        const d = new THREE.Vector3(axis.x / len, axis.y / len, axis.z / len);
        const to: NavState = {
            ...this._s,
            // yaw = atan2(x, z), pitch = asin(y) — the inverse of
            // basisFromAngles, so the pose ends exactly on the axis side.
            yaw: Math.atan2(d.x, d.z),
            pitch: Math.asin(Math.max(-1, Math.min(1, d.y))),
        };
        this._startFrame(to);
        this._touch();
    }

    /**
     * Toggles the orthographic projection (the cube's centre click). The ortho
     * size is derived from the distance and the FOV so the framing survives
     * the toggle, as it does in Unity.
     */
    public toggleProjection(): void {
        this._s.orthographic = !this._s.orthographic;
        this._touch();
        this._writeCameraProjection();
    }

    /** The orthographic half-height that matches the current framing. */
    public get orthoSize(): number {
        return this._s.distance * Math.tan((this._camera?.fov ?? 50) * DEG / 2);
    }

    /** Rebuilds the camera as perspective or orthographic for the current pose. */
    public _writeCameraProjection(): void {
        this._camera?.setOrthographic?.(this._s.orthographic, this.orthoSize);
    }

    /** Frames the given bounds (engine-space centre + radius), animated. */
    public frame(center: { x: number; y: number; z: number }, radius: number): void {
        const dist = Math.max((radius / Math.tan((this._camera?.fov ?? 50) * DEG / 2)) * 1.2, MIN_DISTANCE);
        const to: NavState = { ...this._s, pivot: { ...center }, distance: dist };
        this._startFrame(to);
    }

    /** Frames and then follows the primary selection each frame. */
    public frameAndFollow(getTarget: () => { x: number; y: number; z: number } | null): void {
        const t = getTarget();
        this._follow = { go: getTarget, hasLast: t !== null };
        if (t) this.frame(t, 1);
        else this._follow = null;
    }

    /** Stops following (the followed object is gone). */
    public stopFollow(): void { this._follow = null; }

    /** Cancels the active gesture and the frame animation (a gizmo drag). */
    public cancelGestures(): void {
        this._mode = 'none';
        this._keys.clear();
        this._framing = null;
        try { if (this._pointerId !== null && this._canvas) this._canvas.releasePointerCapture(this._pointerId); } catch { /* jsdom */ }
        this._pointerId = null;
    }

    public get following(): boolean { return this._follow !== null; }

    // ── Internals ──────────────────────────────────────────────────────

    /** A user gesture: following ends (a manual look is not a follow). */
    private _touch(): void {
        if (this._follow) this._follow = null;
        this.onCameraGesture?.();
    }

    private _startFrame(to: NavState): void {
        const from: NavState = { ...this._s, pivot: { ...this._s.pivot } };
        this._framing = { from, to, t: 0 };
    }

    private _write(): void {
        if (!this._camera) return;
        applyPose(this._camera, this._s);
        this._writeCameraProjection();
    }

    private _tick(dt: number): void {
        let dirty = false;

        if (this._framing) {
            this._framing.t = Math.min(this._framing.t + dt * 1000 / FRAME_MS, 1);
            const e = 1 - Math.pow(1 - this._framing.t, 3);
            const a = this._framing.from;
            const b = this._framing.to;
            this._s = {
                ...this._s,
                yaw: a.yaw + (b.yaw - a.yaw) * e,
                pitch: a.pitch + (b.pitch - a.pitch) * e,
                pivot: {
                    x: a.pivot.x + (b.pivot.x - a.pivot.x) * e,
                    y: a.pivot.y + (b.pivot.y - a.pivot.y) * e,
                    z: a.pivot.z + (b.pivot.z - a.pivot.z) * e,
                },
                distance: a.distance + (b.distance - a.distance) * e,
            };
            if (this._framing.t >= 1) this._framing = null;
            dirty = true;
        }

        if (this._follow?.go && this._follow.hasLast) {
            const t = this._follow.go();
            if (!t) { this._follow = null; return; }
            // The followed object's world position is the pivot; the framing
            // animation that started with it carries the distance home.
            this._s.pivot = { x: t.x, y: t.y, z: t.z };
            dirty = true;
        }

        if (this._mode === 'fly' && this._keys.size > 0) {
            const forward = this._camera ? threeDirToEngine(forwardOf(this._camera)) : { x: 0, y: 0, z: 1 };
            // Engine-space right = forward rotated +90° about +Y: (z, 0, -x).
            const right = { x: forward.z, y: 0, z: -forward.x };
            const up = { x: 0, y: 1, z: 0 };
            const step = this._s.flySpeed * (this._shift ? 4 : 1) * dt;
            const move = { x: 0, y: 0, z: 0 };
            if (this._keys.has('w')) { move.x += forward.x; move.y += forward.y; move.z += forward.z; }
            if (this._keys.has('s')) { move.x -= forward.x; move.y -= forward.y; move.z -= forward.z; }
            if (this._keys.has('d')) { move.x += right.x; move.z += right.z; }
            if (this._keys.has('a')) { move.x -= right.x; move.z -= right.z; }
            if (this._keys.has('e')) { move.x += up.x; move.y += up.y; move.z += up.z; }
            if (this._keys.has('q')) { move.x -= up.x; move.y -= up.y; move.z -= up.z; }
            const len = Math.hypot(move.x, move.y, move.z);
            if (len > 0) {
                // Normalised, so W and D together do not fly faster than either.
                this._s.pivot = {
                    x: this._s.pivot.x + move.x / len * step,
                    y: this._s.pivot.y + move.y / len * step,
                    z: this._s.pivot.z + move.z / len * step,
                };
            }
            dirty = true;
        }

        if (dirty) this._write();
    }

    // ── Pointer plumbing ───────────────────────────────────────────────

    private _onPointerDown = (e: PointerEvent): void => {
        if (this._mode !== 'none') return;
        const canvas = this._canvas!;
        this._pointerId = e.pointerId;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._downX = e.clientX;
        this._downY = e.clientY;
        this._shift = e.shiftKey;
        // The gesture the button + modifiers mean (D-4). Alt+LMB orbits;
        // plain LMB is the selection's, except under the View tool (Q), where it
        // pans like Unity's hand. A movement key already held wins over
        // Shift+RMB's orbit: Shift is the fly's sprint, so RMB+Shift+W flies
        // fast instead of orbiting.
        if (e.button === 2 && e.altKey)      this._mode = 'dolly';
        else if (e.button === 2 && this._keys.size > 0) this._mode = 'fly';
        else if (e.button === 2 && e.shiftKey) this._mode = 'orbit';
        else if (e.button === 2)             this._mode = 'look';
        else if (e.button === 1)             this._mode = 'pan';
        else if (e.button === 0 && e.altKey) this._mode = 'orbit';
        else if (e.button === 0 && this._viewTool) this._mode = 'pan';
        else { this._pointerId = null; return; }

        // A movement key pressed after the right button turns the look into a fly.
        if (this._mode === 'look' && this._keys.size > 0) this._mode = 'fly';

        try { canvas.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
        e.preventDefault();
        this._touch();
    };

    private _onPointerMove = (e: PointerEvent): void => {
        if (this._mode === 'none') return;
        // Some browsers report aux-button drags with the mouse's pointer id or
        // with -1; the gesture is already chosen, so accept either.
        if (this._pointerId !== e.pointerId && e.pointerId !== -1 && e.pointerId !== 1) return;
        const dx = e.clientX - this._lastX;
        const dy = e.clientY - this._lastY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;

        switch (this._mode) {
            case 'orbit':
                this._s.yaw -= dx * ORBIT_PER_PIXEL;
                this._s.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this._s.pitch + dy * ORBIT_PER_PIXEL));
                this._write();
                break;
            case 'look': {
                // Unity's RMB look turns the camera in place: the position is
                // untouched. The pose is derived from the pivot, so the pivot is
                // re-derived *behind* the new direction — position + offset are
                // both carried, and the offset keeps its length.
                const yaw = this._s.yaw - dx * ORBIT_PER_PIXEL;
                const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this._s.pitch + dy * ORBIT_PER_PIXEL));
                const dir = basisFromAngles(this._s.yaw, this._s.pitch);
                const d = this._s.distance;
                const pos = {
                    x: this._s.pivot.x + dir.x * d,
                    y: this._s.pivot.y + dir.y * d,
                    z: this._s.pivot.z + dir.z * d,
                };
                const next = basisFromAngles(yaw, pitch);
                this._s.yaw = yaw;
                this._s.pitch = pitch;
                this._s.pivot = {
                    x: pos.x - next.x * d,
                    y: pos.y - next.y * d,
                    z: pos.z - next.z * d,
                };
                this._write();
                break;
            }
            case 'pan': {
                // The pivot moves by the drag in the camera plane and the camera
                // rides with it — the pose is derived, so the distance to the
                // pivot is untouched by construction.
                this._updatePanScale();
                // The world point under the cursor stays under it: the pivot
                // moves with the drag in the camera plane (right for x, world
                // up for y), and the camera rides along because the pose is
                // derived from the pivot.
                const forward = this._camera ? threeDirToEngine(forwardOf(this._camera)) : { x: 0, y: 0, z: 1 };
                // Right = forward turned +90° about +Y in engine space: (z, 0, −x).
                const right = { x: forward.z, y: 0, z: -forward.x };
                const d = {
                    x: right.x * dx * this._panPerPixel,
                    y: -dy * this._panPerPixel,
                    z: right.z * dx * this._panPerPixel,
                };
                this._s.pivot = {
                    x: this._s.pivot.x + d.x,
                    y: this._s.pivot.y + d.y,
                    z: this._s.pivot.z + d.z,
                };
                this._write();
                break;
            }
            case 'dolly': {
                // Alt+RMB drag: the same dolly as the wheel, in vertical pixels.
                const fov = (this._camera?.fov ?? 50) * DEG;
                const h = this._canvas?.clientHeight ?? 800;
                const per = 2 * this._s.distance * Math.tan(fov / 2) / h;
                this._s.distance = Math.max(MIN_DISTANCE, this._s.distance + dy * per);
                this._write();
                break;
            }
        }
    };

    private _onPointerUp = (e: PointerEvent): void => {
        if (this._pointerId !== e.pointerId) return;
        try { this._canvas?.releasePointerCapture(e.pointerId); } catch { /* jsdom */ }
        // An orbit/look press that never moved is not a gesture.
        this._pointerId = null;
        this._mode = 'none';
    };

    private _onWheel = (e: WheelEvent): void => {
        // A middle-button drag's autoscroll must not dolly; the pan owns it.
        if (this._mode === 'pan') return;
        e.preventDefault();
        if (this._mode === 'fly') {
            // The wheel scales the fly speed, ×1.2 per notch.
            this._s.flySpeed = Math.max(MIN_FLY, Math.min(MAX_FLY, this._s.flySpeed * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
            return;
        }
        // Scroll toward the user (deltaY < 0) zooms in: the distance drops.
        const dir = e.deltaY < 0 ? 1 : -1;
        const step = this._s.distance * 0.12;
        this._s.distance = Math.max(MIN_DISTANCE, this._s.distance - step * dir);
        this._write();
    };

    private _onContextMenu = (e: MouseEvent): void => {
        // Only on the canvas: the hierarchy and inspector keep their menus.
        e.preventDefault();
        e.stopPropagation();
    };

    private _onKeyDown = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        if (k === 'shift') { this._shift = true; return; }
        if ('wasdqe'.includes(k) && k.length === 1) {
            // WASDQE flies while the right mouse button is held; a key held
            // before the press starts the fly at the press. While flying, the
            // app's own tool shortcuts (W/E/R) must not see the key.
            if (this._mode === 'look') this._mode = 'fly';
            if (this._mode === 'fly') e.stopPropagation();
            this._keys.add(k);
        }
    };

    private _onKeyUp = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        if (k === 'shift') { this._shift = false; return; }
        this._keys.delete(k);
    };

    private _onBlur = (): void => {
        // A blur releases every key: an alt-tab mid-flight must not fly on.
        this._keys.clear();
        this._shift = false;
        if (this._mode === 'fly') this._mode = 'none';
    };

    /** World units per pixel at the pivot depth (D-4's pan scale). */
    private _updatePanScale(): void {
        const fov = (this._camera?.fov ?? 50) * DEG;
        const h = this._canvas?.clientHeight ?? 900;
        this._panPerPixel = 2 * this._s.distance * Math.tan(fov / 2) / h;
    }
}
