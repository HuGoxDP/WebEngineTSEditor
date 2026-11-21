/**
 * `@babel/standalone` ships no types. Declared structurally for the transpile
 * call the script runtime makes: a source string in, ES-module JavaScript out.
 */
declare module '@babel/standalone' {
    export interface BabelFileResult { readonly code: string | null; }
    export function transform(
        code: string,
        options: {
            filename?: string;
            presets?: unknown[];
            plugins?: unknown[];
            sourceType?: 'module' | 'script' | 'unambiguous';
            compact?: boolean;
        },
    ): BabelFileResult;
}
