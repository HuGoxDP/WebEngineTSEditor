import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IconComponent } from '../icon.component';
import { CommandsService } from '../services/commands.service';
import { HistoryService } from '../services/history.service';
import { PlayModeService } from '../services/play-mode.service';
import { TPipe } from '../i18n/t.pipe';

/** Undo / redo, play and stop, new / open / save. */
@Component({
    selector: 'app-toolbar',
    standalone: true,
    imports: [IconComponent, TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { style: 'display: contents' },
    template: `
        <header class="toolbar">
            <div class="tb-group">
                <button class="tb-btn"
                    [disabled]="!history.canUndo()"
                    (click)="history.undo()" [title]="'toolbar.undo' | t">
                    <wets-icon name="undo"></wets-icon>
                </button>
                <button class="tb-btn"
                    [disabled]="!history.canRedo()"
                    (click)="history.redo()" [title]="'toolbar.redo' | t">
                    <wets-icon name="redo"></wets-icon>
                </button>
            </div>
            <div class="tb-sep"></div>
            <div class="tb-group">
                <button class="tb-btn primary"
                    [class.playing]="play.isPlaying()"
                    [disabled]="play.isPlaying()"
                    (click)="play.play()" [title]="'toolbar.play' | t">
                    <wets-icon name="play"></wets-icon>
                </button>
                <button class="tb-btn"
                    [disabled]="!play.isPlaying()"
                    (click)="play.stop()" [title]="'toolbar.stop' | t">
                    <wets-icon name="stop"></wets-icon>
                </button>
            </div>
            <div class="tb-sep"></div>
            <div class="tb-group">
                <button class="tb-btn" (click)="cmd.newScene()" [title]="'toolbar.newScene' | t">
                    <wets-icon name="file-new"></wets-icon>
                </button>
                <button class="tb-btn" (click)="cmd.openSceneFile()" [title]="'toolbar.open' | t">
                    <wets-icon name="folder"></wets-icon>
                </button>
                <button class="tb-btn" (click)="cmd.save()" [title]="'toolbar.save' | t">
                    <wets-icon name="save"></wets-icon>
                </button>
            </div>

            <div class="tb-spacer"></div>

            @if (play.isPlaying()) {
                <div class="tb-live"><span class="rec"></span>{{ 'toolbar.live' | t }}</div>
            }
        </header>
    `,
})
export class ToolbarComponent {
    public readonly history = inject(HistoryService);
    public readonly play = inject(PlayModeService);
    public readonly cmd = inject(CommandsService);
}
