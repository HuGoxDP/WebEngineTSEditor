import { Injectable, inject } from '@angular/core';
import { SceneSerializer, type GameObject, type SerializedScene } from 'WebEngineTS';
import { SceneService } from './scene.service';
import { SelectionService } from './selection.service';
import { HistoryService } from './history.service';
import { ClipboardService } from './clipboard.service';
import { ComponentRegistryService } from './component-registry.service';
import { FileIoService } from './file-io.service';
import { ProjectService, type ProjectEntry } from './project.service';
import { ViewportService } from '../viewport.service';
import { DialogService } from '../dialogs/dialog.service';
import { SettingsDialogComponent } from '../settings/settings-dialog.component';
import { I18nService, type MessageKey } from '../i18n/i18n.service';
import type { CtxItem } from '../context-menu/context-menu.component';

type CtorOf = new (...args: any[]) => unknown;

/** A creatable object: the menu label, and the component it comes with. */
interface CreateEntry { label: MessageKey; component: string; }

const LIGHTS: CreateEntry[] = [
    { label: 'go.directionalLight', component: 'DirectionalLight' },
    { label: 'go.pointLight',       component: 'PointLight' },
    { label: 'go.spotLight',        component: 'SpotLight' },
    { label: 'go.ambientLight',     component: 'AmbientLight' },
];
const AUDIO: CreateEntry[] = [
    { label: 'go.audioSource',   component: 'AudioSource' },
    { label: 'go.audioListener', component: 'AudioListener' },
];
const EFFECTS: CreateEntry[] = [
    { label: 'go.particleSystem', component: 'ParticleSystem' },
];
const UI: CreateEntry[] = [
    { label: 'go.canvas', component: 'Canvas' },
    { label: 'go.image',  component: 'UIImage' },
    { label: 'go.text',   component: 'UIText' },
    { label: 'go.button', component: 'Button' },
];

/**
 * Everything the editor can *do* — create, delete, copy, save, open.
 *
 * @remarks
 * The menu bar, the Hierarchy menu, the toolbar and the keyboard all reach the
 * same actions through here, so there is one definition of what "Duplicate" or
 * "Save" means instead of one per place that offers it.
 *
 * Failures that come from the disk (a revoked permission, a locked file) are
 * shown in a dialog by {@link fail}; they are ordinary events, not bugs.
 */
@Injectable({ providedIn: 'root' })
export class CommandsService {

    private readonly _scene = inject(SceneService);
    private readonly _selection = inject(SelectionService);
    private readonly _history = inject(HistoryService);
    private readonly _clipboard = inject(ClipboardService);
    private readonly _registry = inject(ComponentRegistryService);
    private readonly _fileIo = inject(FileIoService);
    private readonly _project = inject(ProjectService);
    private readonly _viewport = inject(ViewportService);
    private readonly _dialog = inject(DialogService);
    private readonly _i18n = inject(I18nService);

    // ── Creating ─────────────────────────────────────────────────────

    /** The Create entries, as menu items — shared by the GameObject menu and the Hierarchy. */
    public createMenu(parent: GameObject | null = null): CtxItem[] {
        const t = (k: MessageKey): string => this._i18n.t(k);
        const group = (label: MessageKey, entries: CreateEntry[]): CtxItem => ({
            label: t(label),
            children: entries.map(e => ({ label: t(e.label), action: () => this.createWith(e, parent) })),
        });
        return [
            { label: t('go.createEmpty'), shortcut: 'Alt+Shift+N', action: () => this.createEmpty(parent) },
            { separator: true, label: null },
            { label: t('go.camera'), action: () => this.createWith({ label: 'go.camera', component: 'Camera' }, parent) },
            group('go.light', LIGHTS),
            group('go.audio', AUDIO),
            group('go.effects', EFFECTS),
            group('go.ui', UI),
        ];
    }

    public createEmpty(parent: GameObject | null = null): void {
        this._history.record('Create GameObject', () => {
            const go = this._scene.createEmpty(this._i18n.t('go.newName'));
            if (parent) go.transform.parent = parent.transform;
            this._selection.select(go);
        });
    }

