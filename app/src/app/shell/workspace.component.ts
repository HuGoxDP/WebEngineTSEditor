import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    ViewChild,
    effect,
    inject,
    signal,
} from '@angular/core';
import { ViewportService, type GizmoMode } from '../viewport.service';
import type { MessageKey } from '../i18n/i18n.service';
import { CommandsService } from '../services/commands.service';
import { ConsoleService } from '../services/console.service';
import { HistoryService } from '../services/history.service';
import { LayoutService } from '../services/layout.service';
import { SelectionService } from '../services/selection.service';
import { SettingsService } from '../services/settings.service';
import { ShortcutsService } from '../services/shortcuts.service';
import { HierarchyComponent } from '../panels/hierarchy/hierarchy.component';
import { InspectorComponent } from '../panels/inspector/inspector.component';
import { ProjectComponent } from '../panels/project/project.component';
import { ConsoleComponent } from '../panels/console/console.component';
import { IconComponent } from '../icon.component';
import { TPipe } from '../i18n/t.pipe';
import { ToolbarComponent } from './toolbar.component';
import { StatusbarComponent } from './statusbar.component';

/**
 * The editing screen: toolbar, the four panes with their splitters, the 3D
 * viewport, and the status bar.
 *
 * @remarks
 * Owns the viewport's lifetime. The WebGL context exists only while this
 * component does, so leaving the workspace releases it instead of leaking one
 * per project opened.
 */
