/**
 * English interface text — and the definition of every key.
 *
 * `uk.ts` is typed against this file, so a key added here without a Ukrainian
 * translation does not compile. Plural messages are four keys, one per CLDR
 * category (`one`, `few`, `many`, `other`); English uses two of them, Ukrainian
 * uses three — see `I18nService.tp`.
 *
 * Not here, on purpose: names the engine owns (`Transform`, `MeshRenderer`,
 * field names). They are what the API documentation calls them.
 */
export const en = {
    // ── dialogs ─────────────────────────────────────────────────────
    'dialog.close': 'Close',
    'dialog.ok': 'OK',
    'dialog.cancel': 'Cancel',
    'dialog.error': 'Something went wrong',
    'dialog.valueRequired': 'Enter a value.',

    // ── menu bar ────────────────────────────────────────────────────
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.gameObject': 'GameObject',
    'menu.component': 'Component',
    'menu.window': 'Window',
    'menu.help': 'Help',

    'file.openProject': 'Open Project…',
    'file.closeProject': 'Close Project',
    'file.newScene': 'New Scene',
    'file.openScene': 'Open Scene…',
    'file.save': 'Save',
    'file.saveAs': 'Save As…',

    'edit.undo': 'Undo',
    'edit.redo': 'Redo',
    'edit.cut': 'Cut',
    'edit.copy': 'Copy',
    'edit.paste': 'Paste',
    'edit.duplicate': 'Duplicate',
    'edit.delete': 'Delete',
    'edit.selectAll': 'Select All',
    'edit.rename': 'Rename',
    'edit.projectSettings': 'Project Settings…',
    'edit.preferences': 'Preferences…',

    'go.createEmpty': 'Create Empty',
    'go.camera': 'Camera',
    'go.light': 'Light',
    'go.directionalLight': 'Directional Light',
    'go.pointLight': 'Point Light',
    'go.spotLight': 'Spot Light',
    'go.ambientLight': 'Ambient Light',
    'go.audio': 'Audio',
    'go.audioSource': 'Audio Source',
    'go.audioListener': 'Audio Listener',
    'go.effects': 'Effects',
    'go.particleSystem': 'Particle System',
    'go.ui': 'UI',
    'go.canvas': 'Canvas',
    'go.image': 'Image',
    'go.text': 'Text',
    'go.button': 'Button',
    'go.centerOnSelection': 'Center on Selection',
    'go.newName': 'GameObject',

    'component.selectFirst': 'Select a GameObject first',

    'window.hierarchy': 'Hierarchy',
    'window.inspector': 'Inspector',
    'window.scene': 'Scene',
    'window.project': 'Project',
    'window.console': 'Console',
    'window.animation': 'Animation',
    'window.resetLayout': 'Reset Layout',

    'help.about': 'About WETS',
    'help.documentation': 'Documentation',
    'help.releaseNotes': 'Release Notes',
    'help.aboutText': 'WebEngineTS Editor 0.1.0\nA Unity-like editor for WebEngineTS.',

    // ── toolbar ─────────────────────────────────────────────────────
    'toolbar.undo': 'Undo (Ctrl+Z)',
    'toolbar.redo': 'Redo (Ctrl+Shift+Z)',
    'toolbar.play': 'Play',
    'toolbar.stop': 'Stop',
    'toolbar.newScene': 'New scene',
    'toolbar.open': 'Open scene',
    'toolbar.save': 'Save (Ctrl+S)',
    'toolbar.live': 'LIVE',
    'project.none': 'no project',

    // ── panels ──────────────────────────────────────────────────────
    'panel.hierarchy': 'Hierarchy',
    'panel.scene': 'Scene',
    'panel.inspector': 'Inspector',
    'panel.project': 'Project',
    'panel.console': 'Console',
    'panel.lock': 'Lock',
    'panel.menu': 'Menu',

    // ── viewport ────────────────────────────────────────────────────
    'vp.pivot': 'Pivot',
    'vp.local': 'Local',
    'vp.localSpace': 'Local space',
    'vp.snap': 'Snap value',
    'vp.shaded': 'Shaded',
    'vp.lighting': 'Lighting',
    'vp.audio': 'Audio',
    'vp.effects': 'Effects',
    'vp.gizmos': 'Gizmos',
    'vp.visibility': 'Visibility',
    'vp.hand': 'Hand (Q)',
    'vp.move': 'Move (W)',
    'vp.rotate': 'Rotate (E)',
    'vp.scale': 'Scale (R)',
    'vp.rect': 'Rect (T)',
    'vp.combined': 'Combined transform (Y)',
    'vp.tool': 'Tool',
    'vp.shortcuts': 'Shortcuts',
    'tool.translate': 'Move',
    'tool.rotate': 'Rotate',
    'tool.scale': 'Scale',

    // ── status bar ──────────────────────────────────────────────────
    'status.playing': 'Playing',
    'status.ready': 'Ready',
    'status.saved': 'Saved',
    'status.unsaved': 'Unsaved',
    'status.fps': 'Frames per second',
    'status.frameTime': 'Frame time',
    'status.objects.one': '{n} GameObject',
    'status.objects.few': '{n} GameObjects',
    'status.objects.many': '{n} GameObjects',
    'status.objects.other': '{n} GameObjects',
    'status.selected.one': '{n} selected',
    'status.selected.few': '{n} selected',
    'status.selected.many': '{n} selected',
    'status.selected.other': '{n} selected',

    // ── hierarchy ───────────────────────────────────────────────────
    'hier.create': 'Create',
    'hier.all': 'All',
    'hier.panelMode': 'Panel mode',
    'hier.unsaved': 'Unsaved changes',
    'hier.renameTitle': 'Rename',
    'hier.renameLabel': 'New name',

    // ── inspector ───────────────────────────────────────────────────
    'insp.empty': 'Select a GameObject to inspect.',
    'insp.multi.one': '{n} GameObject selected',
    'insp.multi.few': '{n} GameObjects selected',
    'insp.multi.many': '{n} GameObjects selected',
    'insp.multi.other': '{n} GameObjects selected',
    'insp.multiHint': "Multi-edit isn't supported yet. Pick a single object to edit its properties.",
    'insp.active': 'Active in hierarchy',
    'insp.static': 'Static',
    'insp.tag': 'Tag',
    'insp.layer': 'Layer',
    'insp.default': 'Default',
    'insp.reset': 'Reset',
    'insp.position': 'Position',
    'insp.rotation': 'Rotation',
    'insp.scale': 'Scale',
    'insp.addComponent': 'Add Component',
    'insp.searchComponents': 'Search components...',
    'insp.noMatch': 'No components match.',

    'comp.reset': 'Reset',
    'comp.menu': 'Component menu',
    'comp.pick': 'Pick',
    'comp.clear': 'Clear',
    'comp.pickFile': 'Pick file',
    'comp.none': '(None)',
    'comp.moveUp': 'Move Up',
    'comp.moveDown': 'Move Down',
    'comp.copy': 'Copy Component',
    'comp.pasteValues': 'Paste Component Values',
    'comp.remove': 'Remove Component',

    // ── console ─────────────────────────────────────────────────────
    'cons.clear': 'Clear',
    'cons.collapse': 'Collapse',
    'cons.empty': 'Console is empty.',

    // ── project panel ───────────────────────────────────────────────
    'proj.unsupportedTitle': 'Project folders are not available in this browser',
    'proj.unsupportedHint': 'The editor keeps projects on your computer, which needs Chrome or Edge and a page opened over HTTPS or from localhost.',
    'proj.noneTitle': 'No project open',
    'proj.noneHint': 'A project is a folder on your computer. Nothing is uploaded until you publish a scenario.',
    'proj.openFolder': 'Open project folder…',
    'proj.reconnectHint': 'The browser asks for access to the folder again after a reload.',
    'proj.reconnect': 'Reconnect',
    'proj.openAnother': 'Open another folder…',
    'proj.section': 'PROJECT',
    'proj.items.one': '{n} item',
    'proj.items.few': '{n} items',
    'proj.items.many': '{n} items',
    'proj.items.other': '{n} items',
    'proj.newFolder': 'New folder',
    'proj.import': 'Import files into this folder',
    'proj.refresh': 'Refresh from disk',
    'proj.emptyFolder': 'Empty folder — drop files here.',
    'proj.setupLayout': 'Set up as a scenario project',
    'proj.open': 'Open',
    'proj.delete': 'Delete',
    'proj.closeProject': 'Close Project',
    'proj.openAnotherMenu': 'Open Another Project…',
    'proj.refreshMenu': 'Refresh',
    'proj.newFolderMenu': 'New Folder',
    'proj.folderTitle': 'New folder',
    'proj.folderLabel': 'Folder name',
    'proj.folderDefault': 'New Folder',
    'proj.create': 'Create',
    'proj.invalidName': '"{name}" is not a valid name.',
    'proj.deleteTitle': 'Delete from disk?',
    'proj.deleteFolder': 'The folder "{path}" and everything in it will be deleted from your computer. This cannot be undone.',
    'proj.deleteFile': 'The file "{path}" will be deleted from your computer. This cannot be undone.',

    // ── saving and opening scenes ───────────────────────────────────
    'scene.discardTitle': 'Discard unsaved changes?',
    'scene.discardMessage': 'The scene has changes that are not saved.',
    'scene.discard': 'Discard',
    'scene.saveAsTitle': 'Save scene as',
    'scene.saveAsLabel': 'Scene name',
    'scene.saved': 'Saved {path}',
    'scene.saveFailed': 'Could not save {path}: {error}',
    'scene.readFailed': 'Could not read {path}: {error}',
    'scene.parseFailed': '{name} is not valid JSON.',
    'scene.invalid': '{name} is not a valid scene file.',
    'scene.mainName': 'main',
} as const;

export type MessageKey = keyof typeof en;

/** Keys that have the four plural forms — the part before `.other`. */
export type PluralBase = MessageKey extends infer K
    ? K extends `${infer B}.other` ? B : never
    : never;
