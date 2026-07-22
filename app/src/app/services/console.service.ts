import { Injectable, signal, computed } from '@angular/core';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
    id: number;
    level: LogLevel;
    message: string;
    /** Local-time HH:MM:SS string, captured at log time. */
    time: string;
    /** Best-effort source string (file:line) parsed from the call stack. */
    source: string;
    count: number;  // collapsed-duplicate counter
}

/**
 * Editor console — captures `console.log/warn/error` and exposes them
 * as a reactive log. Patches the global `console` once at construction.
 *
 * @remarks
 * Original console methods are still called so the browser DevTools
 * console keeps working alongside the editor panel.
 */
@Injectable({ providedIn: 'root' })
export class ConsoleService {

    private static readonly MAX_ENTRIES = 500;

    private readonly _entries = signal<LogEntry[]>([]);
    public readonly entries = this._entries.asReadonly();

    /** Filter toggles (sticky between sessions are stretch). */
    public readonly showInfo  = signal(true);
    public readonly showWarn  = signal(true);
    public readonly showError = signal(true);
    /** When true, repeat messages bump a counter instead of adding new rows. */
    public readonly collapse  = signal(true);

    public readonly visible = computed<LogEntry[]>(() => {
        const list = this._entries();
        const i = this.showInfo(), w = this.showWarn(), e = this.showError();
        return list.filter(en =>
            (i && en.level === 'info') ||
            (w && en.level === 'warn') ||
            (e && en.level === 'error'),
        );
    });

    public readonly counts = computed(() => {
        let info = 0, warn = 0, err = 0;
        for (const e of this._entries()) {
            if (e.level === 'info') info += e.count;
            else if (e.level === 'warn') warn += e.count;
            else err += e.count;
        }
        return { info, warn, err };
    });

    private _nextId = 1;

    constructor() {
        this._patchConsole();
    }

    public clear(): void {
        this._entries.set([]);
        this._nextId = 1;
    }

    private _patchConsole(): void {
        // Already patched? Skip.
        if ((globalThis as any).__wets_console_patched__) return;
        (globalThis as any).__wets_console_patched__ = true;

        const log   = console.log.bind(console);
        const warn  = console.warn.bind(console);
        const error = console.error.bind(console);

        const push = (level: LogLevel, args: unknown[]) => {
            const message = args.map(a => this._fmt(a)).join(' ');
            this._push(level, message, this._sourceOf());
        };

        console.log = (...args: unknown[]) => { push('info', args); log(...args); };
        console.info = console.log;
        console.warn = (...args: unknown[]) => { push('warn', args); warn(...args); };
        console.error = (...args: unknown[]) => { push('error', args); error(...args); };

        window.addEventListener('error', e => {
            this._push('error', e.message ?? String(e.error ?? e), `${e.filename}:${e.lineno}`);
        });
        window.addEventListener('unhandledrejection', e => {
            const r = (e as PromiseRejectionEvent).reason;
            this._push('error',
                r instanceof Error ? r.message : String(r),
                'unhandledrejection');
        });
    }

    private _fmt(v: unknown): string {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return v.stack ?? v.message;
        try { return JSON.stringify(v); } catch { return String(v); }
    }

    private _sourceOf(): string {
        // Walk a stack trace and skip our own frames.
        const stack = new Error().stack ?? '';
        const lines = stack.split('\n').slice(3, 8);
        for (const ln of lines) {
            const m = ln.match(/(\w+\.\w+):(\d+)/);
            if (m) return `${m[1]}:${m[2]}`;
        }
        return '';
    }

    private _push(level: LogLevel, message: string, source: string): void {
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const list = this._entries();

        if (this.collapse() && list.length > 0) {
            const last = list[list.length - 1];
            if (last.level === level && last.message === message) {
                const next = list.slice(0, -1);
                next.push({ ...last, count: last.count + 1, time });
                this._entries.set(next);
                return;
            }
        }

        const entry: LogEntry = {
            id: this._nextId++,
            level, message, time, source, count: 1,
        };
        const next = [...list, entry];
        if (next.length > ConsoleService.MAX_ENTRIES) next.splice(0, next.length - ConsoleService.MAX_ENTRIES);
        this._entries.set(next);
    }
}
