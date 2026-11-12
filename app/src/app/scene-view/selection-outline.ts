import * as THREE from 'three';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * The selection outline — Unity's orange silhouette (B1 phase 5; D-9).
 *
 * A screen-space mask post-pass, not an `OutlinePass` composer: the Scene view
 * must keep matching the platform's own render, so the scene is never moved into
 * render targets. Each frame with a selection:
 *
 * 1. every selected mesh (and its descendants) is drawn flat white into a
 *    render target the size of the canvas, through **proxy meshes** that share
 *    the engine mesh's geometry and copy its `matrixWorld` (read-only, so
 *    nothing editor-owned is ever written into the engine scene);
 * 2. a full-screen quad draws Unity orange `#FF6600` wherever the mask is empty
 *    and any pixel within 2 of it is filled — the silhouette's rim, one or two
 *    pixels wide, alpha-blended over the frame.
 *
 * Objects without a mesh (lights, cameras, empties) keep a thin dim-orange
 * `BoxHelper`: Unity highlights their gizmo instead, which is D-11's.
 */

/** Unity's Scene-view selection orange. */
const OUTLINE_COLOR = 0xff6600;
/** The rim's thickness, in pixels. */
const RIM = 2;

/** One proxy, kept per engine object it stands in for. */
interface Proxy {
    /** The engine object whose world matrix is copied. */
    source: THREE.Object3D;
    mesh: THREE.Mesh;
}

export class SelectionOutline {

    private readonly _renderer: SceneViewRenderer;
    private readonly _maskScene = new THREE.Scene();
    private readonly _quadScene = new THREE.Scene();
    private readonly _quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private _target: THREE.WebGLRenderTarget | null = null;
    private _material: THREE.ShaderMaterial | null = null;
    private _quad: THREE.Mesh | null = null;
    /** One proxy per engine object, reused across frames and selections. */
    private readonly _proxies = new Map<THREE.Object3D, Proxy>();
    /** Objects without meshes: the dim-orange box Unity keeps for gizmos. */
    private _boxes: THREE.BoxHelper[] = [];
    /** The selection the proxies currently stand for. */
    private _outlined: readonly THREE.Object3D[] = [];

    constructor(renderer: SceneViewRenderer) {
        this._renderer = renderer;
        // D-2's last step: the outline composites over the finished frame.
        renderer.setPostPass((gl, camera) => this._draw(gl, camera));
    }

    /**
     * Sets what is outlined. Meshed objects go through the mask; the rest get a
     * box. Called on every selection change.
     */
    public setTargets(objects: readonly THREE.Object3D[]): void {
        this._outlined = objects;
        this._rebuild();
    }

    /** Removes everything. */
    public clear(): void { this.setTargets([]); }

    public dispose(): void {
        this._renderer.setPostPass(null);
        for (const proxy of this._proxies.values()) this._maskScene.remove(proxy.mesh);
        this._proxies.clear();
        this._disposeBoxes();
        this._target?.dispose();
        this._target = null;
        this._material?.dispose();
        this._material = null;
        this._quad?.geometry.dispose();
        this._quad = null;
    }

    // ── Internals ──────────────────────────────────────────────────────

    /** The engine objects with meshes, and those without. */
    private _split(objects: readonly THREE.Object3D[]): {
        meshed: THREE.Object3D[]; bare: THREE.Object3D[];
    } {
        const meshed: THREE.Object3D[] = [];
        const bare: THREE.Object3D[] = [];
        const hasMesh = (object: THREE.Object3D): boolean => {
            let found = false;
            object.traverse(o => {
                if (found) return;
                const mesh = o as THREE.Mesh;
                if (mesh.isMesh && mesh.geometry) found = true;
            });
            return found;
        };
        for (const object of objects) {
            (hasMesh(object) ? meshed : bare).push(object);
        }
        return { meshed, bare };
    }

