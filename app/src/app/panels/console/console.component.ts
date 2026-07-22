import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConsoleService } from '../../services/console.service';
import { IconComponent } from '../../icon.component';

/** Editor console — captured `console.*` output with filters. */
@Component({
    selector: 'app-console',
    standalone: true,
    imports: [IconComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="cons">
            <div class="cons-toolbar">
                <button class="cons-btn" (click)="logs.clear()">Clear</button>
                <button class="cons-toggle"
                    [class.on]="logs.collapse()"
                    (click)="logs.collapse.set(!logs.collapse())">Collapse</button>
                <div class="cons-spacer"></div>
                <button class="cons-toggle info"
                    [class.on]="logs.showInfo()"
                    (click)="logs.showInfo.set(!logs.showInfo())">
                    <wets-icon name="check"></wets-icon>
                    <span>{{ logs.counts().info }}</span>
                </button>
                <button class="cons-toggle warn"
                    [class.on]="logs.showWarn()"
                    (click)="logs.showWarn.set(!logs.showWarn())">
                    <wets-icon name="reset"></wets-icon>
                    <span>{{ logs.counts().warn }}</span>
                </button>
                <button class="cons-toggle err"
                    [class.on]="logs.showError()"
                    (click)="logs.showError.set(!logs.showError())">
                    <wets-icon name="cross"></wets-icon>
                    <span>{{ logs.counts().err }}</span>
                </button>
            </div>

            <div class="cons-list">
                @for (e of logs.visible(); track e.id) {
                    <div class="log" [class]="'log ' + e.level">
                        <span class="time">{{ e.time }}</span>
                        <span class="lvl">
                            @if (e.level === 'info')  { ⓘ }
                            @if (e.level === 'warn')  { ⚠ }
                            @if (e.level === 'error') { ✕ }
                        </span>
                        <span class="msg">
                            {{ e.message }}
                            @if (e.count > 1) {
                                <span class="rep">×{{ e.count }}</span>
                            }
                        </span>
                        <span class="src">{{ e.source }}</span>
                    </div>
                } @empty {
                    <div class="cons-empty">Console is empty.</div>
                }
            </div>
        </div>
    `,
    styles: [`
        :host {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          background: var(--bg-1);
        }
        .cons {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          font-family: "JetBrains Mono", monospace;
        }
        .cons-toolbar {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          background: var(--bg-2);
          border-bottom: 1px solid var(--line);
        }
        .cons-btn {
          background: var(--bg-3);
          color: var(--fg-1);
          border: 1px solid var(--line-2);
          padding: 2px 8px;
          height: 20px;
          font-size: 10px;
          border-radius: var(--radius);
          cursor: pointer;
        }
        .cons-btn:hover { color: var(--fg-0); background: var(--bg-4); }
        .cons-toggle {
          display: flex;
          align-items: center;
          gap: 4px;
          background: var(--bg-3);
          color: var(--fg-2);
          border: 1px solid var(--line-2);
          padding: 0 6px;
          height: 20px;
          font-size: 10px;
          border-radius: var(--radius);
          cursor: pointer;
        }
        .cons-toggle:hover { color: var(--fg-0); }
        .cons-toggle.on.info  { color: var(--info); }
        .cons-toggle.on.warn  { color: var(--warn); }
        .cons-toggle.on.err   { color: var(--err); }
        .cons-toggle.on { background: var(--bg-1); border-color: currentColor; }
        .cons-spacer { flex: 1; }

        .cons-list {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
        }
        .cons-empty {
          padding: 18px;
          color: var(--fg-3);
          text-align: center;
          font-style: italic;
          font-family: "Inter", system-ui, sans-serif;
        }
        .log {
          display: grid;
          grid-template-columns: 64px 18px 1fr 160px;
          gap: 8px;
          align-items: center;
          padding: 3px 10px;
          font-size: 11px;
          color: var(--fg-1);
          border-bottom: 1px solid var(--bg-2);
          cursor: pointer;
        }
        .log:hover { background: var(--bg-2); }
        .log.info .lvl  { color: var(--info); }
        .log.warn      { color: var(--warn); }
        .log.warn .lvl { color: var(--warn); }
        .log.error     { color: var(--err); }
        .log.error .lvl{ color: var(--err); }
        .log .time { color: var(--fg-3); font-size: 10px; }
        .log .lvl  { display: grid; place-items: center; font-size: 12px; }
        .log .msg  { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .log .msg .rep {
          margin-left: 6px;
          color: var(--fg-2);
          background: var(--bg-3);
          padding: 1px 5px;
          border-radius: 8px;
          font-size: 9px;
        }
        .log .src  { color: var(--fg-2); font-size: 10px; text-align: right; overflow: hidden; text-overflow: ellipsis; }
    `],
})
export class ConsoleComponent {
    public readonly logs = inject(ConsoleService);
}
