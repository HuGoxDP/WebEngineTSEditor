/**
 * Monaco's Monarch grammar modules carry no type declarations — they register a
 * language as a side effect and export nothing an editor reads. Declared here
 * so importing them by specifier type-checks (and the bundler inlines them,
 * which a relative path at run time would not).
 */
declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js';
declare module 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
declare module 'monaco-editor/esm/vs/language/typescript/tsMode.js';
declare module 'monaco-editor/esm/vs/language/typescript/tsMode.js';
