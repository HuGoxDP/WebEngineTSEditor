import { Injectable, computed, signal } from '@angular/core';

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

/** Where the open-project state stands — drives the panel's empty states. */
export type ProjectStatus =
    /** The browser has no File System Access API (not Chromium, or not HTTPS / localhost). */
    | 'unsupported'
    /** Nothing open. */
    | 'closed'
    /** A folder is remembered from last time, but the browser wants a click before granting it again. */
    | 'needs-permission'
    | 'open';

// The File System Access API is not in TypeScript's DOM lib beyond the basics,
// so the handful of members used here are declared rather than pulled in as a
// dependency.
interface PermissionCapable {
    queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
type DirHandle = FileSystemDirectoryHandle & PermissionCapable & {
    values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
};
type PickerWindow = Window & {
    showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandle>;
};

/** Folders that are build output or tooling, never project content. */
const HIDDEN = new Set(['node_modules', 'dist', 'lods']);

/** A project that large is not a scenario; stop rather than hang the tab. */
const MAX_ENTRIES = 5000;

const DB_NAME = 'wets-editor';
const DB_STORE = 'handles';
const DB_KEY = 'project';

/**
 * The scenario project open in the editor — a folder on the user's own disk.
 *
 * @remarks
 * Nothing about a project is stored on the server: the platform keeps published
 * scenarios only. The folder is reached through the browser's File System
 * Access API, which is why this needs a Chromium-based browser on HTTPS or
 * localhost. The handle is remembered in IndexedDB, so the project reopens
 * after a reload — once the user clicks to grant access again, which the
 * browser requires on every new page load.
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

    private _root: DirHandle | null = null;
    private _children = new Map<string, ProjectEntry[]>();

    constructor() {
        if (!(window as PickerWindow).showDirectoryPicker) {
            this.status.set('unsupported');
            return;
        }
        void this._restore();
    }

    // ── Opening and closing ──────────────────────────────────────────

    /** Shows the folder picker. Resolves false if the user cancels. */
    public async open(): Promise<boolean> {
        const host = window as PickerWindow;
        if (!host.showDirectoryPicker) return false;

        let handle: DirHandle;
        try {
            handle = await host.showDirectoryPicker({ id: 'wets-project', mode: 'readwrite' });
        } catch (err) {
            // AbortError is the user closing the dialog, not a failure.
            if ((err as DOMException)?.name === 'AbortError') return false;
            throw err;
        }
        await this._adopt(handle);
        await this._remember(handle);
        return true;
    }

    /**
     * Re-grants access to the folder remembered from the last session.
     * Must be called from a click: the browser only prompts on a user gesture.
     */
    public async reconnect(): Promise<boolean> {
        const handle = this._root;
        if (!handle) return false;
        if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return false;
        await this._adopt(handle);
        return true;
    }

    /** Forgets the project. Files on disk are untouched. */
    public async close(): Promise<void> {
        this._root = null;
        this._children.clear();
        this.folders.set([]);
        this.name.set('');
        this.scenePath.set(null);
        this.status.set('closed');
        this.revision.update(n => n + 1);
        await this._forget();
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

    /** Writes a file, creating its parent folders. Rescans afterwards. */
    public async write(path: string, data: string | Blob): Promise<void> {
        const handle = await this._fileHandle(path, true);
        const writable = await handle.createWritable();
        try {
            await writable.write(data);
        } finally {
            await writable.close();
        }
        await this._scan();
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
     */
    public async initializeLayout(): Promise<void> {
        const slug = this.name().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

        if (!this.exists('scenario.meta.json')) {
            const meta = { id: slug, name: this.name(), version: '1.0.0' };
            await this.write('scenario.meta.json', `${JSON.stringify(meta, null, 2)}\n`);
        }
        if (!this.exists('scripts/Scenario.ts')) {
            await this.write('scripts/Scenario.ts', SCENARIO_TEMPLATE);
        }
        await this._dirHandle('assets/scenes', true);
        await this._dirHandle('scripts/components', true);
        await this._scan();
    }

    // ── internal ─────────────────────────────────────────────────────

    private async _adopt(handle: DirHandle): Promise<void> {
        this._root = handle;
        this.name.set(handle.name);
        this.scenePath.set(null);
        this.status.set('open');
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

            for await (const child of dir.values()) {
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

    // ── Remembering the folder between sessions ──────────────────────

    private async _restore(): Promise<void> {
        let handle: DirHandle | undefined;
        try {
            handle = await idb<DirHandle | undefined>('readonly', s => s.get(DB_KEY));
        } catch {
            return;   // No IndexedDB (private mode): the project simply is not remembered.
        }
        if (!handle) return;

        this._root = handle;
        this.name.set(handle.name);
        if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
            await this._adopt(handle);
        } else {
            this.status.set('needs-permission');
        }
    }

    private async _remember(handle: DirHandle): Promise<void> {
        try { await idb('readwrite', s => s.put(handle, DB_KEY)); } catch { /* not remembered */ }
    }

    private async _forget(): Promise<void> {
        try { await idb('readwrite', s => s.delete(DB_KEY)); } catch { /* nothing to forget */ }
    }
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

/** One IndexedDB request against the handle store, as a promise. */
function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
            request.onsuccess = () => { resolve(request.result as T); db.close(); };
            request.onerror = () => { reject(request.error); db.close(); };
        };
    });
}

/**
 * Entry point written into a new project. It loads the scene the editor saved;
 * anything better built in code goes after that call.
 */
const SCENARIO_TEMPLATE = `import { ScenarioBehaviour, SceneSerializer } from "WebEngineTS";

/** Scene the editor saves, relative to assets/. */
const SCENE = "scenes/main.scene.json";

export default class Scenario extends ScenarioBehaviour {

    override async awake(): Promise<void> {
        const blob = await this.context.assets.getAsset(SCENE);
        SceneSerializer.deserializeScene(JSON.parse(await blob.text()));
    }
}
`;
