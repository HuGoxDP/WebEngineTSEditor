import {
    ChangeDetectionStrategy,
    Component,
    EventEmitter,
    OnDestroy,
    Output,
    computed,
    effect,
    inject,
    signal,
    untracked,
} from '@angular/core';
import { IconComponent } from '../../icon.component';
import { ContextMenuComponent, type CtxItem } from '../../context-menu/context-menu.component';
import { ProjectService, type ProjectEntry } from '../../services/project.service';

/** Images above this size are not decoded just to draw a 52px thumbnail. */
const THUMB_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Bottom Project pane — Unity-style asset browser over the open project folder.
 *
 * @remarks
 * Shows what is actually on the user's disk, through {@link ProjectService}:
 * a folder tree on the left, breadcrumbs and a grid of the current folder on
 * the right. Files can be dropped in from the OS; a scene opens on double-click.
 */
@Component({
    selector: 'app-project',
    standalone: true,
    imports: [IconComponent, ContextMenuComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @switch (project.status()) {
            @case ('unsupported') {
                <div class="proj-empty">
                    <div class="title">Project folders are not available in this browser</div>
                    <div class="hint">
                        The editor keeps projects on your computer, which needs Chrome or Edge
                        and a page opened over HTTPS or from localhost.
                    </div>
                </div>
            }
            @case ('closed') {
                <div class="proj-empty">
                    <div class="title">No project open</div>
                    <div class="hint">
                        A project is a folder on your computer. Nothing is uploaded
                        until you publish a scenario.
                    </div>
                    <button class="proj-btn primary" (click)="onOpenProject()">
                        <wets-icon name="folder"></wets-icon>
                        <span>Open project folder…</span>
                    </button>
                </div>
            }
            @case ('needs-permission') {
                <div class="proj-empty">
                    <div class="title">{{ project.name() }}</div>
                    <div class="hint">The browser asks for access to the folder again after a reload.</div>
                    <div class="row">
                        <button class="proj-btn primary" (click)="onReconnect()">
                            <wets-icon name="folder"></wets-icon>
                            <span>Reconnect</span>
                        </button>
                        <button class="proj-btn" (click)="onOpenProject()">Open another folder…</button>
                    </div>
                </div>
            }
            @case ('open') {
                <div class="proj">
                    <div class="folders">
                        <div class="folder-group">PROJECT</div>
                        @for (f of project.folders(); track f.path) {
                            <div class="folder"
                                [class.active]="active() === f.path"
                                [style.padding-left.px]="8 + f.depth * 14"
                                (click)="navigate(f.path)"
                            >
                                <wets-icon name="folder"></wets-icon>
                                <span>{{ f.name }}</span>
                            </div>
                        }
                    </div>

                    <div class="files"
                        [class.drop]="dropping()"
                        (dragover)="onDragOver($event)"
                        (dragleave)="dropping.set(false)"
                        (drop)="onDrop($event)"
                        (contextmenu)="onContextMenu($event, null)"
                    >
                        <div class="crumbs">
                            @for (c of crumbs(); track c.path; let last = $last) {
                                <span class="c" [class.here]="last" (click)="navigate(c.path)">{{ c.label }}</span>
                                @if (!last) { <span class="sep">›</span> }
                            }
                            <span class="counter">{{ entries().length }} items</span>
                            <button class="proj-btn icon" title="New folder" (click)="onNewFolder()">
                                <wets-icon name="plus"></wets-icon>
                            </button>
                            <button class="proj-btn icon" title="Import files into this folder" (click)="picker.click()">
                                <wets-icon name="file-new"></wets-icon>
                            </button>
                            <button class="proj-btn icon" title="Refresh from disk" (click)="project.refresh()">
                                <wets-icon name="reset"></wets-icon>
                            </button>
                            <input #picker type="file" multiple hidden (change)="onPicked(picker)">
                        </div>

                        <div class="grid">
                            @for (a of entries(); track a.path) {
                                <div class="asset"
                                    [class.selected]="selected() === a.path"
                                    [class.current]="project.scenePath() === a.path"
                                    [title]="a.path"
                                    (click)="selected.set(a.path)"
                                    (dblclick)="onOpenEntry(a)"
                                    (contextmenu)="onContextMenu($event, a)"
                                >
                                    <div class="thumb" [class]="'thumb ' + a.kind">
                                        @if (thumbs()[a.path]; as url) {
                                            <img [src]="url" alt="" draggable="false">
                                        } @else {
                                            <wets-icon [name]="iconOf(a)"></wets-icon>
                                        }
                                    </div>
                                    <span class="label">{{ a.name }}</span>
                                </div>
                            }
                            @if (entries().length === 0) {
                                <div class="empty-grid">
                                    Empty folder — drop files here.
                                    @if (active() === '' && !isLaidOut()) {
                                        <div class="row">
                                            <button class="proj-btn" (click)="onInitialize()">Set up as a scenario project</button>
                                        </div>
                                    }
                                </div>
                            }
                        </div>
                    </div>
                </div>
            }
        }

        @if (ctxOpen()) {
            <ctx-menu
                [items]="ctxItems()"
                [x]="ctxX()"
                [y]="ctxY()"
                (closed)="ctxOpen.set(false)"
            ></ctx-menu>
        }
    `,
})
export class ProjectComponent implements OnDestroy {

    public readonly project = inject(ProjectService);

    /** A file the user asked to open — the shell decides what opening means. */
    @Output() public readonly openEntry = new EventEmitter<ProjectEntry>();

    /** Folder shown in the grid, project-relative. `''` is the root. */
    public readonly active = signal<string>('');
    public readonly selected = signal<string | null>(null);
    public readonly dropping = signal(false);

    public readonly ctxOpen = signal(false);
    public readonly ctxItems = signal<CtxItem[]>([]);
    public readonly ctxX = signal(0);
    public readonly ctxY = signal(0);

    /** Object URLs for the image files in the current folder, by path. */
    public readonly thumbs = signal<Record<string, string>>({});

    public readonly entries = computed<ProjectEntry[]>(() => {
        this.project.revision();
        return this.project.list(this.active());
    });

    public readonly crumbs = computed(() => {
        const out = [{ label: this.project.name(), path: '' }];
        let path = '';
        for (const part of this.active().split('/').filter(Boolean)) {
            path = path ? `${path}/${part}` : part;
            out.push({ label: part, path });
        }
        return out;
    });

    /** Whether the folder already has the layout ScenarioCreator builds from. */
    public readonly isLaidOut = computed(() => {
        this.project.revision();
        return this.project.exists('scripts');
    });

    constructor() {
        // The folder being viewed can disappear underneath us — deleted here,
        // or outside the editor and noticed on refresh.
        effect(() => {
            this.project.revision();
            if (!this.project.exists(this.active())) this.active.set('');
        });

        // untracked: with nothing to read, _loadThumbs runs synchronously to the
        // point where it reads and writes `thumbs`, which would make this effect
        // depend on the signal it sets.
        effect(() => {
            const entries = this.entries();
            untracked(() => void this._loadThumbs(entries));
        });
    }

    ngOnDestroy(): void {
        this._revokeThumbs(this.thumbs());
    }

    public navigate(path: string): void {
        this.active.set(path);
        this.selected.set(null);
    }

    public iconOf(entry: ProjectEntry): string {
        switch (entry.kind) {
            case 'folder':   return 'folder';
            case 'script':   return 'cog';
            case 'mesh':     return 'mesh';
            case 'tex':      return 'box';
            case 'audio':    return 'audio-fx';
            case 'scene':    return 'globe';
            case 'prefab':   return 'gameobject';
            case 'material': return 'shaded';
            default:         return 'file-new';
        }
    }

    public onOpenEntry(entry: ProjectEntry): void {
        if (entry.kind === 'folder') this.navigate(entry.path);
        else this.openEntry.emit(entry);
    }

    // ── Project actions ──────────────────────────────────────────────

    public onOpenProject(): void {
        this._run(async () => { await this.project.open(); this.navigate(''); });
    }

    public onReconnect(): void {
        this._run(() => this.project.reconnect());
    }

    public onInitialize(): void {
        this._run(() => this.project.initializeLayout());
    }

    public onNewFolder(): void {
        const name = prompt('Folder name', 'New Folder')?.trim();
        if (!name) return;
        if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
            alert(`"${name}" is not a valid folder name.`);
            return;
        }
        this._run(() => this.project.createFolder(this._join(name)));
    }

    public onPicked(input: HTMLInputElement): void {
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length > 0) this._run(() => this.project.importFiles(this.active(), files));
    }

    public onDelete(entry: ProjectEntry): void {
        const what = entry.kind === 'folder' ? 'folder and everything in it' : 'file';
        if (!confirm(`Delete the ${what} "${entry.path}" from disk? This cannot be undone.`)) return;
        this.selected.set(null);
        this._run(() => this.project.remove(entry.path));
    }

    // ── Drag and drop from the OS ────────────────────────────────────

    public onDragOver(e: DragEvent): void {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.dropping.set(true);
    }

    public onDrop(e: DragEvent): void {
        e.preventDefault();
        this.dropping.set(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) this._run(() => this.project.importFiles(this.active(), files));
    }

    // ── Context menu ─────────────────────────────────────────────────

    public onContextMenu(e: MouseEvent, entry: ProjectEntry | null): void {
        e.preventDefault();
        e.stopPropagation();
        if (entry) this.selected.set(entry.path);

        const items: CtxItem[] = [];
        if (entry) {
            items.push({ label: 'Open', action: () => this.onOpenEntry(entry) });
            items.push({ label: 'Delete', action: () => this.onDelete(entry) });
            items.push({ separator: true, label: null });
        }
        items.push({ label: 'New Folder', action: () => this.onNewFolder() });
        items.push({ label: 'Refresh', action: () => void this.project.refresh() });
        items.push({ separator: true, label: null });
        items.push({ label: 'Open Another Project…', action: () => this.onOpenProject() });
        items.push({ label: 'Close Project', action: () => void this.project.close() });

        this.ctxItems.set(items);
        this.ctxX.set(e.clientX);
        this.ctxY.set(e.clientY);
        this.ctxOpen.set(true);
    }

    // ── internal ─────────────────────────────────────────────────────

    private _join(name: string): string {
        const base = this.active();
        return base ? `${base}/${name}` : name;
    }

    /** Disk operations fail for ordinary reasons (permission revoked, file locked) — say so. */
    private _run(action: () => Promise<unknown>): void {
        action().catch(err => {
            console.error('[Project]', err);
            alert(`Project: ${(err as Error)?.message ?? err}`);
        });
    }

    private _thumbRun = 0;

    private async _loadThumbs(entries: ProjectEntry[]): Promise<void> {
        const run = ++this._thumbRun;
        const next: Record<string, string> = {};

        for (const entry of entries) {
            // KTX2 is a texture, but not one an <img> can show.
            if (entry.kind !== 'tex' || entry.name.toLowerCase().endsWith('.ktx2')) continue;
            try {
                const file = await this.project.readFile(entry.path);
                if (file.size <= THUMB_MAX_BYTES) next[entry.path] = URL.createObjectURL(file);
            } catch {
                // Unreadable right now: the icon stays.
            }
        }

        // A newer listing started while this one was reading — its URLs win.
        if (run !== this._thumbRun) {
            this._revokeThumbs(next);
            return;
        }
        const previous = this.thumbs();
        this.thumbs.set(next);
        this._revokeThumbs(previous);
    }

    private _revokeThumbs(urls: Record<string, string>): void {
        for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    }
}
