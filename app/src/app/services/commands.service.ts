import { Injectable, inject } from '@angular/core';
import { Camera, DirectionalLight, Quaternion, SceneSerializer, Vector3, type GameObject, type SerializedScene } from 'WebEngineTS';
import { SceneService } from './scene.service';
import { SelectionService } from './selection.service';
import { HistoryService } from './history.service';
import { ClipboardService } from './clipboard.service';
import { ComponentRegistryService } from './component-registry.service';
import { FileIoService } from './file-io.service';
import { ProjectService, type ProjectEntry, type ProjectFolderHandle, type RecentProject } from './project.service';
import { ViewportService } from '../viewport.service';
import { DialogService } from '../dialogs/dialog.service';
import { SettingsDialogComponent } from '../settings/settings-dialog.component';
import { NewProjectDialogComponent, type NewProjectResult } from '../screens/start/new-project-dialog.component';
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

    /**
     * Runs the new-project wizard, then creates what it described: a folder, the
     * scenario layout, and a first scene saved to disk so the project has a main
     * scene from the start. Cancelling the wizard writes nothing.
     */
    public createProject(): void {
        this.run(async () => {
            if (!await this._confirmDiscard()) return;
            const result = await this._dialog.open<NewProjectResult>(
                () => this._i18n.t('wiz.title'), NewProjectDialogComponent);
            if (!result) return;

            const folder = await this._project.createFolderIn(result.parent, result.folderName);
            await this._enter(folder);
            await this._project.initializeLayout(result.meta);
            if (result.template === 'lightCamera') this._buildLightAndCamera();

            const path = 'assets/scenes/main.scene.json';
            await this._project.write(path, `${JSON.stringify(this._scene.serialize(), null, 2)}\n`);
            this._project.scenePath.set(path);
            this._history.clear();
        });
    }

    /**
     * The "Light and camera" starting point, built through the engine and then
     * serialized like any other scene — a hand-written scene file would go stale
     * the first time the engine's format moved.
     */
    private _buildLightAndCamera(): void {
        const camera = this._scene.createEmpty(this._i18n.t('go.camera'));
        camera.tag = 'MainCamera';
        camera.addComponent(Camera);
        camera.transform.localPosition = new Vector3(0, 1, -10);

        const sun = this._scene.createEmpty(this._i18n.t('go.directionalLight'));
        sun.addComponent(DirectionalLight);
        sun.transform.localPosition = new Vector3(0, 3, 0);
        sun.transform.localRotation = Quaternion.euler(50, -30, 0);
    }

    /**
     * Picks a folder and opens it as the project.
     *
     * What happens next depends on what the folder is: a project opens as it
     * is; an empty folder or one that is not yet a project is set up only after
     * the user agrees, because turning someone's folder into a project is not
     * something to do silently.
     */
    public openProject(): void {
        this.run(async () => {
            if (!await this._confirmDiscard()) return;
            const handle = await this._project.pickFolder();
            if (!handle) return;

            const kind = await this._project.inspect(handle);
            if (kind !== 'project') {
                const set = await this._dialog.confirm(kind === 'empty'
                    ? {
                        title: this._i18n.t('open.emptyTitle'),
                        message: this._i18n.t('open.emptyMessage', { name: handle.name }),
                        confirmLabel: this._i18n.t('open.setUp'),
                        cancelLabel: this._i18n.t('dialog.cancel'),
                    }
                    : {
                        title: this._i18n.t('open.notProjectTitle'),
                        message: this._i18n.t('open.notProjectMessage', { name: handle.name }),
                        confirmLabel: this._i18n.t('open.makeProject'),
                        cancelLabel: this._i18n.t('dialog.cancel'),
                    });
                if (!set) return;
            }

            await this._enter(handle);
            if (kind !== 'project') await this._project.initializeLayout();
        });
    }

    /**
     * Reopens a project from the recent list. Called straight from the click —
     * the browser's permission prompt needs the user gesture, so nothing may be
     * awaited before the project service asks for access.
     */
    public openRecent(recent: RecentProject): void {
        this.run(async () => {
            const result = await this._project.openRecent(recent);
            if (result === 'ok') {
                this._resetScene();
                await this._loadDefaultScene();
            } else {
                await this.fail(this._i18n.t(result === 'denied' ? 'open.denied' : 'open.missing', { name: recent.name }));
            }
        });
    }

    /** Closes the project and goes back to the start screen. */
    public closeProject(): void {
        this.run(async () => {
            if (!await this._confirmDiscard()) return;
            this._resetScene();
            await this._project.close();
        });
    }

    /** Makes `handle` the open project, replacing the one that is open. */
    private async _enter(handle: ProjectFolderHandle): Promise<void> {
        this._resetScene();
        await this._project.adopt(handle);
        await this._loadDefaultScene();
    }

    /** An empty scene, with nothing selected and nothing to undo. */
    private _resetScene(): void {
        this._selection.clear();
        this._scene.clear();
        this._history.clear();
        this._project.scenePath.set(null);
    }

    /**
     * Opens the project's main scene if it has one. Without this, saving in a
     * project that already has `main.scene.json` would write the empty scene
     * over it.
     */
    private async _loadDefaultScene(): Promise<void> {
        const path = 'assets/scenes/main.scene.json';
        if (!this._project.exists(path)) return;
        try {
            const text = await this._project.readText(path);
            if (await this._loadSceneText('main.scene.json', text)) this._project.scenePath.set(path);
        } catch (err) {
            await this.fail(this._i18n.t('scene.readFailed', { path, error: messageOf(err) }));
        }
    }

    // ── Scenes ───────────────────────────────────────────────────────

    public async newScene(): Promise<void> {
        if (!await this._confirmDiscard()) return;
        this._resetScene();
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
        const known = this._project.scenePath();
        if (known) {
            this._writeScene(known, text);
            return;
        }
        // A scene with no file yet. If the default name is taken by another scene,
        // writing to it would silently replace that scene.
        const target = 'assets/scenes/main.scene.json';
        if (!this._project.exists(target)) {
            this._writeScene(target, text);
            return;
        }
        void this._dialog.confirm({
            title: this._i18n.t('scene.overwriteTitle'),
            message: this._i18n.t('scene.overwriteMessage', { path: target }),
            confirmLabel: this._i18n.t('scene.replace'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            danger: true,
        }).then(replace => { if (replace) this._writeScene(target, text); });
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
    const e = err as { name?: string; message?: string } | null | undefined;
    if (e?.message) return e.message;
    return `${Object.prototype.toString.call(err)} ${e?.name ?? ''} ${String(err)}`.trim();
}