@Component({
    selector: 'app-workspace',
    standalone: true,
    imports: [
        HierarchyComponent, InspectorComponent, ProjectComponent, ConsoleComponent,
        IconComponent, ToolbarComponent, StatusbarComponent, TPipe,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { style: 'display: contents' },
    template: `
        <app-toolbar></app-toolbar>

        <section class="work"
            [style.--left-w.px]="layout.leftW()"
            [style.--right-w.px]="layout.rightW()"
            [style.--bottom-h.px]="layout.bottomH()"
        >
            <aside class="pane left">
                <div class="pane-tabs">
                    <div class="pane-tab active">≡ {{ 'panel.hierarchy' | t }}</div>
                    <div class="pane-tab-actions">
                        <button class="pane-btn" [title]="'panel.lock' | t">🔒</button>
                        <button class="pane-btn" [title]="'panel.menu' | t">
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
                    <div class="pane-tab active">◉ {{ 'panel.scene' | t }}</div>
                </div>
                <div class="pane-body">
                    <div class="viewport-wrap">

                        <!-- Sub-toolbar above the canvas -->
                        <div class="vp-subtoolbar">
                            <button class="chip" [title]="'vp.pivot' | t">
                                <wets-icon name="pivot"></wets-icon>
                                <span>{{ 'vp.pivot' | t }}</span>
                                <span class="caret">▾</span>
                            </button>
                            <button class="chip" [title]="'vp.localSpace' | t">
                                <wets-icon name="globe"></wets-icon>
                                <span>{{ 'vp.local' | t }}</span>
                                <span class="caret">▾</span>
                            </button>
                            <button class="chip" [title]="'vp.snap' | t">
                                <wets-icon name="magnet"></wets-icon>
                                <span>{{ settings.gridSnap() > 0 ? settings.gridSnap() : '–' }}</span>
                            </button>
                            <div class="vp-sep"></div>
                            <button class="chip active" [title]="'vp.shaded' | t">
                                <wets-icon name="shaded"></wets-icon>
                            </button>
                            <button class="chip" [title]="'vp.lighting' | t"><wets-icon name="light"></wets-icon></button>
                            <button class="chip" [title]="'vp.audio' | t"><wets-icon name="audio-fx"></wets-icon></button>
                            <button class="chip" [title]="'vp.effects' | t"><wets-icon name="cog"></wets-icon></button>
                            <button class="chip" [title]="'vp.gizmos' | t"><wets-icon name="gizmo"></wets-icon></button>
                            <div class="vp-spacer"></div>
                            <button class="chip" [title]="'vp.visibility' | t"><wets-icon name="eye"></wets-icon></button>
                        </div>

                        <div class="vp-canvas">
                            <canvas #viewportCanvas></canvas>

                            <!-- Floating vertical tool palette (Unity-style) -->
                            <aside class="tool-palette">
                                <button class="tool-btn" [title]="'vp.hand' | t" disabled>
                                    <wets-icon name="hand"></wets-icon>
                                </button>
                                <button class="tool-btn"
                                    [class.active]="viewport.tool() === 'translate'"
                                    (click)="viewport.setTool('translate')" [title]="'vp.move' | t">
                                    <wets-icon name="translate"></wets-icon>
                                </button>
                                <button class="tool-btn"
                                    [class.active]="viewport.tool() === 'rotate'"
                                    (click)="viewport.setTool('rotate')" [title]="'vp.rotate' | t">
                                    <wets-icon name="rotate"></wets-icon>
                                </button>
                                <button class="tool-btn"
                                    [class.active]="viewport.tool() === 'scale'"
                                    (click)="viewport.setTool('scale')" [title]="'vp.scale' | t">
                                    <wets-icon name="scale"></wets-icon>
                                </button>
                                <button class="tool-btn" [title]="'vp.rect' | t" disabled>
                                    <wets-icon name="rect"></wets-icon>
                                </button>
                                <button class="tool-btn" [title]="'vp.combined' | t" disabled>
                                    <wets-icon name="transform-combo"></wets-icon>
                                </button>
                            </aside>

                            <div class="vp-overlay-tl">
                                <div class="chip">
                                    <span class="k">{{ 'vp.tool' | t }}</span>
                                    <span class="v">{{ TOOL_LABEL[viewport.tool()] | t }}</span>
                                </div>
                                <div class="chip">
                                    <span class="k">{{ 'vp.shortcuts' | t }}</span>
                                    <span class="v">W · E · R · Del · Alt+Shift+N</span>
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
                    <div class="pane-tab active">☰ {{ 'panel.inspector' | t }}</div>
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
                        <span>{{ 'panel.project' | t }}</span>
                    </div>
                    <div class="pane-tab"
                        [class.active]="bottomTab() === 'console'"
                        (click)="bottomTab.set('console')"
                    >
                        <wets-icon name="cog"></wets-icon>
                        <span>{{ 'panel.console' | t }}</span>
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
                        <app-project (openEntry)="cmd.openProjectEntry($event)"></app-project>
                    } @else {
                        <app-console></app-console>
                    }
                </div>
            </section>
        </section>

        <app-statusbar></app-statusbar>
    `,
})
export class WorkspaceComponent implements AfterViewInit, OnDestroy {

    @ViewChild('viewportCanvas', { static: true })
    private readonly _canvasRef!: ElementRef<HTMLCanvasElement>;

    /** Message key for each tool's name, so a typo in one does not compile. */
    public readonly TOOL_LABEL: Record<GizmoMode, MessageKey> = {
        translate: 'tool.translate',
        rotate: 'tool.rotate',
        scale: 'tool.scale',
    };

    public readonly viewport = inject(ViewportService);
    public readonly layout = inject(LayoutService);
    public readonly settings = inject(SettingsService);
    public readonly cmd = inject(CommandsService);
    public readonly consoleService = inject(ConsoleService);
    private readonly _shortcuts = inject(ShortcutsService);
    private readonly _history = inject(HistoryService);
    private readonly _selection = inject(SelectionService);

    /** Active bottom pane tab. */
    public readonly bottomTab = signal<'project' | 'console'>('project');

    /** Active splitter while dragging — drives the dragging-state highlight. */
    public readonly dragAxis = signal<'left' | 'right' | 'bottom' | null>(null);

    constructor() {
        // End the current "edit session" whenever the selection changes, so the
        // next field edit starts a fresh undo entry.
        effect(() => {
            this._selection.selected();
            this._history.commitPendingEdit();
        });
    }

    ngAfterViewInit(): void {
        this.viewport.attach(this._canvasRef.nativeElement);
        this._shortcuts.attach();
    }

    ngOnDestroy(): void {
        this._shortcuts.detach();
        this.viewport.detach();
    }

    public onSplitterDown(e: PointerEvent, axis: 'left' | 'right' | 'bottom'): void {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        this.dragAxis.set(axis);
        document.body.classList.add('resizing');
        document.body.style.cursor = axis === 'bottom' ? 'row-resize' : 'col-resize';

        const startLeft = this.layout.leftW();
        const startRight = this.layout.rightW();
        const startBottom = this.layout.bottomH();
        const startX = e.clientX;
        const startY = e.clientY;

        const move = (ev: PointerEvent): void => {
            if (axis === 'left') {
                this.layout.setLeft(startLeft + (ev.clientX - startX));
            } else if (axis === 'right') {
                // Dragging left makes the right pane wider.
                this.layout.setRight(startRight - (ev.clientX - startX));
            } else {
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
}
