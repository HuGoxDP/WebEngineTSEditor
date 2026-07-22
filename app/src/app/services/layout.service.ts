import { Injectable, effect, signal } from '@angular/core';

const KEY = 'wets:layout:v1';

interface LayoutState {
    leftW: number;
    rightW: number;
    bottomH: number;
}

const DEFAULTS: LayoutState = {
    leftW: 260,
    rightW: 320,
    bottomH: 240,
};

const MIN: LayoutState = { leftW: 180, rightW: 220, bottomH: 120 };
const MAX_FRACTION = 0.5; // each pane caps at 50% of viewport in its axis

/**
 * Persisted editor layout state (panel sizes).
 *
 * @remarks
 * Panel sizes are exposed as signals; the AppComponent template binds them
 * as CSS variables on the `.work` grid. Splitter drag handlers call the
 * setters here. Values are clamped and saved to localStorage on every change.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {

    public readonly leftW   = signal(DEFAULTS.leftW);
    public readonly rightW  = signal(DEFAULTS.rightW);
    public readonly bottomH = signal(DEFAULTS.bottomH);

    constructor() {
        this._load();
        // Persist any change.
        effect(() => {
            const state: LayoutState = {
                leftW: this.leftW(),
                rightW: this.rightW(),
                bottomH: this.bottomH(),
            };
            try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
        });
    }

    public setLeft(px: number): void {
        const max = window.innerWidth * MAX_FRACTION;
        this.leftW.set(Math.max(MIN.leftW, Math.min(max, px)));
    }
    public setRight(px: number): void {
        const max = window.innerWidth * MAX_FRACTION;
        this.rightW.set(Math.max(MIN.rightW, Math.min(max, px)));
    }
    public setBottom(px: number): void {
        const max = window.innerHeight * MAX_FRACTION;
        this.bottomH.set(Math.max(MIN.bottomH, Math.min(max, px)));
    }

    public reset(): void {
        this.leftW.set(DEFAULTS.leftW);
        this.rightW.set(DEFAULTS.rightW);
        this.bottomH.set(DEFAULTS.bottomH);
    }

    private _load(): void {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<LayoutState>;
            if (typeof parsed.leftW   === 'number') this.leftW.set(parsed.leftW);
            if (typeof parsed.rightW  === 'number') this.rightW.set(parsed.rightW);
            if (typeof parsed.bottomH === 'number') this.bottomH.set(parsed.bottomH);
        } catch {
            // ignore — fall back to defaults
        }
    }
}
