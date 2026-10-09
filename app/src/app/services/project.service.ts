import { Injectable, computed, signal } from '@angular/core';
import { defaultMeta, metaJson, SCENARIO_TEMPLATE, type ProjectMeta } from './project-templates';

/** What a file is, as far as the Project panel cares — drives icon and double-click. */
export type ProjectEntryKind =
    | 'folder' | 'scene' | 'prefab' | 'material' | 'script'
    | 'mesh' | 'tex' | 'audio' | 'file';

/** One file or folder inside the open project. */
export interface ProjectEntry {
    name: string;
    /** Slash-separated, relative to the project root. Never starts with a slash. */
    path: string;
    kind: ProjectEntryKind;
}

/** A folder row for the tree on the left of the Project panel. */
export interface ProjectFolder {
    name: string;
    path: string;
    depth: number;
}

/** Where the open-project state stands. */
export type ProjectStatus =
    /** The browser has no File System Access API (not Chromium, or not HTTPS / localhost). */
    | 'unsupported'
    /** Nothing open. */
    | 'closed'
    | 'open';

/** What a folder the user picked turned out to be. */
export type FolderKind =
    /** Has `scenario.meta.json` — a scenario project. */
    | 'project'
    /** Nothing in it. */
    | 'empty'
    /** Has files, but is not a project. */
    | 'foreign';

/** A project the user opened before, remembered across sessions. */
export interface RecentProject {
    id: string;
    name: string;
    /** `Date.now()` of the last time it was opened. */
    openedAt: number;
    handle: ProjectFolderHandle;
}

/** How a recent project's reopening went. */
export type ReopenResult = 'ok' | 'denied' | 'missing';

// The File System Access API is not in TypeScript's DOM lib beyond the basics,
// so the handful of members used here are declared rather than pulled in as a
// dependency.
interface PermissionCapable {
    queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
export type ProjectFolderHandle = FileSystemDirectoryHandle & PermissionCapable & {
    values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
};
type DirHandle = ProjectFolderHandle;
type PickerWindow = Window & {
    showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandle>;
};

/** Folders that are build output or tooling, never project content. */
const HIDDEN = new Set(['node_modules', 'dist', 'lods']);

/** A project that large is not a scenario; stop rather than hang the tab. */
const MAX_ENTRIES = 5000;

const DB_NAME = 'wets-editor';
/** Folder handles of recently opened projects, keyed by id. */
const RECENTS = 'recents';
/** How many recent projects are kept. */
const MAX_RECENTS = 10;

/**
 * The scenario project open in the editor — a folder on the user's own disk.
 *
 * @remarks
 * Nothing about a project is stored on the server: the platform keeps published
 * scenarios only. The folder is reached through the browser's File System
 * Access API, which is why this needs a Chromium-based browser on HTTPS or
 * localhost. Opened folders are remembered in IndexedDB as a list of recent
 * projects. After a reload the browser wants a click before it grants a folder
 * again, so a project is never opened on its own: the start screen lists them
 * and {@link openRecent} runs from the click.
 *
 * The folder has the layout ScenarioCreator builds from
 * (`scripts/`, `assets/`, `scenario.meta.json`), so a project authored here is
 * buildable there without conversion.
 */
@Injectable({ providedIn: 'root' })
export class ProjectService {

    public readonly status = signal<ProjectStatus>('closed');

    /** Folder name of the open (or remembered) project. */
    public readonly name = signal<string>('');

    /** Every folder, depth-first, for the tree. The root is `path: ''`. */
    public readonly folders = signal<ProjectFolder[]>([]);

    /** Bumped after every rescan, so views recompute. */
    public readonly revision = signal(0);

    /** Project-relative path of the scene being edited, once it has one. */
    public readonly scenePath = signal<string | null>(null);

    public readonly isOpen = computed(() => this.status() === 'open');

    /** Identity of the open project, stable across sessions. Empty while none is open. */
    public readonly projectId = signal('');

    /** Recently opened projects, newest first. */
    public readonly recents = signal<RecentProject[]>([]);

    private _root: DirHandle | null = null;
    private _children = new Map<string, ProjectEntry[]>();

    constructor() {
        if (!(window as PickerWindow).showDirectoryPicker) {
            this.status.set('unsupported');
            return;
        }
        void this.loadRecents();
    }

    // ── Choosing a folder ────────────────────────────────────────────

    /** Shows the folder picker. Resolves null if the user cancels. Opens nothing by itself. */
    public async pickFolder(): Promise<ProjectFolderHandle | null> {
        const host = window as PickerWindow;
        if (!host.showDirectoryPicker) return null;
        try {
            return await host.showDirectoryPicker({ id: 'wets-project', mode: 'readwrite' });
        } catch (err) {
            // AbortError is the user closing the dialog, not a failure.
            if ((err as DOMException)?.name === 'AbortError') return null;
            throw err;
        }
    }

