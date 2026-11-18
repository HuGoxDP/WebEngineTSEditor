import * as THREE from 'three';
import type { SceneViewRenderer } from './scene-view-renderer';

/**
 * The gizmo billboard icons (B1 phase 6; D-11).
 *
 * One canvas-drawn sprite per icon kind, drawn in the on-top layer so an icon
 * is always readable (Unity's icons ignore depth). The sprites are pooled and
 * only the visible ones' positions are written each frame; their size follows
 * the Gizmos menu's slider, and their colour reports what the gizmo means:
 * a light is warm, a camera cool, audio neutral. Each kind has a brighter twin
 * pool for the selected objects' icons (D-11), fed by `place`'s selected flags.
 */

/** The icons D-11 names. */
export type IconKind = 'camera' | 'light' | 'audio';

const GLYPHS: Record<IconKind, string> = {
    camera: '▣',
    light: '☀',
    audio: '♫',
};

const COLORS: Record<IconKind, number> = {
    camera: 0x8ec5ff,
    light: 0xffd48a,
    audio: 0xd7dae0,
};

export class GizmoIcons {

    private readonly _renderer: SceneViewRenderer;
    private readonly _group = new THREE.Group();
    private readonly _sprites = new Map<IconKind, THREE.Sprite[]>();
    private readonly _materials = new Map<IconKind, THREE.SpriteMaterial>();
    /** The brighter twin pools for the selection's icons (D-11). */
    private readonly _brightSprites = new Map<IconKind, THREE.Sprite[]>();
    private readonly _brightMaterials = new Map<IconKind, THREE.SpriteMaterial>();
    private _size = 1;
    private _mounted = false;

    constructor(renderer: SceneViewRenderer) {
        this._renderer = renderer;
        for (const kind of ['camera', 'light', 'audio'] as IconKind[]) {
            this._materials.set(kind, this._material(kind, false));
            this._brightMaterials.set(kind, this._material(kind, true));
            this._sprites.set(kind, []);
            this._brightSprites.set(kind, []);
        }
        this._group.visible = true;
    }

    /** The menu's icon scale, in world units at the default distance. */
    public set size(size: number) { this._size = Math.max(0.25, Math.min(4, size)); }

    public mount(): void {
        if (this._mounted) return;
        this._mounted = true;
        this._renderer.addOverlayLayer('above-scene', this._group);
    }

    /** Hides or shows the layer as a whole (the master Gizmos switch). */
    public set visible(visible: boolean) { this._group.visible = visible; }

    /** The master switch, as a setter (the menu's checkbox). */
    public setVisibleIf(enabled: boolean): void { this._group.visible = enabled; }

    /**
     * Places one icon per object, reusing the pools. `positions` are engine-space
     * points the icons float just above; the z flip of space.ts is inlined so
     * the per-frame path allocates nothing. `count` is how many entries are live
     * this frame — the array itself is pooled and may hold stale tail entries.
     * An entry flagged `selected` goes to the kind's brighter twin pool (D-11).
     */
    public place(kind: IconKind, positions: readonly { x: number; y: number; z: number; selected?: boolean }[], count = positions.length): void {
        const pool = this._sprites.get(kind)!;
        const bright = this._brightSprites.get(kind)!;
        let n = 0, b = 0;
        for (let i = 0; i < count; i++) {
            const p = positions[i];
            const target = p.selected ? bright : pool;
            const j = p.selected ? b++ : n++;
            const material = (p.selected ? this._brightMaterials : this._materials).get(kind)!;
            const sprite = target[j] ?? (target[j] = new THREE.Sprite(material));
            if (!sprite.parent) this._group.add(sprite);
            sprite.position.set(p.x, p.y + 0.45 * this._size, -p.z);
            sprite.scale.set(this._size, this._size, this._size);
            sprite.visible = true;
        }
        for (let i = n; i < pool.length; i++) pool[i].visible = false;
        for (let i = b; i < bright.length; i++) bright[i].visible = false;
    }

    public dispose(): void {
        this._mounted = false;
        this._renderer.removeOverlayLayer(this._group);
        for (const material of [...this._materials.values(), ...this._brightMaterials.values()]) material.map?.dispose();
        this._materials.clear();
        this._brightMaterials.clear();
        this._sprites.clear();
        this._brightSprites.clear();
    }

    /** The icon's canvas texture: a glyph on a transparent square. */
    private _material(kind: IconKind, bright: boolean): THREE.SpriteMaterial {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, size, size);
            const color = bright
                ? new THREE.Color(COLORS[kind]).lerp(new THREE.Color(0xffffff), 0.5).getHex()
                : COLORS[kind];
            ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
            ctx.font = '44px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(GLYPHS[kind], size / 2, size / 2 + 2);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        return new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    }
}
