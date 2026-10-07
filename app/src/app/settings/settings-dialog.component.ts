import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BuildInfo } from 'WebEngineTS';
import { DIALOG_REF } from '../dialogs/dialog.service';
import { I18nService, type MessageKey } from '../i18n/i18n.service';
import { TPipe } from '../i18n/t.pipe';
import { SettingsService, type Density, type Language, type Theme } from '../services/settings.service';

type Section = 'general' | 'editor' | 'shortcuts' | 'about';

const SECTIONS: ReadonlyArray<{ id: Section; label: MessageKey }> = [
    { id: 'general',   label: 'prefs.general' },
    { id: 'editor',    label: 'prefs.editor' },
    { id: 'shortcuts', label: 'prefs.shortcuts' },
    { id: 'about',     label: 'prefs.about' },
];

/** Languages are named in themselves, so a person can find theirs in any current language. */
const LANGUAGES: ReadonlyArray<{ id: Language; name: string }> = [
    { id: 'uk', name: 'Українська' },
    { id: 'en', name: 'English' },
];

const SHORTCUTS: ReadonlyArray<{ label: MessageKey; keys: string }> = [
    { label: 'file.save',            keys: 'Ctrl+S' },
    { label: 'file.saveAs',          keys: 'Ctrl+Shift+S' },
    { label: 'file.openScene',       keys: 'Ctrl+O' },
    { label: 'edit.undo',            keys: 'Ctrl+Z' },
    { label: 'edit.redo',            keys: 'Ctrl+Shift+Z / Ctrl+Y' },
    { label: 'edit.cut',             keys: 'Ctrl+X' },
    { label: 'edit.copy',            keys: 'Ctrl+C' },
    { label: 'edit.paste',           keys: 'Ctrl+V' },
    { label: 'edit.duplicate',       keys: 'Ctrl+D' },
    { label: 'edit.delete',          keys: 'Del' },
    { label: 'edit.selectAll',       keys: 'Ctrl+A' },
    { label: 'edit.rename',          keys: 'F2' },
    { label: 'go.createEmpty',       keys: 'Alt+Shift+N' },
    { label: 'go.centerOnSelection', keys: 'F' },
    { label: 'tool.translate',       keys: 'W' },
    { label: 'tool.rotate',          keys: 'E' },
    { label: 'tool.scale',           keys: 'R' },
    { label: 'sc.preferences',       keys: 'Ctrl+,' },
];

/**
 * Preferences: language, theme, density, and the editor's own switches.
 *
 * @remarks
 * Opened over whatever is on screen, so nothing beneath it is reset. Every
 * change applies at once — there is no Save button, and the language switches
 * while the dialog is still open, which is how a person finds out it worked.
 */
