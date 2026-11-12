import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    OnDestroy,
    ViewChild,
    ElementRef,
    inject,
    signal,
} from '@angular/core';
import { TPipe } from '../../i18n/t.pipe';
import { IconComponent } from '../../icon.component';
import { CodeEditorService } from '../../services/code-editor.service';

/** Monaco's own module shape, as the bits used here. Kept structural on purpose. */
type Monaco = typeof import('monaco-editor');
type Editor = import('monaco-editor').editor.IStandaloneCodeEditor;

/**
 * The Code tab: one script file, in Monaco, with a save that goes through the
 * project store.
 *
 * @remarks
 * Monaco is big enough to move the bundle budget on its own, so it is imported
 * at construction and never at module load: the panel is the only thing that
 * pulls it in, and the Code tab is not on screen until a script is opened. Its
 * workers run from blob URLs, which the platform's CSP allows
 * (`worker-src 'self' blob:`) — and no `eval` anywhere, which it does not
 * (`script-src 'self' blob: 'nonce-…'`).
 */
@Component({
    selector: 'app-code',
    standalone: true,
    imports: [IconComponent, TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @if (code.empty()) {
            <div class="code-empty">
                <wets-icon name="file"></wets-icon>
                <strong>{{ 'code.empty' | t }}</strong>
                <span>{{ 'code.emptyHint' | t }}</span>
            </div>
        } @else {
            <div class="code-head">
                <wets-icon name="file"></wets-icon>
                <span class="code-name" [title]="code.file()!.path">{{ code.file()!.name }}</span>
                @if (code.dirty()) { <span class="dot unsaved" [title]="'code.unsaved' | t"></span> }
                <span class="code-spacer"></span>
                <button class="pane-btn" [class.primary]="code.dirty()" [disabled]="!code.dirty()"
                    (click)="save()" [title]="'code.save' | t">
                    {{ 'code.save' | t }}
                </button>
            </div>
            <div #host class="code-host"></div>
        }
    `,
    styles: [`
        :host { display: flex; flex-direction: column; min-height: 0; height: 100%; }
        .code-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 6px; height: 100%; color: var(--fg-3); text-align: center; padding: 24px; }
        .code-empty strong { color: var(--fg-2); font-size: 13px; }
        .code-empty span { font-size: 11px; }
        .code-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
            border-bottom: 1px solid var(--border); font-size: 12px; }
        .code-name { color: var(--fg-1); }
        .code-spacer { flex: 1; }
        .dot.unsaved { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
        .pane-btn { font-size: 11px; padding: 3px 10px; border: 1px solid var(--border); border-radius: 4px;
            background: var(--bg-2); color: var(--fg-2); cursor: pointer; }
        .pane-btn.primary { border-color: var(--accent); color: var(--accent); }
        .pane-btn:disabled { opacity: 0.5; cursor: default; }
        .code-host { flex: 1; min-height: 0; }
    `],
})
export class CodeComponent implements AfterViewInit, OnDestroy {

    public readonly code = inject(CodeEditorService);

    @ViewChild('host', { static: false })
    private readonly _host?: ElementRef<HTMLDivElement>;

    private _monaco: Monaco | null = null;
    private _editor: Editor | null = null;
    private readonly _ready = signal(false);

    public constructor() {}

    public async ngAfterViewInit(): Promise<void> {
        const host = this._host?.nativeElement;
        if (!host || this.code.empty()) return;
        await this._mount(host);
    }

    /** Saves the buffer. The keyboard path is the panel's Ctrl+S, below. */
    public async save(): Promise<void> {
        if (!this._editor) return;
        await this.code.save(this._editor.getValue());
    }

    /** Monaco's own save, wired in `_mount` so the browser's Ctrl+S also lands here. */
    private async _saveFromEditor(): Promise<void> {
        if (!this._editor) return;
        await this.code.save(this._editor.getValue());
    }

    /**
     * The editor API, and the two Monarch grammars this tab needs.
     *
     * Deliberately `editor.api` rather than the `monaco-editor` entry: the full
     * entry pulls the contrib widgets, which import the codicon CSS and with it
     * a `.ttf` this build has no loader for. Highlighting and editing are in
     * the API; the completion widgets arrive with Phase 2's diagnostics.
     */
    private async _loadMonaco(): Promise<Monaco> {
        // By specifier, so the bundler inlines them: a relative path would
        // become a 404 at run time, because a chunk is served from /editor/.
        const api = await import('monaco-editor/esm/vs/editor/editor.api');
        await Promise.all([
            import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js'),
            import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js'),
            // The TypeScript language service: its worker is what compiles a
            // script for the runtime and what later reports diagnostics.
            import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js'),
        ]);
        return api as unknown as Monaco;
    }

    private async _mount(host: HTMLDivElement): Promise<void> {
        this._monaco ??= await this._loadMonaco();
        const monaco = this._monaco;
        const file = this.code.file()!;
        const editor = monaco.editor.create(host, {
            value: '',
            language: file.language,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            tabSize: 4,
            insertSpaces: true,
            renderWhitespace: 'selection',
            fixedOverflowWidgets: true,
        });
        this._editor = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void this._saveFromEditor(); });
        editor.onDidChangeModelContent(() => {
            if (!this._ready()) return;
            this.code.markEdited();
        });
        await this._sync(file);

        // A Console row asked for this file before the editor existed — the
        // line is revealed once the model is in place.
        const jump = this.code.jumpTo();
        if (jump && jump.path === file.path) {
            this._editor.revealLine(jump.line);
            this._editor.setPosition({ lineNumber: jump.line, column: 1 });
            this._editor.focus();
            this.code.jumpTo.set(null);
        }
    }

    /** Reads the file from the store into the model, without marking it dirty. */
    private async _sync(file: { path: string; language: string }): Promise<void> {
        if (!this._editor) return;
        const monaco = this._monaco!;
        let text: string;
        try {
            text = await this._projectText(file.path);
        } catch {
            return;
        }
        const model = monaco.editor.getModels().find(m => m.uri.path === file.path)
            ?? monaco.editor.createModel(text, file.language, monaco.Uri.parse(`file:///${file.path}`));
        if (model.getValue() !== text) model.setValue(text);
        this._editor.setModel(model);
        this._ready.set(true);
    }

    private async _projectText(path: string): Promise<string> {
        // The store is reached through the service so a test can read it back
        // the same way; the panel never talks to the store directly.
        return await this.code.readText(path);
    }

    public ngOnDestroy(): void {
        this._editor?.dispose();
        this._editor = null;
    }
}