    public createWith(entry: CreateEntry, parent: GameObject | null = null): void {
        const found = this._registry.all().find(c => c.name === entry.component);
        if (!found) return;
        const name = this._i18n.t(entry.label);
        this._history.record(`Create ${entry.component}`, () => {
            const go = this._scene.createEmpty(name);
            if (parent) go.transform.parent = parent.transform;
            go.addComponent(found.ctor as any);
            this._selection.select(go);
        });
    }

    public addComponent(target: GameObject, ctor: CtorOf, name: string): void {
        this._history.record(`Add ${name}`, () => {
            target.addComponent(ctor as any);
            this._selection.notifyChanged();
        });
    }

    // ── Editing the scene ────────────────────────────────────────────

    public deleteObjects(targets: readonly GameObject[]): void {
        if (targets.length === 0) return;
        this._history.record(targets.length === 1 ? 'Delete GameObject' : `Delete ${targets.length} GameObjects`, () => {
            this._selection.clear();
            for (const go of targets) this._scene.destroy(go);
        });
    }

    public deleteSelected(): void {
        this.deleteObjects(this._selection.toArray());
    }

    public copy(): void {
        this._clipboard.copy(this._selection.toArray());
    }

    public cut(): void {
        const targets = this._selection.toArray();
        if (targets.length === 0) return;
        this._clipboard.copy(targets);
        this.deleteObjects(targets);
    }

    public paste(): void {
        if (!this._clipboard.hasContent()) return;
        this._history.record('Paste', () => {
            const created = this._clipboard.paste();
            this._scene.notify();
            if (created.length > 0) {
                this._selection.clear();
                this._selection.addToSelection(created);
            }
        });
    }

    public duplicate(targets: readonly GameObject[] = this._selection.toArray()): void {
        if (targets.length === 0) return;
        this._history.record(targets.length === 1 ? 'Duplicate GameObject' : `Duplicate ${targets.length} GameObjects`, () => {
            const created: GameObject[] = [];
            for (const go of targets) {
                const json = SceneSerializer.serializeGameObject(go);
                json.name = `${json.name} (Clone)`;
                const copy = SceneSerializer.deserializeGameObject(json);
                if (go.transform.parent) copy.transform.parent = go.transform.parent;
                created.push(copy);
            }
            this._scene.notify();
            this._selection.clear();
            this._selection.addToSelection(created);
        });
    }

    public selectAll(): void {
        const all: GameObject[] = [];
        const walk = (g: GameObject): void => {
            all.push(g);
            const t = g.transform;
            for (let i = 0; i < t.childCount; i++) walk(t.getChild(i).gameObject);
        };
        for (const r of this._scene.roots()) walk(r);
        this._selection.clear();
        this._selection.addToSelection(all);
    }

    public async rename(go: GameObject): Promise<void> {
        const next = await this._dialog.prompt({
            title: this._i18n.t('hier.renameTitle'),
            label: this._i18n.t('hier.renameLabel'),
            value: go.name,
            confirmLabel: this._i18n.t('dialog.ok'),
            cancelLabel: this._i18n.t('dialog.cancel'),
        });
        if (next === null) return;
        this._history.record('Rename', () => this._scene.rename(go, next));
    }

    public frameSelection(): void {
        const go = this._selection.selected();
        if (go) this._viewport.frameOnObject(go.transform._internalObject3D);
    }

    // ── Preferences ──────────────────────────────────────────────────

    private _preferencesOpen = false;

    /** Opens Preferences over whatever is on screen. Asking again while it is open does nothing. */
    public async openPreferences(): Promise<void> {
        if (this._preferencesOpen) return;
        this._preferencesOpen = true;
        try {
            await this._dialog.open(() => this._i18n.t('prefs.title'), SettingsDialogComponent);
        } finally {
            this._preferencesOpen = false;
        }
    }

    // ── Project ──────────────────────────────────────────────────────

    public openProject(): void {
        this.run(() => this._project.open());
    }

    public closeProject(): void {
        this.run(() => this._project.close());
    }

    // ── Scenes ───────────────────────────────────────────────────────

