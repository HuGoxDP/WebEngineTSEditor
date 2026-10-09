import { Injectable, computed, inject } from '@angular/core';
import { ProjectService } from './project.service';

/** Which screen the editor shows. */
export type AppScreen =
    /** The browser cannot give the editor a folder to work in. */
    | 'unsupported'
    /** Create or open a project. */
    | 'start'
    /** Editing the open project. */
    | 'workspace';

/**
 * Which screen is on, derived from whether a project is open.
 *
 * @remarks
 * There is no router: the editor has one address, and the screen is a function
 * of one fact. The rule it enforces is that **without an open project there is
 * nothing to edit**, so the workspace — and with it the WebGL context — exists
 * only while a project does. Play and publishing are modes inside the
 * workspace, not screens.
 */
@Injectable({ providedIn: 'root' })
export class AppStateService {

    private readonly _project = inject(ProjectService);

    public readonly screen = computed<AppScreen>(() => {
        switch (this._project.status()) {
            case 'unsupported': return 'unsupported';
            case 'open':        return 'workspace';
            default:            return 'start';
        }
    });
}
