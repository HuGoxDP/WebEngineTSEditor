import { Injectable } from '@angular/core';

/**
 * Monaco's own module shape, as the bits used here. Kept structural on purpose:
 * the package ships no ambient types for the deep paths this loads.
 */
export type Monaco = typeof import('monaco-editor');

/**
 * Loads Monaco once, in one place.
 *
 * @remarks
 * The API is imported rather than the `monaco-editor` entry, and the TypeScript
 * language service is imported as a contribution, because the full entry pulls
 * the contrib widgets — which import the codicon CSS, and with it a `.ttf` this
 * build has no loader for. Everything is a dynamic import, so Monaco stays in a
 * lazy chunk and the app's initial bundle is unchanged.
 *
 * Monaco's own *worker* is deliberately not started here. Its ESM build locates
 * itself through an AMD `require.toUrl` shim a bundler cannot satisfy, so a
 * headless `getEmitOutput` would hang in "TypeScript not registered!" forever.
 * A project's scripts are compiled by the TypeScript compiler API in its own
 * lazy chunk (`script-runtime.service.ts`): no worker, no `unsafe-eval`, and the
 * same emitter the platform's `tsc` runs.
 *
 * The grammar and contribution modules carry no declarations and export nothing
 * a caller reads; `monaco-grammars.d.ts` declares their paths.
 */
@Injectable({ providedIn: 'root' })
export class MonacoLoaderService {

    private _monaco: Monaco | null = null;
    private _loading: Promise<Monaco> | null = null;

    /** The loaded API, loading it on the first call. Never resolves twice over. */
    public load(): Promise<Monaco> {
        this._loading ??= this._import();
        return this._loading;
    }

    private async _import(): Promise<Monaco> {
        const api = await import('monaco-editor/esm/vs/editor/editor.api');
        await Promise.all([
            import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js'),
            import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js'),
            import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js'),
        ]);
        // The contribution's own `onLanguage` hook fires only when something
        // asks for rich language features, which a headless compile never does —
        // so the worker it would start is not needed here either.
        this._configureTypeScript(api as unknown as Monaco);
        return api as unknown as Monaco;
    }

    /**
     * The compiler options a scenario script is emitted with.
     *
     * `module: ESNext` keeps the `import`/`export` statements the pre-linker
     * rewrites — a CommonJS emit would turn them into `require()` and a blob
     * module could not be linked at all. `experimentalDecorators` is what the
     * engine's legacy `@Serializable` / `@SerializedField` need to be emitted as
     * calls; no metadata is emitted, because the engine's decorators read their
     * arguments themselves.
     *
     * `ESNext`, not `ES2022`: there is no `ES2022` member in Monaco's enum, and an
     * undefined target silently falls back to the ES3/CommonJS defaults.
     */
    private _configureTypeScript(monaco: Monaco): void {
        const ts = monaco.languages.typescript as unknown as {
            typescriptDefaults: { setCompilerOptions(o: Record<string, unknown>): void };
            ScriptTarget: Record<string, number>;
            ModuleKind: Record<string, number>;
        };
        ts.typescriptDefaults.setCompilerOptions({
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            experimentalDecorators: true,
            emitDecoratorMetadata: false,
        });
    }
}
