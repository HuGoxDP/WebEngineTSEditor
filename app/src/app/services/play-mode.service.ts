import { Injectable, NgZone, signal } from '@angular/core';
import {
    Animation,
    Application,
    EngineSettings,
    Physics,
    SceneManager,
    Time,
    type SerializedScene,
} from 'WebEngineTS';
import { SceneService } from './scene.service';
import { SelectionService } from './selection.service';

/**
 * The editor's edit/play contract with the engine.
 *
 * @remarks
 * This service is the only `app/src` owner of the engine's mode switch. It puts
 * the editor in edit mode as soon as it is constructed — before the script
 * runtime can register a user class — so a script's `awake`/`onEnable` never
 * runs while editing: not on project open, Add Component, save, undo, or a
 * script rebuild. `@ExecuteAlways` is the explicit opt-in for code that should
 * run in the edit world.
 *
 * Play is an in-place switch: snapshot the scene, let the engine wake each
 * instance once, refresh the hierarchy so objects created in `awake` show up,
 * then tick the component update phases. Stop tears the play world down *while
 * still in play* so every `onDisable` pairs with its `onEnable`, switches back
 * to edit mode, and restores the snapshot on the pre-Play scene.
 *
 * A callback that throws is logged and never strands the editor between modes.
 * We do not start the full `Application` loop (that would spawn a second
 * renderer); a minimal loop ticks `Time` and the update phases while the
 * editor's own ViewportService keeps drawing the scene.
 */
@Injectable({ providedIn: 'root' })
export class PlayModeService {

    /** True while the scene is actively simulating. */
    public readonly isPlaying = signal(false);

    private _snapshot: SerializedScene | null = null;
    private _rafId: number = 0;
    private _lastTime: number = 0;
    private _fixedAccumulator: number = 0;

    constructor(
        private readonly _zone: NgZone,
        private readonly _scene: SceneService,
        private readonly _selection: SelectionService,
    ) {
        // Own the mode from the first moment a user script class can exist:
        // ScriptRuntimeService injects this service before it reloads scripts.
        Application.enterEditMode();
    }

    /** Snapshots the scene, wakes scripts through the engine, and starts the loop. */
    public play(): void {
        if (this.isPlaying()) return;
        this._snapshot = this._scene.serialize();
        this.isPlaying.set(true);
        this._lastTime = performance.now();
        this._fixedAccumulator = 0;
        try {
            Application.enterPlayMode();
        } catch (err) {
            console.error(`[Play] A script threw while waking: ${String(err)}`);
        }
        // Objects created in `awake` are new roots; refresh the hierarchy so the
        // editor shows the same world the scripts see.
        this._scene.notify();
        this._zone.runOutsideAngular(() => this._loop());
    }

    /** Tears down in play, returns to edit mode, restores the pre-Play snapshot. */
    public stop(): void {
        if (!this.isPlaying()) return;
        this.isPlaying.set(false);
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;

        const snap = this._snapshot;
        this._snapshot = null;
        try {
            this._selection.clear();
            this._scene.clear();
        } catch (err) {
            console.error(`[Play] A script threw while stopping: ${String(err)}`);
        } finally {
            // Leave play mode only after the world is empty, so the switch does
            // not wake a script on its way out; restore in the edit world.
            Application.enterEditMode();
            if (snap) this._scene.loadFromJSON(snap);
            else this._scene.notify();
        }
    }

    /** Toggle Play ↔ Stop. */
    public toggle(): void {
        if (this.isPlaying()) this.stop();
        else this.play();
    }

    // ── internal ─────────────────────────────────────────────────────

    private _loop = (): void => {
        if (!this.isPlaying()) return;
        this._rafId = requestAnimationFrame(this._loop);

        const now = performance.now();
        const dt = Math.min((now - this._lastTime) / 1000, 0.1);
        this._lastTime = now;

        // Engine time.
        Time._update(dt);

        const scene = SceneManager.activeScene as unknown as {
            _fixedUpdate: () => void;
            _update: () => void;
            _lateUpdate: () => void;
        };

        // Fixed update accumulator (physics timestep).
        const fixedStep = EngineSettings.Time.FIXED_TIMESTEP;
        this._fixedAccumulator += dt;
        while (this._fixedAccumulator >= fixedStep) {
            scene._fixedUpdate();
            Physics._step(fixedStep);
            this._fixedAccumulator -= fixedStep;
        }

        // Per-frame update → animation → late update.
        scene._update();
        Animation._updateAll();
        scene._lateUpdate();
    };
}
