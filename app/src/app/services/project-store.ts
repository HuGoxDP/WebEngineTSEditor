// path: src/app/services/project-store.ts
//
// Where an open project's files live. Two implementations share one interface:
// a folder on the user's own disk (File System Access API, Chromium) and the
// browser's origin-private file system (every modern browser — decision #10,
// R1). Everything above this file — the Project panel, the editor, the
// commands — sees one API addressed by project-relative paths, so a project
// opened from either store behaves the same.

/** One entry in a project folder. */
export interface StoreEntry {
    name: string;
    kind: 'file' | 'directory';
}

/**
 * An open project: a root addressed by project-relative, slash-separated paths,
 * never starting with a slash. `''` is the project root itself.
 */
export interface ProjectStore {
    /** The folder's name, for the panel's title. */
    readonly name: string;

    /** Entries directly inside `path`, unsorted — the caller sorts, as the panel wants. */
    entries(path: string): Promise<StoreEntry[]>;

    /** A file handle for `path`. With `create`, the parent folders and the file are made. */
    file(path: string, create: boolean): Promise<FileSystemFileHandle>;

    /** Makes the folder at `path`, and any folder above it that is missing. */
    mkdir(path: string): Promise<void>;

    /** Removes the entry at `path`; `recursive` for a folder with contents. */
    remove(path: string, recursive: boolean): Promise<void>;

    /** Whether two stores name the same project — identity for the recent list. */
    isSameEntry(other: ProjectStore): Promise<boolean>;
}

/**
 * The directory-iteration member used here — `values()` is newer than TypeScript's
 * DOM lib, so it is declared rather than pulled in as a dependency (the same reason
 * the project service declares its permission members).
 */
interface ValuesCapable {
    values(): AsyncIterable<FileSystemHandle>;
}

/**
 * Steps a directory iterator by hand instead of `for await`.
 *
 * The production build lowers `for await`, and when the first `next()` rejected — a
 * folder deleted behind the editor's back — the lowered loop rethrew `undefined`,
 * hiding the browser's `NotFoundError` that the caller needs to see.
 */
async function stepValues(
    dir: ValuesCapable,
    limit: number = Infinity,
): Promise<FileSystemHandle[]> {
    const out: FileSystemHandle[] = [];
    const iterator = dir.values()[Symbol.asyncIterator]();
    while (out.length < limit) {
        const step = await iterator.next();
        if (step.done) return out;
        out.push(step.value);
    }
    await iterator.return?.();
    return out;
}

/** Walks from a root to the folder at `path`, making folders on the way when asked. */
async function dirAt(
    root: FileSystemDirectoryHandle,
    path: string,
    create: boolean,
): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const part of path.split('/').filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
}

/** Under the OPFS root: one folder per project, so two projects never share a namespace. */
const PROJECTS_DIR = 'projects';

/** A project in the browser's origin-private file system (OPFS). */
export class OpfsStore implements ProjectStore {

    private _id: string;

    private constructor(private readonly _root: Promise<FileSystemDirectoryHandle>, id: string) {
        this._id = id;
    }

    /** The project's id — its folder name under `projects/`, and its stable identity. */
    public get id(): string { return this._id; }

    /**
     * Whether this browser can run projects from OPFS: the API itself, and a
     * way to write (Safari below 26 has the directory but no `createWritable`,
     * so a project there would open read-only — not a store).
     */
    public static available(): boolean {
        const storage: Partial<StorageManager> | undefined = globalThis.navigator?.storage;
        return typeof storage?.getDirectory === 'function'
            && typeof FileSystemFileHandle !== 'undefined'
            && typeof FileSystemFileHandle.prototype.createWritable === 'function';
    }

    /** Opens (making it if it is new) the project folder `id`. */
    public static async create(id: string = crypto.randomUUID()): Promise<OpfsStore> {
        const opfs = await navigator.storage.getDirectory();
        const projects = await opfs.getDirectoryHandle(PROJECTS_DIR, { create: true });
        const root = await projects.getDirectoryHandle(id, { create: true });
        return new OpfsStore(Promise.resolve(root), id);
    }

