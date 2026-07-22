import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    EventEmitter,
    HostListener,
    Input,
    Output,
    ViewChild,
    signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

/** Single item in a context menu. Either a leaf, a submenu parent, or a separator. */
export interface CtxItem {
    /** Visible label. Use null for separator. */
    label: string | null;
    /** Right-side keyboard hint (e.g. "Ctrl+Shift+N"). */
    shortcut?: string;
    /** True for a separator row. */
    separator?: boolean;
    /** Disabled appearance + non-clickable. */
    disabled?: boolean;
    /** Children — promotes the item to a submenu parent. */
    children?: CtxItem[];
    /** Action invoked on click for leaf items. */
    action?: () => void;
}

/**
 * Floating right-click menu — Unity-style.
 *
 * @remarks
 * Renders a list of items at the given screen position. Supports
 * disabled rows, separators, keyboard-shortcut hints, and one-level
 * fly-out submenus on hover.
 *
 * Used by the hierarchy panel (right-click and the `+ Create` button).
 */
@Component({
    selector: 'ctx-menu',
    standalone: true,
    imports: [CommonModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="ctx" #root [style.left.px]="adjustedX()" [style.top.px]="adjustedY()">
            <ul class="ctx-list">
                @for (it of items; track $index) {
                    @if (it.separator) {
                        <li class="ctx-sep"></li>
                    } @else {
                        <li class="ctx-item"
                            [class.disabled]="it.disabled"
                            [class.has-sub]="it.children?.length"
                            (mouseenter)="onHover($index, it)"
                            (click)="onClick(it)"
                        >
                            <span class="ctx-label">{{ it.label }}</span>
                            @if (it.shortcut) {
                                <span class="ctx-kbd">{{ it.shortcut }}</span>
                            }
                            @if (it.children?.length) {
                                <span class="ctx-caret">▸</span>
                            }
                        </li>
                    }
                }
            </ul>

            @if (subItems(); as sub) {
                <ul class="ctx-list ctx-sub"
                    [style.left.px]="subX()"
                    [style.top.px]="subY()"
                >
                    @for (it of sub; track $index) {
                        @if (it.separator) {
                            <li class="ctx-sep"></li>
                        } @else {
                            <li class="ctx-item"
                                [class.disabled]="it.disabled"
                                (click)="onClick(it)"
                            >
                                <span class="ctx-label">{{ it.label }}</span>
                                @if (it.shortcut) {
                                    <span class="ctx-kbd">{{ it.shortcut }}</span>
                                }
                            </li>
                        }
                    }
                </ul>
            }
        </div>
    `,
    styles: [`
        /* Host is a transparent overlay — passes pointer events through to
           the underlying UI so right-click can reposition the menu and
           left-click anywhere acts on the underlying element AND closes us. */
        :host { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
        .ctx {
            position: absolute;
            min-width: 240px;
            background: var(--bg-2);
            border: 1px solid var(--line-2);
            border-radius: var(--radius);
            box-shadow: 0 16px 50px rgba(0,0,0,0.55), 0 3px 10px rgba(0,0,0,0.4);
            padding: 4px;
            font-size: 12px;
            pointer-events: auto;
        }
        .ctx-sub {
            position: absolute;
            min-width: 200px;
            pointer-events: auto;
        }
        .ctx-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }
        .ctx-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 4px 8px;
            border-radius: var(--radius);
            color: var(--fg-1);
            cursor: pointer;
            min-height: 22px;
            position: relative;
        }
        .ctx-item:hover:not(.disabled) {
            background: var(--accent-bg);
            color: var(--fg-0);
        }
        .ctx-item.disabled {
            color: var(--fg-3);
            cursor: default;
        }
        .ctx-item .ctx-label {
            flex: 1;
        }
        .ctx-item .ctx-kbd {
            margin-left: auto;
            font-family: "JetBrains Mono", monospace;
            font-size: 10px;
            color: var(--fg-2);
        }
        .ctx-item .ctx-caret {
            color: var(--fg-2);
            font-size: 9px;
        }
        .ctx-sep {
            height: 1px;
            background: var(--line);
            margin: 4px 2px;
        }
    `],
})
export class ContextMenuComponent implements AfterViewInit {

    @Input() public items: CtxItem[] = [];
    @Input() public set x(v: number) { this._x = v; this._refreshPos(); }
    @Input() public set y(v: number) { this._y = v; this._refreshPos(); }
    public get x(): number { return this._x; }
    public get y(): number { return this._y; }

    @ViewChild('root', { static: false }) public rootRef?: ElementRef<HTMLElement>;

    private _x: number = 0;
    private _y: number = 0;
    public readonly adjustedX = signal(0);
    public readonly adjustedY = signal(0);

    public ngAfterViewInit(): void {
        // Wait one frame so the DOM has measured size, then clamp.
        requestAnimationFrame(() => this._clampToViewport());
    }

    private _refreshPos(): void {
        this.adjustedX.set(this._x);
        this.adjustedY.set(this._y);
        if (this.rootRef) requestAnimationFrame(() => this._clampToViewport());
    }

    private _clampToViewport(): void {
        const el = this.rootRef?.nativeElement;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 4;
        let nx = this._x;
        let ny = this._y;
        if (nx + rect.width  + margin > vw) nx = Math.max(margin, vw - rect.width  - margin);
        if (ny + rect.height + margin > vh) ny = Math.max(margin, vh - rect.height - margin);
        if (nx !== this.adjustedX()) this.adjustedX.set(nx);
        if (ny !== this.adjustedY()) this.adjustedY.set(ny);
    }

    /** Closes via parent's signal — bubbles a click anywhere outside. */
    @Output() public closed = new EventEmitter<void>();

    public readonly subItems = signal<CtxItem[] | null>(null);
    public readonly subX = signal(0);
    public readonly subY = signal(0);

    public onHover(idx: number, item: CtxItem): void {
        if (item.children && !item.disabled) {
            this.subItems.set(item.children);
            this.subX.set(238); // panel width minus a hair so they overlap by 2px
            this.subY.set(idx * 22);
        } else {
            this.subItems.set(null);
        }
    }

    public onClick(item: CtxItem): void {
        if (item.disabled || item.children) return;
        item.action?.();
        this.closed.emit();
    }

    @HostListener('document:click', ['$event'])
    public onDocumentClick(e: MouseEvent): void {
        // Ignore clicks on our own panel — those are handled inline.
        const root = this.rootRef?.nativeElement;
        if (root && root.contains(e.target as Node)) return;
        this.closed.emit();
    }

    /**
     * If a fresh right-click happens elsewhere, close this menu so the
     * underlying element's `(contextmenu)` handler can open a new one.
     * Without this, right-clicking on a different hierarchy row while the
     * menu is open would either do nothing or surface the browser menu.
     */
    @HostListener('document:contextmenu', ['$event'])
    public onDocumentContextMenu(e: MouseEvent): void {
        const root = this.rootRef?.nativeElement;
        if (root && root.contains(e.target as Node)) {
            // Right-clicking on our own panel just suppresses the browser menu.
            e.preventDefault();
            return;
        }
        // Otherwise let the underlying element handle it; just dismiss us.
        this.closed.emit();
    }

    @HostListener('document:keydown.escape')
    public onEscape(): void {
        this.closed.emit();
    }
}