    /** Whether a folder is already a project, empty, or something else. */
    public async inspect(handle: ProjectFolderHandle): Promise<FolderKind> {
        const children = await listDir(handle);
        if (children.some(c => c.kind === 'file' && c.name === 'scenario.meta.json')) return 'project';
        return children.length > 0 ? 'foreign' : 'empty';
    }

    /**
     * Whether a project could be created as `name` inside `parent`: `free` if
     * nothing is there, `taken` if a non-empty folder or a file already is.
     * An existing empty folder is fine to use.
     */
    public async folderState(parent: ProjectFolderHandle, name: string): Promise<'free' | 'taken'> {
        try {
            const existing = await parent.getDirectoryHandle(name) as ProjectFolderHandle;
            return (await listDir(existing, 1)).length === 0 ? 'free' : 'taken';
        } catch (err) {
            const kind = (err as DOMException)?.name;
            if (kind === 'NotFoundError') return 'free';
            // A *file* with that name: the folder cannot be made.
            if (kind === 'TypeMismatchError') return 'taken';
            throw err;
        }
    }

    /** Creates `name` inside `parent` (or reuses it if it exists) and returns it. */
    public async createFolderIn(parent: ProjectFolderHandle, name: string): Promise<ProjectFolderHandle> {
        return await parent.getDirectoryHandle(name, { create: true }) as ProjectFolderHandle;
    }

    // ── Opening and closing ──────────────────────────────────────────

    /**
     * Makes a folder the open project and remembers it in the recent list.
     *
     * @param layout - when given, the scenario layout is written into the folder
     *   first. The project only counts as open — and the workspace only appears —
     *   once that is done, so nothing ever shows a project that is half set up.
     */
    public async adopt(handle: ProjectFolderHandle, layout?: ProjectMeta): Promise<void> {
        await this._adopt(handle);
        if (layout) await this.initializeLayout(layout);
        this.status.set('open');
        this.projectId.set(await this._remember(handle));
    }

