import { Injectable, inject } from '@angular/core';
import { CommandsService } from './commands.service';
import { HistoryService } from './history.service';
import { SelectionService } from './selection.service';
import { ViewportService } from '../viewport.service';
import { DialogService } from '../dialogs/dialog.service';

/**
 * Keyboard shortcuts, as Unity has them.
 *
 * @remarks
 * One listener for the whole editor, installed while the workspace is on screen.
 * It stands down while a dialog is open or a text field has focus, so typing a
 * name never deletes an object.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutsService {

    private readonly _cmd = inject(CommandsService);
    private readonly _history = inject(HistoryService);
    private readonly _selection = inject(SelectionService);
    private readonly _viewport = inject(ViewportService);
    private readonly _dialog = inject(DialogService);

    /** Starts listening. */
    public attach(): void {
        window.addEventListener('keydown', this._onKeyDown);
    }

    /** Stops listening. */
    public detach(): void {
        window.removeEventListener('keydown', this._onKeyDown);
    }

    private readonly _onKeyDown = (e: KeyboardEvent): void => {
        if (this._dialog.isOpen()) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        // Unity's Ctrl+Shift+N opens an incognito window in Chrome and cannot be
        // intercepted from a page, so Create Empty is Alt+Shift+N here.
        if (e.altKey && e.shiftKey && !mod && key === 'n') {
            e.preventDefault();
            this._cmd.createEmpty();
            return;
        }

        if (mod) {
            const handled = this._withModifier(key, e.shiftKey);
            if (handled) e.preventDefault();
            return;
        }

        switch (e.key) {
            case 'Delete':
            case 'Backspace':
                if (this._selection.selected()) {
                    e.preventDefault();
                    this._cmd.deleteSelected();
                }
                return;
            case 'F2':
                if (this._selection.selected()) {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent('wets:rename-selected'));
                }
                return;
        }

        switch (key) {
            case 'f':
                if (this._selection.selected()) {
                    e.preventDefault();
                    this._cmd.frameSelection();
                }
                break;
            case 'w': this._viewport.setTool('translate'); break;
            case 'e': this._viewport.setTool('rotate');    break;
            case 'r': this._viewport.setTool('scale');     break;
        }
    };

    /** Returns whether the combination was one of ours. */
    private _withModifier(key: string, shift: boolean): boolean {
        switch (key) {
            case 'z': shift ? this._history.redo() : this._history.undo(); return true;
            case 'y': this._history.redo();                                return true;
            case 's': shift ? void this._cmd.saveAs() : this._cmd.save();  return true;
            case 'o': void this._cmd.openSceneFile(); return true;
            case 'a': this._cmd.selectAll(); return true;
            case 'c': this._cmd.copy();      return true;
            case 'v': this._cmd.paste();     return true;
            case 'x': this._cmd.cut();       return true;
            case 'd': this._cmd.duplicate(); return true;
            default:  return false;
        }
    }
}
