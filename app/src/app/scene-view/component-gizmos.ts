import * as THREE from 'three';
import { GameObject, SceneManager, Transform, TypeRegistry } from 'WebEngineTS';
import { enginePointToThree } from './space';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * Component gizmos — Unity's light, camera, collider and audio helpers
 * (B1 phase 6; D-11).
 *
 * The geometry is rebuilt each frame from the components' public fields and
 * pushed into one pooled `LineSegments` per kind, so nothing here allocates per
 * frame and nothing editor-owned ever enters the engine scene (D-1). Every
 * gizmo is built in **engine space** — the space the Inspector shows, the space
 * Unity parity is defined in — and converted once, per vertex, by `space.ts`.
 *
 * The Gizmos menu's switches live here: they decide which kinds are drawn and
 * whether any are at all, and they survive a reload because they are view state
 * (Unity keeps it per user), not scene data.
 */

/** The kinds the menu can switch independently. */
export type GizmoKind =
    | 'cameraFrustum' | 'directionalLight' | 'pointLight' | 'spotLight'
    | 'boxCollider' | 'sphereCollider' | 'capsuleCollider' | 'audioSource';

/** Every kind, in the menu's order. */
export const GIZMO_KINDS: readonly GizmoKind[] = [
    'cameraFrustum', 'directionalLight', 'pointLight', 'spotLight',
    'boxCollider', 'sphereCollider', 'capsuleCollider', 'audioSource',
];

/** The Gizmos menu's state, as the user left it. */
export interface GizmoSettings {
    /** The master switch: off hides every kind. */
    enabled: boolean;
    camera: boolean;
    lights: boolean;
    colliders: boolean;
    audio: boolean;
    /** The billboard icons' scale, in gizmo units. */
    iconSize: number;
}

const KEY = 'wets:gizmos:v1';
const VERTS = 8192;

export function defaultGizmoSettings(): GizmoSettings {
    return { enabled: true, camera: true, lights: true, colliders: true, audio: true, iconSize: 1 };
}

/** Reads the stored switches, each checked (a hand-edited entry must not break startup). */
export function loadGizmoSettings(storage?: Pick<Storage, 'getItem'>): GizmoSettings {
    const out = defaultGizmoSettings();
    try {
        const raw = (storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined))?.getItem(KEY);
        if (!raw) return out;
        const p = JSON.parse(raw) as Partial<GizmoSettings>;
        for (const k of ['enabled', 'camera', 'lights', 'colliders', 'audio'] as const) {
            if (typeof p[k] === 'boolean') out[k] = p[k] as boolean;
        }
        if (typeof p.iconSize === 'number' && p.iconSize > 0 && Number.isFinite(p.iconSize)) out.iconSize = Math.min(4, p.iconSize);
    } catch { /* unreadable entry: defaults */ }
    return out;
}

/** Writes the switches back. */
export function saveGizmoSettings(settings: GizmoSettings): void {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* quota / private mode */ }
}

/** Unity's green for colliders, the one colour the spec fixes for them. */
const COLLIDER_COLOR = 0x35b557;
const GIZMO_COLOR = 0xcfd3da;

/** What one object's gizmos added to a kind's pool, for the probe's read-back. */
interface Drawn {
    kind: GizmoKind;
    /** The farthest gizmo extent from the object, in engine units. */
    extent: number;
}

export class ComponentGizmos {

    private readonly _renderer: SceneViewRenderer;
    private readonly _lines = new Map<GizmoKind, THREE.LineSegments>();
    private readonly _drawn = new Map<THREE.Object3D, Drawn[]>();
    private _settings: GizmoSettings = defaultGizmoSettings();
    /** The objects gizmos are drawn for; null = every object in the scene. */
    private _scope: ReadonlySet<THREE.Object3D> | null = null;

