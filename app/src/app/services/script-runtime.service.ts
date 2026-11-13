import { Injectable, signal } from '@angular/core';
import { ProjectService } from './project.service';
import { ConsoleService } from './console.service';
import { SelectionService } from './selection.service';
import { SceneService } from './scene.service';
import {
    GameObject,
    SceneManager,
    SceneSerializer,
    TypeRegistry,
    getClassMeta,
} from 'WebEngineTS';

/**
 * The project's scripts, compiled and linked the way the platform runs them.
 *
 * @remarks
 * The engine's own loader does this for a ZIP of **pre-compiled** `.js`
 * (`Scenario._prelinkAllScripts`, `@internal` and private). The editor holds
 * TypeScript, so it compiles first and then applies the same rules:
 *
 * 1. enumerate every `.ts`/`.js` under `scripts/`, declarations excluded;
 * 2. compile each `.ts` with Monaco's TypeScript worker;
 * 3. rewrite the relative import specifiers to Blob URLs in dependency order
 *    (leaves first), appending `.js` where the specifier has no extension —
 *    exactly `Scenario._resolveRelativeImport`;
 * 4. `import()` each Blob URL and collect what the module exported.
 *
 * A bare `"WebEngineTS"` is **not** rewritten: the import map in `index.html`
 * resolves it to the very bundle the editor uses, so a script and the editor
 * share one `TypeRegistry`. That is the whole reason a class a script exports
 * reaches the scene the editor deserializes.
 *
 * Registration then swaps the class. `TypeRegistry.register` is what a
 * `@Serializable` decorator already called when the module ran;
 * `TypeRegistry.replace` (C3) is what a *reload* needs, because a second
 * constructor under the same name is the collision `register` refuses on
 * purpose.
 */
@Injectable({ providedIn: 'root' })
export class ScriptRuntimeService {

    /** How many modules the last load imported. */
    public readonly moduleCount = signal(0);

    /** The class names the last load registered, sorted — the inspector's list. */
    public readonly classNames = signal<string[]>([]);

    /** Notes from the last load: a cycle, a module that threw, a skipped export. */
    public readonly notes = signal<string[]>([]);

    private readonly _urls: string[] = [];

    public constructor(
        private readonly _project: ProjectService,
        private readonly _console: ConsoleService,
        private readonly _selection: SelectionService,
        private readonly _scene: SceneService,
    ) {}

