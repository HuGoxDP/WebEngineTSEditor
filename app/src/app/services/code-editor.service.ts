import { Injectable, computed, signal } from '@angular/core';
import { DialogService } from '../dialogs/dialog.service';
import { I18nService } from '../i18n/i18n.service';
import { ProjectService } from './project.service';
import { ScriptRuntimeService } from './script-runtime.service';

/**
 * One file open in the Code tab, and whether its buffer differs from the disk.
 *
 * The editor's dirty state is the *scene's* (`DocumentService`); a script file
 * has its own, because editing a script never makes the scene unsaved — the
 * object graph did not change, the source did.
 */
export interface CodeFile {
    readonly path: string;
    readonly name: string;
    readonly language: string;
}

/** A script language Monaco knows, by the extension the Project panel shows. */
function languageOf(path: string): string {
    return /\.(ts|tsx)$/i.test(path) ? 'typescript'
        : /\.(js|mjs|cjs)$/i.test(path) ? 'javascript'
        : /\.json$/i.test(path) ? 'json'
        : 'plaintext';
}

@Injectable({ providedIn: 'root' })
export class CodeEditorService {

    /** The file open in the Code tab, or null when none is. */
    public readonly file = signal<CodeFile | null>(null);

    /** Bumped on every buffer change, so the panel re-syncs the untitled mark. */
    public readonly revision = computed(() => this._revision());
    private readonly _revision = signal(0);

    /** Whether the open file's buffer differs from what was last read or saved. */
    public readonly dirty = computed(() => this._dirty());
    private readonly _dirty = signal(false);

    /** What the Code tab shows when no file is open. */
    public readonly empty = computed(() => this.file() === null);

    /**
     * Each script file's `lastModified` as this editor last read or wrote it —
     * the outside-edit baseline (the scene's is `DocumentService`'s stamp).
     * Seeded for every script when a project settles, so a file never opened
     * here is watched too. A file deleted outside loses its entry; the next
     * settle or reload picks up whatever replaced it.
     */
    private readonly _stamps = new Map<string, number>();

    /**
     * Bumped when the open file's buffer was replaced from disk, so the panel
     * re-reads it even though its path did not change (the workspace tracks
     * the path, not the text).
     */
    public readonly diskReload = signal(0);

    public constructor(
        private readonly _project: ProjectService,
        private readonly _runtime: ScriptRuntimeService,
        private readonly _dialog: DialogService,
        private readonly _i18n: I18nService,
    ) {
        window.addEventListener('focus', () => void this.checkOutsideEdits());
    }

    /**
     * Reads `path` into the Code tab. A read failure is reported, not swallowed.
     * Returns false when the author declines to discard a dirty buffer, or the
     * read failed — in both cases the current file and its buffer are untouched.
     */
    public async open(path: string): Promise<boolean> {
        const open = this.file();
        // D2: reopening the file already shown keeps its unsaved buffer — no ask.
        if (open?.path === path) return true;
        // D3: a different file replaces a dirty buffer only after the author agrees.
        if (open && this._dirty()) {
            const discard = await this._dialog.confirm({
                title: this._i18n.t('code.discardTitle'),
                message: this._i18n.t('code.discardMessage', { name: open.name, path }),
                confirmLabel: this._i18n.t('scene.replace'),
                cancelLabel: this._i18n.t('dialog.cancel'),
                danger: true,
            });
            if (!discard) return false;   // declined: no state change at all
        }
        try {
            // The read is the failure check; the panel reads the text again for
            // its model, so the value is deliberately not held here.
            await this._project.readText(path);
        } catch (err) {
            // Through console, which the Console panel captures — so the failure
            // reaches the same place a compile diagnostic will.
            console.error(`[Script] Could not read ${path}: ${String(err)}`);
            return false;
        }
        this.file.set({ path, name: path.slice(path.lastIndexOf('/') + 1), language: languageOf(path) });
        this._dirty.set(false);
        this._revision.update(n => n + 1);
        // D3: a model kept at this path can still hold an older edit (a discard
        // does not dispose it). Force the panel to take the disk text afresh.
        this.diskReload.update(n => n + 1);
        await this._stamp(path);
        return true;
    }

    /**
     * Writes the buffer back through the project store, clears the mark, and
     * hands the saved file to the script runtime — a save is the moment the
     * project's classes change, which is what Unity's "reload on save" means.
     *
     * A file changed outside since the last read is never overwritten without
     * a say: the same question the focus check asks, here before the write.
     *
     * @param current - reads the live buffer after the write. Typing during the
     *   awaited write must keep the file dirty (D5); the panel passes a closure
     *   over its Monaco model, which stays valid even if the editor is disposed.
     */
    public async save(text: string, current?: () => string): Promise<boolean> {
        const file = this.file();
        // A second press while a save is in flight is the same save: the first
        // has the buffer, and letting the second run would see the first's own
        // write as an outside change (C4 review R4). The buffer stays dirty if
        // it moved again, so nothing typed is lost by the skip. A focus check
        // already in flight is the same window from the other side: its
        // per-file reads could see this save's write before the stamp update,
        // so the save stands down until the check is done (C4 review R4-G3).
        if (!file || this._saving || this._checking) return false;
        this._saving = true;
        try {
            if (await this._changedOnDisk(file.path) && !await this._askReplace(file)) return false;
            try {
                await this._project.write(file.path, text);
            } catch (err) {
                console.error(`[Script] Could not save ${file.path}: ${String(err)}`);
                return false;
            }
            // D5: the buffer may have moved while the write was in flight. Clear
            // the mark only when it still equals what was actually written.
            if (current === undefined || current() === text) this._dirty.set(false);
            this._revision.update(n => n + 1);
            await this._stamp(file.path);
            await this._reload();
            return true;
        } finally {
            this._saving = false;
        }
    }

