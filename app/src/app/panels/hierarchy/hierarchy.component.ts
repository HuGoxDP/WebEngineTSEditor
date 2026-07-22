import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    computed,
    inject,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
    AmbientLight,
    AudioListener,
    AudioSource,
    Camera,
    Canvas as UICanvas,
    DirectionalLight,
    GameObject,
    ParticleSystem,
    PointLight,
    SceneSerializer,
    SpotLight,
    type Component as EngineComponent,
} from 'WebEngineTS';
import { SceneService } from '../../services/scene.service';
import { SelectionService } from '../../services/selection.service';
import { HistoryService } from '../../services/history.service';
import { IconComponent } from '../../icon.component';
import { ContextMenuComponent, type CtxItem } from '../../context-menu/context-menu.component';

interface HierarchyNode {
    go: GameObject;
    depth: number;
    name: string;
    hasChildren: boolean;
    icon: string;
}

type CtorOf<T> = new (...args: any[]) => T;

@Component({
    selector: 'app-hierarchy',
    standalone: true,
    imports: [FormsModule, IconComponent, ContextMenuComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="hier-toolbar">
            <button class="create-btn" (click)="openCreateMenu($event)" title="Create">
                <wets-icon name="plus"></wets-icon>
                <span class="caret">▾</span>
            </button>
            <div class="h-search">
                <wets-icon name="search"></wets-icon>
                <span class="cat">All <span style="font-size: 8px; opacity: 0.6;">▾</span></span>
                <span class="h-divider"></span>
                <input type="text" placeholder=""
                    [ngModel]="filter()"
                    (ngModelChange)="filter.set($event)">
            </div>
            <button class="panel-mode-btn" title="Panel mode">
                <wets-icon name="rect"></wets-icon>
            </button>
        </div>

        <ul class="tree"
            (contextmenu)="openMenuAt($event, null)"
            (dragover)="onDragOverEmpty($event)"
            (drop)="onDropOnEmpty($event)"
        >
            <!-- Scene root row — Unity-style -->
            <li class="scene-root"
                (click)="selection.clear()"
                (contextmenu)="openMenuAt($event, null)"
            >
                <span class="caret">
                    <wets-icon name="caret-r" style="transform: rotate(90deg);"></wets-icon>
                </span>
                <span class="go-ico">
                    <wets-icon name="gameobject"></wets-icon>
                </span>
                <span class="label">MainScene</span>
                @if (history.canUndo()) {
                    <span class="dirty" title="Unsaved changes"></span>
                }
            </li>

            @for (node of flat(); track node.go.getInstanceID(); let idx = $index) {
                <li
                    [class.selected]="selection.isSelected(node.go)"
                    [class.primary]="selection.selected() === node.go"
                    [class.drop-target]="dragOverId() === node.go.getInstanceID()"
                    [style.padding-left.px]="22 + node.depth * 14"
                    [attr.draggable]="editingId() === node.go.getInstanceID() ? null : true"
                    (click)="onRowClick($event, node.go, idx)"
                    (dblclick)="startRename(node.go)"
                    (contextmenu)="openMenuAt($event, node.go)"
                    (dragstart)="onDragStart($event, node.go)"
                    (dragend)="onDragEnd()"
                    (dragover)="onDragOver($event, node.go)"
                    (dragleave)="onDragLeave(node.go)"
                    (drop)="onDrop($event, node.go)"
                >
                    <span class="caret" [class.empty]="!node.hasChildren">
                        <wets-icon name="caret-r"></wets-icon>
                    </span>
                    <span class="go-ico">
                        <wets-icon [name]="node.icon"></wets-icon>
                    </span>
                    @if (editingId() === node.go.getInstanceID()) {
                        <input
                            #renameInput
                            class="rename-input"
                            [value]="node.name"
                            (click)="$event.stopPropagation()"
                            (keydown.enter)="commitRename(node.go, renameInput.value)"
                            (keydown.escape)="cancelRename()"
                            (blur)="commitRename(node.go, renameInput.value)"
                            autofocus
                        >
                    } @else {
                        <span class="label">{{ node.name }}</span>
                    }
                </li>
            }
        </ul>

        @if (menuOpen()) {
            <ctx-menu
                [items]="menuItems()"
                [x]="menuX()"
                [y]="menuY()"
                (closed)="menuOpen.set(false)"
            ></ctx-menu>
        }
    `,
})
export class HierarchyComponent {

    public readonly scene = inject(SceneService);
    public readonly selection = inject(SelectionService);
    public readonly history = inject(HistoryService);

    public readonly filter = signal('');

    /** Instance id of the GO being renamed inline; -1 = none. */
    public readonly editingId = signal<number>(-1);

    /** Instance id of the GO currently being hovered over while dragging. */
    public readonly dragOverId = signal<number>(-1);

    /** GO currently being dragged. */
    private _dragSource: GameObject | null = null;

    /** Last clicked row index — anchor for Shift+Click range selection. */
    private _lastClickedIndex: number = -1;

    constructor() {
        const destroyRef = inject(DestroyRef);
        const onRename = (): void => {
            const go = this.selection.selected();
            if (go) this.startRename(go);
        };
        window.addEventListener('wets:rename-selected', onRename);
        destroyRef.onDestroy(() => window.removeEventListener('wets:rename-selected', onRename));
    }

    public readonly flat = computed<HierarchyNode[]>(() => {
        this.scene.revision();
        const q = this.filter().toLowerCase().trim();
        const out: HierarchyNode[] = [];
        for (const root of this.scene.roots()) {
            HierarchyComponent._walk(root, 0, out);
        }
        return q
            ? out.filter(n => n.name.toLowerCase().includes(q))
            : out;
    });

    // ── Context menu state ─────────────────────────────────

    public readonly menuOpen = signal(false);
    public readonly menuX = signal(0);
    public readonly menuY = signal(0);
    public readonly menuItems = signal<CtxItem[]>([]);
    /** GameObject the menu was opened against (null = empty area). */
    private _ctxTarget: GameObject | null = null;

    public openMenuAt(e: MouseEvent, target: GameObject | null): void {
        e.preventDefault();
        e.stopPropagation();
        this._ctxTarget = target;
        if (target) this.selection.select(target);
        this.menuItems.set(this._buildItems(target));
        this.menuX.set(e.clientX);
        this.menuY.set(e.clientY);
        // Open on next microtask so the document-level click that triggered
        // this right-click doesn't immediately close it again.
        queueMicrotask(() => this.menuOpen.set(true));
    }

    public openCreateMenu(e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        this._ctxTarget = null;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.menuItems.set(this._buildItems(null));
        this.menuX.set(rect.left);
        this.menuY.set(rect.bottom + 2);
        queueMicrotask(() => this.menuOpen.set(true));
    }

    // ── Menu builder ───────────────────────────────────────

    private _buildItems(target: GameObject | null): CtxItem[] {
        const onTarget = !!target;
        const items: CtxItem[] = [];

        // Edit ops (mostly stubs — only Rename / Duplicate / Delete are wired)
        items.push({ label: 'Cut',          shortcut: 'Ctrl+X', disabled: true });
        items.push({ label: 'Copy',         shortcut: 'Ctrl+C', disabled: true });
        items.push({ label: 'Paste',        shortcut: 'Ctrl+V', disabled: true });
        items.push({ separator: true, label: null });
        items.push({
            label: 'Rename',
            disabled: !onTarget,
            action: () => this._rename(target!),
        });
        items.push({
            label: 'Duplicate',
            shortcut: 'Ctrl+D',
            disabled: !onTarget,
            action: () => this._duplicate(target!),
        });
        items.push({
            label: 'Delete',
            shortcut: 'Del',
            disabled: !onTarget,
            action: () => this._delete(target!),
        });
        items.push({ separator: true, label: null });

        // Create
        items.push({
            label: 'Create Empty',
            shortcut: 'Ctrl+Shift+N',
            action: () => this._createEmpty(),
        });

        items.push({
            label: 'Light',
            children: [
                { label: 'Directional Light', action: () => this._createWith('Directional Light', DirectionalLight as CtorOf<EngineComponent>) },
                { label: 'Point Light',       action: () => this._createWith('Point Light',       PointLight       as CtorOf<EngineComponent>) },
                { label: 'Spot Light',        action: () => this._createWith('Spot Light',        SpotLight        as CtorOf<EngineComponent>) },
                { label: 'Ambient Light',     action: () => this._createWith('Ambient Light',     AmbientLight     as CtorOf<EngineComponent>) },
            ],
        });

        items.push({
            label: 'Audio',
            children: [
                { label: 'Audio Source',   action: () => this._createWith('Audio Source',   AudioSource   as CtorOf<EngineComponent>) },
                { label: 'Audio Listener', action: () => this._createWith('Audio Listener', AudioListener as CtorOf<EngineComponent>) },
            ],
        });

        items.push({
            label: 'Effects',
            children: [
                { label: 'Particle System', action: () => this._createWith('Particle System', ParticleSystem as CtorOf<EngineComponent>) },
            ],
        });

        items.push({
            label: 'UI',
            children: [
                { label: 'Canvas', action: () => this._createWith('Canvas', UICanvas as CtorOf<EngineComponent>) },
            ],
        });

        items.push({
            label: 'Camera',
            action: () => this._createWith('Camera', Camera as CtorOf<EngineComponent>),
        });

        return items;
    }

    // ── Actions ────────────────────────────────────────────

    private _createEmpty(): void {
        this.history.record('Create GameObject', () => {
            const parent = this._ctxTarget;
            const go = this.scene.createEmpty('GameObject');
            if (parent) go.transform.parent = parent.transform;
            this.selection.select(go);
        });
    }

    private _createWith(name: string, ctor: CtorOf<EngineComponent>): void {
        this.history.record(`Create ${name}`, () => {
            const parent = this._ctxTarget;
            const go = this.scene.createEmpty(name);
            if (parent) go.transform.parent = parent.transform;
            go.addComponent(ctor as any);
            this.selection.select(go);
        });
    }

    private _rename(go: GameObject): void {
        const next = window.prompt('New name', go.name);
        if (next === null || next === '') return;
        this.history.record('Rename', () => {
            this.scene.rename(go, next);
        });
    }

    private _duplicate(go: GameObject): void {
        this.history.record('Duplicate', () => {
            const json = SceneSerializer.serializeGameObject(go);
            // Append " (Clone)" to the name like Unity does.
            json.name = `${json.name} (Clone)`;
            const copy = SceneSerializer.deserializeGameObject(json);
            const parent = go.transform.parent;
            if (parent) copy.transform.parent = parent;
            this.scene.notify();
            this.selection.select(copy);
        });
    }

    private _delete(go: GameObject): void {
        this.history.record('Delete GameObject', () => {
            if (this.selection.selected() === go) this.selection.clear();
            this.scene.destroy(go);
        });
    }

    public onCreate(): void {
        // Compatibility — kept for any direct callers; opens the menu next to the button.
        // Most callers should use openCreateMenu(MouseEvent).
        this._ctxTarget = null;
        this._createEmpty();
    }

    // ── Multi-select click handling ────────────────────────

    public onRowClick(e: MouseEvent, go: GameObject, idx: number): void {
        if (e.ctrlKey || e.metaKey) {
            // Ctrl / ⌘ + Click — toggle in/out of selection.
            this.selection.toggle(go);
            this._lastClickedIndex = idx;
        } else if (e.shiftKey && this._lastClickedIndex >= 0) {
            // Shift + Click — extend selection to a range from the anchor.
            const flat = this.flat();
            const a = Math.min(this._lastClickedIndex, idx);
            const b = Math.max(this._lastClickedIndex, idx);
            const range = flat.slice(a, b + 1).map(n => n.go);
            this.selection.addToSelection(range);
        } else {
            // Plain click — single-select.
            this.selection.select(go);
            this._lastClickedIndex = idx;
        }
    }

    // ── Inline rename ──────────────────────────────────────

    public startRename(go: GameObject): void {
        this.editingId.set(go.getInstanceID());
    }

    public commitRename(go: GameObject, value: string): void {
        if (this.editingId() !== go.getInstanceID()) return;
        const next = value.trim();
        this.editingId.set(-1);
        if (!next || next === go.name) return;
        this.history.record('Rename', () => {
            this.scene.rename(go, next);
        });
    }

    public cancelRename(): void {
        this.editingId.set(-1);
    }

    // ── Drag to reparent ───────────────────────────────────

    public onDragStart(e: DragEvent, go: GameObject): void {
        this._dragSource = go;
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', go.name);
        }
    }

    public onDragEnd(): void {
        this._dragSource = null;
        this.dragOverId.set(-1);
    }

    public onDragOver(e: DragEvent, target: GameObject): void {
        if (!this._dragSource || this._dragSource === target) return;
        if (HierarchyComponent._isAncestorOf(this._dragSource, target)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        this.dragOverId.set(target.getInstanceID());
    }

    public onDragLeave(target: GameObject): void {
        if (this.dragOverId() === target.getInstanceID()) {
            this.dragOverId.set(-1);
        }
    }

    public onDragOverEmpty(e: DragEvent): void {
        if (!this._dragSource) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    }

    public onDrop(e: DragEvent, target: GameObject): void {
        e.preventDefault();
        const src = this._dragSource;
        this._dragSource = null;
        this.dragOverId.set(-1);
        if (!src || src === target) return;
        if (HierarchyComponent._isAncestorOf(src, target)) return;
        this.history.record('Reparent', () => {
            src.transform.parent = target.transform;
            this.scene.notify();
        });
    }

    public onDropOnEmpty(e: DragEvent): void {
        e.preventDefault();
        const src = this._dragSource;
        this._dragSource = null;
        this.dragOverId.set(-1);
        if (!src || src.transform.parent === null) return;
        this.history.record('Move to root', () => {
            src.transform.parent = null;
            this.scene.notify();
        });
    }

    private static _isAncestorOf(a: GameObject, b: GameObject): boolean {
        // True if `a` is an ancestor of `b` (or the same).
        let cur = b.transform.parent;
        while (cur) {
            if (cur.gameObject === a) return true;
            cur = cur.parent;
        }
        return a === b;
    }

    // ── Helpers ────────────────────────────────────────────

    private static _walk(go: GameObject, depth: number, out: HierarchyNode[]): void {
        const t = go.transform;
        out.push({
            go,
            depth,
            name: go.name,
            hasChildren: t.childCount > 0,
            icon: HierarchyComponent._iconFor(go),
        });
        for (let i = 0; i < t.childCount; i++) {
            HierarchyComponent._walk(t.getChild(i).gameObject, depth + 1, out);
        }
    }

    private static _iconFor(go: GameObject): string {
        const comps = (go as unknown as { _components: Array<{ constructor: { name: string } }> })._components ?? [];
        for (const c of comps) {
            const n = c.constructor.name;
            if (n === 'Camera') return 'camera';
            if (n.endsWith('Light')) return 'light';
            if (n === 'MeshRenderer' || n === 'MeshFilter' || n === 'SkinnedMeshRenderer') return 'mesh';
        }
        return go.transform.childCount > 0 ? 'folder' : 'gameobject';
    }
}
