import {
    ChangeDetectionStrategy,
    Component,
    Input,
    inject,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/* ════════════════════════════════════════════════════════════
   SVG icon library (compact, single-stroke, currentColor-based)
   ════════════════════════════════════════════════════════════ */
const PATHS: Record<string, string> = {
    // ── Toolbar tools ──
    'translate': '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    'rotate':    '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    'scale':     '<path d="M4 20v-7M4 20h7M4 20l8-8M20 4v7M20 4h-7M20 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',

    // ── Edit ops ──
    'undo':      '<path d="M3 7h11a6 6 0 0 1 0 12H8M3 7l4-4M3 7l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    'redo':      '<path d="M21 7H10a6 6 0 0 0 0 12h6M21 7l-4-4M21 7l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',

    // ── Playback ──
    'play':      '<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>',
    'stop':      '<rect x="6" y="6" width="12" height="12" fill="currentColor"/>',

    // ── File ops ──
    'file-new':  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    'folder':    '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    'save':      '<path d="M5 3h11l3 3v15H5V3z M8 3v5h7V3 M8 21v-7h8v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',

    // ── GameObject ops ──
    'plus':      '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    'trash':     '<path d="M4 7h16M9 7V4h6v3M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M10 11v7M14 11v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',

    // ── Search ──
    'search':    '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M21 21l-4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',

    // ── Hierarchy nodes ──
    'gameobject':'<path d="M12 2L3 7v10l9 5 9-5V7l-9-5z M3 7l9 5 9-5M12 12v10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    'camera':    '<path d="M3 7h4l2-2h6l2 2h4v12H3V7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'light':     '<path d="M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12c1 .8 2 2 2 3v1h4v-1c0-1 1-2.2 2-3a7 7 0 0 0-4-12z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    'mesh':      '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M4 7.5L12 12l8-4.5 M12 12v9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    'transform': '<path d="M12 4v16M4 12h16M7 7l-3 5 3 5M17 7l3 5-3 5M7 7l5-3 5 3M7 17l5 3 5-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',

    // ── Inspector decorators ──
    'cog':       '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    'reset':     '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    'more':      '<circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/>',
    'caret-r':   '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',

    // ── Reference widget ──
    'pick':      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
    'cross':     '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',

    // ── Misc ──
    'box':       '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    'check':     '<path d="M5 12l4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',

    // ── Viewport tools ──
    'hand':      '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4M10 10V4a1.5 1.5 0 0 1 3 0v6M13 10V5a1.5 1.5 0 0 1 3 0v6M16 8a1.5 1.5 0 0 1 3 0v6c0 4-3 7-6.5 7S6 18 6 14v-2.5a1.5 1.5 0 0 1 3 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    'rect':      '<rect x="4" y="4" width="16" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="4" cy="4" r="1.6" fill="currentColor"/><circle cx="20" cy="4" r="1.6" fill="currentColor"/><circle cx="4" cy="20" r="1.6" fill="currentColor"/><circle cx="20" cy="20" r="1.6" fill="currentColor"/>',
    'transform-combo':'<path d="M12 4v8M8 8l4-4 4 4M4 12h8M8 16l-4-4 4-4M12 12v8M16 16l-4 4-4-4M12 12h8M16 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',

    // ── Viewport sub-toolbar ──
    'pivot':     '<circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2"/>',
    'center':    '<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M2 12h6M16 12h6M12 2v6M12 16v6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'globe':     '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    'magnet':    '<path d="M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0V4z M5 4v3h4 M19 4v3h-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    'eye':       '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'shaded':    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    'audio-fx':  '<path d="M3 9v6h4l5 4V5L7 9H3z M16 9c2 1 2 5 0 6 M19 7c4 2 4 8 0 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    'gizmo':     '<path d="M12 3v18M3 12h18M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="1.4"/>',

    // ── Context menu / extras ──
    'caret-d':   '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    'copy':      '<rect x="8" y="8" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 4H5a1 1 0 0 0-1 1v11" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'duplicate': '<rect x="3" y="3" width="14" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="8" y="8" width="13" height="13" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'pencil':    '<path d="M14 4l6 6L8 22H2v-6L14 4z M14 4l3-3 6 6-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};

/**
 * Inline SVG icon — `<wets-icon name="play"></wets-icon>`.
 *
 * Renders icons sized via the parent's `font-size` / `width` / `height`,
 * tinted via `currentColor`. Falls back to an empty span when the name
 * is unknown.
 */
@Component({
    selector: 'wets-icon',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `<span class="wets-icon" [innerHTML]="svg"></span>`,
    styles: [`
        :host { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
        .wets-icon, .wets-icon svg {
            display: inline-block;
            width: 1em;
            height: 1em;
            line-height: 0;
        }
        .wets-icon svg { fill: currentColor; vertical-align: middle; }
    `],
})
export class IconComponent {

    @Input({ required: true }) public set name(value: string) {
        this._name = value;
        this.svg = this._build(value);
    }
    public get name(): string { return this._name; }
    private _name: string = '';

    private readonly _sanitizer = inject(DomSanitizer);
    public svg: SafeHtml = '';

    private _build(name: string): SafeHtml {
        const path = PATHS[name];
        if (!path) return '';
        const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${path}</svg>`;
        return this._sanitizer.bypassSecurityTrustHtml(svg);
    }

    /** Helper for templates that want to embed SVG as a string outside of the component. */
    public static raw(name: string): string {
        const path = PATHS[name];
        return path
            ? `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${path}</svg>`
            : '';
    }
}