    /** Whether a save is in flight — its own write is not an outside change. */
    private _saving = false;

    /**
     * Compiles, links and loads the project's scripts (the runtime's entry).
     * The runtime has just read every script, so this is also the moment the
     * outside-edit baseline is (re-)seeded for files never opened here.
     */
    public async reloadScripts(): Promise<string[]> {
        const notes = await this._reload();
        // The baseline is this project's: a switch must not keep the previous
        // project's stamps, whose same-named paths would read as outside edits
        // (C4 review R4-G3). Every current script is re-seeded just below.
        this._stamps.clear();
        for (const path of await this._runtime.scriptFiles()) await this._stamp(path);
        return notes;
    }

    private async _reload(): Promise<string[]> {
        try {
            return await this._runtime.reload();
        } catch (err) {
            console.error(`[Script] Could not reload scripts: ${String(err)}`);
            return [String(err)];
        }
    }

    /**
     * The file's text as it is on the store — for the panel's model, so the
     * buffer it first shows is what a later save would have replaced.
     */
    public async readText(path: string): Promise<string> {
        return await this._project.readText(path);
    }

    /** Records that the buffer changed. Called by the panel, not by the runtime. */
    public markEdited(): void {
        this._dirty.set(true);
    }

    /**
     * The path of the open file, for a Console row to jump to, or null.
     * A row's line is held by the panel that opened it; the service keeps the
     * target so a click from anywhere can open the file.
     */
    public readonly jumpTo = signal<{ path: string; line: number } | null>(null);

    /** Bumped whenever a Console row asks for a file: the workspace shows the tab. */
    public readonly showRequest = signal(0);

    /**
     * Opens `path` and asks the panel to reveal `line` once it is laid out.
     *
     * The line is kept in `jumpTo` until the panel's mount consumes it, so a
     * click from the Console works whether or not the Code tab was open.
     */
    public async reveal(path: string, line: number): Promise<void> {
        // D4: a declined discard leaves the current buffer in place — the jump
        // must not fire either, or the Console would silently switch files.
        if (!await this.open(path)) return;
        this.jumpTo.set({ path, line });
        this.showRequest.update(n => n + 1);
    }

    // ── Changes made outside the editor ──────────────────────────────

    private _checking = false;

    /**
     * When the window regains focus, looks for changes made to the project's
     * scripts outside the editor — the scene's question is `CommandsService`'s.
     * A clean buffer reloads quietly; a dirty one is asked, and "keep mine"
     * takes the disk stamp so the same change is not asked about again. Any
     * change costs one reload: the runtime re-reads every script itself.
     */
    public async checkOutsideEdits(): Promise<void> {
        if (!this._project.isOpen() || this._checking || this._saving || this._dialog.isOpen()) return;
        this._checking = true;
        try {
            const changed: string[] = [];
            const gone: string[] = [];
            for (const path of await this._runtime.scriptFiles()) {
                if (await this._changedOnDisk(path)) changed.push(path);
            }
            // A script deleted outside loses its stamp too; its class must not
            // stay linked against a file the project no longer has.
            for (const path of [...this._stamps.keys()]) {
                if (changed.includes(path)) continue;
                if (await this._project.modifiedAt(path).catch(() => null) === null) gone.push(path);
            }
            for (const path of gone) this._stamps.delete(path);
            const open = this.file();
            if (open && changed.includes(open.path)) {
                if (this._dirty()) {
                    const reload = await this._dialog.confirm({
                        title: this._i18n.t('disk.changedTitle', { name: open.name }),
                        message: this._i18n.t('code.changedMessage'),
                        confirmLabel: this._i18n.t('disk.reload'),
                        cancelLabel: this._i18n.t('disk.keepMine'),
                        danger: true,
                    });
                    if (!reload) {
                        await this._stamp(open.path);   // seen and kept: stop asking
                    } else {
                        await this._stamp(open.path);
                        this._dirty.set(false);
                        this.diskReload.update(n => n + 1);   // the panel re-reads the model
                    }
                } else {
                    await this._stamp(open.path);
                    this.diskReload.update(n => n + 1);
                }
            }
            if (changed.length > 0 || gone.length > 0) await this.reloadScripts();
        } catch (err) {
            console.warn('[Script] Could not check the scripts for outside changes', err);
        } finally {
            this._checking = false;
        }
    }

    /** Records the file's disk time as the baseline — what a read or write saw. */
    private async _stamp(path: string): Promise<void> {
        const at = await this._project.modifiedAt(path).catch(() => null);
        if (at === null) this._stamps.delete(path);
        else this._stamps.set(path, at);
    }

    /** Whether the file changed on disk since this editor last read or wrote it. */
    private async _changedOnDisk(path: string): Promise<boolean> {
        const now = await this._project.modifiedAt(path).catch(() => null);
        if (now === null) return false;
        const stamp = this._stamps.get(path);
        // A listed script with no stamp is new to this editor — written into
        // the project folder from outside. It has never been read or compiled
        // here, so its class is not registered yet: treat it as changed so the
        // focus check reloads the project and offers the class (C4r18). Stamped
        // files keep the old "differs from the baseline" answer.
        return stamp === undefined || now !== stamp;
    }

    /**
     * Save's question when the file changed outside: replace it, or leave it.
     * Refused, the save is aborted — the buffer stays dirty and the disk file
     * is what the outside edit made it.
     */
    private async _askReplace(file: CodeFile): Promise<boolean> {
        return this._dialog.confirm({
            title: this._i18n.t('code.overwriteTitle'),
            message: this._i18n.t('code.overwriteMessage', { path: file.path }),
            confirmLabel: this._i18n.t('scene.replace'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            danger: true,
        });
    }
}
