import { Injectable, effect, signal } from '@angular/core';

export type Language = 'uk' | 'en';
export type Theme = 'dark' | 'light';
export type Density = 'compact' | 'comfy';

const KEY = 'wets:settings:v1';

/** Everything the user can change in Preferences. */
export interface Settings {
    language: Language;
    theme: Theme;
    density: Density;
    /** Gizmo snap step in world units. `0` turns snapping off. */
    gridSnap: number;
    /** Writes `.editor/autosave.scene.json` while a scene has unsaved changes. */
    autosave: boolean;
    /** Asks before deleting objects and files. */
    confirmDelete: boolean;
}

function detectLanguage(): Language {
    return navigator.language?.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}

function defaults(): Settings {
    return {
        language: detectLanguage(),
        theme: 'dark',
        density: 'compact',
        gridSnap: 1,
        autosave: true,
        confirmDelete: true,
    };
}

/**
 * Editor preferences, kept in the browser.
 *
 * @remarks
 * These belong to the person, not to a project, so they are never written into
 * a project folder. Each setting is a signal; the service mirrors theme,
 * density and language onto `<html>` so the stylesheet and `lang` follow.
 * Panel sizes are not here — they are layout state, see `LayoutService`.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {

    public readonly language      = signal<Language>('en');
    public readonly theme         = signal<Theme>('dark');
    public readonly density       = signal<Density>('compact');
    public readonly gridSnap      = signal(1);
    public readonly autosave      = signal(true);
    public readonly confirmDelete = signal(true);

    constructor() {
        this._apply(this._load());

        effect(() => {
            const root = document.documentElement;
            root.dataset['theme'] = this.theme();
            root.dataset['density'] = this.density();
            root.lang = this.language();
        });

        effect(() => {
            try { localStorage.setItem(KEY, JSON.stringify(this.snapshot())); } catch { /* quota / private mode */ }
        });
    }

    public snapshot(): Settings {
        return {
            language: this.language(),
            theme: this.theme(),
            density: this.density(),
            gridSnap: this.gridSnap(),
            autosave: this.autosave(),
            confirmDelete: this.confirmDelete(),
        };
    }

    public reset(): void {
        this._apply(defaults());
    }

    private _apply(s: Settings): void {
        this.language.set(s.language);
        this.theme.set(s.theme);
        this.density.set(s.density);
        this.gridSnap.set(s.gridSnap);
        this.autosave.set(s.autosave);
        this.confirmDelete.set(s.confirmDelete);
    }

    /** Stored values, each checked — a hand-edited or older entry must not break startup. */
    private _load(): Settings {
        const out = defaults();
        try {
            const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
            if (!p || typeof p !== 'object') return out;
            if (p.language === 'uk' || p.language === 'en') out.language = p.language;
            if (p.theme === 'dark' || p.theme === 'light') out.theme = p.theme;
            if (p.density === 'compact' || p.density === 'comfy') out.density = p.density;
            if (typeof p.gridSnap === 'number' && p.gridSnap >= 0 && Number.isFinite(p.gridSnap)) out.gridSnap = p.gridSnap;
            if (typeof p.autosave === 'boolean') out.autosave = p.autosave;
            if (typeof p.confirmDelete === 'boolean') out.confirmDelete = p.confirmDelete;
        } catch {
            // Unreadable entry: defaults.
        }
        return out;
    }
}
