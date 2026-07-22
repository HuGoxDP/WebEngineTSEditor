import {
    ChangeDetectionStrategy,
    Component,
    computed,
    signal,
} from '@angular/core';
import { IconComponent } from '../../icon.component';

/** Logical folder in the project tree. */
interface Folder {
    /** Slash-separated path, e.g. `Assets/Scripts`. */
    path: string;
    label: string;
    /** Indent level. */
    depth: number;
    /** Always show — top-level group label. */
    favorite?: boolean;
}

/** Single asset entry in the grid. */
interface AssetEntry {
    folder: string;
    name: string;
    /** Drives the thumbnail color/icon. */
    kind: 'folder' | 'material' | 'mesh' | 'tex' | 'script' | 'prefab' | 'audio';
}

/**
 * Bottom Project pane — Unity-style asset browser.
 *
 * @remarks
 * Mock data for now; the full file-system / OPFS integration arrives in
 * Phase 12c. The visual structure matches the WETS design:
 * a folder tree on the left, breadcrumbs + asset grid on the right.
 */
@Component({
    selector: 'app-project',
    standalone: true,
    imports: [IconComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="proj">
            <div class="folders">
                <div class="folder-group">FAVORITES</div>
                @for (f of FAVORITES; track f.path) {
                    <div class="folder"
                        [class.active]="active() === f.path"
                        [class.nested]="f.depth === 1"
                        [class.level2]="f.depth === 2"
                        (click)="active.set(f.path)"
                    >
                        <wets-icon name="search"></wets-icon>
                        <span>{{ f.label }}</span>
                    </div>
                }
                <div class="folder-group">ASSETS</div>
                @for (f of FOLDERS; track f.path) {
                    <div class="folder"
                        [class.active]="active() === f.path"
                        [class.nested]="f.depth === 1"
                        [class.level2]="f.depth === 2"
                        (click)="active.set(f.path)"
                    >
                        <span class="caret" [class.open]="f.depth === 0">
                            @if (f.depth === 0) {
                                <wets-icon name="caret-r"></wets-icon>
                            }
                        </span>
                        <wets-icon name="folder"></wets-icon>
                        <span>{{ f.label }}</span>
                    </div>
                }
            </div>

            <div class="files">
                <div class="crumbs">
                    @for (c of crumbs(); track $index; let last = $last) {
                        <span class="c" [class.here]="last">{{ c }}</span>
                        @if (!last) { <span class="sep">›</span> }
                    }
                    <span class="counter">{{ visibleAssets().length }} items</span>
                </div>

                <div class="grid">
                    @for (a of visibleAssets(); track a.name) {
                        <div class="asset"
                            [class.selected]="selectedAsset() === a.name"
                            (click)="selectedAsset.set(a.name)"
                        >
                            <div class="thumb" [class]="'thumb ' + a.kind">
                                @if (a.kind === 'folder') {
                                    <wets-icon name="folder"></wets-icon>
                                } @else if (a.kind === 'script') {
                                    <wets-icon name="cog"></wets-icon>
                                } @else if (a.kind === 'mesh') {
                                    <wets-icon name="mesh"></wets-icon>
                                } @else if (a.kind === 'tex') {
                                    <wets-icon name="box"></wets-icon>
                                } @else if (a.kind === 'audio') {
                                    <wets-icon name="audio-fx"></wets-icon>
                                } @else if (a.kind === 'prefab') {
                                    <wets-icon name="gameobject"></wets-icon>
                                } @else if (a.kind === 'material') {
                                    <wets-icon name="shaded"></wets-icon>
                                }
                            </div>
                            <span class="label">{{ a.name }}</span>
                        </div>
                    }
                    @if (visibleAssets().length === 0) {
                        <div class="empty-grid">Empty folder.</div>
                    }
                </div>
            </div>
        </div>
    `,
})
export class ProjectComponent {

    /** Hard-coded mock folder tree. */
    public readonly FAVORITES: Folder[] = [
        { path: 'fav:scripts',   label: 'All Scripts',   depth: 1, favorite: true },
        { path: 'fav:materials', label: 'All Materials', depth: 1, favorite: true },
        { path: 'fav:prefabs',   label: 'All Prefabs',   depth: 1, favorite: true },
    ];

    public readonly FOLDERS: Folder[] = [
        { path: 'Assets',                  label: 'Assets',     depth: 0 },
        { path: 'Assets/Scripts',          label: 'Scripts',    depth: 1 },
        { path: 'Assets/Scripts/Player',   label: 'Player',     depth: 2 },
        { path: 'Assets/Scripts/Enemies',  label: 'Enemies',    depth: 2 },
        { path: 'Assets/Materials',        label: 'Materials',  depth: 1 },
        { path: 'Assets/Models',           label: 'Models',     depth: 1 },
        { path: 'Assets/Textures',         label: 'Textures',   depth: 1 },
        { path: 'Assets/Prefabs',          label: 'Prefabs',    depth: 1 },
        { path: 'Assets/Audio',            label: 'Audio',      depth: 1 },
        { path: 'Assets/Scenes',           label: 'Scenes',     depth: 1 },
    ];

    /** Mock assets keyed by folder path. */
    private readonly _assets: Record<string, AssetEntry[]> = {
        'Assets': [
            { folder: 'Assets', name: 'Scripts',   kind: 'folder' },
            { folder: 'Assets', name: 'Materials', kind: 'folder' },
            { folder: 'Assets', name: 'Models',    kind: 'folder' },
            { folder: 'Assets', name: 'Textures',  kind: 'folder' },
            { folder: 'Assets', name: 'Prefabs',   kind: 'folder' },
            { folder: 'Assets', name: 'Audio',     kind: 'folder' },
            { folder: 'Assets', name: 'Scenes',    kind: 'folder' },
        ],
        'Assets/Scripts': [
            { folder: 'Assets/Scripts', name: 'Player',  kind: 'folder' },
            { folder: 'Assets/Scripts', name: 'Enemies', kind: 'folder' },
            { folder: 'Assets/Scripts', name: 'GameManager.ts', kind: 'script' },
            { folder: 'Assets/Scripts', name: 'UIRoot.ts',       kind: 'script' },
        ],
        'Assets/Scripts/Player': [
            { folder: 'Assets/Scripts/Player', name: 'PlayerController.ts', kind: 'script' },
            { folder: 'Assets/Scripts/Player', name: 'PlayerHealth.ts',     kind: 'script' },
            { folder: 'Assets/Scripts/Player', name: 'PlayerInput.ts',      kind: 'script' },
        ],
        'Assets/Scripts/Enemies': [
            { folder: 'Assets/Scripts/Enemies', name: 'EnemyAI.ts',     kind: 'script' },
            { folder: 'Assets/Scripts/Enemies', name: 'PatrolPath.ts',  kind: 'script' },
        ],
        'Assets/Materials': [
            { folder: 'Assets/Materials', name: 'Default.mat',   kind: 'material' },
            { folder: 'Assets/Materials', name: 'Metallic.mat',  kind: 'material' },
            { folder: 'Assets/Materials', name: 'Glass.mat',     kind: 'material' },
        ],
        'Assets/Models': [
            { folder: 'Assets/Models', name: 'Capsule.glb', kind: 'mesh' },
            { folder: 'Assets/Models', name: 'Cube.glb',    kind: 'mesh' },
            { folder: 'Assets/Models', name: 'Plane.glb',   kind: 'mesh' },
        ],
        'Assets/Textures': [
            { folder: 'Assets/Textures', name: 'Floor.png',  kind: 'tex' },
            { folder: 'Assets/Textures', name: 'Wall.png',   kind: 'tex' },
            { folder: 'Assets/Textures', name: 'Sky.ktx2',   kind: 'tex' },
        ],
        'Assets/Prefabs': [
            { folder: 'Assets/Prefabs', name: 'Player.prefab.json',  kind: 'prefab' },
            { folder: 'Assets/Prefabs', name: 'Enemy.prefab.json',   kind: 'prefab' },
            { folder: 'Assets/Prefabs', name: 'Crate.prefab.json',   kind: 'prefab' },
        ],
        'Assets/Audio': [
            { folder: 'Assets/Audio', name: 'Footstep.mp3', kind: 'audio' },
            { folder: 'Assets/Audio', name: 'Hit.wav',      kind: 'audio' },
            { folder: 'Assets/Audio', name: 'Music.ogg',    kind: 'audio' },
        ],
        'Assets/Scenes': [
            { folder: 'Assets/Scenes', name: 'MainScene.scene.json', kind: 'prefab' },
        ],
        'fav:scripts':   [
            { folder: 'fav:scripts', name: 'GameManager.ts',     kind: 'script' },
            { folder: 'fav:scripts', name: 'PlayerController.ts',kind: 'script' },
            { folder: 'fav:scripts', name: 'EnemyAI.ts',         kind: 'script' },
            { folder: 'fav:scripts', name: 'PlayerHealth.ts',    kind: 'script' },
            { folder: 'fav:scripts', name: 'PlayerInput.ts',     kind: 'script' },
            { folder: 'fav:scripts', name: 'PatrolPath.ts',      kind: 'script' },
            { folder: 'fav:scripts', name: 'UIRoot.ts',          kind: 'script' },
        ],
        'fav:materials': [
            { folder: 'fav:materials', name: 'Default.mat',   kind: 'material' },
            { folder: 'fav:materials', name: 'Metallic.mat',  kind: 'material' },
            { folder: 'fav:materials', name: 'Glass.mat',     kind: 'material' },
        ],
        'fav:prefabs': [
            { folder: 'fav:prefabs', name: 'Player.prefab.json', kind: 'prefab' },
            { folder: 'fav:prefabs', name: 'Enemy.prefab.json',  kind: 'prefab' },
            { folder: 'fav:prefabs', name: 'Crate.prefab.json',  kind: 'prefab' },
        ],
    };

    public readonly active = signal<string>('Assets');
    public readonly selectedAsset = signal<string | null>(null);

    public readonly visibleAssets = computed<AssetEntry[]>(() => {
        return this._assets[this.active()] ?? [];
    });

    public readonly crumbs = computed<string[]>(() => {
        const a = this.active();
        if (a.startsWith('fav:')) return ['Favorites', a.split(':')[1]];
        return a.split('/');
    });
}
