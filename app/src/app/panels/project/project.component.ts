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
import { CommandsService } from '../../services/commands.service';
import { ProjectService, type ProjectEntry } from '../../services/project.service';
import { SettingsService } from '../../services/settings.service';
import { DialogService } from '../../dialogs/dialog.service';
import { I18nService } from '../../i18n/i18n.service';
import { TPipe } from '../../i18n/t.pipe';

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
    imports: [IconComponent, ContextMenuComponent, TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @switch (project.status()) {
            @case ('unsupported') {
                <div class="proj-empty">
                    <div class="title">{{ 'proj.unsupportedTitle' | t }}</div>
                    <div class="hint">{{ 'proj.unsupportedHint' | t }}</div>
                </div>
            }
            @case ('closed') {
                <div class="proj-empty">
                    <div class="title">{{ 'proj.noneTitle' | t }}</div>
                    <div class="hint">{{ 'proj.noneHint' | t }}</div>
                    <button class="proj-btn primary" (click)="onOpenProject()">
                        <wets-icon name="folder"></wets-icon>
                        <span>{{ 'proj.openFolder' | t }}</span>
                    </button>
                </div>
            }
            @case ('needs-permission') {
                <div class="proj-empty">
                    <div class="title">{{ project.name() }}</div>
                    <div class="hint">{{ 'proj.reconnectHint' | t }}</div>
                    <div class="row">
                        <button class="proj-btn primary" (click)="onReconnect()">
                            <wets-icon name="folder"></wets-icon>
                            <span>{{ 'proj.reconnect' | t }}</span>
                        </button>
                        <button class="proj-btn" (click)="onOpenProject()">{{ 'proj.openAnother' | t }}</button>
                    </div>
                </div>
            }
            @case ('open') {
                <div class="proj">
                    <div class="folders">
                        <div class="folder-group">{{ 'proj.section' | t }}</div>
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
                            <span class="counter">{{ itemsLabel() }}</span>
                            <button class="proj-btn icon" [title]="'proj.newFolder' | t" (click)="onNewFolder()">
                                <wets-icon name="plus"></wets-icon>
                            </button>
                            <button class="proj-btn icon" [title]="'proj.import' | t" (click)="picker.click()">
                                <wets-icon name="file-new"></wets-icon>
                            </button>
                            <button class="proj-btn icon" [title]="'proj.refresh' | t" (click)="project.refresh()">
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
                                    {{ 'proj.emptyFolder' | t }}
                                    @if (active() === '' && !isLaidOut()) {
                                        <div class="row">
                                            <button class="proj-btn" (click)="onInitialize()">{{ 'proj.setupLayout' | t }}</button>
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
    private readonly _cmd = inject(CommandsService);
    private readonly _dialog = inject(DialogService);
    private readonly _settings = inject(SettingsService);
    private readonly _i18n = inject(I18nService);

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

    public readonly itemsLabel = computed(() => this._i18n.tp('proj.items', this.entries().length));

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
        this._cmd.run(async () => { await this.project.open(); this.navigate(''); });
    }

    public onReconnect(): void {
        this._cmd.run(() => this.project.reconnect());
    }

    public onInitialize(): void {
        this._cmd.run(() => this.project.initializeLayout());
    }

    public async onNewFolder(): Promise<void> {
        const name = await this._dialog.prompt({
            title: this._i18n.t('proj.folderTitle'),
            label: this._i18n.t('proj.folderLabel'),
            value: this._i18n.t('proj.folderDefault'),
            confirmLabel: this._i18n.t('proj.create'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            validate: v => /[\\/:*?"<>|]/.test(v) || v === '.' || v === '..'
                ? this._i18n.t('proj.invalidName', { name: v })
                : null,
        });
        if (name === null) return;
        this._cmd.run(() => this.project.createFolder(this._join(name)));
    }

    public onPicked(input: HTMLInputElement): void {
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length > 0) this._cmd.run(() => this.project.importFiles(this.active(), files));
    }

    public async onDelete(entry: ProjectEntry): Promise<void> {
        if (this._settings.confirmDelete()) {
            const sure = await this._dialog.confirm({
                title: this._i18n.t('proj.deleteTitle'),
                message: this._i18n.t(entry.kind === 'folder' ? 'proj.deleteFolder' : 'proj.deleteFile', { path: entry.path }),
                confirmLabel: this._i18n.t('proj.delete'),
                cancelLabel: this._i18n.t('dialog.cancel'),
                danger: true,
            });
            if (!sure) return;
        }
        this.selected.set(null);
        this._cmd.run(() => this.project.remove(entry.path));
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
        if (files.length > 0) this._cmd.run(() => this.project.importFiles(this.active(), files));
    }

    // ── Context menu ─────────────────────────────────────────────────

    public onContextMenu(e: MouseEvent, entry: ProjectEntry | null): void {
        e.preventDefault();
        e.stopPropagation();
        if (entry) this.selected.set(entry.path);

        const t = this._i18n.t.bind(this._i18n);
        const items: CtxItem[] = [];
        if (entry) {
            items.push({ label: t('proj.open'), action: () => this.onOpenEntry(entry) });
            items.push({ label: t('proj.delete'), action: () => void this.onDelete(entry) });
            items.push({ separator: true, label: null });
        }
        items.push({ label: t('proj.newFolderMenu'), action: () => void this.onNewFolder() });
        items.push({ label: t('proj.refreshMenu'), action: () => void this.project.refresh() });
        items.push({ separator: true, label: null });
        items.push({ label: t('proj.openAnotherMenu'), action: () => this.onOpenProject() });
        items.push({ label: t('proj.closeProject'), action: () => this._cmd.closeProject() });

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