    /**
     * Whether the project folder `id` is there — without making it. A remembered
     * project whose folder was cleared is *missing*, and must not silently come
     * back empty.
     */
    public static async exists(id: string): Promise<boolean> {
        try {
            const opfs = await navigator.storage.getDirectory();
            const projects = await opfs.getDirectoryHandle(PROJECTS_DIR);
            await projects.getDirectoryHandle(id);
            return true;
        } catch {
            return false;
        }
    }

    public get name(): string { return this._id; }

    public async entries(path: string): Promise<StoreEntry[]> {
        const dir = (await dirAt(await this._root, path, false)) as FileSystemDirectoryHandle & ValuesCapable;
        const out: StoreEntry[] = [];
        for (const child of await stepValues(dir)) {
            out.push({ name: child.name, kind: child.kind === 'directory' ? 'directory' : 'file' });
        }
        return out;
    }

    public async file(path: string, create: boolean): Promise<FileSystemFileHandle> {
        const cut = path.lastIndexOf('/');
        const dir = await dirAt(await this._root, cut === -1 ? '' : path.slice(0, cut), create);
        return dir.getFileHandle(cut === -1 ? path : path.slice(cut + 1), { create });
    }

    public async mkdir(path: string): Promise<void> {
        await dirAt(await this._root, path, true);
    }

    public async remove(path: string, recursive: boolean): Promise<void> {
        const cut = path.lastIndexOf('/');
        const dir = await dirAt(await this._root, cut === -1 ? '' : path.slice(0, cut), false);
        await dir.removeEntry(cut === -1 ? path : path.slice(cut + 1), { recursive });
    }

    public async isSameEntry(other: ProjectStore): Promise<boolean> {
        if (!(other instanceof OpfsStore)) return false;
        try {
            return await (await this._root).isSameEntry(await other._root);
        } catch {
            return false;
        }
    }

    /**
     * Asks the browser to keep this origin's storage out of eviction. Best
     * effort: a browser may still ask the user, and OPFS in private mode is
     * gone when the window closes whatever the answer — a failure here never
     * fails the project.
     */
    public async keepAcrossRestarts(): Promise<void> {
        try { await navigator.storage.persist(); } catch { /* best effort */ }
    }
}

/** A project folder on the user's own disk, opened through the folder picker. */
export class FileSystemAccessStore implements ProjectStore {

    public constructor(private readonly _root: FileSystemDirectoryHandle) {}

    public get name(): string { return this._root.name; }

    public async entries(path: string): Promise<StoreEntry[]> {
        const dir = (await dirAt(this._root, path, false)) as FileSystemDirectoryHandle & ValuesCapable;
        const out: StoreEntry[] = [];
        for (const child of await stepValues(dir)) {
            out.push({ name: child.name, kind: child.kind === 'directory' ? 'directory' : 'file' });
        }
        return out;
    }

    public async file(path: string, create: boolean): Promise<FileSystemFileHandle> {
        const cut = path.lastIndexOf('/');
        const dir = await dirAt(this._root, cut === -1 ? '' : path.slice(0, cut), create);
        return dir.getFileHandle(cut === -1 ? path : path.slice(cut + 1), { create });
    }

    public async mkdir(path: string): Promise<void> {
        await dirAt(this._root, path, true);
    }

    public async remove(path: string, recursive: boolean): Promise<void> {
        const cut = path.lastIndexOf('/');
        const dir = await dirAt(this._root, cut === -1 ? '' : path.slice(0, cut), false);
        await dir.removeEntry(cut === -1 ? path : path.slice(cut + 1), { recursive });
    }

    public async isSameEntry(other: ProjectStore): Promise<boolean> {
        if (!(other instanceof FileSystemAccessStore)) return false;
        try {
            return await this._root.isSameEntry(other._root);
        } catch {
            // A stale handle cannot be compared; it is just not the same one.
            return false;
        }
    }
}
