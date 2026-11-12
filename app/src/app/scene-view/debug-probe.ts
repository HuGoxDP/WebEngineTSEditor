/**
 * The debug probe (B1 phase 1; D-13).
 *
 * e2e reads Scene-view state through `window.__wetsProbe`, which exists only
 * when `localStorage['wets:debug:probe'] === '1'` (the `wets:debug:autosaveMs`
 * precedent) — a production editor carries none of it and nothing in the app
 * depends on the probe. Every method answers in **engine space** (phase 1's
 * `space.ts`), so the tests assert the space the Inspector shows; three-space
 * values would hide sign errors (the research's mirror-math warning).
 *
 * `pixel()` is the render-order proof: DW-1.4 needs the gizmo's red X arrow to
 * land *over* the cube, which is exactly the D-2 layering, so the probe reads
 * the composed frame back through {@link SceneViewRenderer.readPixel}.
 */

import * as THREE from 'three';
import type { SceneViewRenderer } from './scene-view-renderer';

/** The probe's shape, as installed on `window`. */
export interface WetsProbe {
    /** The editor camera pose in engine space. */
    camera(): {
        position: { x: number; y: number; z: number };
        forward: { x: number; y: number; z: number };
        up: { x: number; y: number; z: number };
        orthographic: boolean;
    };
    /** The Scene-view pivot (the orbit target) in engine space. */
    pivot(): { x: number; y: number; z: number };
    /** The selected object names. */
    selection(): string[];
    /** Client pixels of a point `t` along the given axis from the pivot. */
    handlePoint(axis: 'x' | 'y' | 'z', t: number): { x: number; y: number } | null;
    /** RGBA of the composed frame at a client pixel (null if off-canvas). */
    pixel(x: number, y: number): [number, number, number, number] | null;
    /** Client size of the drawing surface. */
    size(): { width: number; height: number };
}

declare global {
    interface Window { __wetsProbe?: WetsProbe; }
}

/** Whether the probe should be installed (production editors never have the flag). */
export function probeEnabled(): boolean {
    return typeof localStorage !== 'undefined' && localStorage.getItem('wets:debug:probe') === '1';
}

/** The engine-space pose of a three camera (phase 1's space.ts conversion, probe-local). */
function enginePose(camera: THREE.Camera): {
    position: { x: number; y: number; z: number };
    forward: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
    orthographic: boolean;
} {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    const pos = camera.getWorldPosition(new THREE.Vector3());
    return {
        position: { x: pos.x, y: pos.y, z: -pos.z },
        forward: { x: forward.x, y: forward.y, z: -forward.z },
        up: { x: up.x, y: up.y, z: -up.z },
        orthographic: (camera as THREE.OrthographicCamera).isOrthographicCamera === true,
    };
}

/**
 * Installs the probe for the given renderer + selection source. Called by the
 * viewport facade when the flag is on.
 */
export function installProbe(
    renderer: SceneViewRenderer,
    deps: {
        selection: { selectedSet(): ReadonlySet<{ name: string }> },
        canvas: () => HTMLCanvasElement | null;
        /** The navigation controller's state, engine space, while one exists. */
        nav?: { pivot: { x: number; y: number; z: number }; distance: number; yaw: number; pitch: number; orthographic: boolean; flySpeed: number };
    },
): void {
    const probe: WetsProbe = {
        camera: () => {
            const cam = renderer.camera;
            if (!cam) throw new Error('probe: no camera attached');
            return enginePose(cam);
        },
        pivot: () => {
            if (deps.nav) return { ...deps.nav.pivot };
            return { x: 0, y: 0, z: 0 };
        },
        selection: () => [...deps.selection.selectedSet()].map(o => o.name),
        handlePoint: (axis, t) => {
            const cam = renderer.camera;
            const canvas = deps.canvas();
            if (!cam || !canvas) return null;
            const nv = deps.nav ? { ...deps.nav.pivot } : { x: 0, y: 0, z: 0 };
            const pivot = new THREE.Vector3(nv.x, nv.y, nv.z);
            const dir = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? -1 : 0);
            const p = pivot.clone().addScaledVector(dir, t).project(cam);
            const rect = canvas.getBoundingClientRect();
            return {
                x: rect.left + ((p.x + 1) / 2) * rect.width,
                y: rect.top + ((1 - p.y) / 2) * rect.height,
            };
        },
        size: () => {
            const canvas = deps.canvas();
            return { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 };
        },
        pixel: (x, y) => renderer.readPixel(x, y),
    };
    window.__wetsProbe = probe;
}
