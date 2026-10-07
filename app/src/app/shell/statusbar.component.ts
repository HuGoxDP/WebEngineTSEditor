import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HistoryService } from '../services/history.service';
import { PlayModeService } from '../services/play-mode.service';
import { SceneService } from '../services/scene.service';
import { SelectionService } from '../services/selection.service';
import { ViewportService } from '../viewport.service';
import { I18nService } from '../i18n/i18n.service';
import { TPipe } from '../i18n/t.pipe';

/** Ready / playing, object count, saved state, frame rate. */
@Component({
    selector: 'app-statusbar',
    standalone: true,
    imports: [TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { style: 'display: contents' },
    template: `
        <footer class="statusbar">
            <div class="st">
                <span class="dot" [class.ok]="!play.isPlaying()" [class.live]="play.isPlaying()"></span>
                {{ (play.isPlaying() ? 'status.playing' : 'status.ready') | t }}
            </div>
            <div class="st">{{ objectCount() }}</div>
            @if (selection.count() > 1) {
                <div class="st accent">{{ selectedCount() }}</div>
            }
            <div class="st accent">{{ (history.canUndo() ? 'status.unsaved' : 'status.saved') | t }}</div>
            <div class="spacer"></div>
            <div class="st" [title]="'status.fps' | t">
                <span style="opacity:0.7">FPS</span>&nbsp;{{ viewport.fps() || '—' }}
            </div>
            <div class="st" [title]="'status.frameTime' | t">
                <span style="opacity:0.7">Δt</span>&nbsp;{{ viewport.frameMs() || 0 }}ms
            </div>
            <div class="st">TypeScript · WebEngineTS 0.1.0</div>
        </footer>
    `,
})
export class StatusbarComponent {
    public readonly play = inject(PlayModeService);
    public readonly history = inject(HistoryService);
    public readonly selection = inject(SelectionService);
    public readonly viewport = inject(ViewportService);
    private readonly _scene = inject(SceneService);
    private readonly _i18n = inject(I18nService);

    public readonly objectCount = computed(() => {
        this._scene.revision();
        const count = (list: ReadonlyArray<{ transform: { childCount: number; getChild(i: number): any } }>): number => {
            let sum = 0;
            for (const g of list) {
                sum += 1;
                for (let i = 0; i < g.transform.childCount; i++) sum += count([g.transform.getChild(i).gameObject]);
            }
            return sum;
        };
        return this._i18n.tp('status.objects', count(this._scene.roots()));
    });

    public readonly selectedCount = computed(() => this._i18n.tp('status.selected', this.selection.count()));
}