@Component({
    selector: 'app-settings-dialog',
    standalone: true,
    imports: [TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="prefs">
            <nav class="prefs-nav" role="tablist">
                @for (s of SECTIONS; track s.id) {
                    <button class="prefs-tab" role="tab"
                        [class.active]="section() === s.id"
                        [attr.aria-selected]="section() === s.id"
                        (click)="section.set(s.id)">{{ s.label | t }}</button>
                }
            </nav>

            <div class="prefs-body" role="tabpanel">
                @switch (section()) {
                    @case ('general') {
                        <div class="prefs-row">
                            <label for="prefs-language">{{ 'prefs.language' | t }}</label>
                            <select id="prefs-language" [value]="settings.language()"
                                (change)="settings.language.set($any($event.target).value)">
                                @for (l of LANGUAGES; track l.id) {
                                    <option [value]="l.id" [selected]="settings.language() === l.id">{{ l.name }}</option>
                                }
                            </select>
                        </div>

                        <div class="prefs-row">
                            <span class="lbl">{{ 'prefs.theme' | t }}</span>
                            <div class="seg" role="radiogroup">
                                <button role="radio" [attr.aria-checked]="settings.theme() === 'dark'"
                                    [class.on]="settings.theme() === 'dark'" (click)="setTheme('dark')">{{ 'prefs.themeDark' | t }}</button>
                                <button role="radio" [attr.aria-checked]="settings.theme() === 'light'"
                                    [class.on]="settings.theme() === 'light'" (click)="setTheme('light')">{{ 'prefs.themeLight' | t }}</button>
                            </div>
                        </div>

                        <div class="prefs-row">
                            <span class="lbl">{{ 'prefs.density' | t }}</span>
                            <div class="seg" role="radiogroup">
                                <button role="radio" [attr.aria-checked]="settings.density() === 'compact'"
                                    [class.on]="settings.density() === 'compact'" (click)="setDensity('compact')">{{ 'prefs.densityCompact' | t }}</button>
                                <button role="radio" [attr.aria-checked]="settings.density() === 'comfy'"
                                    [class.on]="settings.density() === 'comfy'" (click)="setDensity('comfy')">{{ 'prefs.densityComfy' | t }}</button>
                            </div>
                        </div>

                        <p class="prefs-note">{{ 'prefs.storedLocally' | t }}</p>
                    }

                    @case ('editor') {
                        <div class="prefs-row">
                            <label for="prefs-snap">{{ 'prefs.gridSnap' | t }}</label>
                            <input id="prefs-snap" class="num" type="number" min="0" step="0.25"
                                [value]="settings.gridSnap()"
                                (change)="onSnap($any($event.target).value)">
                        </div>
                        <p class="prefs-hint">{{ 'prefs.gridSnapHint' | t }}</p>

                        <div class="prefs-row check">
                            <input id="prefs-autosave" type="checkbox" [checked]="settings.autosave()"
                                (change)="settings.autosave.set($any($event.target).checked)">
                            <label for="prefs-autosave">{{ 'prefs.autosave' | t }}</label>
                        </div>
                        <p class="prefs-hint">{{ 'prefs.autosaveHint' | t }}</p>

                        <div class="prefs-row check">
                            <input id="prefs-confirm" type="checkbox" [checked]="settings.confirmDelete()"
                                (change)="settings.confirmDelete.set($any($event.target).checked)">
                            <label for="prefs-confirm">{{ 'prefs.confirmDelete' | t }}</label>
                        </div>
                        <p class="prefs-hint">{{ 'prefs.confirmDeleteHint' | t }}</p>
                    }

                    @case ('shortcuts') {
                        <table class="prefs-keys">
                            @for (s of SHORTCUTS; track s.label) {
                                <tr><td>{{ s.label | t }}</td><td><kbd>{{ s.keys }}</kbd></td></tr>
                            }
                        </table>
                        <p class="prefs-hint">{{ 'prefs.shortcutsHint' | t }}</p>
                    }

                    @case ('about') {
                        <table class="prefs-keys">
                            <tr><td>{{ 'prefs.editorVersion' | t }}</td><td>0.1.0</td></tr>
                            <tr><td>{{ 'prefs.engineVersion' | t }}</td><td>{{ engineVersion }}</td></tr>
                            <tr><td>{{ 'prefs.engineBuilt' | t }}</td><td>{{ engineBuilt() }}</td></tr>
                        </table>
                    }
                }
            </div>
        </div>

        <div class="dlg-foot">
            <button class="dlg-btn" (click)="settings.reset()">{{ 'prefs.reset' | t }}</button>
            <span class="grow"></span>
            <button class="dlg-btn primary" (click)="ref.close()">{{ 'prefs.done' | t }}</button>
        </div>
    `,
    styles: [`
        :host { display: flex; flex-direction: column; min-height: 0; }
        .prefs { display: flex; min-height: 280px; width: min(620px, 90vw); }
        .prefs-nav {
            display: flex; flex-direction: column; gap: 2px;
            width: 140px; padding: 10px 8px;
            border-right: 1px solid var(--line); background: var(--bg-2);
        }
        .prefs-tab {
            text-align: left; padding: 6px 10px; border-radius: var(--radius); color: var(--fg-1);
        }
        .prefs-tab:hover { background: var(--bg-3); color: var(--fg-0); }
        .prefs-tab.active { background: var(--accent-bg-strong); color: var(--fg-0); font-weight: 600; }
        .prefs-body { flex: 1; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
        .prefs-row { display: flex; align-items: center; gap: 12px; }
        .prefs-row > label, .prefs-row > .lbl { width: 120px; color: var(--fg-1); }
        .prefs-row.check { gap: 8px; }
        .prefs-row.check > label { width: auto; color: var(--fg-0); }
        .prefs-row select, .prefs-row .num {
            height: 26px; padding: 0 8px;
            background: var(--bg-2); color: var(--fg-0);
            border: 1px solid var(--line-2); border-radius: var(--radius); font: inherit;
        }
        .prefs-row .num { width: 90px; }
        .seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: var(--radius); overflow: hidden; }
        .seg button { height: 26px; padding: 0 14px; background: var(--bg-2); color: var(--fg-1); }
        .seg button + button { border-left: 1px solid var(--line-2); }
        .seg button.on { background: var(--accent); color: #121318; font-weight: 600; }
        .prefs-hint { margin: -6px 0 4px 0; padding-left: 132px; font-size: 11px; color: var(--fg-2); }
        .prefs-row.check + .prefs-hint { padding-left: 24px; }
        .prefs-note { margin: auto 0 0; font-size: 11px; color: var(--fg-2); }
        .prefs-keys { border-collapse: collapse; width: 100%; }
        .prefs-keys td { padding: 4px 0; border-bottom: 1px solid var(--line); }
        .prefs-keys td:last-child { text-align: right; color: var(--fg-1); font-family: "JetBrains Mono", monospace; }
        .prefs-keys kbd { font: inherit; }
        .dlg-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
        .grow { flex: 1; }
        .dlg-btn {
            height: 26px; padding: 0 14px;
            background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius);
        }
        .dlg-btn:hover { background: var(--bg-4); }
        .dlg-btn.primary { background: var(--accent); border-color: transparent; color: #121318; font-weight: 600; }
        .dlg-btn.primary:hover { background: var(--accent-600); }
    `],
})
export class SettingsDialogComponent {

    public readonly settings = inject(SettingsService);
    public readonly ref = inject(DIALOG_REF);
    private readonly _i18n = inject(I18nService);

    public readonly SECTIONS = SECTIONS;
    public readonly LANGUAGES = LANGUAGES;
    public readonly SHORTCUTS = SHORTCUTS;

    public readonly section = signal<Section>('general');

    public readonly engineVersion = BuildInfo.version;
    public readonly engineBuilt = computed(() =>
        BuildInfo.builtAt ?? this._i18n.t('prefs.fromSource'));

    public setTheme(theme: Theme): void { this.settings.theme.set(theme); }
    public setDensity(density: Density): void { this.settings.density.set(density); }

    /** A cleared or negative field is not a step; keep what was there. */
    public onSnap(raw: string): void {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) this.settings.gridSnap.set(value);
    }
}
