import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ContextMenuComponent, type CtxItem } from '../context-menu/context-menu.component';
import { MENUBAR, MenuModelService, type MenuId } from '../services/menu-model.service';
import { ProjectService } from '../services/project.service';
import { TPipe } from '../i18n/t.pipe';

/** The top strip: logo, menus, and which project is open. */
@Component({
    selector: 'app-topbar',
    standalone: true,
    imports: [ContextMenuComponent, TPipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { style: 'display: contents' },
    template: `
        <header class="menubar">
            <div class="brand">
                <span class="brand-mark"></span>
                <span>WETS</span>
            </div>
            @for (m of MENUBAR; track m.id) {
                <div class="menubar-item"
                    #miEl
                    [class.open]="openMenu() === m.id"
                    (click)="onClick($event, m.id, miEl)"
                    (mouseenter)="onEnter(m.id, miEl)"
                >{{ m.label | t }}</div>
            }
            <div class="spacer"></div>
            <div class="project-tag" [title]="project.scenePath() ?? ''">
                <span class="dot"></span>
                <span>{{ project.isOpen() ? project.name() : ('project.none' | t) }}</span>
            </div>
        </header>

        @if (openMenu()) {
            <ctx-menu
                [items]="items()"
                [x]="x()"
                [y]="y()"
                (closed)="close()"
            ></ctx-menu>
        }
    `,
})
export class TopbarComponent {

    public readonly MENUBAR = MENUBAR;
    public readonly project = inject(ProjectService);
    private readonly _menus = inject(MenuModelService);

    public readonly openMenu = signal<MenuId | null>(null);
    public readonly items = signal<CtxItem[]>([]);
    public readonly x = signal(0);
    public readonly y = signal(0);

    public onClick(e: MouseEvent, id: MenuId, el: HTMLElement): void {
        e.stopPropagation();
        if (this.openMenu() === id) {
            this.close();
            return;
        }
        this._show(id, el);
    }

    /** With a menu already open, hovering a neighbour switches to it — as menu bars do. */
    public onEnter(id: MenuId, el: HTMLElement): void {
        if (this.openMenu() && this.openMenu() !== id) this._show(id, el);
    }

    public close(): void {
        this.openMenu.set(null);
    }

    private _show(id: MenuId, el: HTMLElement): void {
        const rect = el.getBoundingClientRect();
        this.x.set(rect.left);
        this.y.set(rect.bottom + 1);
        this.items.set(this._menus.build(id));
        // A microtask later, so the click that closes the old menu does not close this one too.
        queueMicrotask(() => this.openMenu.set(id));
    }
}