    /**
     * Compiles, links, imports and registers the project's scripts, then
     * rebuilds the open scene so an object that names a just-registered class
     * deserializes into it rather than the placeholder the engine keeps for an
     * unknown type.
     *
     * Returns the notes: a module that fails to import is reported, not thrown,
     * because one broken script must not cost the whole project its classes.
     */
    public async reload(): Promise<string[]> {
        const notes: string[] = [];
        const files = await this._scriptFiles();
        const compiled = new Map<string, string>();
        for (const file of files) {
            // A file listed and then gone (the whole project cleared under the
            // editor's feet, which the app supports) is a file the project no
            // longer has, not an error to shout about.
            let text: string;
            try {
                text = await this._project.readText(file);
            } catch {
                continue;
            }
            const key = file.replace(/\.tsx?$/, '.js');
            const code = await this._compile(file, text);
            // A file that did not transpile is left out of the link entirely: the
            // class the project already loaded stays registered, so a broken edit
            // costs a fresh module and not the component on the GameObject.
            if (code.trim().length === 0) continue;
            compiled.set(key, code);
        }

        const deps = new Map<string, Set<string>>();
        for (const [path, code] of compiled) {
            const found = new Set<string>();
            RELATIVE_IMPORT_RE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = RELATIVE_IMPORT_RE.exec(code)) !== null) {
                const target = resolveRelative(path, match[2]);
                if (compiled.has(target)) found.add(target);
            }
            deps.set(path, found);
        }

        // Topological order, and a cycle warns instead of hanging — the engine's
        // own pre-linker does exactly this.
        const blobs = new Map<string, string>();
        const remaining = new Set(compiled.keys());
        let lastSize = -1;
        while (remaining.size > 0) {
            if (remaining.size === lastSize) {
                notes.push(`Circular dependency among ${[...remaining].join(', ')} — linking anyway`);
                for (const path of remaining) blobs.set(path, relink(path, compiled.get(path)!, blobs, this._urls));
                remaining.clear();
                break;
            }
            lastSize = remaining.size;
            for (const path of remaining) {
                if ([...deps.get(path)!].every(d => blobs.has(d))) {
                    blobs.set(path, relink(path, compiled.get(path)!, blobs, this._urls));
                    remaining.delete(path);
                }
            }
        }

        const names: string[] = [];
        for (const [path] of compiled) {
            let module: Record<string, unknown>;
            try {
                module = await import(/* @vite-ignore */ blobs.get(path)!) as Record<string, unknown>;
            } catch (err) {
                notes.push(`${path} could not be imported: ${String(err)}`);
                continue;
            }
            for (const value of Object.values(module)) {
                const name = this._register(value);
                if (name && !names.includes(name)) names.push(name);
            }
        }

        this.moduleCount.set(compiled.size);
        this.classNames.set(names.sort());
        this.notes.set(notes);
        console.info(`[Script] loaded ${compiled.size} module(s), classes: ${names.join(', ') || 'none'}; notes: ${notes.join(' / ') || 'none'}`);
        await this._rebuildScene();
        return notes;
    }

    /** Every `.ts`/`.js` under `scripts/`, project-relative and sorted. */
    private async _scriptFiles(): Promise<string[]> {
        const out: string[] = [];
        const walk = async (path: string): Promise<void> => {
            let entries;
            try { entries = await this._project.entries(path); } catch { return; }
            for (const entry of entries) {
                const full = path ? `${path}/${entry.name}` : entry.name;
                if (entry.kind === 'directory') { await walk(full); continue; }
                if (/\.(ts|js)$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
            }
        };
        await walk('scripts');
        return out.sort();
    }

    /**
     * TypeScript to JavaScript, in its own lazy chunk.
     *
     * `@babel/standalone` is the transpiler: it is built for the browser (no
     * worker, no wasm, no `eval`), it is a normal dependency so esbuild bundles
     * it into a chunk nothing loads until a project's scripts are compiled, and
     * its TypeScript preset emits the same ES modules the pre-linker rewrites.
     *
     * Monaco's own worker was the first choice and is not usable here: its ESM
     * build locates itself through an AMD `require.toUrl` shim a bundler cannot
     * satisfy, so a headless emit never resolves. `typescript` itself is not an
     * option either — it reaches Node's `path`, which a browser build cannot
     * resolve.
     */
    private async _compile(path: string, text: string): Promise<string> {
        if (!/\.tsx?$/.test(path)) return text;
        try {
            // The package is CommonJS, so a bundler's ESM interop hides the API
            // on `default`; take it from wherever it ended up.
            const loaded = await import('@babel/standalone');
            const babel = ('default' in loaded ? loaded.default : loaded) as {
                transform: (code: string, options: Record<string, unknown>) => { code: string | null };
            };
            const out = babel.transform(text, {
                filename: path,
                presets: [['typescript', { allExtensions: false, isTSX: false }]],
                // The engine's `@Serializable` / `@SerializedField` are legacy
                // decorators, and its fields are declared the modern way — the
                // two plugins Babel needs for both, in the order it needs them.
                plugins: [
                    // Babel standalone registers them without the
                    // `@babel/plugin-` prefix.
                    ['proposal-decorators', { legacy: true }],
                    ['transform-class-properties'],
                ],
                sourceType: 'module',
                compact: false,
            });
            return out.code ?? text;
        } catch (err) {
            // A syntax error is a diagnostics problem, not a reason to refuse the
            // load: Babel hands back a `loc`, the row is reported with it, and the
            // module is skipped — the class the project already has stays loaded,
            // so the scene does not lose its component.
            this._reportDiagnostic(path, err);
            return "";
        }
    }

    /**
     * Reports a transpile failure as a Console row naming the file and the line.
     *
     * Babel's `loc` is on the thrown error (`Position { line, column, index }`);
     * the message carries the same location as `…/file.ts: Unexpected token
     * (3:6)`, which is what a human reads first, so the row shows that.
     */
    private _reportDiagnostic(path: string, err: unknown): void {
        const loc = (err as { loc?: { line?: number } }).loc;
        const line = typeof loc?.line === "number" ? loc.line : 1;
        const detail = err instanceof Error ? err.message : String(err);
        this._console.push({
            level: 'error',
            message: `[Script] ${path} could not be compiled: ${detail.split(String.fromCharCode(10))[0]}`,
            jump: { path, line },
        });
    }

    /** Registers or swaps the class, and reports the name it took. */
    private _register(value: unknown): string | null {
        const ctor = value as (new (...args: never[]) => unknown) | undefined;
        if (typeof ctor !== 'function') return null;
        const meta = getClassMeta(ctor);
        if (!meta) return null;                       // not @Serializable: no name to save under
        const existing = TypeRegistry.get(meta.typeName);
        if (existing && existing !== ctor) TypeRegistry.replace(meta.typeName, ctor, TypeRegistry.getMeta(existing)!);
        return meta.typeName;
    }

    /**
     * Rebuilds the open scene so the freshly registered classes attach.
     *
     * Through {@link SceneService.loadFromJSON}, which is the editor's own
     * "replace the world" operation: it clears, deserializes and refreshes the
     * panels. Rebuilding by hand would leave the hierarchy holding destroyed
     * objects — a click on such a row selects an object whose components are
     * gone, which is exactly what the author must never see after a save.
     */
    private _rebuildScene(): void {
        const scene = SceneManager.activeScene;
        const roots = scene.getRootGameObjects();
        if (roots.length === 0) return;

        const saved = JSON.parse(JSON.stringify(SceneSerializer.serializeScene(scene))) as ReturnType<typeof SceneSerializer.serializeScene>;
        this._scene.loadFromJSON(saved);
        this._selection.clear();
    }
}

/** Captures `import … from`, `export … from` and a side-effect `import '…'`. */
const RELATIVE_IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+|)(["'])(\.\.?\/[^"']+)\1/g;

/** Resolves a relative specifier the way `Scenario._resolveRelativeImport` does. */
export function resolveRelative(fromPath: string, specifier: string): string {
    const fromDir = fromPath.slice(0, fromPath.lastIndexOf('/'));
    const parts = `${fromDir}/${specifier}`.split('/');
    const out: string[] = [];
    for (const part of parts) {
        if (part === '.' || part === '') continue;
        if (part === '..') out.pop(); else out.push(part);
    }
    const joined = out.join('/');
    return joined.endsWith('.js') ? joined : `${joined}.js`;
}

/** Rewrites the relative specifiers in `code` to Blob URLs and makes the blob. */
function relink(path: string, code: string, blobs: Map<string, string>, urls: string[]): string {
    const rewritten = code.replace(RELATIVE_IMPORT_RE, (full, quote: string, specifier: string) => {
        const target = blobs.get(resolveRelative(path, specifier));
        if (!target) return full;                     // unresolved: left alone, like the engine
        return full.replace(`${quote}${specifier}${quote}`, `${quote}${target}${quote}`);
    });
    const url = URL.createObjectURL(new Blob([rewritten], { type: 'application/javascript' }));
    urls.push(url);
    return url;
}
