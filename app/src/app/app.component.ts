import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    HostListener,
    OnDestroy,
    ViewChild,
    computed,
    effect,
    inject,
    signal,
} from '@angular/core';
import { ViewportService } from './viewport.service';
import { SceneService } from './services/scene.service';
import { SelectionService } from './services/selection.service';
import { FileIoService } from './services/file-io.service';
import { PlayModeService } from './services/play-mode.service';
import { HistoryService } from './services/history.service';
import { HierarchyComponent } from './panels/hierarchy/hierarchy.component';
import { InspectorComponent } from './panels/inspector/inspector.component';
import { ProjectComponent } from './panels/project/project.component';
import { ConsoleComponent } from './panels/console/console.component';
import { IconComponent } from './icon.component';
import { ContextMenuComponent, type CtxItem } from './context-menu/context-menu.component';
import { ComponentRegistryService } from './services/component-registry.service';
import { ConsoleService } from './services/console.service';
import { ClipboardService } from './services/clipboard.service';
import { LayoutService } from './services/layout.service';
import { SceneSerializer } from 'WebEngineTS';
import type { SerializedScene, GameObject } from 'WebEngineTS';

/** Top-level editor shell — menubar, toolbar, work grid, status bar. */
@Component({
    selector: 'app-root',
    standalone: true,
    imports: [HierarchyComponent, InspectorComponent, ProjectComponent, ConsoleComponent, IconComponent, ContextMenuComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="app">
            <!-- ═══ MENU BAR ═══ -->
            <header class="menubar">
                <div class="brand">
                    <span class="brand-mark"></span>
                    <span>WETS</span>
                </div>
                @for (m of MENUBAR; track m.name) {
                    <div class="menubar-item"
                        #miEl
                        [class.open]="openMenu() === m.name"
                        (click)="onMenubarClick($event, m.name, miEl)"
                        (mouseenter)="onMenubarEnter(m.name, miEl)"
                    >{{ m.name }}</div>
                }
                <div class="spacer"></div>
                <div class="project-tag">
                    <span class="dot"></span>
                    <span>main</span>
                </div>
            </header>

            <!-- ═══ TOOLBAR ═══ -->
            <header class="toolbar">
                <div class="tb-group">
                    <button class="tb-btn"
                        [disabled]="!history.canUndo()"
                        (click)="history.undo()" title="Undo (Ctrl+Z)">
                        <wets-icon name="undo"></wets-icon>
                    </button>
                    <button class="tb-btn"
                        [disabled]="!history.canRedo()"
                        (click)="history.redo()" title="Redo (Ctrl+Shift+Z)">
                        <wets-icon name="redo"></wets-icon>
                    </button>
                </div>
                <div class="tb-sep"></div>
                <div class="tb-group">
                    <button class="tb-btn primary"
                        [class.playing]="play.isPlaying()"
                        [disabled]="play.isPlaying()"
                        (click)="play.play()" title="Play">
                        <wets-icon name="play"></wets-icon>
                    </button>
                    <button class="tb-btn"
                        [disabled]="!play.isPlaying()"
                        (click)="play.stop()" title="Stop">
                        <wets-icon name="stop"></wets-icon>
                    </button>
                </div>
                <div class="tb-sep"></div>
                <div class="tb-group">
                    <button class="tb-btn" (click)="onNew()" title="New scene">
                        <wets-icon name="file-new"></wets-icon>
                    </button>
                    <button class="tb-btn" (click)="onOpen()" title="Open">
                        <wets-icon name="folder"></wets-icon>
                    </button>
                    <button class="tb-btn" (click)="onSave()" title="Save">
                        <wets-icon name="save"></wets-icon>
                    </button>
                </div>

                <div class="tb-spacer"></div>

                @if (play.isPlaying()) {
                    <div class="tb-live"><span class="rec"></span>LIVE</div>
                }
            </header>

            <!-- ═══ WORK AREA ═══ -->
            <section class="work"
                [style.--left-w.px]="layout.leftW()"
                [style.--right-w.px]="layout.rightW()"
                [style.--bottom-h.px]="layout.bottomH()"
            >
                <aside class="pane left">
                    <div class="pane-tabs">
                        <div class="pane-tab active">≡ Hierarchy</div>
                        <div class="pane-tab-actions">
                            <button class="pane-btn" title="Lock">🔒</button>
                            <button class="pane-btn" title="Menu">
                                <wets-icon name="more"></wets-icon>
                            </button>
                        </div>
                    </div>
                    <div class="pane-body">
                        <app-hierarchy></app-hierarchy>
                    </div>
                </aside>

                <div class="splitter vsplit-l"
                    [class.dragging]="dragAxis() === 'left'"
                    (pointerdown)="onSplitterDown($event, 'left')"
                ></div>

                <section class="pane center">
                    <div class="pane-tabs">
                        <div class="pane-tab active">◉ Scene</div>
                    </div>
                    <div class="pane-body">
                        <div class="viewport-wrap">

                            <!-- Sub-toolbar above the canvas (Pivot/Center · Local/Global · Snap · render-mode chips) -->
                            <div class="vp-subtoolbar">
                                <button class="chip" title="Pivot">
                                    <wets-icon name="pivot"></wets-icon>
                                    <span>Pivot</span>
                                    <span class="caret">▾</span>
                                </button>
                                <button class="chip" title="Local space">
                                    <wets-icon name="globe"></wets-icon>
                                    <span>Local</span>
                                    <span class="caret">▾</span>
                                </button>
                                <button class="chip" title="Snap value">
                                    <wets-icon name="magnet"></wets-icon>
                                    <span>1.0</span>
                                </button>
                                <div class="vp-sep"></div>
                                <button class="chip active" title="Shaded">
                                    <wets-icon name="shaded"></wets-icon>
                                </button>
                                <button class="chip" title="Lighting"><wets-icon name="light"></wets-icon></button>
                                <button class="chip" title="Audio"><wets-icon name="audio-fx"></wets-icon></button>
                                <button class="chip" title="Effects"><wets-icon name="cog"></wets-icon></button>
                                <button class="chip" title="Gizmos"><wets-icon name="gizmo"></wets-icon></button>
                                <div class="vp-spacer"></div>
                                <button class="chip" title="Visibility"><wets-icon name="eye"></wets-icon></button>
                            </div>

                            <div class="vp-canvas">
                                <canvas #viewportCanvas></canvas>

                                <!-- Floating vertical tool palette (Unity-style) -->
                                <aside class="tool-palette">
                                    <button class="tool-btn" title="Hand (Q)" disabled>
                                        <wets-icon name="hand"></wets-icon>
                                    </button>
                                    <button class="tool-btn"
                                        [class.active]="tool() === 'translate'"
                                        (click)="setTool('translate')" title="Move (W)">
                                        <wets-icon name="translate"></wets-icon>
                                    </button>
                                    <button class="tool-btn"
                                        [class.active]="tool() === 'rotate'"
                                        (click)="setTool('rotate')" title="Rotate (E)">
                                        <wets-icon name="rotate"></wets-icon>
                                    </button>
                                    <button class="tool-btn"
                                        [class.active]="tool() === 'scale'"
                                        (click)="setTool('scale')" title="Scale (R)">
                                        <wets-icon name="scale"></wets-icon>
                                    </button>
                                    <button class="tool-btn" title="Rect (T)" disabled>
                                        <wets-icon name="rect"></wets-icon>
                                    </button>
                                    <button class="tool-btn" title="Combined transform (Y)" disabled>
                                        <wets-icon name="transform-combo"></wets-icon>
                                    </button>
                                </aside>

                                <div class="vp-overlay-tl">
                                    <div class="chip">
                                        <span class="k">Tool</span><span class="v">{{ tool() }}</span>
                                    </div>
                                    <div class="chip">
                                        <span class="k">Shortcuts</span><span class="v">W · E · R · Del · Ctrl+Shift+N</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <div class="splitter vsplit-r"
                    [class.dragging]="dragAxis() === 'right'"
                    (pointerdown)="onSplitterDown($event, 'right')"
                ></div>

                <aside class="pane right">
                    <div class="pane-tabs">
                        <div class="pane-tab active">☰ Inspector</div>
                    </div>
                    <div class="pane-body">
                        <app-inspector></app-inspector>
                    </div>
                </aside>

                <div class="splitter hsplit"
                    [class.dragging]="dragAxis() === 'bottom'"
                    (pointerdown)="onSplitterDown($event, 'bottom')"
                ></div>

                <section class="pane bottom">
                    <div class="pane-tabs">
                        <div class="pane-tab"
                            [class.active]="bottomTab() === 'project'"
                            (click)="bottomTab.set('project')"
                        >
                            <wets-icon name="folder"></wets-icon>
                            <span>Project</span>
                        </div>
                        <div class="pane-tab"
                            [class.active]="bottomTab() === 'console'"
                            (click)="bottomTab.set('console')"
                        >
                            <wets-icon name="cog"></wets-icon>
                            <span>Console</span>
                            @if (consoleService.counts().err > 0) {
                                <span class="badge err">{{ consoleService.counts().err }}</span>
                            } @else if (consoleService.counts().warn > 0) {
                                <span class="badge warn">{{ consoleService.counts().warn }}</span>
                            } @else {
                                <span class="badge">{{ consoleService.entries().length }}</span>
                            }
                        </div>
                    </div>
                    <div class="pane-body">
                        @if (bottomTab() === 'project') {
                            <app-project></app-project>
                        } @else {
                            <app-console></app-console>
                        }
                    </div>
                </section>
            </section>

            <!-- ═══ STATUS BAR ═══ -->
            <footer class="statusbar">
                <div class="st"><span class="dot" [class.ok]="!play.isPlaying()" [class.live]="play.isPlaying()"></span>{{ play.isPlaying() ? 'Playing' : 'Ready' }}</div>
                <div class="st">{{ goCountLabel() }}</div>
                @if (selection.count() > 1) {
                    <div class="st accent">{{ selection.count() }} selected</div>
                }
                <div class="st accent">{{ history.canUndo() ? 'Unsaved' : 'Saved' }}</div>
                <div class="spacer"></div>
                <div class="st" title="Frames per second">
                    <span style="opacity:0.7">FPS</span>&nbsp;{{ viewport.fps() || '—' }}
                </div>
                <div class="st" title="Frame time">
                    <span style="opacity:0.7">Δt</span>&nbsp;{{ viewport.frameMs() || 0 }}ms
                </div>
                <div class="st">TypeScript · WebEngineTS 0.1.0</div>
            </footer>

            @if (openMenu()) {
                <ctx-menu
                    [items]="openMenuItems()"
                    [x]="menuX()"
                    [y]="menuY()"
                    (closed)="closeMenu()"
                ></ctx-menu>
            }
        </div>
    `,
})
export class AppComponent implements AfterViewInit, OnDestroy {

    @ViewChild('viewportCanvas', { static: true })
    private readonly _canvasRef!: ElementRef<HTMLCanvasElement>;

    private readonly _viewport = inject(ViewportService);
    /** Exposed so the status-bar template can read FPS / frame time. */
    public readonly viewport = this._viewport;
    private readonly _scene = inject(SceneService);
    public readonly selection = inject(SelectionService);
    private readonly _fileIo = inject(FileIoService);
    public readonly play = inject(PlayModeService);
    public readonly history = inject(HistoryService);
    private readonly _clipboard = inject(ClipboardService);

    constructor() {
        // End the current "edit session" any time the active selection changes
        // — so the next field edit creates a fresh undo entry.
        effect(() => {
            this.selection.selected();
            this.history.commitPendingEdit();
        });
    }
    public readonly layout = inject(LayoutService);

    /** Currently active gizmo tool (drives the toolbar toggle). */
    public readonly tool = signal<'translate' | 'rotate' | 'scale'>('translate');

    /** Active splitter while dragging — drives the dragging-state highlight. */
    public readonly dragAxis = signal<'left' | 'right' | 'bottom' | null>(null);

    public onSplitterDown(e: PointerEvent, axis: 'left' | 'right' | 'bottom'): void {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        this.dragAxis.set(axis);
        document.body.classList.add('resizing');
        document.body.style.cursor = axis === 'bottom' ? 'row-resize' : 'col-resize';

        const work = (e.currentTarget as HTMLElement).closest('.work') as HTMLElement | null;
        const rect = work?.getBoundingClientRect();
        const startLeft = this.layout.leftW();
        const startRight = this.layout.rightW();
        const startBottom = this.layout.bottomH();
        const startX = e.clientX;
        const startY = e.clientY;

        const move = (ev: PointerEvent): void => {
            if (axis === 'left') {
                this.layout.setLeft(startLeft + (ev.clientX - startX));
            } else if (axis === 'right') {
                // right-side: drag left = wider right pane.
                this.layout.setRight(startRight - (ev.clientX - startX));
            } else if (axis === 'bottom' && rect) {
                this.layout.setBottom(startBottom - (ev.clientY - startY));
            }
        };
        const up = (ev: PointerEvent): void => {
            (e.target as HTMLElement).releasePointerCapture(ev.pointerId);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            this.dragAxis.set(null);
            document.body.classList.remove('resizing');
            document.body.style.cursor = '';
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    private readonly _registry = inject(ComponentRegistryService);

    /** Exposed to the bottom pane template for the tab badge. */
    public readonly consoleService = inject(ConsoleService);

    /** Active bottom pane tab. */
    public readonly bottomTab = signal<'project' | 'console'>('project');

    // ── Menubar dropdowns ───────────────────────────────────────────

    public readonly MENUBAR = [
        { name: 'File' }, { name: 'Edit' },
        { name: 'GameObject' }, { name: 'Component' },
        { name: 'Window' }, { name: 'Help' },
    ];

    public readonly openMenu = signal<string | null>(null);
    public readonly openMenuItems = signal<CtxItem[]>([]);
    public readonly menuX = signal(0);
    public readonly menuY = signal(0);

    public onMenubarClick(e: MouseEvent, name: string, el: HTMLElement): void {
        e.stopPropagation();
        if (this.openMenu() === name) {
            this.closeMenu();
            return;
        }
        this._showMenu(name, el);
    }

    public onMenubarEnter(name: string, el: HTMLElement): void {
        // If a menu is already open, hovering over a sibling switches to it.
        if (this.openMenu() && this.openMenu() !== name) {
            this._showMenu(name, el);
        }
    }

    public closeMenu(): void {
        this.openMenu.set(null);
    }

    private _showMenu(name: string, el: HTMLElement): void {
        const rect = el.getBoundingClientRect();
        this.menuX.set(rect.left);
        this.menuY.set(rect.bottom + 1);
        this.openMenuItems.set(this._buildMenu(name));
        // queueMicrotask so a closing-doc-click doesn't immediately reclose us.
        queueMicrotask(() => this.openMenu.set(name));
    }

    private _buildMenu(name: string): CtxItem[] {
        switch (name) {
            case 'File':       return this._fileMenu();
            case 'Edit':       return this._editMenu();
            case 'GameObject': return this._gameObjectMenu();
            case 'Component':  return this._componentMenu();
            case 'Window':     return this._windowMenu();
            case 'Help':       return this._helpMenu();
            default:           return [];
        }
    }

    private _fileMenu(): CtxItem[] {
        return [
            { label: 'New Scene',  shortcut: 'Ctrl+N',       action: () => this.onNew() },
            { label: 'Open Scene…',shortcut: 'Ctrl+O',       action: () => this.onOpen() },
            { separator: true, label: null },
            { label: 'Save',       shortcut: 'Ctrl+S',       action: () => this.onSave() },
            { label: 'Save As…',   shortcut: 'Ctrl+Shift+S', action: () => this.onSave() },
            { separator: true, label: null },
            { label: 'Build Settings…', disabled: true },
            { label: 'Build',           disabled: true },
            { separator: true, label: null },
            { label: 'Exit', disabled: true },
        ];
    }

    private _editMenu(): CtxItem[] {
        const hasSel = this.selection.count() > 0;
        return [
            { label: 'Undo', shortcut: 'Ctrl+Z',
                disabled: !this.history.canUndo(),
                action: () => this.history.undo() },
            { label: 'Redo', shortcut: 'Ctrl+Shift+Z',
                disabled: !this.history.canRedo(),
                action: () => this.history.redo() },
            { separator: true, label: null },
            { label: 'Cut',   shortcut: 'Ctrl+X',
                disabled: !hasSel,
                action: () => this.onCut() },
            { label: 'Copy',  shortcut: 'Ctrl+C',
                disabled: !hasSel,
                action: () => this.onCopy() },
            { label: 'Paste', shortcut: 'Ctrl+V',
                disabled: !this._clipboard.hasContent(),
                action: () => this.onPaste() },
            { label: 'Duplicate', shortcut: 'Ctrl+D',
                disabled: !hasSel,
                action: () => this.onDuplicate() },
            { separator: true, label: null },
            { label: 'Delete', shortcut: 'Del',
                disabled: !hasSel,
                action: () => this.onDeleteSelected() },
            { label: 'Select All', shortcut: 'Ctrl+A',
                action: () => this._selectAll() },
            { separator: true, label: null },
            { label: 'Project Settings…', disabled: true },
            { label: 'Preferences…',      disabled: true },
        ];
    }

    private _selectAll(): void {
        const all: GameObject[] = [];
        const walk = (g: GameObject): void => {
            all.push(g);
            const t = g.transform;
            for (let i = 0; i < t.childCount; i++) walk(t.getChild(i).gameObject);
        };
        for (const r of this._scene.roots()) walk(r);
        this.selection.clear();
        this.selection.addToSelection(all);
    }

    private _gameObjectMenu(): CtxItem[] {
        return [
            { label: 'Create Empty', shortcut: 'Ctrl+Shift+N',
                action: () => this.onCreateEmpty() },
            { separator: true, label: null },
            { label: 'Camera',
                action: () => this._createWith('Camera', 'Camera') },
            { label: 'Light',
                children: [
                    { label: 'Directional Light', action: () => this._createWith('Directional Light', 'DirectionalLight') },
                    { label: 'Point Light',       action: () => this._createWith('Point Light',       'PointLight') },
                    { label: 'Spot Light',        action: () => this._createWith('Spot Light',        'SpotLight') },
                    { label: 'Ambient Light',     action: () => this._createWith('Ambient Light',     'AmbientLight') },
                ],
            },
            { label: 'Audio',
                children: [
                    { label: 'Audio Source',   action: () => this._createWith('Audio Source',   'AudioSource') },
                    { label: 'Audio Listener', action: () => this._createWith('Audio Listener', 'AudioListener') },
                ],
            },
            { label: 'Effects',
                children: [
                    { label: 'Particle System', action: () => this._createWith('Particle System', 'ParticleSystem') },
                ],
            },
            { label: 'UI',
                children: [
                    { label: 'Canvas', action: () => this._createWith('Canvas', 'Canvas') },
                    { label: 'Image',  action: () => this._createWith('Image',  'UIImage') },
                    { label: 'Text',   action: () => this._createWith('Text',   'UIText') },
                    { label: 'Button', action: () => this._createWith('Button', 'Button') },
                ],
            },
            { separator: true, label: null },
            { label: 'Center on Selection', shortcut: 'F',
                disabled: !this.selection.selected(),
                action: () => {
                    const go = this.selection.selected();
                    if (go) this._viewport.frameOnObject(go.transform._internalObject3D);
                } },
        ];
    }

    private _componentMenu(): CtxItem[] {
        const target = this.selection.selected();
        if (!target) {
            return [{ label: 'Select a GameObject first', disabled: true }];
        }
        // Group registry entries by category.
        const byCat = new Map<string, CtxItem[]>();
        for (const c of this._registry.all()) {
            if (!byCat.has(c.category)) byCat.set(c.category, []);
            byCat.get(c.category)!.push({
                label: c.name,
                action: () => this._addComponent(target, c.ctor, c.name),
            });
        }
        const out: CtxItem[] = [];
        const cats = [...byCat.keys()].sort();
        for (const cat of cats) {
            out.push({ label: cat, children: byCat.get(cat)! });
        }
        return out;
    }

    private _windowMenu(): CtxItem[] {
        return [
            { label: 'Hierarchy',  disabled: true },
            { label: 'Inspector',  disabled: true },
            { label: 'Scene',      disabled: true },
            { label: 'Project',    disabled: true },
            { label: 'Console',    disabled: true },
            { label: 'Animation',  disabled: true },
            { separator: true, label: null },
            { label: 'Reset Layout',
                action: () => this.layout.reset() },
        ];
    }

    private _helpMenu(): CtxItem[] {
        return [
            { label: 'About WETS', action: () => alert('WebEngineTS Editor 0.1.0\nA Unity-like editor for WebEngineTS.') },
            { label: 'Documentation', disabled: true },
            { label: 'Release Notes', disabled: true },
        ];
    }

    // ── Helpers reused by the menus ─────────────────────────────────

    private _createWith(displayName: string, ctorName: string): void {
        const entry = this._registry.all().find(c => c.name === ctorName);
        if (!entry) return;
        this.history.record(`Create ${displayName}`, () => {
            const go = this._scene.createEmpty(displayName);
            go.addComponent(entry.ctor as any);
            this.selection.select(go);
        });
    }

    private _addComponent(target: GameObject, ctor: new (...args: any[]) => unknown, name: string): void {
        this.history.record(`Add ${name}`, () => {
            target.addComponent(ctor as any);
            this.selection.notifyChanged();
        });
    }

    public readonly goCountLabel = computed(() => {
        this._scene.revision();
        const count = (arr: ReadonlyArray<{ transform: { childCount: number; getChild(i: number): any } }>): number => {
            let sum = 0;
            for (const g of arr) {
                sum += 1;
                for (let i = 0; i < g.transform.childCount; i++) {
                    sum += count([g.transform.getChild(i).gameObject]);
                }
            }
            return sum;
        };
        const n = count(this._scene.roots());
        return `${n} GameObject${n === 1 ? '' : 's'}`;
    });

    ngAfterViewInit(): void {
        this._viewport.attach(this._canvasRef.nativeElement);
        window.addEventListener('keydown', this._onKeyDown);
    }

    /**
     * Globally suppress the browser's native context menu inside the editor.
     * Components that want their own menu (e.g. Hierarchy) call preventDefault
     * themselves; this is a safety net for everything else.
     */
    @HostListener('contextmenu', ['$event'])
    public onHostContextMenu(e: MouseEvent): void {
        e.preventDefault();
    }

    ngOnDestroy(): void {
        window.removeEventListener('keydown', this._onKeyDown);
        this._viewport.detach();
    }

    public setTool(mode: 'translate' | 'rotate' | 'scale'): void {
        this.tool.set(mode);
        this._viewport.setGizmoMode(mode);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) this.history.redo();
            else            this.history.undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            this.history.redo();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            this.onCreateEmpty();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            const all: import('WebEngineTS').GameObject[] = [];
            const walk = (g: import('WebEngineTS').GameObject): void => {
                all.push(g);
                const t = g.transform;
                for (let i = 0; i < t.childCount; i++) walk(t.getChild(i).gameObject);
            };
            for (const r of this._scene.roots()) walk(r);
            this.selection.clear();
            this.selection.addToSelection(all);
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            this.onCopy();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            this.onPaste();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            this.onDuplicate();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            e.preventDefault();
            this.onCut();
            return;
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selection.selected()) {
                this.onDeleteSelected();
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'F2') {
            const go = this.selection.selected();
            if (go) {
                window.dispatchEvent(new CustomEvent('wets:rename-selected'));
                e.preventDefault();
            }
            return;
        }

        if (e.key.toLowerCase() === 'f') {
            const go = this.selection.selected();
            if (go) {
                this._viewport.frameOnObject(go.transform._internalObject3D);
                e.preventDefault();
            }
            return;
        }

        switch (e.key.toLowerCase()) {
            case 'w': this.setTool('translate'); break;
            case 'e': this.setTool('rotate');    break;
            case 'r': this.setTool('scale');     break;
        }
    };

    public onCreateEmpty(): void {
        this.history.record('Create GameObject', () => {
            const go = this._scene.createEmpty('GameObject');
            this.selection.select(go);
        });
    }

    public onDeleteSelected(): void {
        const targets = this.selection.toArray();
        if (targets.length === 0) return;
        const label = targets.length === 1
            ? 'Delete GameObject'
            : `Delete ${targets.length} GameObjects`;
        this.history.record(label, () => {
            this.selection.clear();
            for (const go of targets) this._scene.destroy(go);
        });
    }

    public onCopy(): void {
        this._clipboard.copy(this.selection.toArray());
    }

    public onCut(): void {
        const targets = this.selection.toArray();
        if (targets.length === 0) return;
        this._clipboard.copy(targets);
        const label = targets.length === 1
            ? 'Cut GameObject'
            : `Cut ${targets.length} GameObjects`;
        this.history.record(label, () => {
            this.selection.clear();
            for (const go of targets) this._scene.destroy(go);
        });
    }

    public onPaste(): void {
        if (!this._clipboard.hasContent()) return;
        const label = `Paste`;
        this.history.record(label, () => {
            const created = this._clipboard.paste();
            this._scene.notify();
            if (created.length > 0) {
                this.selection.clear();
                this.selection.addToSelection(created);
            }
        });
    }

    public onDuplicate(): void {
        const targets = this.selection.toArray();
        if (targets.length === 0) return;
        const label = targets.length === 1
            ? 'Duplicate GameObject'
            : `Duplicate ${targets.length} GameObjects`;
        this.history.record(label, () => {
            // Snapshot current selection, then re-create each as a sibling.
            const created: GameObject[] = [];
            for (const go of targets) {
                const json = SceneSerializer.serializeGameObject(go);
                json.name = `${json.name} (Clone)`;
                const copy = SceneSerializer.deserializeGameObject(json);
                if (go.transform.parent) copy.transform.parent = go.transform.parent;
                created.push(copy);
            }
            this._scene.notify();
            this.selection.clear();
            this.selection.addToSelection(created);
        });
    }

    public onNew(): void {
        if (this._scene.roots().length > 0 &&
            !confirm('Discard all unsaved changes?')) return;
        this.selection.clear();
        this._scene.clear();
        this.history.clear();
    }

    public onSave(): void {
        const json = this._scene.serialize();
        const fileName = `${json.name || 'scene'}.scene.json`;
        this._fileIo.saveText(fileName, JSON.stringify(json, null, 2));
    }

    public async onOpen(): Promise<void> {
        const file = await this._fileIo.openText('.json,.scene.json');
        if (!file) return;
        let data: SerializedScene;
        try {
            data = JSON.parse(file.text) as SerializedScene;
        } catch {
            alert(`Failed to parse ${file.name}: not valid JSON.`);
            return;
        }
        if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.roots)) {
            alert(`${file.name} is not a valid scene file.`);
            return;
        }
        this.selection.clear();
        this._scene.loadFromJSON(data);
        this.history.clear();
    }
}
