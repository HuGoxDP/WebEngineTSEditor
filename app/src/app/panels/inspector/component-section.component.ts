import {
    ChangeDetectionStrategy,
    Component,
    Input,
    inject,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
    Color,
    FieldMeta,
    FieldType,
    GameObject,
    SceneManager,
    TypeRegistry,
    Vector2,
    Vector3,
    Vector4,
    getAllFields,
} from 'WebEngineTS';
import { SelectionService } from '../../services/selection.service';
import { HistoryService } from '../../services/history.service';
import { SceneService } from '../../services/scene.service';
import { IconComponent } from '../../icon.component';
import { ContextMenuComponent, type CtxItem } from '../../context-menu/context-menu.component';
import type { Component as EngineComponent, GameObject } from 'WebEngineTS';

/**
 * Renders one `@Serializable` component as a `.comp` section using the
 * design-system widgets (`.field`, `.vec`, `.color`, `.cb`, `.select`,
 * `.ref`). Widget dispatch is driven by {@link FieldMeta}.
 */
@Component({
    selector: 'app-component-section',
    standalone: true,
    imports: [FormsModule, IconComponent, ContextMenuComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="comp">
            <div class="comp-head" (click)="open.set(!open())">
                <span class="caret" [class.open]="open()">
                    <wets-icon name="caret-r"></wets-icon>
                </span>
                <span class="enable-cb on"></span>
                <span class="ico">
                    <wets-icon [name]="iconName"></wets-icon>
                </span>
                <span class="title">{{ typeName }}</span>
                <div class="actions" (click)="$event.stopPropagation()">
                    <span class="a-btn" title="Reset" (click)="onReset()">
                        <wets-icon name="reset"></wets-icon>
                    </span>
                    <span class="a-btn" title="Component menu" #kebab
                        (click)="openCompMenu($event, kebab)">
                        <wets-icon name="more"></wets-icon>
                    </span>
                </div>
            </div>

            @if (menuOpen()) {
                <ctx-menu
                    [items]="menuItems()"
                    [x]="menuX()"
                    [y]="menuY()"
                    (closed)="menuOpen.set(false)"
                ></ctx-menu>
            }

            @if (open()) {
                <div class="comp-body">
                    @for (field of visibleFields(); track field.name) {
                        @if (field.header) {
                            <div class="comp-header-section">{{ field.header }}</div>
                        }

                        <div class="field" [title]="field.tooltip ?? ''">
                            <label>{{ label(field) }}</label>

                            <!-- Number -->
                            @if (isNumber(field)) {
                                @if (field.range) {
                                    <div class="range-wrap">
                                        <input type="range"
                                            [min]="field.range[0]" [max]="field.range[1]" step="any"
                                            [ngModel]="numberOf(field)"
                                            (ngModelChange)="setNumber(field, $event)">
                                        <input class="in num" type="number" step="any"
                                            [ngModel]="numberOf(field)"
                                            (ngModelChange)="setNumber(field, $event)">
                                    </div>
                                } @else {
                                    <input class="in num" type="number" step="any"
                                        [ngModel]="numberOf(field)"
                                        (ngModelChange)="setNumber(field, $event)">
                                }
                            }

                            <!-- String -->
                            @else if (isString(field)) {
                                <input class="in" type="text"
                                    [ngModel]="stringOf(field)"
                                    (ngModelChange)="setString(field, $event)">
                            }

                            <!-- Boolean -->
                            @else if (isBoolean(field)) {
                                <span class="cb" [class.on]="booleanOf(field)"
                                    (click)="setBoolean(field, !booleanOf(field))"></span>
                            }

                            <!-- Vector2 -->
                            @else if (field.type === 'Vector2') {
                                <div class="vec n2">
                                    <span class="axis x">X</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec2Of(field).x"
                                            (ngModelChange)="setVec(field, 'x', $event)">
                                    </div>
                                    <span class="axis y">Y</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec2Of(field).y"
                                            (ngModelChange)="setVec(field, 'y', $event)">
                                    </div>
                                </div>
                            }

                            <!-- Vector3 -->
                            @else if (field.type === 'Vector3') {
                                <div class="vec n3">
                                    <span class="axis x">X</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec3Of(field).x"
                                            (ngModelChange)="setVec(field, 'x', $event)">
                                    </div>
                                    <span class="axis y">Y</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec3Of(field).y"
                                            (ngModelChange)="setVec(field, 'y', $event)">
                                    </div>
                                    <span class="axis z">Z</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec3Of(field).z"
                                            (ngModelChange)="setVec(field, 'z', $event)">
                                    </div>
                                </div>
                            }

                            <!-- Vector4 -->
                            @else if (field.type === 'Vector4') {
                                <div class="vec n4">
                                    <span class="axis x">X</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec4Of(field).x"
                                            (ngModelChange)="setVec(field, 'x', $event)">
                                    </div>
                                    <span class="axis y">Y</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec4Of(field).y"
                                            (ngModelChange)="setVec(field, 'y', $event)">
                                    </div>
                                    <span class="axis z">Z</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec4Of(field).z"
                                            (ngModelChange)="setVec(field, 'z', $event)">
                                    </div>
                                    <span class="axis w">W</span>
                                    <div class="wrap">
                                        <input class="in num" type="number" step="0.1"
                                            [ngModel]="vec4Of(field).w"
                                            (ngModelChange)="setVec(field, 'w', $event)">
                                    </div>
                                </div>
                            }

                            <!-- Color -->
                            @else if (field.type === 'Color') {
                                <div class="color">
                                    <input class="swatch" type="color"
                                        [style.background]="colorHex(field)"
                                        [ngModel]="colorHex(field)"
                                        (ngModelChange)="setColorHex(field, $event)">
                                    <input class="hex" type="text"
                                        [ngModel]="colorHex(field)"
                                        (ngModelChange)="setColorHex(field, $event)">
                                    <input class="alpha" type="number" step="0.05" min="0" max="1"
                                        [ngModel]="colorOf(field).a"
                                        (ngModelChange)="setColorAlpha(field, $event)">
                                </div>
                            }

                            <!-- Enum -->
                            @else if (field.type === 'Enum' && field.enumValues) {
                                <div class="select">
                                    <select [ngModel]="raw(field)"
                                            (ngModelChange)="setRaw(field, $event)">
                                        @for (k of enumKeys(field); track k) {
                                            <option [ngValue]="field.enumValues[k]">{{ k }}</option>
                                        }
                                    </select>
                                </div>
                            }

                            <!-- GameObject reference -->
                            @else if (field.type === 'GameObject') {
                                <div class="ref">
                                    <span class="ref-ico">
                                        <wets-icon name="gameobject"></wets-icon>
                                    </span>
                                    <span class="ref-label" (click)="togglePicker(field)">
                                        {{ gameObjectRefLabel(field) }}
                                    </span>
                                    <button class="ref-btn" title="Pick"
                                        (click)="togglePicker(field)">
                                        <wets-icon name="pick"></wets-icon>
                                    </button>
                                    <button class="ref-btn" title="Clear"
                                        [disabled]="raw(field) === null"
                                        (click)="setRaw(field, null)">
                                        <wets-icon name="cross"></wets-icon>
                                    </button>
                                </div>
                                @if (isPickerOpen(field)) {
                                    <ul class="ref-picker">
                                        <li (click)="setGameObjectRef(field, null)">
                                            <em>(None)</em>
                                        </li>
                                        @for (entry of allGameObjects(); track entry.go.getInstanceID()) {
                                            <li [style.padding-left.px]="8 + entry.depth * 12"
                                                (click)="setGameObjectRef(field, entry.go)">
                                                {{ entry.go.name }}
                                            </li>
                                        }
                                    </ul>
                                }
                            }

                            <!-- Asset reference -->
                            @else if (field.type === 'Asset') {
                                <div class="ref">
                                    <span class="ref-ico">
                                        <wets-icon name="folder"></wets-icon>
                                    </span>
                                    <span class="ref-label">{{ assetRefLabel(field) }}</span>
                                    <button class="ref-btn" title="Pick file"
                                        (click)="pickAsset(field)">
                                        <wets-icon name="more"></wets-icon>
                                    </button>
                                    <button class="ref-btn" title="Clear"
                                        [disabled]="!raw(field)"
                                        (click)="setRaw(field, null)">
                                        <wets-icon name="cross"></wets-icon>
                                    </button>
                                </div>
                            }

                            <!-- Unknown type → read-only JSON preview -->
                            @else {
                                <span class="in" style="opacity: 0.6; font-family: monospace; font-size: 10px;">
                                    {{ previewOf(field) }}
                                </span>
                            }
                        </div>
                    }
                </div>
            }
        </div>
    `,
})
export class ComponentSectionComponent {

    @Input({ required: true }) public component!: object;

    private readonly _selection = inject(SelectionService);
    private readonly _history = inject(HistoryService);
    private readonly _scene = inject(SceneService);

    public readonly open = signal(true);

    // ── Component context menu (kebab button) ──
    public readonly menuOpen = signal(false);
    public readonly menuX = signal(0);
    public readonly menuY = signal(0);
    public readonly menuItems = signal<CtxItem[]>([]);

    public openCompMenu(e: MouseEvent, anchor: HTMLElement): void {
        e.preventDefault();
        e.stopPropagation();
        const rect = anchor.getBoundingClientRect();
        this.menuX.set(rect.left);
        this.menuY.set(rect.bottom + 2);
        this.menuItems.set([
            { label: 'Reset',  action: () => this.onReset() },
            { separator: true, label: null },
            { label: 'Move Up',   disabled: true },
            { label: 'Move Down', disabled: true },
            { separator: true, label: null },
            { label: 'Copy Component',          disabled: true },
            { label: 'Paste Component Values', disabled: true },
            { separator: true, label: null },
            { label: 'Remove Component', action: () => this.onRemove() },
        ]);
        queueMicrotask(() => this.menuOpen.set(true));
    }

    public onReset(): void {
        const typeName = this.typeName;
        this._history.record(`Reset ${typeName}`, () => {
            const ctor = (this.component as object).constructor as new (...args: any[]) => unknown;
            // Recreate a fresh instance of the same component class on a temporary
            // throw-away GO so we get the constructor defaults, then copy each
            // serialized field back. Avoids needing per-class default exposure.
            const fresh: any = new (ctor as any)((this.component as any).gameObject);
            const allFields = (Reflect as any) // satisfy strict TS w/o import cycles
                ? null : null;
            // Reach into engine reflection via the same path the section uses.
            const fields = this.visibleFields();
            for (const f of fields) {
                (this.component as any)[f.name] = (fresh as any)[f.name];
            }
            // Discard the temporary by removing it (the constructor may have
            // created Three.js side-effects); safe-ish since this is editor-only.
            const owner = (this.component as any).gameObject as GameObject | undefined;
            if (owner) owner.removeComponent(fresh as EngineComponent);
            this._selection.notifyChanged();
        });
    }

    public onRemove(): void {
        const owner = (this.component as any).gameObject as GameObject | undefined;
        if (!owner) return;
        const typeName = this.typeName;
        this._history.record(`Remove ${typeName}`, () => {
            owner.removeComponent(this.component as EngineComponent);
            this._selection.notifyChanged();
        });
    }

    public get typeName(): string {
        return TypeRegistry.getTypeName(this.component) ?? 'Component';
    }

    /** Picks an inspector icon name based on the component class. */
    public get iconName(): string {
        const n = this.component.constructor.name;
        if (n === 'Camera') return 'camera';
        if (n.endsWith('Light')) return 'light';
        if (n === 'MeshRenderer' || n === 'MeshFilter' || n === 'SkinnedMeshRenderer') return 'mesh';
        if (n === 'Transform') return 'transform';
        return 'cog';
    }

    public visibleFields(): FieldMeta[] {
        this._selection.revision();
        return getAllFields(this.component.constructor as any)
            .filter(f => f.serialize && !f.hideInInspector);
    }

    public label(f: FieldMeta): string {
        return f.displayName ?? f.name;
    }

    // ── Type predicates ──────────────────────────────────────────────

    public isNumber(f: FieldMeta): boolean {
        if (f.type === FieldType.Number) return true;
        if (f.type !== undefined) return false;
        return typeof this.raw(f) === 'number';
    }
    public isString(f: FieldMeta): boolean {
        if (f.type === FieldType.String) return true;
        if (f.type !== undefined) return false;
        return typeof this.raw(f) === 'string';
    }
    public isBoolean(f: FieldMeta): boolean {
        if (f.type === FieldType.Boolean) return true;
        if (f.type !== undefined) return false;
        return typeof this.raw(f) === 'boolean';
    }

    // ── Getters ──────────────────────────────────────────────────────

    public raw(f: FieldMeta): unknown { return (this.component as any)[f.name]; }
    public numberOf(f: FieldMeta): number { return Number(this.raw(f) ?? 0); }
    public stringOf(f: FieldMeta): string { return String(this.raw(f) ?? ''); }
    public booleanOf(f: FieldMeta): boolean { return Boolean(this.raw(f)); }
    public vec2Of(f: FieldMeta): Vector2 { return this.raw(f) as Vector2 ?? new Vector2(); }
    public vec3Of(f: FieldMeta): Vector3 { return this.raw(f) as Vector3 ?? new Vector3(); }
    public vec4Of(f: FieldMeta): Vector4 { return this.raw(f) as Vector4 ?? new Vector4(0, 0, 0, 0); }
    public colorOf(f: FieldMeta): Color { return this.raw(f) as Color ?? new Color(); }

    public colorHex(f: FieldMeta): string {
        const c = this.colorOf(f);
        const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
        return `#${to8(c.r)}${to8(c.g)}${to8(c.b)}`;
    }

    public enumKeys(f: FieldMeta): string[] {
        return f.enumValues ? Object.keys(f.enumValues) : [];
    }

    public previewOf(f: FieldMeta): string {
        try { return JSON.stringify(this.raw(f)); } catch { return '[unserializable]'; }
    }

    // ── Setters ──────────────────────────────────────────────────────

    public setRaw(f: FieldMeta, value: unknown): void {
        const label = `Edit ${this.typeName}.${f.name}`;
        this._history.record(label, () => {
            (this.component as any)[f.name] = value;
            this._selection.notifyChanged();
        });
    }

    public setNumber(f: FieldMeta, v: number): void { this.setRaw(f, Number(v)); }
    public setString(f: FieldMeta, v: string): void { this.setRaw(f, v); }
    public setBoolean(f: FieldMeta, v: boolean): void { this.setRaw(f, v); }

    public setVec(f: FieldMeta, axis: 'x' | 'y' | 'z' | 'w', value: number): void {
        const t = f.type;
        if (t === FieldType.Vector2) {
            const v = this.vec2Of(f);
            this.setRaw(f, new Vector2(
                axis === 'x' ? value : v.x,
                axis === 'y' ? value : v.y,
            ));
        } else if (t === FieldType.Vector3) {
            const v = this.vec3Of(f);
            this.setRaw(f, new Vector3(
                axis === 'x' ? value : v.x,
                axis === 'y' ? value : v.y,
                axis === 'z' ? value : v.z,
            ));
        } else if (t === FieldType.Vector4) {
            const v = this.vec4Of(f);
            this.setRaw(f, new Vector4(
                axis === 'x' ? value : v.x,
                axis === 'y' ? value : v.y,
                axis === 'z' ? value : v.z,
                axis === 'w' ? value : v.w,
            ));
        }
    }

    public setColorHex(f: FieldMeta, hex: string): void {
        if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
        const r = parseInt(hex.substring(1, 3), 16) / 255;
        const g = parseInt(hex.substring(3, 5), 16) / 255;
        const b = parseInt(hex.substring(5, 7), 16) / 255;
        const prev = this.colorOf(f);
        this.setRaw(f, new Color(r, g, b, prev.a));
    }

    public setColorAlpha(f: FieldMeta, a: number): void {
        const c = this.colorOf(f);
        this.setRaw(f, new Color(c.r, c.g, c.b, Math.min(1, Math.max(0, Number(a)))));
    }

    // ── GameObject / Asset reference widgets ─────────────────────────

    private readonly _openPicker = signal<string | null>(null);

    public isPickerOpen(f: FieldMeta): boolean {
        return this._openPicker() === f.name;
    }
    public togglePicker(f: FieldMeta): void {
        this._openPicker.set(this._openPicker() === f.name ? null : f.name);
    }

    public gameObjectRefLabel(f: FieldMeta): string {
        const v = this.raw(f) as GameObject | null;
        return v ? v.name : '(None)';
    }
    public setGameObjectRef(f: FieldMeta, value: GameObject | null): void {
        this.setRaw(f, value);
        this._openPicker.set(null);
    }

    public allGameObjects(): { go: GameObject; depth: number }[] {
        this._selection.revision();
        const out: { go: GameObject; depth: number }[] = [];
        const walk = (go: GameObject, depth: number): void => {
            out.push({ go, depth });
            const t = go.transform;
            for (let i = 0; i < t.childCount; i++) {
                walk(t.getChild(i).gameObject, depth + 1);
            }
        };
        for (const r of SceneManager.activeScene.getRootGameObjects()) walk(r, 0);
        return out;
    }

    public assetRefLabel(f: FieldMeta): string {
        const v = this.raw(f);
        if (v === null || v === undefined || v === '') return '(None)';
        if (typeof v === 'string') return v;
        const maybe = v as { name?: string; path?: string };
        return maybe.name ?? maybe.path ?? JSON.stringify(v);
    }

    public pickAsset(f: FieldMeta): void {
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) this.setRaw(f, file.name);
            input.remove();
        });
        document.body.appendChild(input);
        input.click();
    }
}
