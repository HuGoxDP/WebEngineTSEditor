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
import * as engine from 'WebEngineTS';

/**
 * The project's scripts, compiled and linked the way the platform runs them.
 *
 * @remarks
 * The engine's own loader does this for a ZIP of **pre-compiled** `.js`
 * (`Scenario._prelinkAllScripts`, `@internal` and private). The editor holds
 * TypeScript, so it compiles first and then applies the same rules:
 *
 * 1. enumerate every `.ts`/`.js` under `scripts/`, declarations excluded;
 * 2. compile each `.ts` with Babel in its own lazy chunk;
 * 3. rewrite the relative import specifiers to Blob URLs in dependency order
 *    (leaves first), appending `.js` where the specifier has no extension —
 *    exactly `Scenario._resolveRelativeImport`;
 * 4. `import()` each Blob URL and collect what the module exported.
 *
 * The bare `"WebEngineTS"` specifier is rewritten too — see
 * {@link rewriteEngineImports} and {@link createEngineShim}. That is how a
 * script and the editor share one engine instance, and it is the whole reason
 * a class a script exports reaches the scene the editor deserializes.
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

    /** Every class the project's scripts have registered, sorted — the inspector's list. */
    public readonly classNames = signal<string[]>([]);

    /** Notes from the last load: a cycle, a module that threw, a skipped export. */
    public readonly notes = signal<string[]>([]);

    /**
     * What each file compiled to the last time it was loaded, keyed by its
     * `.js` name, with the Blob URL that serves it. A module whose code **and
     * dependency closure** are unchanged keeps its URL on the next pass, so the
     * browser's module map hands the very same module instance to every
     * importer: a second evaluation of an unchanged base module would mint a
     * second class under the same name, and its decorator would re-register it.
     */
    private readonly _loaded = new Map<string, { code: string; url: string }>();

    /**
     * The one module a script's `"WebEngineTS"` specifier resolves to: a Blob
     * URL that re-exports the editor's own engine namespace (see
     * {@link createEngineShim}). Built once per page load — the namespace never
     * changes — and never revoked.
     */
    private readonly _engineShim: string | null;

    /**
     * The classes each module registered, keyed the same way. `classNames` is
     * their union, not the last import's: a save that moved one file must not
     * make the other scripts' classes disappear from the list.
     */
    private readonly _classes = new Map<string, string[]>();

    public constructor(
        private readonly _project: ProjectService,
        private readonly _console: ConsoleService,
        private readonly _selection: SelectionService,
        private readonly _scene: SceneService,
    ) {
        // The editor's own engine module, for a scenario script to import. One
        // instance is the whole point: the classes a script exports are the
        // ones the editor's TypeRegistry resolves.
        const host = globalThis as unknown as { __wetsEngine?: unknown };
        host.__wetsEngine = engine;
        // A script's `"WebEngineTS"` import then resolves to one module that
        // re-exports the namespace — every import/export form the engine
        // supports, default included, works by construction (see the shim).
        this._engineShim = createEngineShim(engine as unknown as Record<string, unknown>);
    }

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
        const files = await this.scriptFiles();
        const compiled = new Map<string, string>();
        const fresh = new Map<string, string>();
        const present = new Set<string>();
        for (const file of files) {
            // A file listed and then gone (the whole project cleared under the
            // editor's feet, which the app supports) is a file the project no
            // longer has, not an error to shout about. Any *other* read failure
            // is a problem the author must see: reported with a jump, like a
            // compile diagnostic, and the file is left out of this pass.
            let text: string;
            try {
                text = await this._project.readText(file);
            } catch (err) {
                if ((err as DOMException)?.name !== 'NotFoundError') {
                    this._console.push({
                        level: 'error',
                        message: `[Script] ${file} could not be read: ${String(err)}`,
                        jump: { path: file, line: 1 },
                    });
                }
                continue;
            }
            const key = file.replace(/\.tsx?$/, '.js');
            present.add(key);
            const code = await this._compile(file, text);
            // A file that did not transpile is left out of the link entirely: the
            // class the project already loaded stays registered, so a broken edit
            // costs a fresh module and not the component on the GameObject.
            if (code.trim().length === 0) continue;
            compiled.set(key, code);
            const previous = this._loaded.get(key);
            if (previous === undefined || previous.code !== code) fresh.set(key, code);
        }
        // Files that left the project must not keep a module linked against a
        // sibling it can no longer reach. A file that is still there but failed
        // to compile keeps its entry: the class it registered last time is still
        // the one the registry has, and the next reload retries it.
        for (const [key, entry] of [...this._loaded.entries()]) {
            if (!present.has(key)) {
                // No importer of a gone module survives: its dependants are
                // re-linked (the module is fresh this pass or their own link
                // names it in an unresolved specifier), so the URL dies with
                // the module and the memory with it.
                URL.revokeObjectURL(entry.url);
                this._loaded.delete(key);
                this._classes.delete(key);
            }
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

        // A changed module must be re-imported by everything that reaches it,
        // transitively — or `Enemy.ts` keeps extending the Base that was linked
        // last time it moved, and the author's edit to Base never shows up in
        // the scene. `fresh` starts at the modules whose own code changed; the
        // reverse edges add their importers.
        const importers = new Map<string, string[]>();
        for (const [path, importing] of deps) {
            for (const dep of importing) {
                const list = importers.get(dep);
                if (list) list.push(path); else importers.set(dep, [path]);
            }
        }
        const closure: string[] = [...fresh.keys()];
        while (closure.length > 0) {
            const key = closure.pop()!;
            for (const importer of importers.get(key) ?? []) {
                if (fresh.has(importer)) continue;
                fresh.set(importer, compiled.get(importer)!);
                closure.push(importer);
            }
        }

        // Topological order, and a cycle warns instead of hanging — the engine's
        // own pre-linker does exactly this.
        //
        // A module whose code and whose importers are all unchanged keeps its
        // Blob URL: nothing about it moved, so the browser serves the module
        // instance it already has — one class object, one decorator run. A new
        // URL would evaluate it again and mint a second class under the same
        // name. `fresh` is closed under importers, so a module that is not fresh
        // has no fresh dependency either.
        const blobs = new Map<string, string>();
        const remaining = new Set(compiled.keys());
        let lastSize = -1;
        while (remaining.size > 0) {
            if (remaining.size === lastSize) {
                notes.push(`Circular dependency among ${[...remaining].join(', ')} — linking anyway`);
                for (const path of remaining) this._link(path, compiled, fresh, blobs);
                remaining.clear();
                break;
            }
            lastSize = remaining.size;
            for (const path of remaining) {
                if ([...deps.get(path)!].every(d => blobs.has(d))) {
                    this._link(path, compiled, fresh, blobs);
                    remaining.delete(path);
                }
            }
        }

        const imported: string[] = [];
        let changed = false;
        // The modules whose code moved, and everything that reaches them: a
        // module that imports a moved sibling must be imported too, or it keeps
        // the sibling's old class (see the closure above).
        for (const [path] of fresh) {
            let module: Record<string, unknown>;
            try {
                module = await import(/* @vite-ignore */ blobs.get(path)!) as Record<string, unknown>;
            } catch (err) {
                notes.push(`${path} could not be imported: ${String(err)}`);
                continue;
            }
            const names: string[] = [];
            for (const value of Object.values(module)) {
                const name = this._register(value);
                if (name && !names.includes(name)) names.push(name);
                if (name) changed = true;
            }
            // A module that imports cleanly is what the project has now, its
            // classes included; one that threw keeps the entry of its last good
            // version, whose class is still the one registered.
            this._classes.set(path, names);
            imported.push(...names);
        }
        // What the project has is what compiled; what was imported is the part
        // of it that changed.
        this.moduleCount.set(compiled.size);
        const all = new Set<string>();
        for (const names of this._classes.values()) for (const name of names) all.add(name);
        this.classNames.set([...all].sort());
        this.notes.set(notes);
        console.info(`[Script] ${fresh.size} module(s) loaded of ${compiled.size}, classes: ${[...all].join(', ') || 'none'}; notes: ${notes.join(' / ') || 'none'}`);
        // The world is rebuilt only when a class actually arrived or changed:
        // it replaces every GameObject, so doing it when nothing moved is a
        // cost the author pays for nothing.
        if (changed) await this._rebuildScene();
        return notes;
    }

    /**
     * Gives `path` its Blob URL for this pass.
     *
     * @remarks
     * A **fresh** module (its own code moved, or it reaches one that moved) gets
     * a new URL built from its code with its dependencies' URLs this pass; the
     * URL it had is revoked, and it is safe to revoke because its importers are
     * fresh too — the closure above guarantees it — so nothing else references
     * the old URL.
     *
     * A module that is not fresh keeps the URL it already has. The browser's
     * module map then hands back the very same module instance it served
     * before, so an unchanged dependency is not evaluated again, and the class
     * object in `TypeRegistry` keeps its identity.
     */
    private _link(
        path: string,
        compiled: Map<string, string>,
        fresh: Map<string, string>,
        blobs: Map<string, string>,
    ): void {
        const code = compiled.get(path)!;
        const previous = this._loaded.get(path);
        if (fresh.has(path)) {
            const url = relink(path, code, blobs, this._engineShim);
            if (previous) URL.revokeObjectURL(previous.url);
            this._loaded.set(path, { code, url });
            blobs.set(path, url);
            return;
        }
        // Not fresh means the entry holds this pass's code already (that is the
        // only way a module can be unchanged), so the URL with it still serves.
        blobs.set(path, previous!.url);
    }

    /** Every `.ts`/`.js` under `scripts/`, project-relative and sorted. */
    public async scriptFiles(): Promise<string[]> {
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

/** A plain word — an identifier the shim can destructure by name. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** Where the shim finds the namespace, and which of a script's names exist. */
const ENGINE_GLOBAL = "globalThis.__wetsEngine";

/**
 * The engine's own token regex for its specifier, verbatim (its
 * `Scenario._rewriteEngineImports`, `_ENGINE_IMPORT_RE`): it matches the
 * *specifier token* — `from "WebEngineTS"`, `import "WebEngineTS"`,
 * `import("WebEngineTS")` — and never the grammar around it, so a lazy span
 * cannot swallow statements between two imports (or a comment that mentions the
 * word). The editor and the platform then share one rewrite rule.
 */
const ENGINE_IMPORT_RE =
    /(?<![\w$.])(from\s*|import\s*\(?\s*)(["'])WebEngineTS\2/g;

/**
 * Builds the one module a script's bare `"WebEngineTS"` specifier resolves to.
 *
 * @remarks
 * A bare specifier cannot resolve inside a Blob URL, and rewriting the import
 * *clause* by hand (a destructure of a published global) can only ever serve one
 * shape: a default import, `export * from`, a namespace import or a dynamic
 * `import()` each fall through it. So the specifier is pointed at a real module
 * instead — one Blob URL whose source re-exports the editor's engine namespace
 * as named exports plus the engine's default — and the browser resolves every
 * import and export form from the shim by construction, exactly as the platform
 * resolves against the engine's own file.
 *
 * Built once per page load: the namespace's exports never change, so one shim
 * serves every project, every reload. It reads the namespace from the global —
 * the shim is ESM source, and it must find the *live* namespace rather than a
 * snapshot spliced in.
 *
 * @param namespace The editor's engine module namespace (`import * as engine`).
 */
function createEngineShim(namespace: Record<string, unknown>): string | null {
    const keys = Object.keys(namespace).filter(key => key !== 'default' && IDENTIFIER_RE.test(key));
    const source = [
        '// Generated by the editor: the app\'s engine namespace, re-exported.',
        `const e = ${ENGINE_GLOBAL};`,
        keys.length > 0 ? `export const { ${keys.join(', ')} } = e;` : '',
        'export default e.default;',
    ].filter(line => line.length > 0).join('\n');
    return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
}

/**
 * Rewrites every bare `"WebEngineTS"` specifier in compiled script code to the
 * shim's Blob URL, keeping the surrounding grammar exactly as it was.
 *
 * @remarks
 * The app bundles the engine — a second, external copy would double the page's
 * parse work, which is measurable (about a second per page) and enough to make
 * the editor's own e2e suite time out. So a script's import of the engine is
 * pointed at the shim, and the two share one instance: the classes a script
 * exports are the classes the editor's `TypeRegistry` resolves.
 *
 * The engine's own loader does the same thing for the platform, where the engine
 * *is* a file (`Scenario._rewriteEngineImports`). Here the host is the editor
 * and the "file" is the shim for its own bundle.
 *
 * @param engineShim The shim's URL, or `null` when the environment cannot make
 *        one — the code is then returned unchanged, like the engine with a
 *        `null` url.
 */
export function rewriteEngineImports(code: string, engineShim: string | null): string {
    if (engineShim === null) return code;
    const literal = JSON.stringify(engineShim);
    return code.replace(ENGINE_IMPORT_RE, (_full: string, head: string) => `${head}${literal}`);
}

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
function relink(path: string, code: string, blobs: Map<string, string>, engineShim: string | null): string {
    const rewritten = code.replace(RELATIVE_IMPORT_RE, (full, quote: string, specifier: string) => {
        const target = blobs.get(resolveRelative(path, specifier));
        if (!target) return full;                     // unresolved: left alone, like the engine
        return full.replace(`${quote}${specifier}${quote}`, `${quote}${target}${quote}`);
    });
    const linked = rewriteEngineImports(rewritten, engineShim);
    return URL.createObjectURL(new Blob([linked], { type: 'application/javascript' }));
}
