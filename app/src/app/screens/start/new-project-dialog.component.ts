import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DIALOG_REF, type DialogRef } from '../../dialogs/dialog.service';
import { DlgFocusDirective } from '../../dialogs/dialog-host.component';
import { I18nService, type MessageKey } from '../../i18n/i18n.service';
import { TPipe } from '../../i18n/t.pipe';
import {
    ID_PATTERN,
    PROJECT_CATEGORIES,
    folderNameFor,
    folderNameProblem,
    slugify,
    type ProjectCategory,
    type ProjectMeta,
    type TemplateId,
} from '../../services/project-templates';
import { ProjectService, type ProjectFolderHandle } from '../../services/project.service';

/** Everything the wizard collected — enough to create the project without asking again. */
export interface NewProjectResult {
    meta: ProjectMeta;
    template: TemplateId;
    /** The folder the user chose; the project goes in a new folder inside it. */
    parent: ProjectFolderHandle;
    folderName: string;
}

type Step = 1 | 2 | 3;

const CATEGORY_LABEL: Record<ProjectCategory, MessageKey> = {
    education: 'wiz.cat.education',
    demo: 'wiz.cat.demo',
    interactive: 'wiz.cat.interactive',
    simulation: 'wiz.cat.simulation',
};

/**
 * New-project wizard: what it is, what to start from, where to keep it.
 *
 * @remarks
 * Three short steps rather than one long form, so each answer can be checked
 * where it is given. The address and the folder name follow the title until the
 * person edits them — then they are theirs and stop following.
 *
 * It only collects. Creating the folder, the layout and the first scene is the
 * caller's job, so cancelling at any step leaves nothing on disk.
 */
