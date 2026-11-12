import { Injectable, computed, signal } from '@angular/core';
import { ProjectService } from './project.service';

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

    public constructor(private readonly _project: ProjectService) {}

    /** Reads `path` into the Code tab. A read failure is reported, not swallowed. */
    public async open(path: string): Promise<boolean> {
        let text: string;
        try {
            text = await this._project.readText(path);
        } catch (err) {
            // Through console, which the Console panel captures — so the failure
            // reaches the same place a compile diagnostic will.
            console.error(`[Script] Could not read ${path}: ${String(err)}`);
            return false;
        }
        this.file.set({ path, name: path.slice(path.lastIndexOf('/') + 1), language: languageOf(path) });
        this._dirty.set(false);
        this._revision.update(n => n + 1);
        return true;
    }

    /** Writes the buffer back through the project store and clears the mark. */
    public async save(text: string): Promise<boolean> {
        const file = this.file();
        if (!file) return false;
        try {
            await this._project.write(file.path, text);
        } catch (err) {
            console.error(`[Script] Could not save ${file.path}: ${String(err)}`);
            return false;
        }
        this._dirty.set(false);
        this._revision.update(n => n + 1);
        return true;
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

    /** Opens `path` and asks the panel to reveal `line` once it is laid out. */
    public async reveal(path: string, line: number): Promise<void> {
        if (this.file()?.path !== path) await this.open(path);
        this.jumpTo.set({ path, line });
    }
}
