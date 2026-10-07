import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    computed,
    inject,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GameObject, SceneManager } from 'WebEngineTS';
import { SceneService } from '../../services/scene.service';
import { SelectionService } from '../../services/selection.service';
import { HistoryService } from '../../services/history.service';
import { ClipboardService } from '../../services/clipboard.service';
import { CommandsService } from '../../services/commands.service';
import { IconComponent } from '../../icon.component';
import { ContextMenuComponent, type CtxItem } from '../../context-menu/context-menu.component';
import { I18nService } from '../../i18n/i18n.service';
import { TPipe } from '../../i18n/t.pipe';

interface HierarchyNode {
    go: GameObject;
    depth: number;
    name: string;
    hasChildren: boolean;
    icon: string;
}

@Component({
    selector: 'app-hierarchy',
    standalone: true,
    imports: [FormsModule, IconComponent, ContextMenuComponent, TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="hier-toolbar">
            <button class="create-btn" (click)="openCreateMenu($event)" [title]="'hier.create' | t">
                <wets-icon name="plus"></wets-icon>
                <span class="caret">▾</span>
            </button>
            <div class="h-search">
                <wets-icon name="search"></wets-icon>
                <span class="cat">{{ 'hier.all' | t }} <span style="font-size: 8px; opacity: 0.6;">▾</span></span>
                <span class="h-divider"></span>
                <input type="text" placeholder=""
                    [ngModel]="filter()"
                    (ngModelChange)="filter.set($event)">
            </div>
            <button class="panel-mode-btn" [title]="'hier.panelMode' | t">
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
                <span class="label">{{ sceneName() }}</span>
                @if (history.canUndo()) {
                    <span class="dirty" [title]="'hier.unsaved' | t"></span>
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
    private readonly _clipboard = inject(ClipboardService);
    private readonly _cmd = inject(CommandsService);
    private readonly _i18n = inject(I18nService);

    public readonly filter = signal('');

    /** Name of the scene shown as the tree's root row. */
    public readonly sceneName = computed(() => {
        this.scene.revision();
        return SceneManager.activeScene.name;
    });

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

    public openMenuAt(e: MouseEvent, target: GameObject | null): void {
        e.preventDefault();
        e.stopPropagation();
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
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.menuItems.set(this._buildItems(null));
        this.menuX.set(rect.left);
        this.menuY.set(rect.bottom + 2);
        queueMicrotask(() => this.menuOpen.set(true));
    }

    // ── Menu builder ───────────────────────────────────────

    private _buildItems(target: GameObject | null): CtxItem[] {
        const t = this._i18n.t.bind(this._i18n);
        const onTarget = !!target;
        return [
            { label: t('edit.cut'),   shortcut: 'Ctrl+X', disabled: !onTarget, action: () => this._cmd.cut() },
            { label: t('edit.copy'),  shortcut: 'Ctrl+C', disabled: !onTarget, action: () => this._cmd.copy() },
            { label: t('edit.paste'), shortcut: 'Ctrl+V', disabled: !this._clipboard.hasContent(), action: () => this._cmd.paste() },
            { separator: true, label: null },
            { label: t('edit.rename'), disabled: !onTarget, action: () => void this._cmd.rename(target!) },
            { label: t('edit.duplicate'), shortcut: 'Ctrl+D', disabled: !onTarget, action: () => this._cmd.duplicate([target!]) },
            { label: t('edit.delete'), shortcut: 'Del', disabled: !onTarget, action: () => this._cmd.deleteObjects([target!]) },
            { separator: true, label: null },
            ...this._cmd.createMenu(target),
        ];
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
