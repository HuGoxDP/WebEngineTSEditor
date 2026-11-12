import * as THREE from 'three';
import { engineDirToThree } from './space';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * The orientation cube — Unity's view gizmo (B1 phase 3; D-5).
 *
 * Editor-owned three objects in the top-right corner of the Scene view, drawn
 * in their own viewport from the camera's own direction: the axes are placed in
 * **engine space** (the cube's +X cone sits where engine +X points), and the
 * corner camera copies the editor camera's orientation, stepped back along its
 * own +Z. So the axes stand still in world space while the camera orbits them,
 * exactly as Unity's cube does, and a click on the +X cone looks along −X in
 * engine space.
 *
 * The cone-and-arm shape follows three's `ViewHelper`, adapted per D-5: the
 * click targets and the reported positions are the *same* projection through
 * the *same* orthographic camera (DW-3.1's proof that a click lands on the cone
 * it hit), the camera animation is delegated to the controller (three's helper
 * moves the camera itself, which would bypass the controller's derived pose),
 * the engine mirror is applied once per axis through `space.ts` rather than as
 * a reflected group root — a negative-determinant matrix would flip the
 * winding and cost the raycast its hits — and every one of the six axes gets a
 * cone, because DW-3.1 snaps to −Z and a two-pixel arm is not a target.
 */

/** A clickable direction: the engine axis and its label. */
export interface AxisTarget {
    axis: { x: number; y: number; z: number };
    label: string;
}

const AXES: AxisTarget[] = [
    { axis: { x: 1, y: 0, z: 0 }, label: 'X' },
    { axis: { x: -1, y: 0, z: 0 }, label: '−X' },
    { axis: { x: 0, y: 1, z: 0 }, label: 'Y' },
    { axis: { x: 0, y: -1, z: 0 }, label: '−Y' },
    { axis: { x: 0, y: 0, z: 1 }, label: 'Z' },
    { axis: { x: 0, y: 0, z: -1 }, label: '−Z' },
];

/** The gizmo's read-back, for the probe and the corner label. */
export interface OrientationState {
    /**
     * The cone centres' positions in **client** pixels, keyed by label: clicking
     * one of these clicks the cone (DW-3.1).
     */
    targets: Record<string, { x: number; y: number }>;
    /** Whether the editor camera is currently orthographic (DW-3.2). */
    orthographic: boolean;
}

const SIZE = 128;
const AXIS_LENGTH = 0.9;
const CONE_LENGTH = 0.36;
const VIEW_DISTANCE = 10;
const VIEW_HALF = 1.7;
const ARM_RADIUS = 0.02;
const CONE_RADIUS = 0.13;
/** The hub sphere's radius — the only thing that can hide a cone. */
const HUB_RADIUS = 0.22;
/** The hub's radius in the corner viewport's NDC (its screen footprint). */
const HUB_NDC = HUB_RADIUS / VIEW_HALF;

export class OrientationGizmo {

    private _scene = new THREE.Scene();
    private _group = new THREE.Group();
    private _orthoCamera: THREE.OrthographicCamera;
    private _raycaster = new THREE.Raycaster();
    /** Everything a click can land on: the arms, the cones and the centre. */
    private _interactive: THREE.Object3D[] = [];
    /** Which axis each interactive object belongs to (the centre maps to none). */
    private _axisOf = new Map<THREE.Object3D, AxisTarget>();
    private _materials: THREE.Material[] = [];
    private _geometries: THREE.BufferGeometry[] = [];
    /** Scratch vectors for the per-frame target computation (no allocation). */
    private _tmpA = new THREE.Vector3();
    private _tmpB = new THREE.Vector3();
    private _tmpC = new THREE.Vector3();
    private _renderer: SceneViewRenderer;
    private _mounted = false;

    /** Called when a cone or arm is clicked; the controller animates the camera. */
    public onLookAlong: ((axis: { x: number; y: number; z: number }) => void) | null = null;
    /** Called when the centre is clicked; the controller toggles the projection. */
    public onToggleProjection: (() => void) | null = null;

    constructor(renderer: SceneViewRenderer) {
        this._renderer = renderer;
        // A square corner viewport, so left/right/top/bottom span the same angle
        // and the cube keeps its aspect at any canvas shape.
        this._orthoCamera = new THREE.OrthographicCamera(-VIEW_HALF, VIEW_HALF, VIEW_HALF, -VIEW_HALF, 0.1, 100);
        this._build();
    }

    /** Adds the gizmo to the renderer's corner viewport (D-2 step 6). */
    public mount(): void {
        if (this._mounted) return;
        this._mounted = true;
        this._renderer.setCornerLayer({ scene: this._scene, camera: this._orthoCamera, size: SIZE });
    }

    public dispose(): void {
        this._mounted = false;
        this._renderer.setCornerLayer(null);
        for (const g of this._geometries) g.dispose();
        for (const m of this._materials) m.dispose();
        this._geometries = [];
        this._materials = [];
        this._interactive = [];
        this._axisOf.clear();
        this._scene.remove(this._group);
    }

    /**
     * Aims the corner camera at the cube from the editor camera's direction and
     * returns the state the probe and the corner label read. Called once per
     * frame, before the renderer draws the corner viewport.
     */
    /**
     * The corner square in **client** pixels — the viewport the renderer draws
     * into (a GL viewport's y is measured from the bottom, this from the top),
     * and the square `handleClick` accepts. One source for both is what keeps a
     * reported position a position that clicks the cone it names.
     */
    private _corner(): { x0: number; y0: number; s: number } | null {
        const canvas = this._renderer.canvasRect;
        const size = this._renderer.viewportSize;
        if (!canvas || size.width === 0 || size.height === 0) return null;
        const s = Math.min(SIZE, size.width, size.height);
        return { x0: canvas.left + size.width - s, y0: canvas.top, s };
    }

    public draw(): OrientationState {
        const cam = this._renderer.camera;
        const empty = { targets: {}, orthographic: false };
        if (!cam) return empty;

        // The corner camera is the editor camera, stepped back: the same
        // orientation, so the cube is seen from the same direction (orthographically).
        const q = (cam as unknown as { quaternion: THREE.Quaternion }).quaternion;
        this._orthoCamera.quaternion.copy(q);
        this._orthoCamera.position.set(0, 0, VIEW_DISTANCE).applyQuaternion(q);
        this._orthoCamera.updateMatrixWorld(true);
        this._group.updateMatrixWorld(true);

        const targets: Record<string, { x: number; y: number }> = {};
        const corner = this._corner();
        if (corner) {
            const { x0, y0, s } = corner;
            const p = new THREE.Vector3();
            for (const [object, target] of this._axisOf) {
                // Only the cones are reported, and only the ones a click can
                // reach: a cone on the far side of the hub projects onto the hub
                // (or onto the cone nearest the camera), so reporting it would
                // name a pixel that clicks something else. The hub owns the
                // middle of the cube, so a cone under it is not a target either.
                if (!userDataOf(object).cone) continue;
                object.getWorldPosition(p);
                if (!this._reachable(p)) continue;
                p.project(this._orthoCamera);
                if (Math.hypot(p.x, p.y) <= HUB_NDC) continue;
                targets[target.label] = {
                    x: x0 + ((p.x + 1) / 2) * s,
                    y: y0 + ((1 - p.y) / 2) * s,
                };
            }
        }

        return {
            targets,
            orthographic: (cam as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera === true,
        };
    }

    /** Handles a click in client pixels; returns true when it hit the cube. */
    public handleClick(clientX: number, clientY: number): boolean {
        const corner = this._corner();
        if (!corner) return false;
        const { x0, y0, s } = corner;
        if (clientX < x0 || clientY < y0 || clientX > x0 + s || clientY > y0 + s) return false;

        // The same projection `draw` reports, so a click at a reported position
        // is a click on that cone — the two can never disagree.
        const ndc = new THREE.Vector2(
            ((clientX - x0) / s) * 2 - 1,
            -((clientY - y0) / s) * 2 + 1,
        );
        // The hub owns the middle of the cube, whichever axis happens to face the
        // camera: a click there toggles the projection (Unity's centre does the
        // same from every view, and the axis-aligned views put a cone right on it).
        if (ndc.length() <= HUB_NDC) {
            this.onToggleProjection?.();
            return true;
        }
        this._raycaster.setFromCamera(ndc, this._orthoCamera);
        const hits = this._raycaster.intersectObjects(this._interactive, false);
        if (hits.length === 0) return false;

        const axis = this._axisOf.get(hits[0].object);
        if (axis) this.onLookAlong?.(axis.axis);
        else this.onToggleProjection?.();
        return true;
    }

    /**
     * Whether a click aimed at this cone's screen position reaches it. The hub
     * at the origin is the only thing that can stand in the way, so the ray to
     * the cone must not pass through the hub *first*: a cone straight behind
     * the hub is hidden, one in front of it (the axis pointing at the camera) is
     * not, and one edge-on beside the hub never was.
     */
    private _reachable(cone: THREE.Vector3): boolean {
        const cam = this._orthoCamera;
        const u = this._tmpA.copy(cone).sub(cam.position);
        const distance = u.length();
        if (distance === 0) return false;
        u.divideScalar(distance);
        // The origin, seen from the camera: the camera aims at it by construction.
        const toOrigin = this._tmpB.set(0, 0, 0).sub(cam.position);
        const t = toOrigin.dot(u);
        if (t <= 0) return false;
        const perp = this._tmpC.copy(toOrigin).addScaledVector(u, -t).length();
        // The hub lies nearer than the cone only when t is smaller than the
        // cone's distance; then it hides the cone exactly when the ray passes
        // through it.
        return !(perp < HUB_RADIUS && t < distance);
    }

    private _build(): void {
        this._group.name = '__orientationGizmo';
        this._scene.add(this._group);

        const armMaterial = this._material(0x8899aa);
        const coneMaterials: Record<string, THREE.MeshBasicMaterial> = {
            X: this._material(0xc44e52) as THREE.MeshBasicMaterial,
            Y: this._material(0x9cab7d) as THREE.MeshBasicMaterial,
            Z: this._material(0x4e7ac7) as THREE.MeshBasicMaterial,
        };
        const negMaterial = this._material(0x555a63);

        // One cylinder geometry, rotated to +Y, shared by every arm; the cones
        // point +Y too, so every axis needs one quaternion.
        const armGeo = new THREE.CylinderGeometry(ARM_RADIUS, ARM_RADIUS, AXIS_LENGTH, 8);
        const coneGeo = new THREE.ConeGeometry(CONE_RADIUS, CONE_LENGTH, 12);
        // The negative arms get a smaller cone of their own: DW-3.1 snaps to
        // −Z too, and a two-pixel-wide arm is not a click target (Unity's cube
        // answers on every axis; three's ViewHelper only draws the positive
        // ones, which is the one shape detail this adapts).
        const negConeGeo = new THREE.ConeGeometry(CONE_RADIUS * 0.75, CONE_LENGTH * 0.8, 12);
        this._geometries.push(armGeo, coneGeo, negConeGeo);

        for (const entry of AXES) {
            // Engine axis → the three-space direction that renders it (space.ts).
            const dir = engineDirToThree(entry.axis);
            const isPositive = entry.axis.x + entry.axis.y + entry.axis.z > 0;
            const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

            // The arm reaches from the centre out to the cone's base.
            const arm = new THREE.Mesh(armGeo, armMaterial);
            arm.quaternion.copy(rotation);
            arm.position.copy(dir).multiplyScalar(AXIS_LENGTH / 2);
            this._group.add(arm);
            this._axisOf.set(arm, entry);
            this._interactive.push(arm);

            const cone = new THREE.Mesh(
                isPositive ? coneGeo : negConeGeo,
                isPositive ? coneMaterials[entry.label] ?? negMaterial : negMaterial,
            );
            cone.quaternion.copy(rotation);
            cone.position.copy(dir).multiplyScalar(AXIS_LENGTH);
            userDataOf(cone).cone = true;
            this._group.add(cone);
            this._axisOf.set(cone, entry);
            this._interactive.push(cone);
        }

        // The centre: the projection toggle's click target (DW-3.2).
        const centreGeo = new THREE.SphereGeometry(0.22, 16, 12);
        this._geometries.push(centreGeo);
        const centre = new THREE.Mesh(centreGeo, this._material(0xd8dde6));
        this._group.add(centre);
        this._interactive.push(centre);
    }

    private _material(color: number): THREE.Material {
        const m = new THREE.MeshBasicMaterial({ color });
        this._materials.push(m);
        return m;
    }
}

/** The per-object flags the gizmo reads back from a mesh's userData. */
function userDataOf(object: THREE.Object3D): { cone?: boolean } {
    return object.userData as { cone?: boolean };
}
