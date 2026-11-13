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
    /**
     * Client pixels of a point `t` along the given axis from the pivot: lowercase
     * for the world axes, uppercase for the **handle's** axes (D-6), which the
     * Pivot/Centre and Local/Global switches move.
     */
    handlePoint(axis: 'x' | 'y' | 'z' | 'X' | 'Y' | 'Z', t: number): { x: number; y: number } | null;
    /** The handle axes under the pointer right now, or null (D-6's tool checks). */
    hoverAxis(): string | null;
    /** A selected object's engine-space transform, by name (D-6's assertions). */
    transformOf(name: string): {
        position: { x: number; y: number; z: number };
        rotation: { x: number; y: number; z: number; w: number };
        /** The rotation as Unity's Inspector shows it, in degrees. */
        euler: { x: number; y: number; z: number };
        scale: { x: number; y: number; z: number };
    } | null;
    /** RGBA of the composed frame at a client pixel (null if off-canvas). */
    pixel(x: number, y: number): [number, number, number, number] | null;
    /** Client size of the drawing surface. */
    size(): { width: number; height: number };
    /** The orientation cube's cone centres, in client pixels (D-5's read-back). */
    orientationTargets(): Record<string, { x: number; y: number }>;
    /** The orientation cube's projection mode and view name. */
    orientationMode(): { orthographic: boolean; label: string };
    /** Clicks the orientation cube at a client pixel (DW-3.1). */
    orientationClick(x: number, y: number): boolean;
    /** Every handle set's axis under the pointer, as `set: axis` (D-6). */
    hoverAll(): Record<string, string | null>;
    /** An object's screen-space bounds, or null when it is behind the camera. */
    objectScreenRect(name: string): { left: number; top: number; right: number; bottom: number } | null;
    /** How many gizmos of each kind the selection draws (D-11's read-back). */
    gizmoCounts(): Record<string, number>;
    /** How far one object's gizmo of a kind reaches, in engine units. */
    gizmoExtent(name: string, kind: string): number | null;
    /** The Gizmos menu's switches, as the menu left them. */
    gizmoSettings(): { enabled: boolean; camera: boolean; lights: boolean; colliders: boolean; audio: boolean; iconSize: number };
    /**
     * Counts pixels by hue inside a client-pixel rectangle: the selection
     * outline's proof (D-9) is a count of orange pixels, not one sample.
     */
    pixelStats(rect: { left: number; top: number; right: number; bottom: number }): {
        total: number; orange: number; green: number; white: number;
    };
}

declare global {
    interface Window { __wetsProbe?: WetsProbe; }
}

/** Whether the probe should be installed (production editors never have the flag). */
export function probeEnabled(): boolean {
    return typeof localStorage !== 'undefined' && localStorage.getItem('wets:debug:probe') === '1';
}

/** The engine-space pose of a three camera (phase 1's space.ts conversion, probe-local). */
/**
 * The engine-space pose of the editor camera. The renderer's camera is the
 * scene-view's own projection camera (phase 3), which carries position and
 * quaternion directly — no world matrices to walk.
 */
function enginePose(camera: THREE.Camera & { position: THREE.Vector3; quaternion: THREE.Quaternion }): {
    position: { x: number; y: number; z: number };
    forward: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
    orthographic: boolean;
} {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const pos = camera.position;
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
        selection: { selectedSet(): ReadonlySet<{ name: string; transform: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; eulerAngles: { x: number; y: number; z: number }; localScale: { x: number; y: number; z: number } } }> },
        canvas: () => HTMLCanvasElement | null;
        /** The navigation controller's state, engine space, while one exists. */
        nav?: { pivot: { x: number; y: number; z: number }; distance: number; yaw: number; pitch: number; orthographic: boolean; flySpeed: number };
        /** The orientation cube's current state, when the gizmo exists. */
        orientation?: () => { targets: Record<string, { x: number; y: number }>; label: string };
        /** Routes a client-pixel click to the orientation cube. */
        orientationClick?: (x: number, y: number) => boolean;
        /** The handle axes under the pointer, when the handles own one. */
        hoverAxis?: () => string | null;
        /** Every handle set's axis under the pointer (the sets can overlap). */
        hoverAll?: () => Record<string, string | null>;
        /** An object's projected renderer bounds (D-10's rectangle target). */
        objectScreenRect?: (name: string) => { left: number; top: number; right: number; bottom: number } | null;
        /** The component gizmos over the selection (D-11). */
        gizmoCounts?: () => Record<string, number>;
        gizmoExtent?: (name: string, kind: string) => number | null;
        gizmoSettings?: () => { enabled: boolean; camera: boolean; lights: boolean; colliders: boolean; audio: boolean; iconSize: number };
        /** The handle's position and axis directions in engine space (D-6). */
        handlePoint?: (axis: 'X' | 'Y' | 'Z', t: number) => { x: number; y: number; z: number } | null;
    },
): void {
    const probe: WetsProbe = {
        camera: () => {
            const cam = renderer.projectionCamera ?? renderer.camera;
            if (!cam) throw new Error('probe: no camera attached');
            return enginePose(cam as unknown as THREE.Camera);
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
            // The handle's own axes: read the proxy through the viewport's engine-space
            // accessor, so a Local-space or Centre-mode handle reports where it is.
            if (axis === 'X' || axis === 'Y' || axis === 'Z') {
                const p = deps.handlePoint?.(axis, t);
                if (!p) return null;
                const v = new THREE.Vector3(p.x, p.y, -p.z).project(cam);
                const rect = canvas.getBoundingClientRect();
                return {
                    x: rect.left + ((v.x + 1) / 2) * rect.width,
                    y: rect.top + ((1 - v.y) / 2) * rect.height,
                };
            }
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
        hoverAxis: () => deps.hoverAxis?.() ?? null,
        hoverAll: () => deps.hoverAll?.() ?? {},
        objectScreenRect: (name) => deps.objectScreenRect?.(name) ?? null,
        gizmoCounts: () => deps.gizmoCounts?.() ?? {},
        gizmoExtent: (name, kind) => deps.gizmoExtent?.(name, kind) ?? null,
        gizmoSettings: () => deps.gizmoSettings?.() ?? { enabled: true, camera: true, lights: true, colliders: true, audio: true, iconSize: 1 },
        pixelStats: (rect) => renderer.pixelStats(rect),
        transformOf: (name) => {
            for (const go of deps.selection.selectedSet()) {
                if (go.name !== name) continue;
                const t = go.transform;
                const p = t.position;
                const q = t.rotation;
                const s = t.localScale;
                return {
                    position: { x: p.x, y: p.y, z: p.z },
                    rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
                    euler: (() => { const e = t.eulerAngles; return { x: e.x, y: e.y, z: e.z }; })(),
                    scale: { x: s.x, y: s.y, z: s.z },
                };
            }
            return null;
        },
        size: () => {
            const canvas = deps.canvas();
            return { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 };
        },
        orientationTargets: () => deps.orientation?.().targets ?? {},
        orientationMode: () => {
            const s = deps.orientation?.();
            const cam = renderer.camera;
            return {
                orthographic: (cam as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera === true,
                label: s?.label ?? '',
            };
        },
        orientationClick: (x, y) => {
            const handler = deps.orientationClick;
            return handler ? handler(x, y) : false;
        },
        pixel: (x, y) => renderer.readPixel(x, y),
    };
    window.__wetsProbe = probe;
}
