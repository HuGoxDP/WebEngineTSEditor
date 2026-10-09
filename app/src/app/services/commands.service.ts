import { Injectable, inject } from '@angular/core';
import { Camera, DirectionalLight, Quaternion, SceneSerializer, Vector3, type GameObject, type SerializedScene } from 'WebEngineTS';
import { SceneService } from './scene.service';
import { SelectionService } from './selection.service';
import { HistoryService } from './history.service';
import { ClipboardService } from './clipboard.service';
import { ComponentRegistryService } from './component-registry.service';
import { DocumentService } from './document.service';
import { defaultMeta, type ProjectMeta } from './project-templates';
import { FileIoService } from './file-io.service';
import { ProjectService, type ProjectEntry, type ProjectFolderHandle, type RecentProject } from './project.service';
import { ViewportService } from '../viewport.service';
import { DialogService } from '../dialogs/dialog.service';
import { SettingsDialogComponent } from '../settings/settings-dialog.component';
import { NewProjectDialogComponent, type NewProjectResult } from '../screens/start/new-project-dialog.component';
import { I18nService, type MessageKey } from '../i18n/i18n.service';
import type { CtxItem } from '../context-menu/context-menu.component';

type CtorOf = new (...args: any[]) => unknown;

/** The scene a project opens with and the first save writes to. */
const DEFAULT_SCENE = 'assets/scenes/main.scene.json';

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
    private readonly _doc = inject(DocumentService);

    constructor() {
        window.addEventListener('focus', () => void this._checkDisk());
    }

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
            const result = await this._dialog.open<NewProjectResult>(
                () => this._i18n.t('wiz.title'), NewProjectDialogComponent);
            if (!result) return;
            // Asked after the wizard, not before: cancelling it must leave the open
            // scene and its unsaved changes exactly as they were.
            if (!await this._confirmDiscard()) return;

            const folder = await this._project.createFolderIn(result.parent, result.folderName);
            await this._enter(folder, result.meta);
            if (result.template === 'lightCamera') this._buildLightAndCamera();

            // The starting scene is written now, so a new project has a main scene
            // from the first moment and is not "unsaved".
            this._history.clear();
            await this._writeScene(DEFAULT_SCENE, this._history.revision());
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

            // Asked once the choice is made, for the same reason as in createProject.
            if (!await this._confirmDiscard()) return;
            await this._enter(handle, kind === 'project' ? undefined : defaultMeta(handle.name));
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
                await this._settle();
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
            this._doc.releaseLock();
            await this._project.close();
        });
    }

    /**
     * Makes `handle` the open project, replacing the one that is open.
     *
     * @param layout - set for a folder that is not a project yet: its identity, and
     *   the instruction to lay out the scenario files before the project opens.
     */
    private async _enter(handle: ProjectFolderHandle, layout?: ProjectMeta): Promise<void> {
        this._resetScene();
        await this._project.adopt(handle, layout);
        await this._settle();
    }

    /**
     * Once a project has been adopted: claim it for this tab, show its main
     * scene, and offer back any work a previous session left unsaved.
     *
     * If another tab already has the project open, this one lets go of it —
     * two tabs on one folder overwrite each other's saves.
     */
    private async _settle(): Promise<void> {
        if (!await this._doc.acquireLock(this._project.projectId())) {
            const name = this._project.name();
            await this._project.close();
            await this.fail(this._i18n.t('open.elsewhere', { name }));
            return;
        }
        this._resetScene();
        await this._loadDefaultScene();
        await this._offerRecovery();
    }

    /** An empty scene, with nothing selected and nothing to undo — and nothing unsaved. */
    private _resetScene(): void {
        this._selection.clear();
        this._scene.clear();
        this._history.clear();
        this._project.scenePath.set(null);
        this._doc.noteBlank();
    }

    /**
     * Opens the project's main scene if it has one. Without this, saving in a
     * project that already has `main.scene.json` would write the empty scene
     * over it.
     */
    private async _loadDefaultScene(): Promise<void> {
        if (!this._project.exists(DEFAULT_SCENE)) return;
        try {
            const text = await this._project.readText(DEFAULT_SCENE);
            if (await this._loadSceneText('main.scene.json', text)) {
                this._project.scenePath.set(DEFAULT_SCENE);
                await this._doc.noteLoaded(DEFAULT_SCENE);
            }
        } catch (err) {
            await this.fail(this._i18n.t('scene.readFailed', { path: DEFAULT_SCENE, error: messageOf(err) }));
        }
    }

    /**
     * If a previous session was cut off with unsaved changes, there is a recovery
     * copy newer than the scene. Restoring it leaves the scene "unsaved", which it
     * is; refusing deletes the copy, so the question is not asked again.
     */
    private async _offerRecovery(): Promise<void> {
        const text = await this._doc.recoverableText(this._project.scenePath() ?? DEFAULT_SCENE);
        if (text === null) return;

        const restore = await this._dialog.confirm({
            title: this._i18n.t('recover.title'),
            message: this._i18n.t('recover.message'),
            confirmLabel: this._i18n.t('recover.restore'),
            cancelLabel: this._i18n.t('recover.discard'),
        });
        if (!restore) {
            await this._doc.discardAutosave();
            return;
        }
        await this._loadSceneText('autosave', text);
    }

    // ── Scenes ───────────────────────────────────────────────────────

    public async newScene(): Promise<void> {
        if (!await this._confirmDiscard()) return;
        this._resetScene();
    }

    /** Saves the scene. See {@link saveNow}. */
    public save(): void {
        this.run(() => this.saveNow());
    }

    /**
     * Saves into the open project — to the file the scene came from, or
     * `assets/scenes/main.scene.json` the first time.
     *
     * @returns whether the scene is on disk afterwards: false if the user
     *   declined to replace another scene, or the write failed.
     */
    public async saveNow(): Promise<boolean> {
        const revision = this._history.revision();
        const known = this._project.scenePath();
        if (known) return this._writeScene(known, revision);

        // A scene with no file yet. If the default name is taken by another scene,
        // writing to it would silently replace that scene.
        if (this._project.exists(DEFAULT_SCENE) && !await this._confirmReplace(DEFAULT_SCENE)) return false;
        return this._writeScene(DEFAULT_SCENE, revision);
    }

    public async saveAs(): Promise<void> {
        const name = await this._dialog.prompt({
            title: this._i18n.t('scene.saveAsTitle'),
            label: this._i18n.t('scene.saveAsLabel'),
            value: this._i18n.t('scene.mainName'),
            confirmLabel: this._i18n.t('file.save'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            validate: v => /[\\/:*?"<>|]/.test(v) ? this._i18n.t('proj.invalidName', { name: v }) : null,
        });
        if (name === null) return;

        const revision = this._history.revision();
        const path = `assets/scenes/${name.replace(/\.scene\.json$/i, '')}.scene.json`;
        if (path !== this._project.scenePath() && this._project.exists(path) && !await this._confirmReplace(path)) return;
        await this._writeScene(path, revision);
    }

    /**
     * Opens a scene file from anywhere on the disk. It is not part of the project
     * yet, so it counts as unsaved: saving puts it into the project.
     */
    public async openSceneFile(): Promise<void> {
        const file = await this._fileIo.openText('.json,.scene.json');
        if (!file) return;
        if (!await this._confirmDiscard()) return;
        if (await this._loadSceneText(file.name, file.text)) {
            this._project.scenePath.set(null);
            await this._doc.discardAutosave();
        }
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
        if (await this._loadSceneText(entry.name, text)) {
            this._project.scenePath.set(entry.path);
            await this._doc.noteLoaded(entry.path);
            await this._doc.discardAutosave();
        }
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

    /**
     * Asks what to do with unsaved changes before something throws them away.
     * Nothing to ask when nothing has changed.
     *
     * @returns true if it is safe to go on: the changes were saved, or the user
     *   chose to give them up. False if they cancelled, or saving did not work.
     */
    private async _confirmDiscard(): Promise<boolean> {
        if (!this._doc.dirty()) return true;

        const answer = await this._dialog.ask({
            title: this._i18n.t('scene.saveChangesTitle', { name: this._sceneLabel() }),
            message: this._i18n.t('scene.saveChangesMessage'),
            buttons: [
                { id: 'cancel', label: this._i18n.t('dialog.cancel') },
                { id: 'discard', label: this._i18n.t('scene.dontSave'), kind: 'danger' },
                { id: 'save', label: this._i18n.t('file.save'), kind: 'primary' },
            ],
        });
        if (answer === 'save') return this.saveNow();
        if (answer === 'discard') {
            await this._doc.abandonChanges();
            return true;
        }
        return false;
    }

    /** What the scene is called in a question: its file, or "the scene" if it has none. */
    private _sceneLabel(): string {
        const path = this._project.scenePath();
        return path ? path.slice(path.lastIndexOf('/') + 1) : this._i18n.t('scene.untitled');
    }

    private async _confirmReplace(path: string): Promise<boolean> {
        return this._dialog.confirm({
            title: this._i18n.t('scene.overwriteTitle'),
            message: this._i18n.t('scene.overwriteMessage', { path }),
            confirmLabel: this._i18n.t('scene.replace'),
            cancelLabel: this._i18n.t('dialog.cancel'),
            danger: true,
        });
    }

    /**
     * Writes the scene to `path` and tells the document it is saved.
     *
     * @param revision - the history revision from before the scene was
     *   serialized, so edits made while the write is in flight stay "unsaved".
     */
    private async _writeScene(path: string, revision: number): Promise<boolean> {
        const text = JSON.stringify(this._scene.serialize(), null, 2);
        try {
            await this._project.write(path, `${text}\n`);
        } catch (err) {
            await this.fail(this._i18n.t('scene.saveFailed', { path, error: messageOf(err) }));
            return false;
        }
        this._project.scenePath.set(path);
        await this._doc.noteSaved(path, revision);
        console.log(this._i18n.t('scene.saved', { path }));
        return true;
    }

    // ── Changes made outside the editor ──────────────────────────────

    private _checkingDisk = false;

    /**
     * When the window regains focus, looks for changes made to the open scene
     * outside the editor. Unchanged-here and changed-there reloads quietly;
     * changed in both places asks, and nothing is ever replaced without a say.
     */
    private async _checkDisk(): Promise<void> {
        const path = this._project.scenePath();
        if (!this._project.isOpen() || !path || this._checkingDisk || this._dialog.isOpen()) return;

        this._checkingDisk = true;
        try {
            await this._project.refresh();
            if (!await this._doc.changedOnDisk(path)) return;

            if (this._doc.dirty()) {
                const reload = await this._dialog.confirm({
                    title: this._i18n.t('disk.changedTitle', { name: this._sceneLabel() }),
                    message: this._i18n.t('disk.changedMessage'),
                    confirmLabel: this._i18n.t('disk.reload'),
                    cancelLabel: this._i18n.t('disk.keepMine'),
                    danger: true,
                });
                if (!reload) {
                    await this._doc.acceptDiskVersion(path);
                    return;
                }
            }
            const text = await this._project.readText(path);
            if (await this._loadSceneText(path, text)) await this._doc.noteLoaded(path);
        } catch (err) {
            console.warn('[Editor] Could not check the scene file for outside changes', err);
        } finally {
            this._checkingDisk = false;
        }
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