    public async newScene(): Promise<void> {
        if (!await this._confirmDiscard()) return;
        this._selection.clear();
        this._scene.clear();
        this._history.clear();
        this._project.scenePath.set(null);
    }

    /**
     * Saves into the open project — to the file the scene came from, or
     * `assets/scenes/main.scene.json` the first time. With no project there is
     * nowhere to write, so the scene is downloaded instead.
     */
    public save(): void {
        const text = JSON.stringify(this._scene.serialize(), null, 2);
        if (!this._project.isOpen()) {
            this._fileIo.saveText('main.scene.json', text);
            return;
        }
        this._writeScene(this._project.scenePath() ?? 'assets/scenes/main.scene.json', text);
    }

    public async saveAs(): Promise<void> {
        if (!this._project.isOpen()) {
            this.save();
            return;
        }
        const name = await this._dialog.prompt({
            title: this._i18n.t('scene.saveAsTitle'),
            label: this._i18n.t('scene.saveAsLabel'),
            value: this._i18n.t('scene.mainName'),
            confirmLabel: this._i18n.t('file.save'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            validate: v => /[\\/:*?"<>|]/.test(v) ? this._i18n.t('proj.invalidName', { name: v }) : null,
        });
        if (name === null) return;
        const text = JSON.stringify(this._scene.serialize(), null, 2);
        this._writeScene(`assets/scenes/${name.replace(/\.scene\.json$/i, '')}.scene.json`, text);
    }

    /** Open a scene file from anywhere on the disk. It belongs to no project path. */
    public async openSceneFile(): Promise<void> {
        const file = await this._fileIo.openText('.json,.scene.json');
        if (!file) return;
        if (!await this._confirmDiscard()) return;
        if (await this._loadSceneText(file.name, file.text)) this._project.scenePath.set(null);
    }

    /** A file double-clicked in the Project panel. Only scenes open so far. */
    public async openProjectEntry(entry: ProjectEntry): Promise<void> {
        if (entry.kind !== 'scene') return;
        if (!await this._confirmDiscard()) return;
        let text: string;
        try {
            text = await this._project.readText(entry.path);
        } catch (err) {
            await this.fail(this._i18n.t('scene.readFailed', { path: entry.path, error: messageOf(err) }));
            return;
        }
        if (await this._loadSceneText(entry.name, text)) this._project.scenePath.set(entry.path);
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /** Runs a disk operation and shows its failure in a dialog instead of losing it. */
    public run(action: () => Promise<unknown>): void {
        action().catch(err => {
            console.error('[Editor]', err);
            void this.fail(messageOf(err));
        });
    }

    public fail(message: string): Promise<void> {
        return this._dialog.alert(this._i18n.t('dialog.error'), message, this._i18n.t('dialog.ok'));
    }

    /** Asks before throwing away edits. Nothing to ask when nothing has changed. */
    private async _confirmDiscard(): Promise<boolean> {
        if (!this._history.canUndo()) return true;
        return this._dialog.confirm({
            title: this._i18n.t('scene.discardTitle'),
            message: this._i18n.t('scene.discardMessage'),
            confirmLabel: this._i18n.t('scene.discard'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            danger: true,
        });
    }

    private _writeScene(path: string, text: string): void {
        this._project.write(path, `${text}\n`).then(
            () => {
                this._project.scenePath.set(path);
                console.log(this._i18n.t('scene.saved', { path }));
            },
            err => void this.fail(this._i18n.t('scene.saveFailed', { path, error: messageOf(err) })),
        );
    }

    /** Replaces the scene with the one in `text`. Returns false if it is not a scene. */
    private async _loadSceneText(name: string, text: string): Promise<boolean> {
        let data: SerializedScene;
        try {
            data = JSON.parse(text) as SerializedScene;
        } catch {
            await this.fail(this._i18n.t('scene.parseFailed', { name }));
            return false;
        }
        if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.roots)) {
            await this.fail(this._i18n.t('scene.invalid', { name }));
            return false;
        }
        this._selection.clear();
        this._scene.loadFromJSON(data);
        this._history.clear();
        return true;
    }
}

function messageOf(err: unknown): string {
    return (err as Error)?.message ?? String(err);
}
