import { Injectable, inject } from '@angular/core';
import type { GameObject } from 'WebEngineTS';
import { CommandsService } from './commands.service';
import { ClipboardService } from './clipboard.service';
import { ComponentRegistryService } from './component-registry.service';
import { HistoryService } from './history.service';
import { LayoutService } from './layout.service';
import { ProjectService } from './project.service';
import { SelectionService } from './selection.service';
import { DialogService } from '../dialogs/dialog.service';
import { I18nService, type MessageKey } from '../i18n/i18n.service';
import type { CtxItem } from '../context-menu/context-menu.component';

export type MenuId = 'file' | 'edit' | 'gameObject' | 'component' | 'window' | 'help';

/** The menu bar's entries, in order. */
export const MENUBAR: ReadonlyArray<{ id: MenuId; label: MessageKey }> = [
    { id: 'file',       label: 'menu.file' },
    { id: 'edit',       label: 'menu.edit' },
    { id: 'gameObject', label: 'menu.gameObject' },
    { id: 'component',  label: 'menu.component' },
    { id: 'window',     label: 'menu.window' },
    { id: 'help',       label: 'menu.help' },
];

/**
 * What each menu contains, built at the moment it is opened.
 *
 * @remarks
 * Built on demand rather than once, because the contents depend on live state —
 * whether anything is selected, whether the clipboard holds something, what
 * language is on — and a menu is only ever read right after it opens.
 */
@Injectable({ providedIn: 'root' })
export class MenuModelService {

    private readonly _cmd = inject(CommandsService);
    private readonly _selection = inject(SelectionService);
    private readonly _history = inject(HistoryService);
    private readonly _clipboard = inject(ClipboardService);
    private readonly _project = inject(ProjectService);
    private readonly _registry = inject(ComponentRegistryService);
    private readonly _layout = inject(LayoutService);
    private readonly _dialog = inject(DialogService);
    private readonly _i18n = inject(I18nService);

    public build(id: MenuId): CtxItem[] {
        switch (id) {
            case 'file':       return this._file();
            case 'edit':       return this._edit();
            case 'gameObject': return this._gameObject();
            case 'component':  return this._component();
            case 'window':     return this._window();
            case 'help':       return this._help();
        }
    }

    private _t(key: MessageKey): string {
        return this._i18n.t(key);
    }

    private _file(): CtxItem[] {
        return [
            { label: this._t('file.openProject'),  disabled: this._project.status() === 'unsupported',
                action: () => this._cmd.openProject() },
            { label: this._t('file.closeProject'), disabled: !this._project.isOpen(),
                action: () => this._cmd.closeProject() },
            { separator: true, label: null },
            { label: this._t('file.newScene'),                             action: () => void this._cmd.newScene() },
            { label: this._t('file.openScene'), shortcut: 'Ctrl+O',       action: () => void this._cmd.openSceneFile() },
            { separator: true, label: null },
            { label: this._t('file.save'),      shortcut: 'Ctrl+S',       action: () => this._cmd.save() },
            { label: this._t('file.saveAs'),    shortcut: 'Ctrl+Shift+S', action: () => void this._cmd.saveAs() },
        ];
    }

    private _edit(): CtxItem[] {
        const hasSel = this._selection.count() > 0;
        return [
            { label: this._t('edit.undo'), shortcut: 'Ctrl+Z',
                disabled: !this._history.canUndo(), action: () => this._history.undo() },
            { label: this._t('edit.redo'), shortcut: 'Ctrl+Shift+Z',
                disabled: !this._history.canRedo(), action: () => this._history.redo() },
            { separator: true, label: null },
            { label: this._t('edit.cut'),   shortcut: 'Ctrl+X', disabled: !hasSel, action: () => this._cmd.cut() },
            { label: this._t('edit.copy'),  shortcut: 'Ctrl+C', disabled: !hasSel, action: () => this._cmd.copy() },
            { label: this._t('edit.paste'), shortcut: 'Ctrl+V',
                disabled: !this._clipboard.hasContent(), action: () => this._cmd.paste() },
            { label: this._t('edit.duplicate'), shortcut: 'Ctrl+D', disabled: !hasSel, action: () => this._cmd.duplicate() },
            { separator: true, label: null },
            { label: this._t('edit.delete'),    shortcut: 'Del',    disabled: !hasSel, action: () => this._cmd.deleteSelected() },
            { label: this._t('edit.selectAll'), shortcut: 'Ctrl+A', action: () => this._cmd.selectAll() },
            { separator: true, label: null },
            { label: this._t('edit.projectSettings'), disabled: true },
            { label: this._t('edit.preferences'),     disabled: true },
        ];
    }

    private _gameObject(): CtxItem[] {
        return [
            ...this._cmd.createMenu(null),
            { separator: true, label: null },
            { label: this._t('go.centerOnSelection'), shortcut: 'F',
                disabled: !this._selection.selected(), action: () => this._cmd.frameSelection() },
        ];
    }

    private _component(): CtxItem[] {
        const target: GameObject | null = this._selection.selected();
        if (!target) return [{ label: this._t('component.selectFirst'), disabled: true }];

        const byCategory = new Map<string, CtxItem[]>();
        for (const c of this._registry.all()) {
            if (!byCategory.has(c.category)) byCategory.set(c.category, []);
            byCategory.get(c.category)!.push({
                label: c.name,
                action: () => this._cmd.addComponent(target, c.ctor, c.name),
            });
        }
        return [...byCategory.keys()].sort().map(category => ({ label: category, children: byCategory.get(category)! }));
    }

    private _window(): CtxItem[] {
        return [
            { label: this._t('window.hierarchy'), disabled: true },
            { label: this._t('window.inspector'), disabled: true },
            { label: this._t('window.scene'),     disabled: true },
            { label: this._t('window.project'),   disabled: true },
            { label: this._t('window.console'),   disabled: true },
            { label: this._t('window.animation'), disabled: true },
            { separator: true, label: null },
            { label: this._t('window.resetLayout'), action: () => this._layout.reset() },
        ];
    }

    private _help(): CtxItem[] {
        return [
            { label: this._t('help.about'),
                action: () => void this._dialog.alert(this._t('help.about'), this._t('help.aboutText'), this._t('dialog.ok')) },
            { label: this._t('help.documentation'), disabled: true },
            { label: this._t('help.releaseNotes'),  disabled: true },
        ];
    }
}
