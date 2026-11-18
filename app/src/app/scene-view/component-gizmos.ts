import * as THREE from 'three';
import { GameObject, SceneManager, Transform, TypeRegistry } from 'WebEngineTS';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * Component gizmos — Unity's light, camera, collider and audio helpers
 * (B1 phase 6; D-11).
 *
 * The geometry is rebuilt each frame from the components' public fields and
 * pushed into pooled `LineSegments` — one per kind, plus a brighter twin per
 * kind fed by the selected objects' vertices (D-11: "all gizmos of a selected
 * object are drawn brighter"). Pools, records and scratch points are reused
 * across frames, so the steady state allocates nothing, and nothing
 * editor-owned ever enters the engine scene (D-1). Every gizmo is built in
 * **engine space** — the space the Inspector shows, the space Unity parity is
 * defined in — and converted once, per vertex (the z flip of `space.ts`,
 * inlined here to stay allocation-free).
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

/** The gizmo kind a stable component type name draws (the probe filters by these). */
export function kindOfType(typeName: string): GizmoKind | null {
    switch (typeName) {
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

const KEY = 'wets:gizmos:v1';
/** Initial pool capacity in vertices; grown by doubling when outgrown. */
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

interface Vec3 { x: number; y: number; z: number }

/**
 * What one component's gizmo drew, for the probe's read-back. All values are
 * in ENGINE space, measured from the vertices actually pushed (never guessed
 * from the component's fields).
 */
export interface Drawn {
    kind: GizmoKind;
    /** The component's registry type name ("PointLight", …) — the probe's kind filter. */
    typeName: string;
    /** The farthest gizmo vertex distance from the object's position, in engine units. */
    extent: number;
    /** Bbox centre of this component's gizmo vertices. */
    center: Vec3;
    /** Bbox half-size of this component's gizmo vertices. */
    half: Vec3;
    /** Every circle this gizmo drew, with unit normals. */
    circles: { center: Vec3; normal: Vec3; radius: number }[];
    /** True when the object is in the selection (drawn brighter, D-11). */
    selected: boolean;
}

/** The probe's deep copy of a Drawn record: `kind` carries the component TYPE name. */
export type DrawnInfo = Omit<Drawn, 'kind' | 'typeName'> & { kind: string };

/** The box/frustum edge list, shared (no per-frame array). */
const BOX_EDGES: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
];
/** The directional light's ray offsets along its local X and Y. */
const RAY_OFFSETS = [-0.35, -0.18, 0, 0.18, 0.35];
/** Shared fallbacks and empty read-back (never allocated per call). */
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const UNIT: Vec3 = { x: 1, y: 1, z: 1 };
const NO_DRAWN: readonly Drawn[] = [];

/**
 * The engine's public scene/component getters return copies and its pose
 * getters return clones; a per-frame rebuild reads the same backing stores
 * the engine's own loops read instead. Editor-internal use, the precedent
 * being scene-picker's `_internalThreeScene`.
 */
interface SceneInternals { _rootGameObjects: GameObject[] }
interface ObjectInternals { _components: unknown[] }

export class ComponentGizmos {

    private readonly _renderer: SceneViewRenderer;
    private readonly _lines = new Map<GizmoKind, THREE.LineSegments>();
    /** The brighter twin of each kind's lines, fed by the selection (D-11). */
    private readonly _selLines = new Map<GizmoKind, THREE.LineSegments>();
    private readonly _pools = new Map<GizmoKind, number[]>();
    private readonly _selPools = new Map<GizmoKind, number[]>();
    private readonly _drawn = new Map<THREE.Object3D, Drawn[]>();
    private _settings: GizmoSettings = defaultGizmoSettings();
    private _selected: ReadonlySet<THREE.Object3D> = new Set();

    // ── Recycled read-back records (steady state allocates nothing) ──
    private readonly _records: Drawn[] = [];
    private _recordCount = 0;
    private readonly _lists: Drawn[][] = [];
    private _listCount = 0;
    private readonly _circleRecs: { center: Vec3; normal: Vec3; radius: number }[] = [];
    private _circleCount = 0;
    private readonly _objects: GameObject[] = [];

    // ── Builder scratch, reset per component ──
    private _pool: number[] = [];
    private _rec: Drawn | null = null;
    private readonly _mat = new THREE.Matrix4();
    private readonly _mpos = new THREE.Vector3();
    private readonly _mrot = new THREE.Quaternion();
    private readonly _mscale = new THREE.Vector3();
    private readonly _pos: Vec3 = { x: 0, y: 0, z: 0 };
    private readonly _rot = { x: 0, y: 0, z: 0, w: 1 };
    private readonly _scale: Vec3 = { x: 1, y: 1, z: 1 };
    private readonly _min: Vec3 = { x: 0, y: 0, z: 0 };
    private readonly _max: Vec3 = { x: 0, y: 0, z: 0 };
    private _extent = 0;
    /** The object's local X/Y/Z axes in world (engine) space — an orthonormal basis. */
    private readonly _ax: Vec3 = { x: 1, y: 0, z: 0 };
    private readonly _ay: Vec3 = { x: 0, y: 1, z: 0 };
    private readonly _az: Vec3 = { x: 0, y: 0, z: 1 };
    private readonly _corners: Vec3[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0 }));
    private readonly _pa: Vec3 = { x: 0, y: 0, z: 0 };
    /** The directional light's two ray axes, reused (no per-frame array). */
    private readonly _sides: Vec3[] = [this._ax, this._ay];

    constructor(renderer: SceneViewRenderer) {
        this._renderer = renderer;
        for (const kind of GIZMO_KINDS) {
            const collider = kind === 'boxCollider' || kind === 'sphereCollider' || kind === 'capsuleCollider';
            const base = collider ? COLLIDER_COLOR : GIZMO_COLOR;
            // Brighter variant of the same hue for the selection (D-11).
            const bright = new THREE.Color(base).lerp(new THREE.Color(0xffffff), 0.5).getHex();
            this._lines.set(kind, this._makeLines(renderer, base));
            this._selLines.set(kind, this._makeLines(renderer, bright));
            this._pools.set(kind, []);
            this._selPools.set(kind, []);
        }
    }

    private _makeLines(renderer: SceneViewRenderer, color: number): THREE.LineSegments {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3));
        const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
        lines.frustumCulled = false;
        lines.visible = false;
        // Depth-tested, like Unity's gizmos: geometry hides them.
        renderer.addOverlayLayer('grid', lines);
        return lines;
    }

    public setSettings(settings: GizmoSettings): void { this._settings = settings; }

    /** Which objects are selected: their gizmos go to the brighter pools. */
    public setSelected(objects: ReadonlySet<THREE.Object3D>): void { this._selected = objects; }

    /** What one object's components drew, for the probe (whole scene, not only the selection). */
    public drawnFor(object: THREE.Object3D): readonly Drawn[] { return this._drawn.get(object) ?? NO_DRAWN; }

    public dispose(): void {
        for (const lines of [...this._lines.values(), ...this._selLines.values()]) {
            this._renderer.removeOverlayLayer(lines);
            lines.geometry.dispose();
            (lines.material as THREE.Material).dispose();
        }
        this._lines.clear();
        this._selLines.clear();
        this._drawn.clear();
    }

    /**
     * Rebuilds every enabled kind for the whole scene. The controller's dirty
     * flush has already run, so the world matrices are current.
     */
    public update(): void {
        this._drawn.clear();
        this._recordCount = 0;
        this._listCount = 0;
        this._circleCount = 0;
        for (const kind of GIZMO_KINDS) {
            this._pools.get(kind)!.length = 0;
            this._selPools.get(kind)!.length = 0;
        }

        if (this._settings.enabled) {
            this._objects.length = 0;
            const scene = SceneManager.activeScene as unknown as SceneInternals;
            const roots = scene._rootGameObjects;
            for (let i = 0; i < roots.length; i++) this._collect(roots[i]);

            for (let oi = 0; oi < this._objects.length; oi++) {
                const go = this._objects[oi];
                // Children of an inactive parent draw nothing (Unity parity).
                if (!go.activeInHierarchy) continue;
                const object = go.transform._internalObject3D;
                const selected = this._selected.has(object);
                const components = (go as unknown as ObjectInternals)._components;
                for (let ci = 0; ci < components.length; ci++) {
                    const component = components[ci];
                    const typeName = TypeRegistry.getTypeName(component as object) ?? '';
                    const kind = kindOfType(typeName);
                    if (!kind || !this._enabled(kind) || !this._active(component)) continue;
                    const rec = this._record();
                    rec.kind = kind;
                    rec.typeName = typeName;
                    rec.selected = selected;
                    rec.circles.length = 0;
                    const pool = (selected ? this._selPools : this._pools).get(kind)!;
                    if (!this._build(kind, component, go.transform, pool, rec)) {
                        this._recordCount--;   // nothing drawn: give the record back
                        continue;
                    }
                    rec.extent = this._extent;
                    rec.center.x = (this._min.x + this._max.x) / 2;
                    rec.center.y = (this._min.y + this._max.y) / 2;
                    rec.center.z = (this._min.z + this._max.z) / 2;
                    rec.half.x = (this._max.x - this._min.x) / 2;
                    rec.half.y = (this._max.y - this._min.y) / 2;
                    rec.half.z = (this._max.z - this._min.z) / 2;
                    let list = this._drawn.get(object);
                    if (!list) {
                        list = this._lists[this._listCount] ?? (this._lists[this._listCount] = []);
                        this._listCount++;
                        list.length = 0;
                        this._drawn.set(object, list);
                    }
                    list.push(rec);
                }
            }
        }

        this._flush(this._lines, this._pools);
        this._flush(this._selLines, this._selPools);
    }

    private _collect(go: GameObject): void {
        this._objects.push(go);
        const children = go.transform._internalChildren;
        for (let i = 0; i < children.length; i++) this._collect(children[i].gameObject);
    }

    /**
     * Copies a kind's pool into its line buffer. A pool that outgrew the buffer
     * grows it by doubling (no silent truncation); the old attribute is simply
     * replaced — nothing still in use is disposed.
     */
    private _flush(lines: Map<GizmoKind, THREE.LineSegments>, pools: Map<GizmoKind, number[]>): void {
        for (const kind of GIZMO_KINDS) {
            const object = lines.get(kind)!;
            const pool = pools.get(kind)!;
            let attribute = object.geometry.getAttribute('position') as THREE.BufferAttribute;
            if (pool.length > attribute.array.length) {
                // Next power of two that fits — no silent truncation.
                let capacity = 1;
                while (capacity < pool.length) capacity *= 2;
                attribute = new THREE.BufferAttribute(new Float32Array(capacity), 3);
                object.geometry.setAttribute('position', attribute);
            }
            (attribute.array as Float32Array).set(pool);
            attribute.needsUpdate = true;
            object.geometry.setDrawRange(0, pool.length / 3);
            object.visible = pool.length > 0;
        }
    }

    private _record(): Drawn {
        let rec = this._records[this._recordCount];
        if (!rec) {
            rec = {
                kind: 'boxCollider', typeName: '', extent: 0,
                center: { x: 0, y: 0, z: 0 }, half: { x: 0, y: 0, z: 0 },
                circles: [], selected: false,
            };
            this._records[this._recordCount] = rec;
        }
        this._recordCount++;
        return rec;
    }

    // ── Which component makes which kind ──────────────────────────────

    private _enabled(kind: GizmoKind): boolean {
        const s = this._settings;
        if (!s.enabled) return false;
        if (kind === 'cameraFrustum') return s.camera;
        if (kind === 'audioSource') return s.audio;
        if (kind === 'boxCollider' || kind === 'sphereCollider' || kind === 'capsuleCollider') return s.colliders;
        return s.lights;
    }

    /** Unity draws nothing for a disabled component or an inactive object (parent included). */
    private _active(component: unknown): boolean {
        const c = component as { isActiveAndEnabled?: boolean; gameObject?: { activeInHierarchy?: boolean } };
        if (typeof c?.isActiveAndEnabled === 'boolean') return c.isActiveAndEnabled;
        return c?.gameObject?.activeInHierarchy !== false;
    }

    // ── Geometry, built in engine space and converted once ────────────

    /**
     * Writes one component's gizmo into the pool. The component itself is
     * passed in — two colliders of one type on one object draw two wireframes.
     * Returns false when there is nothing to draw (a zero range, say).
     */
    private _build(kind: GizmoKind, component: unknown, transform: Transform, pool: number[], rec: Drawn): boolean {
        this._pool = pool;
        this._rec = rec;
        // The world pose through the engine's own matrix accessor: the public
        // position/rotation/lossyScale getters each return a clone, which would
        // allocate three objects per component per frame.
        transform._engineWorldMatrix(this._mat).decompose(this._mpos, this._mrot, this._mscale);
        this._pos.x = this._mpos.x; this._pos.y = this._mpos.y; this._pos.z = this._mpos.z;
        this._rot.x = this._mrot.x; this._rot.y = this._mrot.y; this._rot.z = this._mrot.z; this._rot.w = this._mrot.w;
        this._scale.x = this._mscale.x; this._scale.y = this._mscale.y; this._scale.z = this._mscale.z;
        this._min.x = this._min.y = this._min.z = Infinity;
        this._max.x = this._max.y = this._max.z = -Infinity;
        this._extent = 0;

        switch (kind) {
            case 'cameraFrustum': return this._frustum(component);
            case 'directionalLight': {
                // The basis is the object's own rotated axes — never a world-fixed
                // pair, which collapses for a light pointing straight down.
                this._axes();
                const f = this._az;
                const length = 1.5;
                for (const offset of RAY_OFFSETS) {
                    for (const side of this._sides) {
                        const sx = this._pos.x + side.x * offset;
                        const sy = this._pos.y + side.y * offset;
                        const sz = this._pos.z + side.z * offset;
                        this._line(sx, sy, sz, sx + f.x * length, sy + f.y * length, sz + f.z * length);
                    }
                }
                // A small disc at the far end, perpendicular to forward.
                this._circle(
                    this._pos.x + f.x * length, this._pos.y + f.y * length, this._pos.z + f.z * length,
                    this._ax.x, this._ax.y, this._ax.z, this._ay.x, this._ay.y, this._ay.z,
                    f.x, f.y, f.z, 0.3, 16,
                );
                return true;
            }
            case 'pointLight': {
                const range = Number((component as { range?: number }).range ?? 0);
                if (range <= 0) return false;
                // Three great circles in three distinct planes, centred on the object.
                const c = this._pos;
                this._circle(c.x, c.y, c.z, 1, 0, 0, 0, 1, 0, 0, 0, 1, range, 24);
                this._circle(c.x, c.y, c.z, 1, 0, 0, 0, 0, 1, 0, 1, 0, range, 24);
                this._circle(c.x, c.y, c.z, 0, 1, 0, 0, 0, 1, 1, 0, 0, range, 24);
                return true;
            }
            case 'spotLight': {
                const range = Number((component as { range?: number }).range ?? 0);
                if (range <= 0) return false;
                const angle = Number((component as { spotAngle?: number }).spotAngle ?? 0) * Math.PI / 360;
                this._axes();
                const f = this._az, right = this._ax, up = this._ay;
                const radius = Math.tan(Math.min(angle, Math.PI / 2 - 0.01)) * range;
                const cx = this._pos.x + f.x * range;
                const cy = this._pos.y + f.y * range;
                const cz = this._pos.z + f.z * range;
                for (let i = 0; i < 4; i++) {
                    const sx = i === 0 ? 1 : i === 2 ? -1 : 0;
                    const sy = i === 1 ? 1 : i === 3 ? -1 : 0;
                    this._line(this._pos.x, this._pos.y, this._pos.z,
                        cx + right.x * sx * radius + up.x * sy * radius,
                        cy + right.y * sx * radius + up.y * sy * radius,
                        cz + right.z * sx * radius + up.z * sy * radius);
                }
                // The end circle lies in the plane perpendicular to forward.
                this._circle(cx, cy, cz, right.x, right.y, right.z, up.x, up.y, up.z, f.x, f.y, f.z, radius, 16);
                return true;
            }
            case 'boxCollider': {
                const center = (component as { center?: Vec3 }).center ?? ZERO;
                const size = (component as { size?: Vec3 }).size ?? UNIT;
                const scale = this._scale;
                // center is a LOCAL point: scaled, then rotated, then moved.
                const cx = center.x * scale.x, cy = center.y * scale.y, cz = center.z * scale.z;
                const hx = Math.abs(size.x * scale.x) / 2;
                const hy = Math.abs(size.y * scale.y) / 2;
                const hz = Math.abs(size.z * scale.z) / 2;
                for (let i = 0; i < 8; i++) {
                    this._local(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz), this._corners[i]);
                }
                for (const [a, b] of BOX_EDGES) {
                    const pa = this._corners[a], pb = this._corners[b];
                    this._line(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
                }
                return true;
            }
            case 'sphereCollider': {
                const center = (component as { center?: Vec3 }).center ?? ZERO;
                const scale = this._scale;
                // Unity scales a sphere's radius by the largest absolute axis scale.
                const radius = Number((component as { radius?: number }).radius ?? 0)
                    * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
                if (radius <= 0) return false;
                this._local(center.x * scale.x, center.y * scale.y, center.z * scale.z, this._pa);
                this._axes();
                const c = this._pa;
                this._circle(c.x, c.y, c.z, this._ax.x, this._ax.y, this._ax.z, this._ay.x, this._ay.y, this._ay.z, this._az.x, this._az.y, this._az.z, radius, 24);
                this._circle(c.x, c.y, c.z, this._ax.x, this._ax.y, this._ax.z, this._az.x, this._az.y, this._az.z, this._ay.x, this._ay.y, this._ay.z, radius, 24);
                this._circle(c.x, c.y, c.z, this._ay.x, this._ay.y, this._ay.z, this._az.x, this._az.y, this._az.z, this._ax.x, this._ax.y, this._ax.z, radius, 24);
                return true;
            }
            case 'capsuleCollider': {
                const center = (component as { center?: Vec3 }).center ?? ZERO;
                const radius = Number((component as { radius?: number }).radius ?? 0);
                const height = Number((component as { height?: number }).height ?? 0);
                if (radius <= 0 || height <= 0) return false;
                const scale = this._scale;
                // Unity's scaling for a Y-axis capsule (the engine's only direction):
                // radius by max(|sx|, |sz|), height by |sy|. The engine clamps
                // height >= 2*radius on set; scaling can break that, so clamp again.
                const sr = radius * Math.max(Math.abs(scale.x), Math.abs(scale.z));
                const sh = Math.max(height * Math.abs(scale.y), sr * 2);
                const h = sh / 2 - sr;
                const cx = center.x * scale.x, cy = center.y * scale.y, cz = center.z * scale.z;
                this._axes();
                for (let d = 0; d < 2; d++) {
                    const dir = d === 0 ? 1 : -1;
                    // Cap centres at ±(height/2 − radius) along local Y, rotated.
                    this._local(cx, cy + dir * h, cz, this._pa);
                    const c = this._pa;
                    this._circle(c.x, c.y, c.z, this._ax.x, this._ax.y, this._ax.z, this._ay.x, this._ay.y, this._ay.z, this._az.x, this._az.y, this._az.z, sr, 12);
                    this._circle(c.x, c.y, c.z, this._ax.x, this._ax.y, this._ax.z, this._az.x, this._az.y, this._az.z, this._ay.x, this._ay.y, this._ay.z, sr, 12);
                    this._line(c.x - this._ax.x * sr, c.y - this._ax.y * sr, c.z - this._ax.z * sr,
                        c.x + this._ax.x * sr, c.y + this._ax.y * sr, c.z + this._ax.z * sr);
                    this._line(c.x - this._az.x * sr, c.y - this._az.y * sr, c.z - this._az.z * sr,
                        c.x + this._az.x * sr, c.y + this._az.y * sr, c.z + this._az.z * sr);
                }
                return true;
            }
            case 'audioSource': {
                const min = Number((component as { minDistance?: number }).minDistance ?? 0);
                const max = Number((component as { maxDistance?: number }).maxDistance ?? 0);
                if (max <= 0) return false;
                // ponytail: one plane per distance (the pre-review shape, centred
                // correctly now); upgrade to three great circles if audio needs
                // the point-light treatment.
                const c = this._pos;
                if (min > 0) this._circle(c.x, c.y, c.z, 1, 0, 0, 0, 1, 0, 0, 0, 1, min, 24);
                this._circle(c.x, c.y, c.z, 1, 0, 0, 0, 1, 0, 0, 0, 1, max, 24);
                return true;
            }
        }
        return false;
    }

    /** The camera frustum (or its orthographic box) in engine space. */
    private _frustum(component: unknown): boolean {
        const cam = component as { fieldOfView: number; nearClipPlane: number; farClipPlane: number; orthographic: boolean; orthographicSize: number };
        const near = Math.max(0.01, cam.nearClipPlane);
        // Unity clamps the drawing distance; a far plane of a million would fill
        // the view (D-11's display clamp).
        const far = Math.min(Math.max(cam.farClipPlane, near + 0.01), 100);
        const aspect = this._aspect();
        let nearH: number, farH: number, nearW: number, farW: number;
        if (cam.orthographic) {
            const h = Math.max(0.01, cam.orthographicSize);
            nearH = farH = h;
            nearW = farW = h * aspect;
        } else {
            const half = Math.max(1, cam.fieldOfView) * Math.PI / 360;
            nearH = Math.tan(half) * near; farH = Math.tan(half) * far;
            nearW = nearH * aspect; farW = farH * aspect;
        }
        const c = this._corners;
        this._local(-nearW, -nearH, near, c[0]); this._local(nearW, -nearH, near, c[1]);
        this._local(nearW, nearH, near, c[2]); this._local(-nearW, nearH, near, c[3]);
        this._local(-farW, -farH, far, c[4]); this._local(farW, -farH, far, c[5]);
        this._local(farW, farH, far, c[6]); this._local(-farW, farH, far, c[7]);
        for (const [a, b] of BOX_EDGES) {
            const pa = c[a], pb = c[b];
            this._line(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
        }
        return true;
    }

    // ── Small engine-space helpers (scratch-based, allocation-free) ───

    private _aspect(): number {
        const rect = this._renderer.canvasRect;
        return rect && rect.height > 0 ? rect.width / rect.height : 1;
    }

    /** The object's local X/Y/Z axes through its rotation: an orthonormal basis. */
    private _axes(): void {
        this._rotateInto(1, 0, 0, this._ax);
        this._rotateInto(0, 1, 0, this._ay);
        this._rotateInto(0, 0, 1, this._az);
    }

    /** A local engine point, turned by the object's rotation and moved to it. */
    private _local(lx: number, ly: number, lz: number, out: Vec3): void {
        this._rotateInto(lx, ly, lz, out);
        out.x += this._pos.x; out.y += this._pos.y; out.z += this._pos.z;
    }

    private _rotateInto(x: number, y: number, z: number, out: Vec3): void {
        const q = this._rot;
        const ix = q.w * x + q.y * z - q.z * y;
        const iy = q.w * y + q.z * x - q.x * z;
        const iz = q.w * z + q.x * y - q.y * x;
        const iw = -q.x * x - q.y * y - q.z * z;
        out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
        out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
        out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
    }

    /** One segment, engine space in; the z flip of space.ts happens here. */
    private _line(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
        this._pool.push(ax, ay, -az, bx, by, -bz);
        this._grow(ax, ay, az);
        this._grow(bx, by, bz);
        const p = this._pos;
        const da = Math.hypot(ax - p.x, ay - p.y, az - p.z);
        const db = Math.hypot(bx - p.x, by - p.y, bz - p.z);
        if (da > this._extent) this._extent = da;
        if (db > this._extent) this._extent = db;
    }

    private _grow(x: number, y: number, z: number): void {
        if (x < this._min.x) this._min.x = x;
        if (y < this._min.y) this._min.y = y;
        if (z < this._min.z) this._min.z = z;
        if (x > this._max.x) this._max.x = x;
        if (y > this._max.y) this._max.y = y;
        if (z > this._max.z) this._max.z = z;
    }

    /**
     * A circle in the plane spanned by the orthonormal u/v, centred at c,
     * recorded for the probe with its unit normal n.
     */
    private _circle(
        cx: number, cy: number, cz: number,
        ux: number, uy: number, uz: number,
        vx: number, vy: number, vz: number,
        nx: number, ny: number, nz: number,
        radius: number, segments: number,
    ): void {
        const fx = cx + ux * radius, fy = cy + uy * radius, fz = cz + uz * radius;
        let px = fx, py = fy, pz = fz;
        for (let i = 1; i < segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const c = Math.cos(t) * radius, s = Math.sin(t) * radius;
            const qx = cx + ux * c + vx * s;
            const qy = cy + uy * c + vy * s;
            const qz = cz + uz * c + vz * s;
            this._line(px, py, pz, qx, qy, qz);
            px = qx; py = qy; pz = qz;
        }
        this._line(px, py, pz, fx, fy, fz);
        this._addCircle(cx, cy, cz, nx, ny, nz, radius);
    }

    private _addCircle(cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, radius: number): void {
        let rec = this._circleRecs[this._circleCount];
        if (!rec) {
            rec = { center: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, radius: 0 };
            this._circleRecs[this._circleCount] = rec;
        }
        this._circleCount++;
        rec.center.x = cx; rec.center.y = cy; rec.center.z = cz;
        rec.normal.x = nx; rec.normal.y = ny; rec.normal.z = nz;
        rec.radius = radius;
        this._rec!.circles.push(rec);
    }
}
