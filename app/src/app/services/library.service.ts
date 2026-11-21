import { Injectable, inject } from '@angular/core';
import { TypeRegistry } from 'WebEngineTS';
import { ProjectService } from './project.service';
import { ScriptRuntimeService } from './script-runtime.service';
import { ROTATOR_SOURCE } from '../library/Rotator';
import { MOVER_SOURCE } from '../library/Mover';
import { CLICKABLE_SOURCE } from '../library/Clickable';
import { TOGGLE_VISIBILITY_SOURCE } from '../library/ToggleVisibility';
import { SHOW_TEXT_ON_CLICK_SOURCE } from '../library/ShowTextOnClick';
import { QUIZ_QUESTION_SOURCE } from '../library/QuizQuestion';
import { TIMER_SOURCE } from '../library/Timer';
import { FOLLOW_PATH_SOURCE } from '../library/FollowPath';
import { LOOK_AT_CAMERA_SOURCE } from '../library/LookAtCamera';
import { PLAY_ANIMATION_SOURCE } from '../library/PlayAnimation';

/** A behaviour the editor ships: its type name and the source it copies in. */
export interface LibraryEntry { name: string; source: string; }

/**
 * C4 phase 4 (D5): the ten behaviours "Add Component → Library" offers.
 * Adding one writes its source to `scripts/library/<Name>.ts` — a permanent
 * project file the author owns and can edit — so an entry is installed once
 * that file exists. The class also appears in the picker's Scripts category
 * via the TypeRegistry; the Library section lists only what is not installed,
 * and the Scripts list drops what the Library section already offers.
 */
@Injectable({ providedIn: 'root' })
export class LibraryService {
    private readonly _project = inject(ProjectService);
    private readonly _runtime = inject(ScriptRuntimeService);

    public static readonly CATALOG: readonly LibraryEntry[] = [
        { name: 'Rotator',          source: ROTATOR_SOURCE },
        { name: 'Mover',            source: MOVER_SOURCE },
        { name: 'Clickable',        source: CLICKABLE_SOURCE },
        { name: 'ToggleVisibility', source: TOGGLE_VISIBILITY_SOURCE },
        { name: 'ShowTextOnClick',  source: SHOW_TEXT_ON_CLICK_SOURCE },
        { name: 'QuizQuestion',     source: QUIZ_QUESTION_SOURCE },
        { name: 'Timer',            source: TIMER_SOURCE },
        { name: 'FollowPath',       source: FOLLOW_PATH_SOURCE },
        { name: 'LookAtCamera',     source: LOOK_AT_CAMERA_SOURCE },
        { name: 'PlayAnimation',    source: PLAY_ANIMATION_SOURCE },
    ];

    /** Where adding copies the source: a permanent project file, D5. */
    public static pathOf(name: string): string { return `scripts/library/${name}.ts`; }

    /** Installed = the file is on disk AND its class is registered. A registered
     *  class alone is not enough (the previous session's registry can outlive
     *  the project); neither is a stale or empty file whose class never loaded —
     *  that entry stays offered so the next add heals the file (C4 review). */
    public isInstalled(entry: LibraryEntry): boolean {
        return this._project.exists(LibraryService.pathOf(entry.name)) && this.ctorOf(entry.name) !== null;
    }

    /** The entries to offer in the Library section, matching the filter text.
     *  An entry the project's own scripts already provide — under any path,
     *  e.g. scripts/components/Rotator.ts — is not offered: the library must
     *  not shadow the author's script of the same name. */
    public offered(query: string): LibraryEntry[] {
        this._project.revision(); // re-read after a write adds the file
        // classNames also backs the picker's reactivity: the Scripts list
        // reads the registry, which no signal of its own backs.
        const classes = this._runtime.classNames();
        const q = query.toLowerCase().trim();
        return LibraryService.CATALOG.filter(e =>
            !this.isInstalled(e) && !classes.includes(e.name) && (!q || e.name.toLowerCase().includes(q)));
    }

    /** Names the Library section offers right now — excluded from Scripts. */
    public offeredNames(query: string): Set<string> {
        return new Set(this.offered(query).map(e => e.name));
    }

    /** The registered class of an installed behaviour, for attaching. */
    public ctorOf(name: string): (new (...args: any[]) => unknown) | null {
        return (TypeRegistry.get(name) as (new (...args: any[]) => unknown) | null) ?? null;
    }
}
