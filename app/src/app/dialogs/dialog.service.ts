import { Injectable, InjectionToken, Type, signal } from '@angular/core';

/** A button in a message dialog. */
export interface DialogButton<T extends string = string> {
    id: T;
    label: string;
    /** `primary` takes Enter; `danger` is drawn as a destructive action. */
    kind?: 'primary' | 'danger' | 'normal';
}

export interface AskOptions<T extends string = string> {
    title: string;
    message?: string;
    buttons: DialogButton<T>[];
}

export interface PromptOptions {
    title: string;
    label?: string;
    value?: string;
    confirmLabel: string;
    cancelLabel: string;
    /** Returns an error message to show and block confirming, or null when the value is fine. */
    validate?: (value: string) => string | null;
}

/** Handed to a component opened with {@link DialogService.open}; closes its own dialog. */
export class DialogRef<R = unknown> {
    constructor(private readonly _close: (result: R | undefined) => void) {}
    public close(result?: R): void { this._close(result); }
}
export const DIALOG_REF = new InjectionToken<DialogRef<any>>('DIALOG_REF');

/** What the host renders. One entry per open dialog; the last is on top. */
export type DialogEntry =
    | { id: number; kind: 'ask'; options: AskOptions; resolve: (id: string | null) => void }
    | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
    | { id: number; kind: 'custom'; title: string; component: Type<unknown>; inputs: Record<string, unknown>;
        ref: DialogRef; resolve: (value: unknown) => void };

/**
 * Editor dialogs, as promises.
 *
 * @remarks
 * Replaces `alert` / `confirm` / `prompt`, which cannot be translated, styled or
 * driven by an automated check, and which block the whole page. Dialogs stack:
 * Preferences can open over a confirmation. `DialogHostComponent` draws them.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {

    public readonly stack = signal<DialogEntry[]>([]);

    private _nextId = 1;

    /** True while any dialog is open — keyboard shortcuts stand down. */
    public isOpen(): boolean {
        return this.stack().length > 0;
    }

    /** Message with any set of buttons. Resolves to the pressed button's id, or null for Esc / backdrop. */
    public ask<T extends string>(options: AskOptions<T>): Promise<T | null> {
        return new Promise(resolve => {
            this._push({ id: this._nextId++, kind: 'ask', options, resolve: resolve as (id: string | null) => void });
        });
    }

    /** One button; resolves when it is dismissed. */
    public async alert(title: string, message: string | undefined, okLabel: string): Promise<void> {
        await this.ask({ title, message, buttons: [{ id: 'ok', label: okLabel, kind: 'primary' }] });
    }

    public async confirm(options: {
        title: string; message?: string; confirmLabel: string; cancelLabel: string; danger?: boolean;
    }): Promise<boolean> {
        const answer = await this.ask({
            title: options.title,
            message: options.message,
            buttons: [
                { id: 'cancel', label: options.cancelLabel },
                { id: 'ok', label: options.confirmLabel, kind: options.danger ? 'danger' : 'primary' },
            ],
        });
        return answer === 'ok';
    }

    /** Text input. Resolves to the entered text, or null if cancelled. */
    public prompt(options: PromptOptions): Promise<string | null> {
        return new Promise(resolve => {
            this._push({ id: this._nextId++, kind: 'prompt', options, resolve });
        });
    }

    /**
     * Opens a component as a dialog. It receives `inputs` and may inject
     * {@link DIALOG_REF} to close itself with a result.
     */
    public open<R = unknown>(
        title: string,
        component: Type<unknown>,
        inputs: Record<string, unknown> = {},
    ): Promise<R | undefined> {
        return new Promise(resolve => {
            const id = this._nextId++;
            const ref = new DialogRef<R>(result => this._close(id, result));
            this._push({
                id, kind: 'custom', title, component, inputs, ref: ref as DialogRef,
                resolve: resolve as (value: unknown) => void,
            });
        });
    }

    /** Closes a dialog with its dismissal value (`null` / `undefined`). Used by the host for Esc and the backdrop. */
    public dismiss(entry: DialogEntry): void {
        this._close(entry.id, entry.kind === 'custom' ? undefined : null);
    }

    /** Resolves a dialog with a value. Used by the host for the answer the user chose. */
    public settle(entry: DialogEntry, value: string | null): void {
        this._close(entry.id, value);
    }

    private _push(entry: DialogEntry): void {
        this.stack.update(list => [...list, entry]);
    }

    private _close(id: number, value: unknown): void {
        const entry = this.stack().find(e => e.id === id);
        if (!entry) return;
        this.stack.update(list => list.filter(e => e.id !== id));
        (entry.resolve as (v: unknown) => void)(value);
    }
}
