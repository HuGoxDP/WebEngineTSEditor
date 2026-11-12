import { Injectable } from '@angular/core';
import * as THREE from 'three';
import type { CameraTarget } from './scene-view-controller';
import { SceneManager } from 'WebEngineTS';

/**
 * The Scene view's renderer and the frame it draws (B1 phase 1; D-2 render
 * order, D-13 probe).
 *
 * Owns the WebGLRenderer, the editor camera, the OrbitControls and the
 * **editor overlay** — three-owned objects (grid, outline, gizmo helper,
 * future handles and orientation cube) that never enter the engine scene, so
 * nothing editor-only can be serialized (D-1). Everything the editor draws is
 * handed to a layer, and the frame composites the layers in the D-2 order:
 *
 * 1. clear
 * 2. engine scene (lit per its own lights; wireframe per a later phase)
 * 3. grid — depth-tested against the engine scene, so it is occluded by geometry
 * 4. clearDepth — everything after this is on top of the scene
 * 5. outline composite, component gizmos, transform handles
 * 6. orientation cube (own viewport, a later phase)
 *
 * The overlay lights and the AxesHelper the viewport used to keep are gone: a
 * scene with no light must read as dark (D-7) and the axes are the gizmo's own.
 */

/** An overlay kind decides which D-2 step its objects draw in. */
export type OverlayKind = 'grid' | 'above-scene';

/** The world up every ordinary `lookAt` uses. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** A full-screen pass drawn after every layer (D-9's selection outline). */
export type PostPass = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void;

/**
 * A D-2 step 6 corner viewport: its own scene and camera, drawn last into a
 * square in the top-right corner (the orientation cube, D-5). Kept apart from
 * the overlay layers because the cube must not be projected by the scene
 * camera — it has its own, aimed along the editor camera's direction.
 */
export interface CornerLayer {
    /** The scene holding the cube. Never the engine's. */
    scene: THREE.Scene;
    /** The camera that looks at the cube. */
    camera: THREE.Camera;
    /** The square's side, in client pixels. */
    size: number;
}

@Injectable({ providedIn: 'root' })
export class SceneViewRenderer {

    private _renderer: THREE.WebGLRenderer | null = null;
    private _camera: THREE.PerspectiveCamera | null = null;
    /** The camera implementation: one object, perspective and orthographic modes. */
    private _projection: ProjectionCamera | null = null;

    private _gridScene: THREE.Scene | null = null;
    private _aboveScene: THREE.Scene | null = null;
    /** The corner viewport (D-2 step 6); null when nothing owns one. */
    private _cornerLayer: CornerLayer | null = null;
    /** The final pass (D-9's outline); null when nothing owns one. */
    private _postPass: PostPass | null = null;
    private _rafId = 0;
    private _canvas: HTMLCanvasElement | null = null;
    private _resizeObs: ResizeObserver | null = null;

    /** The grid scene (depth-tested against the engine scene). */
    public get gridScene(): THREE.Scene | null { return this._gridScene; }

    /** The on-top scene (outline, gizmos, handles — D-2 step 5). */
    public get aboveScene(): THREE.Scene | null { return this._aboveScene; }

    /** The editor camera. */
    public get camera(): THREE.PerspectiveCamera | null { return this._camera; }

    /** The camera as a projection target for the navigation controller. */
    public get projectionCamera(): ProjectionCamera | null { return this._projection; }

    /** The drawing surface's client size (for the corner gizmo). */
    public get viewportSize(): { width: number; height: number } {
        return { width: this._canvas?.clientWidth ?? 0, height: this._canvas?.clientHeight ?? 0 };
    }

