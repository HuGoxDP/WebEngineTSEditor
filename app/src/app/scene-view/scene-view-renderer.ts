import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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

@Injectable({ providedIn: 'root' })
export class SceneViewRenderer {

    private _renderer: THREE.WebGLRenderer | null = null;
    private _camera: THREE.PerspectiveCamera | null = null;
    private _controls: OrbitControls | null = null;
    private _gridScene: THREE.Scene | null = null;
    private _aboveScene: THREE.Scene | null = null;
    private _rafId = 0;
    private _canvas: HTMLCanvasElement | null = null;
    private _resizeObs: ResizeObserver | null = null;

    /** The grid scene (depth-tested against the engine scene). */
    public get gridScene(): THREE.Scene | null { return this._gridScene; }

    /** The on-top scene (outline, gizmos, handles — D-2 step 5). */
    public get aboveScene(): THREE.Scene | null { return this._aboveScene; }

    /** The editor camera. */
    public get camera(): THREE.PerspectiveCamera | null { return this._camera; }

    /** The orbit controls (the pivot for creates until B1.2's controller). */
    public get controls(): OrbitControls | null { return this._controls; }

    /** Attaches to a canvas. Idempotent. */
    public attach(canvas: HTMLCanvasElement, onTick?: () => void): void {
        if (this._renderer) return;
        this._canvas = canvas;

        this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this._renderer.setPixelRatio(window.devicePixelRatio);
        this._renderer.autoClear = false;

        this._gridScene = new THREE.Scene();
        this._aboveScene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
        camera.position.set(6, 6, 10);
        camera.lookAt(0, 0, 0);
        this._camera = camera;

        const controls = new OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        this._controls = controls;

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
        const cam = this._camera;
        if (!r || !cam || !this._gridScene || !this._aboveScene) return;

        this._controls?.update();

        // 1–2: clear, then the engine scene.
        r.clear();
        const engineScene = SceneManager.activeScene._internalThreeScene;
        r.render(engineScene, cam);
        // 3: grid, depth-tested against the scene above.
        r.render(this._gridScene, cam);
        // 4+: depth drop, then the on-top layers.
        r.clearDepth();
        r.render(this._aboveScene, cam);
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
        this._controls?.dispose();
        this._controls = null;
        this._renderer?.dispose();
        this._renderer = null;
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
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
    }
}
