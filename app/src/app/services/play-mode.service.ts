import { Injectable, NgZone, signal } from '@angular/core';
import {
    Animation,
    EngineSettings,
    Physics,
    SceneManager,
    Time,
    type SerializedScene,
} from 'WebEngineTS';
import { SceneService } from './scene.service';
import { SelectionService } from './selection.service';

/**
 * Unity-style play mode.
 *
 * @remarks
 * On Play: snapshot the active scene to JSON and run component update
 * hooks (Update / LateUpdate / FixedUpdate via Application's loop).
 * On Stop: tear down all runtime GameObjects and restore the snapshot —
 * undoing anything that happened during play, exactly like Unity.
 *
 * Milestone 7 keeps scope tight: we do NOT start the full `Application`
 * (which would spawn a duplicate renderer). Instead we run a minimal
 * "play loop" that ticks `Time` and calls component update phases, so
 * gameplay scripts still respond to input while the editor's own
 * ViewportService keeps drawing the scene.
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
    ) {}

    /** Captures a scene snapshot and starts simulation. */
    public play(): void {
        if (this.isPlaying()) return;
        this._snapshot = this._scene.serialize();
        this.isPlaying.set(true);
        this._lastTime = performance.now();
        this._zone.runOutsideAngular(() => this._loop());
    }

    /** Stops simulation and restores the pre-play snapshot. */
    public stop(): void {
        if (!this.isPlaying()) return;
        this.isPlaying.set(false);
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;

        const snap = this._snapshot;
        this._snapshot = null;
        if (snap) {
            this._selection.clear();
            this._scene.loadFromJSON(snap);
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
