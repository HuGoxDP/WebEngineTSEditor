import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
    GameObject,
    Quaternion,
    TypeRegistry,
    Vector3,
} from 'WebEngineTS';
import { SelectionService } from '../../services/selection.service';
import { SceneService } from '../../services/scene.service';
import { ComponentRegistryService } from '../../services/component-registry.service';
import { HistoryService } from '../../services/history.service';
import { ComponentSectionComponent } from './component-section.component';
import { IconComponent } from '../../icon.component';

interface EulerDeg { x: number; y: number; z: number; }

@Component({
    selector: 'app-inspector',
    standalone: true,
    imports: [FormsModule, ComponentSectionComponent, IconComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @if (!go()) {
            <div class="insp-empty">Select a GameObject to inspect.</div>
        } @else if (multi()) {
            <div class="insp-multi">
                <strong>{{ selection.count() }} GameObjects selected</strong>
                <div class="hint">
                    Multi-edit isn't supported yet.
                    Pick a single object to edit its properties.
                </div>
            </div>
        } @else {
            <!-- Head: enable · icon · name · static -->
            <div class="insp-head">
                <div class="enable on" title="Active in hierarchy"></div>
                <div class="ico">
                    <wets-icon name="gameobject"></wets-icon>
                </div>
                <input class="name-input"
                    [ngModel]="go()!.name"
                    (ngModelChange)="onRename($event)"
                    spellcheck="false">
                <span class="dim" style="font-size: 10px; color: var(--fg-2);">Static</span>
            </div>

            <!-- Meta row: Tag · Layer (placeholders for now) -->
            <div class="insp-meta">
                <span>Tag</span>
                <div class="pill">{{ go()!.name }} <span>▾</span></div>
                <span>Layer</span>
                <div class="pill">Default <span>▾</span></div>
            </div>

            <div class="insp-body">
                <!-- Transform — first, hand-rolled so position/rotation/scale stay grouped -->
                <div class="comp">
                    <div class="comp-head">
                        <span class="caret open">
                            <wets-icon name="caret-r"></wets-icon>
                        </span>
                        <span class="enable-cb on"></span>
                        <span class="ico">
                            <wets-icon name="transform"></wets-icon>
                        </span>
                        <span class="title">Transform</span>
                        <div class="actions">
                            <span class="a-btn" title="Reset">
                                <wets-icon name="reset"></wets-icon>
                            </span>
                            <span class="a-btn">
                                <wets-icon name="more"></wets-icon>
                            </span>
                        </div>
                    </div>
                    <div class="comp-body">
                        <div class="field">
                            <label>Position</label>
                            <div class="vec n3">
                                <span class="axis x">X</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="0.1"
                                        [ngModel]="pos().x" (ngModelChange)="onPos('x', $event)">
                                </div>
                                <span class="axis y">Y</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="0.1"
                                        [ngModel]="pos().y" (ngModelChange)="onPos('y', $event)">
                                </div>
                                <span class="axis z">Z</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="0.1"
                                        [ngModel]="pos().z" (ngModelChange)="onPos('z', $event)">
                                </div>
                            </div>
                        </div>

                        <div class="field">
                            <label>Rotation</label>
                            <div class="vec n3">
                                <span class="axis x">X</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="1"
                                        [ngModel]="rot().x" (ngModelChange)="onRot('x', $event)">
                                </div>
                                <span class="axis y">Y</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="1"
                                        [ngModel]="rot().y" (ngModelChange)="onRot('y', $event)">
                                </div>
                                <span class="axis z">Z</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="1"
                                        [ngModel]="rot().z" (ngModelChange)="onRot('z', $event)">
                                </div>
                            </div>
                        </div>

                        <div class="field">
                            <label>Scale</label>
                            <div class="vec n3">
                                <span class="axis x">X</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="0.1"
                                        [ngModel]="scl().x" (ngModelChange)="onScl('x', $event)">
                                </div>
                                <span class="axis y">Y</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="0.1"
                                        [ngModel]="scl().y" (ngModelChange)="onScl('y', $event)">
                                </div>
                                <span class="axis z">Z</span>
                                <div class="wrap">
                                    <input class="in num" type="number" step="0.1"
                                        [ngModel]="scl().z" (ngModelChange)="onScl('z', $event)">
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- @Serializable components -->
                @for (comp of components(); track $index) {
                    <app-component-section [component]="comp"></app-component-section>
                }

                <!-- Add Component dock -->
                <div class="add-comp-wrap">
                    @if (!addOpen()) {
                        <button class="add-comp" (click)="addOpen.set(true)">
                            <wets-icon name="plus"></wets-icon>
                            <span>Add Component</span>
                        </button>
                    } @else {
                        <div class="add-menu">
                            <input
                                type="text"
                                placeholder="Search components..."
                                [ngModel]="addFilter()"
                                (ngModelChange)="addFilter.set($event)"
                                (keydown.escape)="addOpen.set(false)"
                                autofocus
                            >
                            <ul class="add-list">
                                @for (c of filteredComponents(); track c.name) {
                                    <li (click)="onAddComponent(c)">{{ c.name }}</li>
                                }
                                @if (filteredComponents().length === 0) {
                                    <li class="empty-hint">No components match.</li>
                                }
                            </ul>
                            <button class="cancel" (click)="addOpen.set(false)">Cancel</button>
                        </div>
                    }
                </div>
            </div>
        }
    `,
})
export class InspectorComponent {

    private readonly _selection = inject(SelectionService);
    private readonly _scene = inject(SceneService);

    /** Public accessor used by the template's multi-select banner. */
    public readonly selection = this._selection;

    public readonly go = computed<GameObject | null>(() => {
        this._selection.revision();
        return this._selection.selected();
    });

    /** True when more than one GameObject is selected. */
    public readonly multi = computed<boolean>(() => this._selection.count() > 1);

    public readonly pos = computed(() => {
        const g = this.go();
        return g
            ? { x: g.transform.localPosition.x, y: g.transform.localPosition.y, z: g.transform.localPosition.z }
            : { x: 0, y: 0, z: 0 };
    });

    public readonly rot = computed<EulerDeg>(() => {
        const g = this.go();
        if (!g) return { x: 0, y: 0, z: 0 };
        return InspectorComponent._quatToEulerDeg(g.transform.localRotation);
    });

    public readonly scl = computed(() => {
        const g = this.go();
        return g
            ? { x: g.transform.localScale.x, y: g.transform.localScale.y, z: g.transform.localScale.z }
            : { x: 1, y: 1, z: 1 };
    });

    public readonly components = computed<object[]>(() => {
        const g = this.go();
        if (!g) return [];
        this._selection.revision();
        const raw = (g as unknown as { _components: object[] })._components;
        return raw.filter(c => TypeRegistry.getTypeName(c) !== null);
    });

    public onRename(name: string): void {
        const g = this.go();
        if (!g) return;
        this._history.record('Rename', () => {
            g.name = name;
            this._scene.notify();
        });
    }

    public onPos(axis: 'x' | 'y' | 'z', value: number): void {
        const g = this.go();
        if (!g) return;
        this._history.record('Edit Position', () => {
            const p = g.transform.localPosition;
            g.transform.localPosition = new Vector3(
                axis === 'x' ? value : p.x,
                axis === 'y' ? value : p.y,
                axis === 'z' ? value : p.z,
            );
            this._selection.notifyChanged();
        });
    }

    public onRot(axis: 'x' | 'y' | 'z', value: number): void {
        const g = this.go();
        if (!g) return;
        this._history.record('Edit Rotation', () => {
            const cur = this.rot();
            const e: EulerDeg = {
                x: axis === 'x' ? value : cur.x,
                y: axis === 'y' ? value : cur.y,
                z: axis === 'z' ? value : cur.z,
            };
            g.transform.localRotation = InspectorComponent._eulerDegToQuat(e);
            this._selection.notifyChanged();
        });
    }

    public onScl(axis: 'x' | 'y' | 'z', value: number): void {
        const g = this.go();
        if (!g) return;
        this._history.record('Edit Scale', () => {
            const s = g.transform.localScale;
            g.transform.localScale = new Vector3(
                axis === 'x' ? value : s.x,
                axis === 'y' ? value : s.y,
                axis === 'z' ? value : s.z,
            );
            this._selection.notifyChanged();
        });
    }

    // ── Add Component menu ──────────────────────────────────────────

    private readonly _componentRegistry = inject(ComponentRegistryService);
    private readonly _history = inject(HistoryService);

    public readonly addOpen = signal(false);
    public readonly addFilter = signal('');

    public readonly filteredComponents = computed(() => {
        const q = this.addFilter().toLowerCase().trim();
        const all = this._componentRegistry.all();
        if (!q) return all;
        return all.filter(c => c.name.toLowerCase().includes(q));
    });

    public onAddComponent(entry: { name: string; ctor: new (...args: any[]) => unknown }): void {
        const g = this.go();
        if (!g) return;
        this._history.record(`Add ${entry.name}`, () => {
            g.addComponent(entry.ctor as any);
            this._selection.notifyChanged();
        });
        this.addOpen.set(false);
        this.addFilter.set('');
    }

    // ── Quaternion ↔ Euler (YXZ order, degrees) ──────────────────

    private static _quatToEulerDeg(q: Quaternion): EulerDeg {
        const { x, y, z, w } = q;
        const sinP = 2 * (w * x - y * z);
        const cp = Math.min(Math.max(sinP, -1), 1);
        const ex = Math.asin(cp);
        let ey: number, ez: number;
        if (Math.abs(sinP) < 0.99999) {
            ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
            ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
        } else {
            ey = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));
            ez = 0;
        }
        const k = 180 / Math.PI;
        return {
            x: +(ex * k).toFixed(3),
            y: +(ey * k).toFixed(3),
            z: +(ez * k).toFixed(3),
        };
    }

    private static _eulerDegToQuat(e: EulerDeg): Quaternion {
        const k = Math.PI / 180;
        const ex = e.x * k, ey = e.y * k, ez = e.z * k;
        const cx = Math.cos(ex * 0.5), sx = Math.sin(ex * 0.5);
        const cy = Math.cos(ey * 0.5), sy = Math.sin(ey * 0.5);
        const cz = Math.cos(ez * 0.5), sz = Math.sin(ez * 0.5);
        return new Quaternion(
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz - sx * sy * cz,
            cx * cy * cz + sx * sy * sz,
        );
    }
}
