import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { CommandsService } from './services/commands.service';
import { DialogHostComponent } from './dialogs/dialog-host.component';
import { TopbarComponent } from './shell/topbar.component';
import { WorkspaceComponent } from './shell/workspace.component';

/**
 * The editor shell: the frame every screen lives in, and the dialog layer.
 *
 * @remarks
 * Deliberately thin. What the editor does lives in `services/`, what it shows
 * in `shell/` and `panels/`.
 */
@Component({
    selector: 'app-root',
    standalone: true,
    imports: [TopbarComponent, WorkspaceComponent, DialogHostComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="app">
            <app-topbar></app-topbar>
            <app-workspace></app-workspace>
        </div>
        <app-dialog-host></app-dialog-host>
    `,
})
export class AppComponent {

    private readonly _cmd = inject(CommandsService);

    /**
     * Preferences are reachable from every screen and while typing, so this
     * listens here rather than with the workspace shortcuts, which stand down
     * in text fields and exist only while the workspace is on screen.
     */
    @HostListener('window:keydown', ['$event'])
    public onWindowKey(e: KeyboardEvent): void {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ',') {
            e.preventDefault();
            void this._cmd.openPreferences();
        }
    }

    /**
     * Suppresses the browser's own context menu inside the editor. Panels that
     * want a menu of their own call `preventDefault` themselves; this is the net
     * for everything else.
     */
    @HostListener('contextmenu', ['$event'])
    public onHostContextMenu(e: MouseEvent): void {
        e.preventDefault();
    }
}