    /**
     * Reopens a project from the recent list.
     *
     * Call it straight from the click: the browser only asks for access on a
     * user gesture, and the permission request is the first thing this does.
     */
    public async openRecent(recent: RecentProject): Promise<ReopenResult> {
        // A folder that was moved or deleted can fail at either step — asking for
        // access, or listing it — so both are checked for "not found".
        try {
            if (await recent.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return 'denied';
            await listDir(recent.handle, 1);
        } catch (err) {
            if ((err as DOMException)?.name === 'NotFoundError') return 'missing';
            throw err;
        }
        await this.adopt(recent.handle);
        return 'ok';
    }

    /** Removes one project from the recent list. The folder itself is untouched. */
    public async forgetRecent(id: string): Promise<void> {
        try { await idb('readwrite', s => s.delete(id)); } catch { /* nothing to forget */ }
        this.recents.update(list => list.filter(r => r.id !== id));
    }

    /** Closes the project. It stays in the recent list; files on disk are untouched. */
    public async close(): Promise<void> {
        this._root = null;
        this._children.clear();
        this.folders.set([]);
        this.name.set('');
        this.projectId.set('');
        this.scenePath.set(null);
        this.status.set('closed');
        this.revision.update(n => n + 1);
        await this.loadRecents();
    }

    /** Re-reads the folder from disk — files change underneath the editor. */
    public async refresh(): Promise<void> {
        if (!this._root || this.status() !== 'open') return;
        await this._scan();
    }

    // ── Reading the tree ─────────────────────────────────────────────

    /** Entries directly inside `path`: folders first, then files, by name. */
    public list(path: string): ProjectEntry[] {
        return this._children.get(path) ?? [];
    }

    public exists(path: string): boolean {
        if (path === '') return this._root !== null;
        const cut = path.lastIndexOf('/');
        const parent = cut === -1 ? '' : path.slice(0, cut);
        return this.list(parent).some(e => e.path === path);
    }

    // ── Files ────────────────────────────────────────────────────────

    public async readFile(path: string): Promise<File> {
        const handle = await this._fileHandle(path, false);
        return handle.getFile();
    }

    public async readText(path: string): Promise<string> {
        return (await this.readFile(path)).text();
    }

    /**
     * Writes a file, creating its parent folders. Rescans afterwards, unless
     * `rescan` is false — for a file the panel does not list anyway, such as the
     * autosave, written every minute.
     */
    public async write(path: string, data: string | Blob, rescan = true): Promise<void> {
        const handle = await this._fileHandle(path, true);
        const writable = await handle.createWritable();
        try {
            await writable.write(data);
        } finally {
            await writable.close();
        }
        if (rescan) await this._scan();
    }

    /**
     * When a file was last modified, in ms, or null if it is not there.
     *
     * Asks the disk rather than the cached listing, so it also sees files the
     * panel hides (the `.editor` folder) and changes made outside the editor.
     */
    public async modifiedAt(path: string): Promise<number | null> {
        try {
            return (await this.readFile(path)).lastModified;
        } catch (err) {
            const kind = (err as DOMException)?.name;
            if (kind === 'NotFoundError' || kind === 'TypeMismatchError') return null;
            throw err;
        }
    }

    /** Deletes a file if it exists, without rescanning and without complaint when it does not. */
    public async removeQuietly(path: string): Promise<void> {
        const cut = path.lastIndexOf('/');
        try {
            const parent = await this._dirHandle(cut === -1 ? '' : path.slice(0, cut), false);
            await parent.removeEntry(cut === -1 ? path : path.slice(cut + 1));
        } catch (err) {
            if ((err as DOMException)?.name !== 'NotFoundError') throw err;
        }
    }

    public async createFolder(path: string): Promise<void> {
        await this._dirHandle(path, true);
        await this._scan();
    }

    /**
     * Copies files chosen or dropped by the user into `folder`.
     * A file with the same name is overwritten, as a copy on disk would be.
     */
    public async importFiles(folder: string, files: readonly File[]): Promise<void> {
        const dir = await this._dirHandle(folder, true);
        for (const file of files) {
            const handle = await dir.getFileHandle(file.name, { create: true });
            const writable = await handle.createWritable();
            try {
                await writable.write(file);
            } finally {
                await writable.close();
            }
        }
        await this._scan();
    }

    /** Deletes a file, or a folder with everything in it. */
    public async remove(path: string): Promise<void> {
        const cut = path.lastIndexOf('/');
        const parent = await this._dirHandle(cut === -1 ? '' : path.slice(0, cut), false);
        await parent.removeEntry(cut === -1 ? path : path.slice(cut + 1), { recursive: true });
        if (this.scenePath() === path) this.scenePath.set(null);
        await this._scan();
    }

    /**
     * Lays out an empty folder as a scenario ScenarioCreator can build:
     * an entry point that loads the saved scene, the scenes folder, and
     * `scenario.meta.json`. Existing files are left alone.
     *
     * @param meta - the project's identity; derived from the folder name when
     *   the folder was not set up through the new-project wizard.
     */
    public async initializeLayout(meta: ProjectMeta = defaultMeta(this.name())): Promise<void> {
        if (!this.exists('scenario.meta.json')) {
            await this.write('scenario.meta.json', metaJson(meta));
        }
        if (!this.exists('scripts/Scenario.ts')) {
            await this.write('scripts/Scenario.ts', SCENARIO_TEMPLATE);
        }
        await this._dirHandle('assets/scenes', true);
        await this._dirHandle('scripts/components', true);
        await this._scan();
    }

    // ── internal ─────────────────────────────────────────────────────

    /** Points the service at a folder and reads it. Does not mark the project open — see {@link adopt}. */
    private async _adopt(handle: DirHandle): Promise<void> {
        this._root = handle;
        this.name.set(handle.name);
        this.scenePath.set(null);
        await this._scan();
    }

    /** Walks the whole folder once; a scenario project is small enough for that. */
    private async _scan(): Promise<void> {
        const root = this._root;
        if (!root) return;

        const children = new Map<string, ProjectEntry[]>();
        const folders: ProjectFolder[] = [{ name: root.name, path: '', depth: 0 }];
        let count = 0;

        const walk = async (dir: DirHandle, path: string, depth: number): Promise<void> => {
            const entries: ProjectEntry[] = [];
            const subdirs: { handle: DirHandle; entry: ProjectEntry }[] = [];

            for (const child of await listDir(dir)) {
                if (child.name.startsWith('.') || HIDDEN.has(child.name)) continue;
                if (++count > MAX_ENTRIES) break;

                const childPath = path ? `${path}/${child.name}` : child.name;
                if (child.kind === 'directory') {
                    const entry: ProjectEntry = { name: child.name, path: childPath, kind: 'folder' };
                    entries.push(entry);
                    subdirs.push({ handle: child as DirHandle, entry });
                } else {
                    entries.push({ name: child.name, path: childPath, kind: kindOf(child.name) });
                }
            }

            entries.sort((a, b) =>
                (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1)
                || a.name.localeCompare(b.name));
            children.set(path, entries);

            subdirs.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
            for (const sub of subdirs) {
                folders.push({ name: sub.entry.name, path: sub.entry.path, depth: depth + 1 });
                await walk(sub.handle, sub.entry.path, depth + 1);
            }
        };

        await walk(root, '', 0);
        if (count > MAX_ENTRIES) {
            console.warn(`[Project] "${root.name}" has more than ${MAX_ENTRIES} entries — the listing is cut short.`);
        }

        this._children = children;
        this.folders.set(folders);
        this.revision.update(n => n + 1);
    }

    private async _dirHandle(path: string, create: boolean): Promise<DirHandle> {
        if (!this._root) throw new Error('[Project] No project is open.');
        let dir: FileSystemDirectoryHandle = this._root;
        for (const part of path.split('/').filter(Boolean)) {
            dir = await dir.getDirectoryHandle(part, { create });
        }
        return dir as DirHandle;
    }

    private async _fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
        const cut = path.lastIndexOf('/');
        const dir = await this._dirHandle(cut === -1 ? '' : path.slice(0, cut), create);
        return dir.getFileHandle(cut === -1 ? path : path.slice(cut + 1), { create });
    }

