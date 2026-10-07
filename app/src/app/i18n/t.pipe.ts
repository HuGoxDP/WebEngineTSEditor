import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService, type MessageKey } from './i18n.service';

/**
 * `{{ 'menu.file' | t }}` — interface text in the current language.
 *
 * Impure on purpose: the result changes when the language does, while the key
 * stays the same, and a pure pipe would be cached against the key alone.
 * `I18nService.t` reads the language signal, so the binding is re-evaluated
 * when it changes.
 */
@Pipe({ name: 't', standalone: true, pure: false })
export class TPipe implements PipeTransform {
    private readonly _i18n = inject(I18nService);

    transform(key: MessageKey, params?: Record<string, string | number>): string {
        return this._i18n.t(key, params);
    }
}
