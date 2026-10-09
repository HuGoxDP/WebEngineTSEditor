import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IconComponent } from '../../icon.component';
import { TPipe } from '../../i18n/t.pipe';
import { AppStateService } from '../../services/app-state.service';
import { CommandsService } from '../../services/commands.service';
import { ProjectService, type RecentProject } from '../../services/project.service';
import { SettingsService, type Language } from '../../services/settings.service';

/**
 * The first thing a person sees: create a project or open one.
 *
 * @remarks
 * The editor has nothing to show until a project is open, so this is the whole
 * screen — no panels behind it. The language switch is here, outside
 * Preferences, because someone who cannot read the interface cannot be asked to
 * find a settings dialog in it first.
 */
@Component({
    selector: 'app-start-screen',
    standalone: true,
    imports: [IconComponent, TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { style: 'display: contents' },
    template: `
        <main class="start">
            <div class="start-card">
                <header class="start-head">
                    <span class="brand-mark big"></span>
                    <h1>{{ 'start.heading' | t }}</h1>
                    <p>{{ 'start.tagline' | t }}</p>
                </header>

                @if (state.screen() === 'unsupported') {
                    <div class="start-unsupported" role="alert">
                        <strong>{{ 'proj.unsupportedTitle' | t }}</strong>
                        <span>{{ 'proj.unsupportedHint' | t }}</span>
                    </div>
                } @else {
                    <div class="start-actions">
                        <button class="start-action primary" (click)="cmd.createProject()">
                            <wets-icon name="plus"></wets-icon>
                            <span><strong>{{ 'start.create' | t }}</strong><small>{{ 'start.createHint' | t }}</small></span>
                        </button>
                        <button class="start-action" (click)="cmd.openProject()">
                            <wets-icon name="folder"></wets-icon>
                            <span><strong>{{ 'start.open' | t }}</strong><small>{{ 'start.openHint' | t }}</small></span>
                        </button>
                    </div>

                    <section class="start-recent">
                        <h2>{{ 'start.recent' | t }}</h2>
                        @for (r of project.recents(); track r.id) {
                            <div class="recent" role="button" tabindex="0"
                                (click)="cmd.openRecent(r)"
                                (keydown.enter)="cmd.openRecent(r)">
                                <wets-icon name="folder"></wets-icon>
                                <span class="rname">{{ r.name }}</span>
                                <span class="rwhen">{{ when(r) }}</span>
                                <button class="rforget" [title]="'start.forget' | t" [attr.aria-label]="'start.forget' | t"
                                    (click)="forget($event, r)">✕</button>
                            </div>
                        } @empty {
                            <p class="start-muted">{{ 'start.recentEmpty' | t }}</p>
                        }
                    </section>
                }

                <footer class="start-foot">
                    <p>{{ 'start.footer' | t }}</p>
                    <div class="start-lang" role="group" [attr.aria-label]="'start.language' | t">
                        @for (l of LANGUAGES; track l.id) {
                            <button [class.on]="settings.language() === l.id"
                                [attr.aria-pressed]="settings.language() === l.id"
                                (click)="settings.language.set(l.id)">{{ l.name }}</button>
                        }
                    </div>
                </footer>
                <p class="start-narrow">{{ 'start.narrow' | t }}</p>
            </div>
        </main>
    `,
})
export class StartScreenComponent {

    public readonly state = inject(AppStateService);
    public readonly cmd = inject(CommandsService);
    public readonly project = inject(ProjectService);
    public readonly settings = inject(SettingsService);

    /** Languages are named in themselves, so each is findable from the other. */
    public readonly LANGUAGES: ReadonlyArray<{ id: Language; name: string }> = [
        { id: 'uk', name: 'Українська' },
        { id: 'en', name: 'English' },
    ];

    /** "2 hours ago", "yesterday" — in the interface language. */
    public when(r: RecentProject): string {
        const seconds = Math.round((r.openedAt - Date.now()) / 1000);
        const format = new Intl.RelativeTimeFormat(this.settings.language(), { numeric: 'auto' });
        const steps: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
            ['day', 86400], ['hour', 3600], ['minute', 60],
        ];
        for (const [unit, size] of steps) {
            if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
        }
        return format.format(0, 'second');
    }

    public forget(e: Event, r: RecentProject): void {
        e.stopPropagation();
        void this.project.forgetRecent(r.id);
    }
}