@Component({
    selector: 'app-new-project-dialog',
    standalone: true,
    imports: [TPipe, DlgFocusDirective],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="wiz">
            <div class="wiz-steps" aria-live="polite">
                <span class="wiz-count">{{ 'wiz.step' | t: { n: step(), total: 3 } }}</span>
                <strong>{{ stepTitle() }}</strong>
            </div>

            @switch (step()) {
                @case (1) {
                    <div class="wiz-field">
                        <label for="wiz-name">{{ 'wiz.name' | t }}</label>
                        <input id="wiz-name" dlgFocus type="text" spellcheck="false"
                            [value]="name()"
                            (input)="name.set($any($event.target).value)"
                            (keydown.enter)="$event.preventDefault(); next()">
                        @if (touched() && !name().trim()) { <span class="wiz-error">{{ 'wiz.nameRequired' | t }}</span> }
                    </div>

                    <div class="wiz-field">
                        <label for="wiz-id">{{ 'wiz.id' | t }}</label>
                        <input id="wiz-id" class="mono" type="text" spellcheck="false"
                            [value]="idShown()"
                            (input)="setId($any($event.target).value)">
                        @if (idShown() && !idValid()) {
                            <span class="wiz-error">{{ 'wiz.idInvalid' | t }}</span>
                        } @else {
                            <span class="wiz-hint">{{ 'wiz.idHint' | t: { id: idShown() || '…' } }}</span>
                        }
                    </div>

                    <div class="wiz-field">
                        <label for="wiz-desc">{{ 'wiz.description' | t }}</label>
                        <textarea id="wiz-desc" rows="3"
                            [value]="description()"
                            (input)="description.set($any($event.target).value)"></textarea>
                        <span class="wiz-hint">{{ 'wiz.descriptionHint' | t }}</span>
                    </div>

                    <div class="wiz-field">
                        <label for="wiz-cat">{{ 'wiz.category' | t }}</label>
                        <select id="wiz-cat" (change)="category.set($any($event.target).value)">
                            @for (c of CATEGORIES; track c) {
                                <option [value]="c" [selected]="category() === c">{{ CATEGORY_LABEL[c] | t }}</option>
                            }
                        </select>
                    </div>
                }

                @case (2) {
                    <div class="wiz-cards" role="radiogroup">
                        <button class="wiz-card" role="radio" [class.on]="template() === 'lightCamera'"
                            [attr.aria-checked]="template() === 'lightCamera'" (click)="template.set('lightCamera')">
                            <strong>{{ 'wiz.tpl.lightCamera' | t }}</strong>
                            <span>{{ 'wiz.tpl.lightCameraHint' | t }}</span>
                        </button>
                        <button class="wiz-card" role="radio" [class.on]="template() === 'empty'"
                            [attr.aria-checked]="template() === 'empty'" (click)="template.set('empty')">
                            <strong>{{ 'wiz.tpl.empty' | t }}</strong>
                            <span>{{ 'wiz.tpl.emptyHint' | t }}</span>
                        </button>
                    </div>
                }

                @case (3) {
                    <div class="wiz-field">
                        <span class="lbl">{{ 'wiz.location' | t }}</span>
                        <div class="wiz-pick">
                            <button class="wiz-btn" (click)="choose()">{{ 'wiz.choose' | t }}</button>
                            <span class="wiz-parent" [class.none]="!parent()">{{ parent()?.name ?? ('wiz.locationNone' | t) }}</span>
                        </div>
                        <span class="wiz-hint">{{ 'wiz.locationHint' | t }}</span>
                    </div>

                    <div class="wiz-field">
                        <label for="wiz-folder">{{ 'wiz.folderName' | t }}</label>
                        <input id="wiz-folder" type="text" spellcheck="false"
                            [value]="folderShown()"
                            (input)="setFolder($any($event.target).value)"
                            (keydown.enter)="$event.preventDefault(); next()">
                        @if (folderError(); as e) { <span class="wiz-error">{{ e }}</span> }
                    </div>

                    @if (parent() && !folderError()) {
                        <p class="wiz-summary">{{ 'wiz.willCreate' | t: { path: parent()!.name + ' / ' + folderShown() } }}</p>
                    }
                }
            }
        </div>

        <div class="dlg-foot">
            <button class="dlg-btn" (click)="ref.close()">{{ 'dialog.cancel' | t }}</button>
            <span class="grow"></span>
            @if (step() > 1) {
                <button class="dlg-btn" [disabled]="busy()" (click)="back()">{{ 'wiz.back' | t }}</button>
            }
            <button class="dlg-btn primary" [disabled]="busy()" (click)="next()">
                {{ (step() === 3 ? 'wiz.create' : 'wiz.next') | t }}
            </button>
        </div>
    `,
    styles: [`
        :host { display: flex; flex-direction: column; min-height: 0; }
        .wiz { width: min(540px, 90vw); min-height: 320px; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
        .wiz-steps { display: flex; align-items: baseline; gap: 10px; }
        .wiz-count { font-size: 11px; color: var(--fg-2); }
        .wiz-field { display: flex; flex-direction: column; gap: 4px; }
        .wiz-field label, .wiz-field .lbl { color: var(--fg-1); font-size: 11px; }
        .wiz-field input, .wiz-field textarea, .wiz-field select {
            padding: 6px 8px; background: var(--bg-2); color: var(--fg-0);
            border: 1px solid var(--line-2); border-radius: var(--radius); font: inherit; user-select: text;
        }
        .wiz-field textarea { resize: vertical; }
        .wiz-field input:focus, .wiz-field textarea:focus, .wiz-field select:focus { outline: none; border-color: var(--accent); }
        .mono { font-family: "JetBrains Mono", monospace; }
        .wiz-hint { font-size: 11px; color: var(--fg-2); }
        .wiz-error { font-size: 11px; color: var(--err); }
        .wiz-cards { display: flex; flex-direction: column; gap: 10px; }
        .wiz-card {
            display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 12px 14px;
            background: var(--bg-2); border: 1px solid var(--line-2); border-radius: var(--radius-lg);
        }
        .wiz-card span { color: var(--fg-2); font-size: 11px; }
        .wiz-card:hover { border-color: var(--accent); }
        .wiz-card.on { border-color: var(--accent); background: var(--accent-bg); }
        .wiz-pick { display: flex; align-items: center; gap: 10px; }
        .wiz-parent { font-weight: 600; }
        .wiz-parent.none { color: var(--fg-3); font-weight: 400; font-style: italic; }
        .wiz-summary { margin: 0; padding: 8px 10px; background: var(--bg-2); border-radius: var(--radius); color: var(--fg-1); font-family: "JetBrains Mono", monospace; font-size: 11px; }
        .wiz-btn, .dlg-btn {
            height: 26px; padding: 0 14px;
            background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius);
        }
        .wiz-btn:hover, .dlg-btn:hover:not([disabled]) { background: var(--bg-4); }
        .dlg-btn[disabled] { opacity: 0.5; cursor: default; }
        .dlg-btn.primary { background: var(--accent); border-color: transparent; color: #121318; font-weight: 600; }
        .dlg-btn.primary:hover:not([disabled]) { background: var(--accent-600); }
        .dlg-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
        .grow { flex: 1; }
    `],
})
export class NewProjectDialogComponent {

    public readonly ref = inject(DIALOG_REF) as DialogRef<NewProjectResult>;
    private readonly _project = inject(ProjectService);
    private readonly _i18n = inject(I18nService);

    public readonly CATEGORIES = PROJECT_CATEGORIES;
    public readonly CATEGORY_LABEL = CATEGORY_LABEL;

    public readonly step = signal<Step>(1);
    public readonly busy = signal(false);
    /** Set once the person has tried to go past step 1, so an untouched form does not open with an error. */
    public readonly touched = signal(false);

    public readonly name = signal('');
    public readonly description = signal('');
    public readonly category = signal<ProjectCategory>('education');
    public readonly template = signal<TemplateId>('lightCamera');
    public readonly parent = signal<ProjectFolderHandle | null>(null);

    /** An address typed by hand. `null` while it still follows the title. */
    private readonly _id = signal<string | null>(null);
    private readonly _folder = signal<string | null>(null);
    private readonly _taken = signal(false);

    public readonly idShown = computed(() =>
        this._id() ?? (this.name().trim() ? slugify(this.name()) : ''));
    public readonly idValid = computed(() => ID_PATTERN.test(this.idShown()));

    public readonly folderShown = computed(() =>
        this._folder() ?? (this.name().trim() ? folderNameFor(this.name()) : ''));

    /** Why the folder name cannot be used, in words — or null. */
    public readonly folderError = computed<string | null>(() => {
        const problem = folderNameProblem(this.folderShown());
        if (problem === 'empty') return this.parent() || this._folder() !== null ? this._i18n.t('wiz.folderEmpty') : null;
        if (problem === 'characters') return this._i18n.t('wiz.folderCharacters');
        if (this._taken()) {
            return this._i18n.t('wiz.folderTaken', { name: this.folderShown(), parent: this.parent()?.name ?? '' });
        }
        return null;
    });

    public readonly stepTitle = computed(() => this._i18n.t(
        this.step() === 1 ? 'wiz.stepDetails' : this.step() === 2 ? 'wiz.stepTemplate' : 'wiz.stepLocation'));

    public setId(value: string): void { this._id.set(value); }

    public setFolder(value: string): void {
        this._folder.set(value);
        this._taken.set(false);
    }

    public async choose(): Promise<void> {
        const handle = await this._project.pickFolder();
        if (!handle) return;
        this.parent.set(handle);
        this._taken.set(false);
    }

    public back(): void {
        this.step.update(s => (s > 1 ? (s - 1) as Step : s));
    }

    public async next(): Promise<void> {
        const step = this.step();
        if (step === 1) {
            this.touched.set(true);
            if (!this.name().trim() || !this.idValid()) return;
            this.step.set(2);
        } else if (step === 2) {
            this.step.set(3);
        } else {
            await this._create();
        }
    }

    private async _create(): Promise<void> {
        const parent = this.parent();
        const folderName = this.folderShown().trim();
        if (!parent || folderNameProblem(folderName)) return;

        this.busy.set(true);
        try {
            if (await this._project.folderState(parent, folderName) === 'taken') {
                this._taken.set(true);
                return;
            }
            this.ref.close({
                meta: {
                    id: this.idShown(),
                    name: this.name().trim(),
                    description: this.description().trim() || undefined,
                    category: this.category(),
                    version: '1.0.0',
                },
                template: this.template(),
                parent,
                folderName,
            });
        } finally {
            this.busy.set(false);
        }
    }
}