    /** The canvas's client rect, for pointer work in client pixels. */
    public get canvasRect(): { left: number; top: number; width: number; height: number } | null {
        const c = this._canvas;
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    /** Registers the corner viewport's contents (null clears it). */
    public setCornerLayer(layer: CornerLayer | null): void { this._cornerLayer = layer; }

    /** Registers the final full-screen pass (null clears it). */
    public setPostPass(pass: PostPass | null): void { this._postPass = pass; }

    /** The WebGLRenderer, for a pass that needs its targets. */
    public get gl(): THREE.WebGLRenderer | null { return this._renderer; }



    /** Attaches to a canvas. Idempotent. */
    public attach(canvas: HTMLCanvasElement, onTick?: () => void): void {
        if (this._renderer) return;
        this._canvas = canvas;

        this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this._renderer.setPixelRatio(window.devicePixelRatio);
        this._renderer.autoClear = false;

        this._gridScene = new THREE.Scene();
        this._aboveScene = new THREE.Scene();

        // One camera object, two modes: the orthographic toggle (B1 phase 3)
        // re-projects the same object instead of swapping cameras, so the
        // controller keeps a stable handle on it.
        const projection = new ProjectionCamera(50, 1, 0.1, 1000);
        projection.placeAt(6, 6, 10);
        this._projection = projection;
        this._camera = projection;

        // The navigation controller (B1 phase 2) owns the pose; a second set of
        // mouse handlers on the same canvas would fight it. The controls are
        // not created at all — the pivot lives in the controller's state.

        this._resize(canvas);
        this._resizeObs = new ResizeObserver(() => this._resize(canvas));
        this._resizeObs.observe(canvas);

        const loop = (): void => {
            this._rafId = requestAnimationFrame(loop);
            onTick?.();
            this.draw();
        };
        loop();
    }

    /** Adds an object to an overlay layer. */
    public addOverlayLayer(kind: OverlayKind, obj: THREE.Object3D): void {
        const scene = kind === 'grid' ? this._gridScene : this._aboveScene;
        scene?.add(obj);
    }

    /** Removes an object from whichever overlay layer holds it. */
    public removeOverlayLayer(obj: THREE.Object3D): void {
        this._gridScene?.remove(obj);
        this._aboveScene?.remove(obj);
    }

    /** Draws one frame in the D-2 order. */
    public draw(): void {
        const r = this._renderer;
        const cam = this._projection;
        if (!r || !cam || !this._gridScene || !this._aboveScene) return;

        // The navigation controller owns the camera pose; the OrbitControls
        // target is kept only as the initial target and is not updated here.

        // 1–2: clear, then the engine scene.
        r.clear();
        const engineScene = SceneManager.activeScene._internalThreeScene;
        r.render(engineScene, cam);
        // 3: grid, depth-tested against the scene above.
        r.render(this._gridScene, cam);
        // 4+: depth drop, then the on-top layers.
        r.clearDepth();
        r.render(this._aboveScene, cam);

        // 6: the corner viewport (the orientation cube). Scissored, so neither
        // its depth clear nor its draw touches the rest of the canvas; the
        // colour is not cleared, so the cube reads over the scene behind it.
        const corner = this._cornerLayer;
        if (corner && this._canvas) {
            const w = Math.min(corner.size, this._canvas.clientWidth);
            const h = Math.min(corner.size, this._canvas.clientHeight);
            const x = Math.max(0, this._canvas.clientWidth - w);
            const y = Math.max(0, this._canvas.clientHeight - h);
            r.setScissorTest(true);
            r.setScissor(x, y, w, h);
            r.setViewport(x, y, w, h);
            r.clearDepth();
            r.render(corner.scene, corner.camera);
            r.setScissorTest(false);
            r.setViewport(0, 0, this._canvas.clientWidth, this._canvas.clientHeight);
        }

        // 7: the screen-space post-pass (the selection outline, D-9). It draws
        // straight onto the canvas after every layer, so the scene itself is
        // never moved into a render target.
        if (this._postPass) this._postPass(r, cam);
    }

    /**
     * Counts pixels by hue inside a client-pixel rectangle (D-9's proof): the
     * frame is drawn and read in one task, because the drawing buffer is not
     * preserved between tasks.
     */
    public pixelStats(rect: { left: number; top: number; right: number; bottom: number }): {
        total: number; orange: number; green: number; white: number;
    } {
        const empty = { total: 0, orange: 0, green: 0, white: 0 };
        if (!this._renderer || !this._canvas) return empty;
        this.draw();
        const gl = this._renderer.getContext();
        const canvasRect = this._canvas.getBoundingClientRect();
        const x = Math.max(0, Math.round((rect.left - canvasRect.left) * window.devicePixelRatio));
        const y = Math.max(0, Math.round((rect.top - canvasRect.top) * window.devicePixelRatio));
        const w = Math.min(gl.drawingBufferWidth - x, Math.round((rect.right - rect.left) * window.devicePixelRatio));
        const h = Math.min(gl.drawingBufferHeight - y, Math.round((rect.bottom - rect.top) * window.devicePixelRatio));
        if (w <= 0 || h <= 0) return empty;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(x, gl.drawingBufferHeight - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const counts = { total: 0, orange: 0, green: 0, white: 0 };
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            counts.total++;
            if (r > 150 && g > 40 && g < 150 && b < 90) counts.orange++;
            else if (g > 150 && r < 130 && b < 140) counts.green++;
            else if (r > 210 && g > 210 && b > 210) counts.white++;
        }
        return counts;
    }

    /**
     * The RGBA of the composed frame at one **client** pixel, or null when the
     * renderer or the GL context is not there. Debug-probe use (D-13): the
     * drawing buffer is not preserved, so this draws and reads in one task —
     * a read any later would see a cleared or stale buffer.
     */
    public readPixel(clientX: number, clientY: number): [number, number, number, number] | null {
        if (!this._renderer || !this._canvas || !this._camera) return null;
        this.draw();
        const gl = this._renderer.getContext();
        const rect = this._canvas.getBoundingClientRect();
        const px = Math.round((clientX - rect.left) * window.devicePixelRatio);
        const py = Math.round((clientY - rect.top) * window.devicePixelRatio);
        if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) return null;
        const out = new Uint8Array(4);
        gl.readPixels(px, gl.drawingBufferHeight - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return [out[0], out[1], out[2], out[3]];
    }

    /** Stops the loop and releases GPU resources. */
    public detach(): void {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;
        this._resizeObs?.disconnect();
        this._resizeObs = null;
        this._renderer?.dispose();
        this._renderer = null;
        this._cornerLayer = null;
        this._postPass = null;
        this._projection = null;
        this._gridScene = null;
        this._aboveScene = null;
        this._camera = null;
        this._canvas = null;
    }

    private _resize(canvas: HTMLCanvasElement): void {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0 || !this._renderer || !this._camera) return;
        this._renderer.setSize(w, h, false);
        this._projection?.setAspect(w / h);
    }
}


