/**
 * Engine space ↔ three space conversions for the Scene view (B1 phase 1).
 *
 * The engine's scene is a left-handed coordinate system: its content root is a
 * `THREE.Group` scaled `(1, 1, -1)` (`WebEngineTS/src/engine/core/Scene.ts:126–129`),
 * so an engine-space point `(x, y, z)` sits at `(x, y, −z)` in the three scene
 * the editor renders. Every editor feature (navigation, tools, gizmos, outline,
 * selection) works in **engine space** — the space the Inspector shows, the space
 * Unity parity is defined in — and converts only here.
 *
 * Directions and quaternions follow their point: a direction is negated in z
 * (a scale of −1 flips orientation), and a quaternion is conjugated (its y and
 * z parts negated) for the same reason. Positions of *editor-owned* three
 * objects (the grid, handles, the orientation cube) are placed through here too,
 * so nothing in the editor has to remember the flip.
 */

import * as THREE from 'three';

/** Engine-space point → three-space point (the scene's z is flipped). */
export function enginePointToThree(p: { x: number; y: number; z: number }): THREE.Vector3 {
    return new THREE.Vector3(p.x, p.y, -p.z);
}

/** Three-space point → engine-space point. */
export function threePointToEngine(v: THREE.Vector3): { x: number; y: number; z: number } {
    return { x: v.x, y: v.y, z: -v.z };
}

/** Engine-space direction → three-space direction. */
export function engineDirToThree(d: { x: number; y: number; z: number }): THREE.Vector3 {
    return new THREE.Vector3(d.x, d.y, -d.z);
}

/** Three-space direction → engine-space direction. */
export function threeDirToEngine(v: THREE.Vector3): { x: number; y: number; z: number } {
    return { x: v.x, y: v.y, z: -v.z };
}

/**
 * Engine-space quaternion (x, y, z, w) → three quaternion.
 *
 * A −1 scale on z is a reflection, and a reflection conjugates rotations:
 * `q_three = (qx, −qy, −qz, qw)` maps the same physical orientation.
 */
export function engineQuatToThree(q: { x: number; y: number; z: number; w: number }): THREE.Quaternion {
    return new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
}

/** Three quaternion → engine-space quaternion (the same conjugation, it is its own inverse). */
export function threeQuatToEngine(q: THREE.Quaternion): { x: number; y: number; z: number; w: number } {
    return { x: q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * The camera's pose in engine space, as the debug probe and the tests read it:
 * position, the forward direction (`−Z` of the camera's three basis, flipped) and
 * the up. `orthographic` is three's own flag — the editor camera is a
 * perspective camera until B1.3's orientation cube switches it.
 */
export function threeCameraToEnginePose(camera: THREE.Camera): {
    position: { x: number; y: number; z: number };
    forward: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
    orthographic: boolean;
} {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    return {
        position: threePointToEngine(camera.getWorldPosition(new THREE.Vector3())),
        forward: threeDirToEngine(forward),
        up: threeDirToEngine(up),
        orthographic: (camera as THREE.OrthographicCamera).isOrthographicCamera === true,
    };
}
