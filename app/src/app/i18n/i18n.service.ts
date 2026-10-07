import { Injectable, inject } from '@angular/core';
import { SettingsService } from '../services/settings.service';
import { en, type MessageKey, type PluralBase } from './en';
import { uk } from './uk';

export type { MessageKey, PluralBase } from './en';

const DICTIONARIES = { en, uk } as const;

/**
 * Looks up interface text in the current language.
 *
 * @remarks
 * Angular's built-in i18n picks a language at build time; this reads a signal,
 * so changing the language in Preferences repaints the interface at once and
 * the open scene is untouched. `t()` is called from templates, which makes each
 * binding depend on the language signal.
 *
 * Names that come from the engine — component and field names, engine log
 * messages — are not translated: they are what the API documentation calls them.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {

    private readonly _settings = inject(SettingsService);

    /**
     * @param key - a message key; a typo does not compile.
     * @param params - values for `{name}` placeholders in the message.
     */
    public t(key: MessageKey, params?: Record<string, string | number>): string {
        const dict: Record<string, string> = DICTIONARIES[this._settings.language()];
        let text = dict[key] ?? en[key];
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.replaceAll(`{${name}}`, String(value));
            }
        }
        return text;
    }

    /**
     * A message whose form depends on a count — "1 item", "2 items", and in
     * Ukrainian a third form for 2–4. The language's own plural rules choose
     * between the four `base.one|few|many|other` keys; `{n}` is the count.
     */
    public tp(base: PluralBase, n: number, params?: Record<string, string | number>): string {
        const category = new Intl.PluralRules(this._settings.language()).select(n);
        return this.t(`${base}.${category}` as MessageKey, { n, ...params });
    }
}
