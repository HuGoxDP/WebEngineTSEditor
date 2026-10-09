import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HistoryService } from './history.service';
import { PlayModeService } from './play-mode.service';
import { ProjectService } from './project.service';
import { SceneService } from './scene.service';
import { SettingsService } from './settings.service';

/** Where the recovery copy lives, inside the project. Hidden from the Project panel (dot folders are) and from builds. */
const AUTOSAVE_FILE = '.editor/autosave.scene.json';

const DEFAULT_AUTOSAVE_MS = 60_000;

/**
 * The state of the scene being edited relative to what is on disk.
 *
 * @remarks
 * Answers "has anything changed since the last save?" truthfully, and keeps the
 * three safety nets that follow from it: the recovery copy written while there
 * are unsaved changes, the browser's warning on closing the tab, and a lock so
 * one project is not edited from two tabs, each overwriting the other.
 *
 * It holds only state and timers. The dialogs that ask what to do about it live
 * in `CommandsService`, which also does the saving — this service is told when a
 * save or a load has happened, and never writes the scene file itself.
 */
@Injectable({ providedIn: 'root' })
export class DocumentService {

    private readonly _history = inject(HistoryService);
    private readonly _project = inject(ProjectService);
    private readonly _scene = inject(SceneService);
    private readonly _settings = inject(SettingsService);
    private readonly _play = inject(PlayModeService);

    /** `HistoryService.revision` at the last save or load. */
    private readonly _savedRevision = signal(0);

    /** True when the scene differs from the file it came from, or has none yet. */
    public readonly dirty = computed(() =>
        this._project.isOpen() && this._history.revision() !== this._savedRevision());

    /** When the scene was last written by this editor, or null if not in this session. */
    public readonly lastSavedAt = signal<number | null>(null);

    /** Modified time of the scene file as this editor last read or wrote it. */
    private _stamp: number | null = null;
    private _releaseLock: (() => void) | null = null;

    constructor() {
        // The tab title says so too: it is what a person sees in the tab strip, and
        // what the browser's close warning is about.
        effect(() => {
            document.title = this._project.isOpen()
                ? `${this.dirty() ? '● ' : ''}${this._project.name()} — WETS`
                : 'WETS · Editor';
        });

        window.addEventListener('beforeunload', e => {
            if (!this.dirty()) return;
            e.preventDefault();
            e.returnValue = '';   // required by some browsers for the prompt to show
        });

        // The interval is a knob for the automated check, which cannot wait a minute.
        const override = Number(localStorage.getItem('wets:debug:autosaveMs'));
        setInterval(() => void this.autosaveNow(), override > 0 ? override : DEFAULT_AUTOSAVE_MS);
    }

    // ── Telling it what happened ─────────────────────────────────────

    /**
     * The scene was written to `path`.
     *
     * @param revision - `HistoryService.revision` read *before* the scene was
     *   serialized. Edits made while the write was in flight are not in the file,
     *   so they must stay "unsaved".
     */
    public async noteSaved(path: string, revision: number): Promise<void> {
        this._savedRevision.set(revision);
        this.lastSavedAt.set(Date.now());
        this._stamp = await this._project.modifiedAt(path).catch(() => null);
        await this.discardAutosave();
    }

    /** The scene was read from `path` exactly as it is on disk. */
    public async noteLoaded(path: string): Promise<void> {
        this.markClean();
        this._stamp = await this._project.modifiedAt(path).catch(() => null);
    }

    /** The scene is empty and tied to no file — a new scene, or a project just opened. */
    public noteBlank(): void {
        this.markClean();
        this._stamp = null;
    }

    private markClean(): void {
        this._savedRevision.set(this._history.revision());
    }

    // ── Recovery copy ────────────────────────────────────────────────

    /** No autosave before this time (ms since the epoch). Set when the user gives their changes up. */
    private _quietUntil = 0;

    /**
     * The user chose not to keep the unsaved changes. Deletes the recovery copy
     * and keeps the timer from writing it again in the moments before the caller
     * replaces the scene — the scene is still "unsaved" until then.
     */
    public async abandonChanges(): Promise<void> {
        this._quietUntil = Date.now() + 5000;
        await this.discardAutosave();
    }

    /** Writes the recovery copy now, if there is anything unsaved to protect. */
    public async autosaveNow(): Promise<void> {
        // Play mode changes the scene to simulate it and puts it back on stop; what
        // is on screen during play is not work.
        if (!this._settings.autosave() || !this.dirty() || this._play.isPlaying()) return;
        if (Date.now() < this._quietUntil) return;
        try {
            await this._project.write(AUTOSAVE_FILE, JSON.stringify(this._scene.serialize()), false);
        } catch (err) {
            console.warn('[Editor] Autosave failed', err);
        }
    }

    /**
     * The recovery copy's text, if it holds work the scene file does not — that
     * is, it is newer than the scene. An older one is a leftover and is removed.
     */
    public async recoverableText(scenePath: string): Promise<string | null> {
        const autosaved = await this._project.modifiedAt(AUTOSAVE_FILE);
        if (autosaved === null) return null;

        const saved = await this._project.modifiedAt(scenePath);
        if (saved !== null && saved >= autosaved) {
            await this.discardAutosave();
            return null;
        }
        try {
            return await this._project.readText(AUTOSAVE_FILE);
        } catch {
            return null;
        }
    }

    /** Deletes the recovery copy. Called once its contents are saved, or deliberately given up. */
    public async discardAutosave(): Promise<void> {
        try {
            await this._project.removeQuietly(AUTOSAVE_FILE);
        } catch {
            // Nothing to delete, or it is locked; the next save removes it.
        }
    }

    // ── One tab per project ──────────────────────────────────────────

    /**
     * Takes the project's lock. False if another tab already holds it.
     *
     * Two tabs editing one folder overwrite each other's saves without either
     * noticing. The lock belongs to the tab and is released when it closes, so a
     * crashed tab cannot keep a project locked.
     */
    public acquireLock(projectId: string): Promise<boolean> {
        this.releaseLock();
        if (!navigator.locks) return Promise.resolve(true);
        return new Promise(resolve => {
            void navigator.locks.request(`wets:project:${projectId}`, { ifAvailable: true }, lock => {
                if (!lock) {
                    resolve(false);
                    return;
                }
                resolve(true);
                // The lock is held for as long as this promise is pending.
                return new Promise<void>(release => { this._releaseLock = release; });
            });
        });
    }

    public releaseLock(): void {
        this._releaseLock?.();
        this._releaseLock = null;
    }

    // ── Changes made outside the editor ──────────────────────────────

    /** Whether the scene file changed on disk since this editor last read or wrote it. */
    public async changedOnDisk(path: string): Promise<boolean> {
        if (this._stamp === null) return false;
        const now = await this._project.modifiedAt(path).catch(() => null);
        return now !== null && now !== this._stamp;
    }

    /** The disk version was seen and the user kept their own: stop asking about it. */
    public async acceptDiskVersion(path: string): Promise<void> {
        this._stamp = await this._project.modifiedAt(path).catch(() => null);
    }
}