/**
 * One camera with two projections (B1 phase 3). three splits perspective and
 * orthographic into different classes; the editor's Scene view toggles between
 * them on the orientation cube's centre click, and the controller needs one
 * stable object to aim.
 *
 * So this is one real `PerspectiveCamera` that becomes orthographic: the mode
 * flips the flags three branches on and takes the orthographic frustum's
 * matrices as its own. Everything else in the app (the render loop, the
 * TransformControls handles, the raycasters, the probe) keeps one object with a
 * current `matrixWorld`, `projectionMatrix` and `fov` — a stand-in object
 * without them broke the handles' `updateMatrixWorld` and their raycasts, which
 * is exactly the bug this shape avoids.
 */
class ProjectionCamera extends THREE.PerspectiveCamera {

    /** Distinguishes the two modes the way three does, for the probe's read. */
    public isOrthographicCamera = false;

    private readonly _ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    private _orthoSize = 5;

    constructor(fov: number, near: number, far: number, orthoSize = 5) {
        super(fov, near, far);
        this._orthoSize = orthoSize;
        this._ortho.near = near;
        this._ortho.far = far;
        this._project();
    }

    /** Places the camera at a three-space point looking at the origin. */
    public placeAt(x: number, y: number, z: number): void {
        this.position.set(x, y, z);
        this.lookAt(new THREE.Vector3(0, 0, 0));
    }

    /** The orthographic half-height that matches the current framing. */
    public get orthoSize(): number { return this._orthoSize; }

    /** The orthographic frustum's bounds, which the handles' scale reads. */
    public get top(): number { return this._ortho.top; }
    public get bottom(): number { return this._ortho.bottom; }

    /**
     * Aims the camera (three's own Object3D.lookAt, written out: there is no
     * parent to compensate for). The optional `up` matters at the poles, where
     * world +Y is parallel to the view and the roll is otherwise three's
     * arbitrary choice — see the controller's {@link applyPose}. Overloads keep
     * the `(x, y, z)` form three's own signature allows, so this stays a
     * PerspectiveCamera for every three API that takes one.
     */
    public override lookAt(target: THREE.Vector3, up?: THREE.Vector3): void;
    public override lookAt(x: number, y: number, z: number, up?: THREE.Vector3): void;
    public override lookAt(target: THREE.Vector3, up?: THREE.Vector3): void;
    public override lookAt(x: number, y: number, z: number, up?: THREE.Vector3): void;
    public override lookAt(targetOrX: THREE.Vector3 | number, yOrUp?: THREE.Vector3 | number, z?: number, upMaybe?: THREE.Vector3): void;
    public override lookAt(targetOrX: THREE.Vector3 | number, yOrUp?: THREE.Vector3 | number, z?: number, upMaybe?: THREE.Vector3): void {
        const target = typeof targetOrX === 'number'
            ? new THREE.Vector3(targetOrX, (yOrUp as number) ?? 0, z ?? 0)
            : targetOrX;
        const up = typeof yOrUp === 'number' ? upMaybe : yOrUp;
        this.quaternion.setFromRotationMatrix(
            new THREE.Matrix4().lookAt(this.position, target, up ?? WORLD_UP),
        );
    }

    public setOrthographic(orthographic: boolean, orthoSize: number): void {
        if (this.isOrthographicCamera === orthographic && this._orthoSize === orthoSize) return;
        this._orthoSize = orthoSize;
        (this as { isOrthographicCamera: boolean }).isOrthographicCamera = orthographic;
        (this as { isPerspectiveCamera: boolean }).isPerspectiveCamera = !orthographic;
        this._project();
    }

    public setAspect(aspect: number): void {
        this.aspect = aspect;
        this._project();
    }

    /** Rebuilds both frustums and adopts the active one's matrices. */
    private _project(): void {
        const h = this._orthoSize;
        this._ortho.left = -h * this.aspect;
        this._ortho.right = h * this.aspect;
        this._ortho.top = h;
        this._ortho.bottom = -h;
        this._ortho.updateProjectionMatrix();
        this.updateProjectionMatrix();
        if (this.isOrthographicCamera) {
            this.projectionMatrix.copy(this._ortho.projectionMatrix);
            this.projectionMatrixInverse.copy(this._ortho.projectionMatrixInverse);
        }
    }
}
