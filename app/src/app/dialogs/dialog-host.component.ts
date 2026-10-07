import {
    ChangeDetectionStrategy,
    Component,
    Directive,
    ElementRef,
    HostListener,
    Injector,
    Input,
    OnInit,
    effect,
    inject,
    signal,
    untracked,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { I18nService } from '../i18n/i18n.service';
import { TPipe } from '../i18n/t.pipe';
import { DIALOG_REF, DialogService, type DialogEntry } from './dialog.service';

/** Puts focus on its element when it appears — the dialog's first field or its main button. */
@Directive({ selector: '[dlgFocus]', standalone: true })
export class DlgFocusDirective implements OnInit {
    private readonly _el = inject<ElementRef<HTMLElement>>(ElementRef);

    /** Bare attribute focuses; a bound `false` leaves focus alone. */
    @Input() public dlgFocus: boolean | '' = '';

    ngOnInit(): void {
        if (this.dlgFocus === false) return;
        // After the dialog is in the DOM and laid out.
        setTimeout(() => {
            const el = this._el.nativeElement;
            el.focus();
            if (el instanceof HTMLInputElement) el.select();
        });
    }
}

/**
 * Draws the dialogs of {@link DialogService}. Mounted once, in the shell.
 *
 * Only the top dialog takes input; those beneath stay mounted, so a dialog
 * that opened another keeps what the user had typed into it.
 */
@Component({
    selector: 'app-dialog-host',
    standalone: true,
    imports: [NgComponentOutlet, TPipe, DlgFocusDirective],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @for (d of dialog.stack(); track d.id; let top = $last) {
            <div class="dlg-backdrop" [class.under]="!top" (mousedown)="onBackdrop($event, d)">
                <div class="dlg" role="dialog" aria-modal="true" [attr.aria-label]="titleOf(d)">
                    <div class="dlg-head">
                        <span class="dlg-title">{{ titleOf(d) }}</span>
                        @if (d.kind === 'custom') {
                            <button class="dlg-x" [attr.aria-label]="'dialog.close' | t" (click)="dialog.dismiss(d)">✕</button>
                        }
                    </div>

                    @switch (d.kind) {
                        @case ('ask') {
                            <div class="dlg-body">
                                @if (d.options.message) { <p class="dlg-msg">{{ d.options.message }}</p> }
                            </div>
                            <div class="dlg-foot">
                                @for (b of d.options.buttons; track b.id) {
                                    <button class="dlg-btn" [class.primary]="b.kind === 'primary'" [class.danger]="b.kind === 'danger'"
                                        [attr.data-id]="b.id"
                                        [dlgFocus]="b.kind === 'primary'"
                                        (click)="dialog.settle(d, b.id)">{{ b.label }}</button>
                                }
                            </div>
                        }
                        @case ('prompt') {
                            <div class="dlg-body">
                                @if (d.options.label) { <label class="dlg-label" [attr.for]="'dlg-in-' + d.id">{{ d.options.label }}</label> }
                                <input class="dlg-input" dlgFocus [id]="'dlg-in-' + d.id" type="text" spellcheck="false"
                                    [value]="promptValue(d)"
                                    (input)="setPrompt(d, $any($event.target).value)"
                                    (keydown.enter)="$event.preventDefault(); submitPrompt(d)">
                                @if (promptError(d); as err) { <div class="dlg-error">{{ err }}</div> }
                            </div>
                            <div class="dlg-foot">
                                <button class="dlg-btn" (click)="dialog.dismiss(d)">{{ d.options.cancelLabel }}</button>
                                <button class="dlg-btn primary" [disabled]="!!promptError(d)" (click)="submitPrompt(d)">{{ d.options.confirmLabel }}</button>
                            </div>
                        }
                        @case ('custom') {
                            <div class="dlg-custom">
                                <ng-container *ngComponentOutlet="d.component; inputs: d.inputs; injector: injectorFor(d)"></ng-container>
                            </div>
                        }
                    }
                </div>
            </div>
        }
    `,
    styles: [`
        .dlg-backdrop {
            position: fixed; inset: 0; z-index: 1000;
            display: grid; place-items: center;
            background: rgba(0, 0, 0, 0.5);
        }
        .dlg-backdrop.under { visibility: hidden; }
        .dlg {
            min-width: 340px; max-width: min(560px, 92vw); max-height: 90vh;
            display: flex; flex-direction: column;
            background: var(--bg-1); color: var(--fg-0);
            border: 1px solid var(--line-2); border-radius: var(--radius-lg);
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
            user-select: text;
        }
        .dlg-head {
            display: flex; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid var(--line);
        }
        .dlg-title { font-size: 13px; font-weight: 600; flex: 1; }
        .dlg-x { width: 22px; height: 22px; color: var(--fg-2); border-radius: var(--radius); }
        .dlg-x:hover { background: var(--bg-3); color: var(--fg-0); }
        .dlg-body { padding: 14px; display: flex; flex-direction: column; gap: 8px; }
        .dlg-msg { margin: 0; line-height: 1.5; color: var(--fg-1); white-space: pre-line; }
        .dlg-label { font-size: 11px; color: var(--fg-2); }
        .dlg-input {
            height: 28px; padding: 0 8px;
            background: var(--bg-2); color: var(--fg-0);
            border: 1px solid var(--line-2); border-radius: var(--radius);
            font: inherit; user-select: text;
        }
        .dlg-input:focus { outline: none; border-color: var(--accent); }
        .dlg-error { font-size: 11px; color: var(--err); }
        .dlg-foot {
            display: flex; justify-content: flex-end; gap: 8px;
            padding: 10px 14px; border-top: 1px solid var(--line);
        }
        .dlg-btn {
            height: 26px; padding: 0 14px;
            background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius);
        }
        .dlg-btn:hover:not([disabled]) { background: var(--bg-4); }
        .dlg-btn[disabled] { opacity: 0.5; cursor: default; }
        .dlg-btn.primary { background: var(--accent); border-color: transparent; color: #121318; font-weight: 600; }
        .dlg-btn.primary:hover:not([disabled]) { background: var(--accent-600); }
        .dlg-btn.danger { background: var(--err); border-color: transparent; color: #121318; font-weight: 600; }
        .dlg-custom { display: flex; flex-direction: column; min-height: 0; }
    `],
})
export class DialogHostComponent {

    public readonly dialog = inject(DialogService);
    private readonly _i18n = inject(I18nService);
    private readonly _injector = inject(Injector);

    private readonly _promptValues = signal<Record<number, string>>({});
    private readonly _injectors = new Map<number, Injector>();
    private _returnFocus: HTMLElement | null = null;

    constructor() {
        // Focus goes back to where it was when the last dialog closes.
        let previous = 0;
        effect(() => {
            const count = this.dialog.stack().length;
            untracked(() => {
                if (previous === 0 && count > 0) this._returnFocus = document.activeElement as HTMLElement | null;
                if (previous > 0 && count === 0) {
                    this._returnFocus?.focus?.();
                    this._returnFocus = null;
                }
                previous = count;
            });
        });
    }

    public titleOf(d: DialogEntry): string {
        return d.kind === 'custom' ? d.title : d.options.title;
    }

    public onBackdrop(e: MouseEvent, d: DialogEntry): void {
        if (e.target !== e.currentTarget) return;
        // A message that asks a question is not dismissed by a stray click.
        if (d.kind === 'ask' && d.options.buttons.length > 1) return;
        this.dialog.dismiss(d);
    }

    @HostListener('document:keydown', ['$event'])
    public onKey(e: KeyboardEvent): void {
        const stack = this.dialog.stack();
        const top = stack[stack.length - 1];
        if (!top) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.dialog.dismiss(top);
        } else if (e.key === 'Enter' && top.kind === 'ask' && !(e.target instanceof HTMLButtonElement)) {
            // Only a primary button answers Enter: a destructive one must be chosen on purpose.
            const primary = top.options.buttons.find(b => b.kind === 'primary');
            if (primary) {
                e.preventDefault();
                this.dialog.settle(top, primary.id);
            }
        }
    }

    // ── prompt ───────────────────────────────────────────────────────

    public promptValue(d: DialogEntry): string {
        if (d.kind !== 'prompt') return '';
        return this._promptValues()[d.id] ?? d.options.value ?? '';
    }

    public setPrompt(d: DialogEntry, value: string): void {
        this._promptValues.update(v => ({ ...v, [d.id]: value }));
    }

    public promptError(d: DialogEntry): string | null {
        if (d.kind !== 'prompt') return null;
        const value = this.promptValue(d).trim();
        if (value === '') return this._i18n.t('dialog.valueRequired');
        return d.options.validate?.(value) ?? null;
    }

    /**
     * Confirms a prompt. The Enter handler must also `preventDefault`: closing
     * the dialog hands focus back to the button that opened it before the
     * browser dispatches `keypress`, and Enter on a focused button clicks it —
     * which reopened the dialog.
     */
    public submitPrompt(d: DialogEntry): void {
        if (d.kind !== 'prompt' || this.promptError(d)) return;
        this.dialog.settle(d, this.promptValue(d).trim());
    }

    // ── custom ───────────────────────────────────────────────────────

    /** One injector per dialog, so the component outlet is not rebuilt on every change detection. */
    public injectorFor(d: DialogEntry): Injector {
        if (d.kind !== 'custom') return this._injector;
        let injector = this._injectors.get(d.id);
        if (!injector) {
            injector = Injector.create({ providers: [{ provide: DIALOG_REF, useValue: d.ref }], parent: this._injector });
            this._injectors.set(d.id, injector);
        }
        return injector;
    }
}