    // ── Remembering projects between sessions ────────────────────────

    /** Reads the recent list from IndexedDB, newest first. */
    public async loadRecents(): Promise<void> {
        try {
            const all = await idb<RecentProject[]>('readonly', s => s.getAll());
            this.recents.set(all.sort((a, b) => b.openedAt - a.openedAt));
        } catch {
            // No IndexedDB (private mode): projects are simply not remembered.
        }
    }

    /**
     * Puts a folder at the top of the recent list. A folder already in it is
     * moved up rather than listed twice — the browser hands out a new handle
     * object every time, so identity is asked of the file system.
     *
     * @returns the project's id — the same one every time this folder is opened,
     *   which is what lets a tab recognise "this project is open elsewhere".
     */
    private async _remember(handle: DirHandle): Promise<string> {
        try {
            const known = await idb<RecentProject[]>('readonly', s => s.getAll());
            let id: string = crypto.randomUUID();
            for (const r of known) {
                try {
                    if (await r.handle.isSameEntry(handle)) { id = r.id; break; }
                } catch {
                    // A stale handle cannot be compared; it is just not the same one.
                }
            }
            const entry: RecentProject = { id, name: handle.name, openedAt: Date.now(), handle };
            await idb('readwrite', s => s.put(entry));

            // Past the limit, the oldest go.
            const sorted = [...known.filter(r => r.id !== id), entry].sort((a, b) => b.openedAt - a.openedAt);
            for (const old of sorted.slice(MAX_RECENTS)) await idb('readwrite', s => s.delete(old.id));
            this.recents.set(sorted.slice(0, MAX_RECENTS));
            return id;
        } catch {
            // Not remembered; the project still opens. The folder name is the best identity left.
            return handle.name;
        }
    }
}

/**
 * Lists a folder's entries, at most `limit` of them.
 *
 * Steps the iterator by hand instead of using `for await`. The production build
 * lowers `for await`, and when the first `next()` rejected — a folder deleted
 * behind the editor's back — the lowered loop rethrew `undefined`, hiding the
 * browser's `NotFoundError` that the caller needs to see.
 */
async function listDir(
    dir: ProjectFolderHandle,
    limit: number = Infinity,
): Promise<Array<FileSystemDirectoryHandle | FileSystemFileHandle>> {
    const out: Array<FileSystemDirectoryHandle | FileSystemFileHandle> = [];
    const iterator = dir.values()[Symbol.asyncIterator]();
    while (out.length < limit) {
        const step = await iterator.next();
        if (step.done) return out;
        out.push(step.value);
    }
    await iterator.return?.();
    return out;
}

function kindOf(name: string): ProjectEntryKind {
    const lower = name.toLowerCase();
    if (lower.endsWith('.scene.json'))  return 'scene';
    if (lower.endsWith('.prefab.json')) return 'prefab';
    if (lower.endsWith('.mat.json'))    return 'material';

    const ext = lower.slice(lower.lastIndexOf('.') + 1);
    switch (ext) {
        case 'ts': case 'js': case 'mjs':                    return 'script';
        case 'glb': case 'gltf':                             return 'mesh';
        case 'png': case 'jpg': case 'jpeg': case 'webp':
        case 'ktx2':                                         return 'tex';
        case 'mp3': case 'ogg': case 'wav':                  return 'audio';
        default:                                             return 'file';
    }
}

/**
 * One IndexedDB request against the recent-projects store, as a promise.
 *
 * Version 1 had a single remembered project under a `handles` store; that store
 * is left alone, and its one project is simply not carried over.
 */
function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, 2);
        open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains(RECENTS)) {
                open.result.createObjectStore(RECENTS, { keyPath: 'id' });
            }
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const request = run(db.transaction(RECENTS, mode).objectStore(RECENTS));
            request.onsuccess = () => { resolve(request.result as T); db.close(); };
            request.onerror = () => { reject(request.error); db.close(); };
        };
    });
}
