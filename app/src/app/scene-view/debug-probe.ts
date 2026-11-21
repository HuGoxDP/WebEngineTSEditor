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
import { TypeRegistry, getClassMeta } from 'WebEngineTS';

/** An object's engine-space transform, as the probe reports it (world + local TRS). */
export interface ProbeTransform {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    /** The rotation as Unity's Inspector shows it, in degrees. */
    euler: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    localPosition: { x: number; y: number; z: number };
    localRotation: { x: number; y: number; z: number; w: number };
    localScale: { x: number; y: number; z: number };
}

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
    /** An object's engine-space transform (world + local TRS), by name over the whole scene (D-6's assertions). */
    transformOf(name: string): ProbeTransform | null;
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
    /**
     * Every gizmo record of a kind for the named object, searched over the whole
     * scene (not only the selection). Engine space: bbox centre/half of the
     * vertices actually drawn, plus each circle's centre, unit normal, radius.
     * `kind` is a stable component type name ("PointLight") or the gizmo kind
     * ("pointLight"); omitted returns every kind the object draws. Each
     * returned record's `kind` carries the stable component type name.
     */
    gizmoInfo(name: string, kind?: string): {
        kind: string; extent: number;
        center: { x: number; y: number; z: number };
        half: { x: number; y: number; z: number };
        circles: { center: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number }; radius: number }[];
        selected: boolean;
    }[];
    /**
     * A kind's ACTUAL flushed line buffer (engine space, z un-flipped): the
     * draw-range vertex count, the attribute capacity and the last vertex.
     * Records are built before the flush, so only this read-back can prove the
     * pool grew past 8192 instead of truncating the tail (B1r5 #6 / B1r4 #9).
     */
    gizmoBufferStats(kind: string): { drawn: number; capacity: number; last: { x: number; y: number; z: number } } | null;
    /** How many billboard icons per stable component type are placed and visible (whole scene). */
    iconCounts(): Record<string, number>;
    /**
     * Toggles one component's enabled flag (the serializer does not persist it,
     * so the tests need a write path). `typeName` is the stable registry name;
     * `index` picks among that object's components of the type, in add order.
     */
    setComponentEnabled(goName: string, typeName: string, index: number, enabled: boolean): boolean;
    /** The Gizmos menu's switches, as the menu left them. */
    gizmoSettings(): { enabled: boolean; camera: boolean; lights: boolean; colliders: boolean; audio: boolean; iconSize: number };
    /**
     * Counts pixels by hue inside a client-pixel rectangle: the selection
     * outline's proof (D-9) is a count of orange pixels, not one sample.
     */
    pixelStats(rect: { left: number; top: number; right: number; bottom: number }): {
        total: number; orange: number; green: number; white: number;
    };
    /** Whether Scene-view lighting is on (B1 phase 7; D-7). */
    lightingOn(): boolean;
    /** The engine scene's draw mode: 'shaded' or 'wireframe' (D-8). */
    drawMode(): string;
    /** Whether the grid overlay is drawn. */
    gridVisible(): boolean;
    /** The grid's actual line spacing in world units (size / divisions). */
    gridStep(): number;
    /**
     * The engine three scene after a normal frame (DW-7.2's proof that the
     * lighting override leaves nothing behind): direct child count and every
     * light's `visible` flag, over the whole graph.
     */
    threeInfo(): { children: number; lightsVisible: boolean[] };
    /**
     * A script class the registry holds, with a **token**: a number that stays
     * with the class object and is never reused, so a test can tell "the same
     * class" from "a second class under the same name". `parent` is the script
     * class it extends (null when it extends an engine class): C4's proof that
     * editing a base module reaches its importers is the parent token.
     */
    scriptClass(name: string): { token: number; parent: string | null; parentToken: number | null } | null;
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
        /** One object's gizmo records of a kind, whole scene, engine space. */
        gizmoInfo?: (name: string, kind?: string) => {
            kind: string; extent: number;
            center: { x: number; y: number; z: number };
            half: { x: number; y: number; z: number };
            circles: { center: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number }; radius: number }[];
            selected: boolean;
        }[];
        iconCounts?: () => Record<string, number>;
        /** A kind's actual flushed line buffer: draw count, capacity, last vertex (B1r5 #6). */
        gizmoBufferStats?: (kind: string) => { drawn: number; capacity: number; last: { x: number; y: number; z: number } } | null;
        /** An object's world + local TRS by name, over the whole scene. */
        transformOf?: (name: string) => ProbeTransform | null;
        /** Toggles one component's enabled flag by stable type name + add-order index. */
        setComponentEnabled?: (goName: string, typeName: string, index: number, enabled: boolean) => boolean;
        gizmoSettings?: () => { enabled: boolean; camera: boolean; lights: boolean; colliders: boolean; audio: boolean; iconSize: number };
        /** The handle's position and axis directions in engine space (D-6). */
        handlePoint?: (axis: 'X' | 'Y' | 'Z', t: number) => { x: number; y: number; z: number } | null;
        /** Scene-view lighting state (B1 phase 7; D-7). */
        lightingOn?: () => boolean;
        /** The engine scene's draw mode (D-8). */
        drawMode?: () => string;
        /** The grid overlay's visibility and actual line spacing. */
        gridVisible?: () => boolean;
        gridStep?: () => number;
        /** The engine three scene as a normal frame leaves it (DW-7.2). */
        threeInfo?: () => { children: number; lightsVisible: boolean[] };
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
        gizmoInfo: (name, kind) => deps.gizmoInfo?.(name, kind) ?? [],
        gizmoBufferStats: kind => deps.gizmoBufferStats?.(kind) ?? null,
        iconCounts: () => deps.iconCounts?.() ?? {},
        setComponentEnabled: (goName, typeName, index, enabled) =>
            deps.setComponentEnabled?.(goName, typeName, index, enabled) ?? false,
        gizmoSettings: () => deps.gizmoSettings?.() ?? { enabled: true, camera: true, lights: true, colliders: true, audio: true, iconSize: 1 },
        pixelStats: (rect) => renderer.pixelStats(rect),
        transformOf: (name) => deps.transformOf?.(name) ?? null,
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
        lightingOn: () => deps.lightingOn?.() ?? true,
        drawMode: () => deps.drawMode?.() ?? 'shaded',
        gridVisible: () => deps.gridVisible?.() ?? true,
        gridStep: () => deps.gridStep?.() ?? 1,
        threeInfo: () => deps.threeInfo?.() ?? { children: 0, lightsVisible: [] },
        scriptClass: (name) => {
            const ctor = TypeRegistry.get(name) as (new (...args: never[]) => unknown) | null;
            if (!ctor) return null;
            const parent = Object.getPrototypeOf(ctor) as (new (...args: never[]) => unknown) | null;
            const parentName = parent ? (getClassMeta(parent)?.typeName ?? null) : null;
            return {
                token: tokenOf(ctor),
                parent: parentName,
                parentToken: parentName && parent ? tokenOf(parent) : null,
            };
        },
    };
    window.__wetsProbe = probe;
}

/** A token that stays with a class object and is never reused (see `scriptClass`). */
const classTokens = new WeakMap<object, number>();
let classTokenSeq = 0;
function tokenOf(ctor: object): number {
    let token = classTokens.get(ctor);
    if (token === undefined) {
        token = ++classTokenSeq;
        classTokens.set(ctor, token);
    }
    return token;
}