    constructor(renderer: SceneViewRenderer) {
        this._renderer = renderer;
        for (const kind of GIZMO_KINDS) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3));
            const material = new THREE.LineBasicMaterial({
                color: kind === 'boxCollider' || kind === 'sphereCollider' || kind === 'capsuleCollider'
                    ? COLLIDER_COLOR : GIZMO_COLOR,
            });
            const lines = new THREE.LineSegments(geometry, material);
            lines.frustumCulled = false;
            lines.visible = false;
            // Depth-tested, like Unity's gizmos: geometry hides them.
            renderer.addOverlayLayer('grid', lines);
            this._lines.set(kind, lines);
        }
    }

    public setSettings(settings: GizmoSettings): void { this._settings = settings; }

    /** Restricts the gizmos to these objects (null = the whole scene). */
    public setScope(objects: ReadonlySet<THREE.Object3D> | null): void { this._scope = objects; }

    /** The extents one object's gizmos reached, for the probe. */
    public drawnFor(object: THREE.Object3D): readonly Drawn[] { return this._drawn.get(object) ?? []; }

    public dispose(): void {
        for (const lines of this._lines.values()) {
            this._renderer.removeOverlayLayer(lines);
            lines.geometry.dispose();
            (lines.material as THREE.Material).dispose();
        }
        this._lines.clear();
        this._drawn.clear();
    }

    /**
     * Rebuilds every enabled kind for the scene's objects. The controller's
     * dirty flush has already run, so the world matrices are current.
     */
    public update(): void {
        this._drawn.clear();
        const settings = this._settings;
        const pools = new Map<GizmoKind, number[]>();
        for (const kind of GIZMO_KINDS) pools.set(kind, []);

        for (const go of this._allObjects()) {
            if ((window as unknown as { __dbg?: boolean }).__dbg) console.log('GZ ' + go.name + ': ' + JSON.stringify(go.getAllComponents().map(c => TypeRegistry.getTypeName(c))));
            const object = go.transform._internalObject3D;
            if (this._scope && !this._scope.has(object)) continue;
            for (const component of go.getAllComponents()) {
                const kind = this._kindOf(component);
                if (!kind || !this._enabled(kind)) continue;
                const extent = this._build(kind, go.transform, pools.get(kind)!);
                if (extent === null) continue;
                const list = this._drawn.get(object) ?? [];
                list.push({ kind, extent });
                this._drawn.set(object, list);
            }
        }

        for (const kind of GIZMO_KINDS) {
            const lines = this._lines.get(kind)!;
            const pool = pools.get(kind)!;
            const attribute = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
            const array = attribute.array as Float32Array;
            const count = Math.min(pool.length, array.length);
            array.set(pool.slice(0, count));
            attribute.needsUpdate = true;
            lines.geometry.setDrawRange(0, count / 3);
            lines.visible = count > 0 && settings.enabled;
        }
        void settings;
    }

    // ── Which component makes which kind ──────────────────────────────

    /**
     * The kind a component's gizmo is. The engine's own registry names the type,
     * which survives the production build's minification (a class name does not).
     */
    private _kindOf(component: unknown): GizmoKind | null {
        switch (TypeRegistry.getTypeName(component as object)) {
            case 'Camera': return 'cameraFrustum';
            case 'DirectionalLight': return 'directionalLight';
            case 'PointLight': return 'pointLight';
            case 'SpotLight': return 'spotLight';
            case 'BoxCollider': return 'boxCollider';
            case 'SphereCollider': return 'sphereCollider';
            case 'CapsuleCollider': return 'capsuleCollider';
            case 'AudioSource': return 'audioSource';
            default: return null;
        }
    }

    private _enabled(kind: GizmoKind): boolean {
        const s = this._settings;
        if (!s.enabled) return false;
        if (kind === 'cameraFrustum') return s.camera;
        if (kind === 'audioSource') return s.audio;
        if (kind === 'boxCollider' || kind === 'sphereCollider' || kind === 'capsuleCollider') return s.colliders;
        return s.lights;
    }

    // ── Geometry, built in engine space and converted once ────────────

    /**
     * Writes one component's gizmo into the pool and returns the farthest extent
     * from the object (or null when the component has nothing to draw — a
     * disabled one, say).
     */
    private _build(kind: GizmoKind, transform: Transform, pool: number[]): number | null {
        const component = this._componentOf(transform, kind);
        if (!component || !this._active(component)) return null;

        const position = transform.position;
        const rotation = transform.rotation;
        const scale = transform.lossyScale;
        const put = (x: number, y: number, z: number): void => {
            const v = enginePointToThree({ x, y, z });
            pool.push(v.x, v.y, v.z);
        };
        /** A local engine point, turned by the object's rotation and moved to it. */
        const local = (lx: number, ly: number, lz: number): { x: number; y: number; z: number } => {
            const q = { x: lx, y: ly, z: lz };
            const r = this._rotate(q, rotation);
            return { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z };
        };
        let extent = 0;
        const line = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): void => {
            put(a.x, a.y, a.z); put(b.x, b.y, b.z);
            extent = Math.max(extent, this._distance(a, position), this._distance(b, position));
        };
        const circle = (radius: number, plane: 'xy' | 'xz' | 'yz', segments = 24): void => {
            for (let i = 0; i < segments; i++) {
                const a = (i / segments) * Math.PI * 2;
                const b = ((i + 1) / segments) * Math.PI * 2;
                line(this._circlePoint(a, radius, plane), this._circlePoint(b, radius, plane));
            }
            extent = Math.max(extent, radius);
        };

        switch (kind) {
            case 'cameraFrustum': return this._frustum(component, local, line, scale);
            case 'directionalLight': {
                const forward = transform.forward;
                const length = 1.5;
                const right = { x: forward.z, y: 0, z: -forward.x };
                const up = { x: 0, y: 1, z: 0 };
                for (const offset of [-0.35, -0.18, 0, 0.18, 0.35]) {
                    for (const side of [right, up]) {
                        const start = {
                            x: position.x + side.x * offset, y: position.y + side.y * offset, z: position.z + side.z * offset,
                        };
                        line(start, {
                            x: start.x + forward.x * length, y: start.y + forward.y * length, z: start.z + forward.z * length,
                        });
                    }
                }
                // A small disc at the far end.
                const centre = {
                    x: position.x + forward.x * length, y: position.y + forward.y * length, z: position.z + forward.z * length,
                };
                for (let i = 0; i < 16; i++) {
                    const a = (i / 16) * Math.PI * 2, b = ((i + 1) / 16) * Math.PI * 2;
                    const disc = (t: number) => ({
                        x: centre.x + Math.cos(t) * 0.3 + right.x * 0 + up.x * 0,
                        y: centre.y + Math.sin(t) * 0.3,
                        z: centre.z,
                    });
                    line(disc(a), disc(b));
                }
                void forward; void up; void right;
                return extent;
            }
            case 'pointLight': {
                const range = Number((component as { range?: number }).range ?? 0);
                if (range <= 0) return null;
                circle(range, 'xy'); circle(range, 'xz'); circle(range, 'yz');
                return extent;
            }
            case 'spotLight': {
                const range = Number((component as { range?: number }).range ?? 0);
                const angle = Number((component as { spotAngle?: number }).spotAngle ?? 0) * Math.PI / 360;
                if (range <= 0) return null;
                const forward = transform.forward;
                const r = Math.tan(Math.min(angle, Math.PI / 2 - 0.01)) * range;
                const right = { x: forward.z, y: 0, z: -forward.x };
                const up = { x: 0, y: 1, z: 0 };
                const centre = { x: position.x + forward.x * range, y: position.y + forward.y * range, z: position.z + forward.z * range };
                for (const [sx, sy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
                    line(position, {
                        x: centre.x + right.x * sx * r + up.x * sy * r,
                        y: centre.y + right.y * sy * r + up.y * sy * r,
                        z: centre.z + right.z * sx * r + up.z * sy * r,
                    });
                }
                for (let i = 0; i < 16; i++) {
                    const a = (i / 16) * Math.PI * 2, b = ((i + 1) / 16) * Math.PI * 2;
                    const at = (t: number) => ({
                        x: centre.x + Math.cos(t) * r, y: centre.y + Math.sin(t) * r, z: centre.z,
                    });
                    line(at(a), at(b));
                }
                extent = Math.max(extent, range);
                return extent;
            }
            case 'boxCollider': {
                const center = (component as { center?: { x: number; y: number; z: number } }).center ?? { x: 0, y: 0, z: 0 };
                const size = (component as { size?: { x: number; y: number; z: number } }).size ?? { x: 1, y: 1, z: 1 };
                const h = { x: (size.x * scale.x) / 2, y: (size.y * scale.y) / 2, z: (size.z * scale.z) / 2 };
                const c = [0, 1, 2, 3, 4, 5, 6, 7].map(i => local(
                    center.x + (i & 1 ? h.x : -h.x),
                    center.y + (i & 2 ? h.y : -h.y),
                    center.z + (i & 4 ? h.z : -h.z),
                ));
                for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) line(c[a], c[b]);
                return extent;
            }
            case 'sphereCollider': {
                const center = (component as { center?: { x: number; y: number; z: number } }).center ?? { x: 0, y: 0, z: 0 };
                const radius = Number((component as { radius?: number }).radius ?? 0) * Math.max(scale.x, scale.y, scale.z);
                if (radius <= 0) return null;
                for (const plane of ['xy', 'xz', 'yz'] as const) {
                    for (let i = 0; i < 24; i++) {
                        const a = (i / 24) * Math.PI * 2, b = ((i + 1) / 24) * Math.PI * 2;
                        const pa = this._offset(this._rotate(this._circlePoint(a, radius, plane), rotation), position);
                        const pb = this._offset(this._rotate(this._circlePoint(b, radius, plane), rotation), position);
                        line({ x: pa.x + center.x, y: pa.y + center.y, z: pa.z + center.z }, { x: pb.x + center.x, y: pb.y + center.y, z: pb.z + center.z });
                    }
                }
                return extent;
            }
            case 'capsuleCollider': {
                const center = (component as { center?: { x: number; y: number; z: number } }).center ?? { x: 0, y: 0, z: 0 };
                const radius = Number((component as { radius?: number }).radius ?? 0);
                const height = Number((component as { height?: number }).height ?? 0);
                if (radius <= 0 || height <= 0) return null;
                const h = Math.max(0, (height - radius * 2) / 2);
                for (const dir of [1, -1]) {
                    const cap = { x: center.x, y: center.y + dir * h, z: center.z };
                    for (const plane of ['xy', 'xz'] as const) {
                        for (let i = 0; i < 12; i++) {
                            const a = (i / 12) * Math.PI * 2, b = ((i + 1) / 12) * Math.PI * 2;
                            const p1 = this._offset(cap, this._rotate(this._circlePoint(a, radius, plane), rotation));
                            const p2 = this._offset(cap, this._rotate(this._circlePoint(b, radius, plane), rotation));
                            line(p1, p2);
                        }
                    }
                    line(
                        { x: center.x - radius, y: center.y + dir * h, z: center.z },
                        { x: center.x + radius, y: center.y + dir * h, z: center.z },
                    );
                    line(
                        { x: center.x, y: center.y + dir * h, z: center.z - radius },
                        { x: center.x, y: center.y + dir * h, z: center.z + radius },
                    );
                }
                extent = Math.max(extent, h + radius);
                return extent;
            }
            case 'audioSource': {
                const min = Number((component as { minDistance?: number }).minDistance ?? 0);
                const max = Number((component as { maxDistance?: number }).maxDistance ?? 0);
                if (max <= 0) return null;
                if (min > 0) circle(min, 'xy');
                circle(max, 'xy');
                return extent;
            }
        }
        return null;
    }

    /** The camera frustum (or its orthographic box) in engine space. */
    private _frustum(
        component: unknown,
        local: (x: number, y: number, z: number) => { x: number; y: number; z: number },
        line: (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => void,
        scale: { x: number; y: number; z: number },
    ): number {
        void scale;
        const cam = component as { fieldOfView: number; nearClipPlane: number; farClipPlane: number; orthographic: boolean; orthographicSize: number };
        const near = Math.max(0.01, cam.nearClipPlane);
        // Unity clamps the drawing distance; a far plane of a million would fill
        // the view (D-11's display clamp).
        const far = Math.min(Math.max(cam.farClipPlane, near + 0.01), 100);
        if (cam.orthographic) {
            const h = Math.max(0.01, cam.orthographicSize);
            const aspect = this._aspect();
            const w = h * aspect;
            const box = [
                local(-w, -h, near), local(w, -h, near), local(w, h, near), local(-w, h, near),
                local(-w, -h, far), local(w, -h, far), local(w, h, far), local(-w, h, far),
            ];
            for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) line(box[a], box[b]);
            return far;
        }
        const half = Math.max(1, cam.fieldOfView) * Math.PI / 360;
        const aspect = this._aspect();
        const nearH = Math.tan(half) * near, farH = Math.tan(half) * far;
        const nearW = nearH * aspect, farW = farH * aspect;
        const box = [
            local(-nearW, -nearH, near), local(nearW, -nearH, near), local(nearW, nearH, near), local(-nearW, nearH, near),
            local(-farW, -farH, far), local(farW, -farH, far), local(farW, farH, far), local(-farW, farH, far),
        ];
        for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) line(box[a], box[b]);
        return far;
    }

    // ── Small engine-space helpers ────────────────────────────────────

    private _aspect(): number {
        const size = this._renderer.viewportSize;
        return size.height > 0 ? size.width / size.height : 1;
    }

    private _componentOf(transform: Transform, kind: GizmoKind): unknown {
        const wanted = kind === 'cameraFrustum' ? 'Camera'
            : kind === 'directionalLight' ? 'DirectionalLight'
            : kind === 'pointLight' ? 'PointLight'
            : kind === 'spotLight' ? 'SpotLight'
            : kind === 'boxCollider' ? 'BoxCollider'
            : kind === 'sphereCollider' ? 'SphereCollider'
            : kind === 'capsuleCollider' ? 'CapsuleCollider'
            : 'AudioSource';
        return transform.gameObject.getAllComponents()
            .find(c => TypeRegistry.getTypeName(c) === wanted) ?? null;
    }

    /** Unity draws nothing for a disabled component or an inactive object. */
    private _active(component: unknown): boolean {
        const c = component as { enabled?: boolean; isActiveAndEnabled?: boolean; gameObject?: { activeSelf?: boolean } };
        if (c && c.enabled === false) return false;
        const go = c?.gameObject as { activeSelf?: boolean } | undefined;
        if (go && go.activeSelf === false) return false;
        return true;
    }

    private _rotate(q: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
        const { x, y, z, w } = rotation;
        const ix = w * q.x + y * q.z - z * q.y;
        const iy = w * q.y + z * q.x - x * q.z;
        const iz = w * q.z + x * q.y - y * q.x;
        const iw = -x * q.x - y * q.y - z * q.z;
        return {
            x: ix * w + iw * -x + iy * -z - iz * -y,
            y: iy * w + iw * -y + iz * -x - ix * -z,
            z: iz * w + iw * -z + ix * -y - iy * -x,
        };
    }

    private _distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }

    private _offset(p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
        return { x: p.x + q.x, y: p.y + q.y, z: p.z + q.z };
    }

    private _circlePoint(t: number, radius: number, plane: 'xy' | 'xz' | 'yz'): { x: number; y: number; z: number } {
        const c = Math.cos(t) * radius;
        const s = Math.sin(t) * radius;
        if (plane === 'xy') return { x: c, y: s, z: 0 };
        if (plane === 'xz') return { x: c, y: 0, z: s };
        return { x: c, y: 0, z: s };
    }

    private _allObjects(): GameObject[] {
        const out: GameObject[] = [];
        const walk = (go: GameObject): void => {
            out.push(go);
            const t = go.transform;
            for (let i = 0; i < t.childCount; i++) walk(t.getChild(i).gameObject);
        };
        for (const root of SceneManager.activeScene.getRootGameObjects()) walk(root);
        return out;
    }
}