    /** (Re)creates the proxies and the boxes for the current selection. */
    private _rebuild(): void {
        const { meshed, bare } = this._split(this._outlined);
        const wanted = new Set(meshed);

        // Proxies: drop what is no longer selected, add what is.
        for (const [source, proxy] of [...this._proxies]) {
            if (!wanted.has(source)) {
                this._maskScene.remove(proxy.mesh);
                this._proxies.delete(source);
            }
        }
        for (const source of meshed) {
            if (this._proxies.has(source)) continue;
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
                color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
            }));
            mesh.matrixAutoUpdate = false;
            mesh.frustumCulled = false;
            this._maskScene.add(mesh);
            this._proxies.set(source, { source, mesh });
        }

        this._rebuildBoxes(bare);
    }

    private _rebuildBoxes(bare: readonly THREE.Object3D[]): void {
        this._disposeBoxes();
        if (bare.length === 0) return;
        // One box per bare object's bounds: their pivot otherwise sits in space.
        for (const object of bare) {
            const helper = new THREE.BoxHelper(object, OUTLINE_COLOR);
            (helper.material as THREE.LineBasicMaterial).transparent = true;
            (helper.material as THREE.LineBasicMaterial).opacity = 0.45;
            this._renderer.addOverlayLayer('above-scene', helper);
            this._boxes.push(helper);
        }
    }

    private _disposeBoxes(): void {
        for (const box of this._boxes) {
            this._renderer.removeOverlayLayer(box);
            box.dispose();
        }
        this._boxes = [];
    }

    /** The render target, resized to the canvas (a mid-session resize follows). */
    private _ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
        const w = Math.max(1, Math.floor(width));
        const h = Math.max(1, Math.floor(height));
        if (!this._target || this._target.width !== w || this._target.height !== h) {
            this._target?.dispose();
            this._target = new THREE.WebGLRenderTarget(w, h, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                depthBuffer: false,
            });
            if (this._material) this._material.uniforms.mask.value = this._target.texture;
        }
        return this._target;
    }

    /** The full-screen quad, with D-9's rim shader. */
    private _ensureQuad(target: THREE.WebGLRenderTarget): THREE.Mesh {
        if (this._quad && this._material) {
            this._material.uniforms.mask.value = target.texture;
            return this._quad;
        }
        const material = new THREE.ShaderMaterial({
            uniforms: {
                mask: { value: target.texture },
                texel: { value: new THREE.Vector2(1 / target.width, 1 / target.height) },
                // Unity's orange, as the sRGB bytes the frame carries: this shader
                // writes straight to the default framebuffer, so a THREE.Color's
                // working-space (linear) conversion would land in the image as a
                // much darker green.
                color: { value: new THREE.Vector3(0xff / 255, 0x66 / 255, 0x00 / 255) },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform sampler2D mask;
                uniform vec2 texel;
                uniform vec3 color;
                varying vec2 vUv;
                void main() {
                    float here = texture2D(mask, vUv).r;
                    if (here > 0.5) discard;
                    // The rim: any sample within RIM pixels of the filled mask.
                    float near = 0.0;
                    for (int y = -${RIM}; y <= ${RIM}; y++) {
                        for (int x = -${RIM}; x <= ${RIM}; x++) {
                            near = max(near, texture2D(mask, vUv + texel * vec2(float(x), float(y))).r);
                        }
                    }
                    gl_FragColor = vec4(color, step(0.5, near));
                }
            `,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.frustumCulled = false;
        this._quadScene.add(quad);
        this._quad = quad;
        this._material = material;
        return quad;
    }

    /** One frame: fill the mask, then composite the rim over the scene. */
    private _draw(gl: THREE.WebGLRenderer, camera: THREE.Camera): void {
        if (this._proxies.size === 0 && this._boxes.length === 0) return;
        const size = gl.getDrawingBufferSize(new THREE.Vector2());
        const target = this._ensureTarget(size.x, size.y);

        // Copy each engine object's world matrix into its proxy, and its geometry.
        for (const { source, mesh } of this._proxies.values()) {
            mesh.matrixWorld.copy(source.matrixWorld);
            mesh.matrix.copy(source.matrix);
            mesh.geometry = this._geometryOf(source) ?? mesh.geometry;
        }

        // 1. The mask: flat white over black, straight onto the target. The
        // default framebuffer is not touched, so the frame drawn above survives.
        gl.setRenderTarget(target);
        gl.setClearColor(0x000000, 1);
        gl.clear(true, false, false);
        gl.render(this._maskScene, camera);
        // 2. The rim, over that frame.
        gl.setRenderTarget(null);
        const quad = this._ensureQuad(target);
        (this._material?.uniforms.texel.value as THREE.Vector2 | undefined)?.set(1 / target.width, 1 / target.height);
        gl.render(this._quadScene, this._quadCamera);
        void quad;
    }

    /** The first mesh geometry in the object's subtree, if any. */
    private _geometryOf(object: THREE.Object3D): THREE.BufferGeometry | null {
        let found: THREE.BufferGeometry | null = null;
        object.traverse(o => {
            if (found) return;
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh && mesh.geometry) found = mesh.geometry;
        });
        return found;
    }

}
