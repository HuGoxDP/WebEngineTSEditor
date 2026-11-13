// End-to-end check of the editor, run against a live URL in a real browser.
//
//   npm run e2e                    # against the Docker deployment, :8044/editor/
//   npm run e2e -- http://localhost:4200/
//   ONLY=preferences npm run e2e   # scenarios whose name contains the text
//
// The editor has no unit tests; this is the safety net. Each stage of
// docs/implementation-plan.md adds a scenario here.
//
// The native folder picker cannot be driven, so `showDirectoryPicker` is
// replaced with one that returns a folder in the browser's origin-private file
// system. That is a real FileSystemDirectoryHandle: everything after the dialog
// runs the real code. The dialog itself is a manual check.
//
// Playwright and Edge are borrowed from testv/virtual-lab/e2e, like
// WebEngineTS/scripts/shoot.mjs does — nothing is downloaded. A machine that has
// neither that checkout nor Edge (CI, a Linux box) points both elsewhere:
//
//   E2E_PLAYWRIGHT_DIR=<dir>       where require("playwright") resolves from, e.g.
//                                  `npm root -g`. A relative path is taken from the
//                                  current directory (app/ under `npm run e2e`).
//                                  Default: testv/virtual-lab/e2e beside this
//                                  repository, ../testv/virtual-lab/e2e from its root.
//   E2E_BROWSER_CHANNEL=chromium   Playwright's own Chromium instead of Edge; an
//                                  empty value uses its headless shell. Default msedge.
//
// On Linux, run it under a UTF-8 locale (LANG=C.UTF-8): under C/POSIX, Chromium
// empties non-ASCII names in the origin-private file system, and the wizard
// scenario fails for that alone. CI (.github/workflows/ci.yml) runs it this way.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E = resolve(process.env.E2E_PLAYWRIGHT_DIR || resolve(HERE, "../../../testv/virtual-lab/e2e"));
// `??`, not `||`: set-but-empty is a choice (the headless shell), not "unset".
const CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? "msedge";
const SHOTS = resolve(HERE, "../../.shots");
const URL_ = process.argv[2] ?? "http://localhost:8044/editor/";

// createRequire wants a file to resolve from; it does not have to exist.
const { chromium } = createRequire(resolve(E2E, "package.json"))("playwright");
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
    if (!ok) failed++;
};

const browser = await chromium.launch({
    channel: CHANNEL || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

let lastPage = null;

/**
 * A fresh browser context per scenario: its own IndexedDB, localStorage and
 * folders. `settings` seeds the editor preferences before it starts; English
 * unless a scenario says otherwise. The folder the picker returns is
 * `window.__pickFolder`, which a scenario can change between opens.
 */
async function newPage(folderName = "DemoScenario", { viewport = { width: 1600, height: 900 }, settings = { language: "en" }, autosaveMs = 0, probe = false } = {}) {
    const context = await browser.newContext({ viewport, locale: "en-US" });
    const page = await context.newPage();
    await instrument(page, folderName, settings, autosaveMs);
    if (probe) {
        // The debug probe (D-13) is only installed with this flag; production
        // editors never set it, and no other scenario does.
        await page.addInitScript(() => localStorage.setItem("wets:debug:probe", "1"));
    }
    await page.goto(URL_, { waitUntil: "load" });
    return page;
}

/** A second tab in the same browser profile — same storage, same locks. */
async function siblingPage(page, folderName) {
    const sibling = await page.context().newPage();
    await instrument(sibling, folderName, null, 0);
    await sibling.goto(URL_, { waitUntil: "load" });
    return sibling;
}

/** Log capture, the folder-picker stand-in, and the preferences/knobs seeded before the editor starts. */
async function instrument(page, folderName, settings, autosaveMs) {
    lastPage = page;
    page.logs = [];
    page.nativeDialogs = 0;
    page.beforeUnloads = 0;
    page.on("console", m => { if (m.type() === "error" || m.type() === "warning") page.logs.push(`[${m.type()}] ${m.text()}`); });
    page.on("pageerror", e => page.logs.push(`[pageerror] ${e.message}`));
    page.on("dialog", d => {
        // The browser's own "leave this page?" prompt is the editor protecting unsaved work, and
        // is counted separately. Accepted, so a test can reload; any other native dialog means
        // something still calls alert/confirm/prompt, which the editor replaced with its own.
        if (d.type() === "beforeunload") { page.beforeUnloads++; d.accept(); return; }
        page.nativeDialogs++;
        d.dismiss();
    });
    if (settings) {
        await page.addInitScript(s => { if (!localStorage.getItem("wets:settings:v1")) localStorage.setItem("wets:settings:v1", JSON.stringify(s)); }, settings);
    }
    if (autosaveMs) {
        await page.addInitScript(ms => localStorage.setItem("wets:debug:autosaveMs", String(ms)), autosaveMs);
    }
    await page.addInitScript(name => {
        window.__pickFolder = name;
        window.showDirectoryPicker = async () => {
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle(window.__pickFolder, { create: true });
        };
    }, folderName);
}

/** Which folder the next "open" picks. */
const pick = (page, folder) => page.evaluate(f => { window.__pickFolder = f; }, folder);

/** Writes files into a folder on the page's "disk", creating it. `files` maps path → text. */
const seed = (page, folder, files) => page.evaluate(async ([name, entries]) => {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(name, { create: true });
    for (const [path, text] of Object.entries(entries)) {
        const parts = path.split("/");
        let dir = base;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(text);
        await w.close();
    }
}, [folder, files]);

/** Every file under a folder on the page's "disk". */
const diskState = (page, folder = "DemoScenario") => page.evaluate(async name => {
    const out = [];
    const walk = async (dir, p) => {
        for await (const h of dir.values()) {
            const path = p ? `${p}/${h.name}` : h.name;
            if (h.kind === "directory") { out.push(`${path}/`); await walk(h, path); }
            else out.push(path);
        }
    };
    const root = await navigator.storage.getDirectory();
    try { await walk(await root.getDirectoryHandle(name), ""); } catch { /* none */ }
    return out.sort();
}, folder);

/** The text of one file on the page's "disk", or null. */
const readDisk = (page, folder, path) => page.evaluate(async ([name, file]) => {
    try {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        const parts = file.split("/");
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    } catch { return null; }
}, [folder, path]);

/**
 * Keeps each write of the recovery copy open `ms` longer before it closes, so
 * an autosave is nearly always in flight when the next step runs. A race with
 * it then shows every run instead of one run in eight. 0 turns it off; a
 * reload does too.
 */
const slowAutosave = (page, ms) => page.evaluate(delay => {
    if (window.__slowAutosave === undefined) {
        const create = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
            const writable = await create.apply(this, args);
            const hold = this.name === "autosave.scene.json" ? window.__slowAutosave : 0;
            if (hold > 0) {
                const close = writable.close.bind(writable);
                writable.close = async () => { await new Promise(r => setTimeout(r, hold)); return close(); };
            }
            return writable;
        };
    }
    window.__slowAutosave = delay;
}, ms);

/** Copies a folder from the page's "disk" to a real directory, so other tools can be pointed at it. */
async function exportFolder(page, folder, sub, targetDir) {
    const files = await page.evaluate(async ([name, path]) => {
        const out = {};
        const walk = async (dir, prefix) => {
            for await (const h of dir.values()) {
                const p = prefix ? `${prefix}/${h.name}` : h.name;
                if (h.kind === "directory") await walk(h, p);
                else out[p] = Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer()));
            }
        };
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        for (const part of path.split("/")) dir = await dir.getDirectoryHandle(part);
        await walk(dir, "");
        return out;
    }, [folder, sub]);
    rmSync(targetDir, { recursive: true, force: true });
    for (const [path, bytes] of Object.entries(files)) {
        const file = resolve(targetDir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(bytes));
    }
}

const shot = async (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

const dialogTitle = page => page.locator(".dlg-title").last();
const dialogButton = (page, text) => page.locator(".dlg-btn", { hasText: text }).last();
const menu = async (page, bar, item) => {
    await page.locator(".menubar-item", { hasText: bar }).click();
    await page.locator(".ctx-item", { hasText: item }).click();
};
// "No errors" ignores the two things that are not the app's: a 404 for an asset the
// static server does not carry, and the GL driver's performance note about the
// readPixels the probe's pixelStats/pixel reads deliberately perform (D-9/D-13).
const noErrors = page => page.logs.filter(l =>
    !l.includes("404")
    && !l.includes("GL Driver Message")
    && !l.includes("GPU stall")
).length === 0;

/** From the start screen: open the (empty) folder the picker returns and accept the set-up. */
async function openEmptyProject(page) {
    await page.getByText("Open folder…").click();
    await dialogButton(page, "Set up").click();
    await page.locator(".work").waitFor();
}

/** A scene file with one object, in the engine's format. */
const sceneWith = name => JSON.stringify({
    name: "Seeded", version: 1,
    roots: [{
        name, active: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [], children: [],
    }],
});

// ═══ Scenarios ═══
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario("start screen: no workspace without a project; open, close, recent, forget", async () => {
    const page = await newPage("LifeDemo");
    check("no workspace before a project", (await page.locator(".work").count()) === 0);
    check("no menus on the start screen", (await page.locator(".menubar-item").count()) === 0);
    check("the start screen is shown", await page.locator(".start-card").isVisible());
    check("the recent list starts empty", (await page.locator(".start-recent").innerText()).includes("Projects you open will appear here"));
    await shot(page, "e2e-start-screen");

    await page.getByText("Open folder…").click();
    check("an empty folder asks before it is set up", (await dialogTitle(page).innerText()) === "Set up a project here?");
    await dialogButton(page, "Set up").click();
    await page.locator(".work").waitFor();
    check("the workspace appears", (await page.locator(".menubar-item").count()) === 6);
    check("the project name is shown", (await page.locator(".project-tag").innerText()).includes("LifeDemo"));
    await page.waitForTimeout(600);   // the layout is written right after the workspace opens
    const files = await diskState(page, "LifeDemo");
    check("the scenario layout was created", ["scenario.meta.json", "scripts/Scenario.ts", "assets/scenes/"].every(f => files.includes(f)), files.join(", "));

    await menu(page, "File", "Close Project");
    await page.locator(".start-card").waitFor();
    check("closing returns to the start screen", (await page.locator(".work").count()) === 0);
    check("the project is in the recent list", (await page.locator(".recent .rname").allInnerTexts()).join() === "LifeDemo");

    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    check("a recent project reopens", (await page.locator(".project-tag").innerText()).includes("LifeDemo"));

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    check("after a reload nothing opens by itself", (await page.locator(".work").count()) === 0);
    check("but the project is remembered", (await page.locator(".recent .rname").allInnerTexts()).join() === "LifeDemo");

    await page.locator(".recent").hover();
    await page.locator(".rforget").click();
    await page.waitForTimeout(200);
    check("a project can be removed from the list", (await page.locator(".recent").count()) === 0);
    check("removing it left the folder alone", (await diskState(page, "LifeDemo")).includes("scenario.meta.json"));
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("opening folders: not a project, an existing project, a missing folder", async () => {
    const page = await newPage("Notes");
    await seed(page, "Notes", { "notes.txt": "keep me" });

    await page.getByText("Open folder…").click();
    check("a folder with other files is not set up silently", (await dialogTitle(page).innerText()) === "This folder is not a project");
    await dialogButton(page, "Cancel").click();
    await page.waitForTimeout(200);
    check("cancelling changes nothing", (await page.locator(".work").count()) === 0
        && !(await diskState(page, "Notes")).includes("scenario.meta.json"));

    await page.getByText("Open folder…").click();
    await dialogButton(page, "Make it a project").click();
    await page.locator(".work").waitFor();
    const notes = await diskState(page, "Notes");
    check("making it a project adds the layout and keeps the files", notes.includes("scenario.meta.json") && notes.includes("notes.txt"), notes.join(", "));

    await menu(page, "File", "Close Project");
    await seed(page, "Existing", {
        "scenario.meta.json": JSON.stringify({ id: "existing", name: "Existing", version: "1.0.0" }),
        "assets/scenes/main.scene.json": sceneWith("SeededObject"),
    });
    await pick(page, "Existing");
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor();
    check("an existing project opens without questions", (await page.locator(".dlg").count()) === 0);
    await page.waitForTimeout(500);
    check("its main scene is loaded", (await page.locator("app-hierarchy").innerText()).includes("SeededObject"));
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(500);
    const saved = JSON.parse(await readDisk(page, "Existing", "assets/scenes/main.scene.json"));
    check("saving writes back to that scene, not a new empty one", saved.roots.map(r => r.name).join() === "SeededObject", JSON.stringify(saved.roots.map(r => r.name)));

    await menu(page, "File", "Close Project");
    await seed(page, "Gone", { "scenario.meta.json": "{}" });
    await pick(page, "Gone");
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor();
    await menu(page, "File", "Close Project");
    await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry("Gone", { recursive: true }); });
    await page.locator(".recent", { hasText: "Gone" }).click();
    await page.waitForTimeout(400);
    await shot(page, "e2e-missing-folder");
    check("a deleted folder is reported, not opened", (await page.locator(".dlg").innerText()).includes("was not found"));
    await dialogButton(page, "OK").click();
    check("and the start screen stays", (await page.locator(".work").count()) === 0);
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("unsaved changes: closing asks, saving never silently replaces a scene", async () => {
    const page = await newPage("Existing");
    await seed(page, "Existing", {
        "scenario.meta.json": JSON.stringify({ id: "existing", name: "Existing", version: "1.0.0" }),
        "assets/scenes/main.scene.json": sceneWith("SeededObject"),
    });
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(500);

    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await menu(page, "File", "Close Project");
    check("closing with unsaved changes asks", (await dialogTitle(page).innerText()) === "Save changes to main.scene.json?");
    check("with three ways out", (await page.locator(".dlg-foot .dlg-btn").allInnerTexts()).join() === "Cancel,Don't save,Save");
    await shot(page, "e2e-save-changes");
    await dialogButton(page, "Cancel").click();
    await page.waitForTimeout(200);
    check("cancelling keeps the project open", (await page.locator(".work").count()) === 1);

    // A new scene has no file; the default name is already taken by another scene.
    await menu(page, "File", "New Scene");
    await dialogButton(page, "Don't save").click();
    await page.waitForTimeout(300);
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.keyboard.press("Control+s");
    check("saving over another scene asks first", (await dialogTitle(page).innerText()) === "Replace the existing scene?");
    await dialogButton(page, "Cancel").click();
    await page.waitForTimeout(300);
    const kept = JSON.parse(await readDisk(page, "Existing", "assets/scenes/main.scene.json"));
    check("cancelling leaves the scene as it was", kept.roots[0].name === "SeededObject");

    await page.keyboard.press("Control+s");
    await dialogButton(page, "Replace").click();
    await page.waitForTimeout(400);
    const replaced = JSON.parse(await readDisk(page, "Existing", "assets/scenes/main.scene.json"));
    check("confirming replaces it", replaced.roots[0].name === "GameObject", replaced.roots[0].name);

    await menu(page, "File", "Close Project");
    await page.waitForTimeout(300);
    check("a saved scene closes without asking", (await page.locator(".start-card").count()) === 1 && (await page.locator(".dlg").count()) === 0);
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("honest saving: the mark, Save from the dialog, the gizmo, closing the tab", async () => {
    // The probe is on here too: the move tool's handle is found through it, so
    // the scenario does not encode the camera's pixels (B1.3 changed them).
    const page = await newPage("SaveDemo", { probe: true });
    await openEmptyProject(page);
    const status = () => page.locator(".statusbar .accent").first().innerText();
    const dot = () => page.locator(".project-tag .dot.unsaved").count();

    check("a fresh project is saved", (await status()) === "Saved" && (await dot()) === 0);
    check("the tab title has no mark", !(await page.title()).startsWith("●"));

    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(200);
    check("an edit makes it unsaved", (await status()) === "Unsaved" && (await dot()) === 1);
    check("the tab title says so", (await page.title()).startsWith("●"));
    check("and so does the tree's root row", (await page.locator("app-hierarchy .scene-root .dirty").count()) === 1);

    await page.keyboard.press("Control+s");
    await page.waitForTimeout(500);
    check("saving clears it", (await status()) === "Saved" && (await dot()) === 0);
    check("the tooltip says when", (await page.locator(".statusbar .accent").first().getAttribute("title")).startsWith("Last saved at"));

    // Selection is not an edit.
    await page.locator("app-hierarchy li", { hasText: "GameObject" }).first().click();
    check("selecting does not make it unsaved", (await status()) === "Saved");

    // A gizmo drag is an edit — and undoable. Dragging the red (X) arrow of the move tool.
    const position = () => page.locator(".insp-body .field").first().locator("input").evaluateAll(els => els.map(e => e.value).join(","));
    const before = await position();

    // The arrow's tip comes from the probe (handlePoint projects the pivot + the
    // axis), so the check does not depend on where the camera happens to sit:
    // B1.3 restored the frozen initial pose and the pixels moved with it.
    const arrow = await page.evaluate(() => {
        const p = window.__wetsProbe.handlePoint("x", 0.8);
        return p ? { x: p.x, y: p.y } : null;
    });
    check("the move tool's X handle is on screen", !!arrow, JSON.stringify(arrow));

    // Pressing a handle without dragging changes nothing, so it must not make the scene unsaved.
    await page.mouse.move(arrow.x, arrow.y, { steps: 3 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);
    check("pressing a handle without dragging is not an edit", (await status()) === "Saved");
    check("and does not deselect the object", (await position()) === before, await position());

    await page.mouse.move(arrow.x, arrow.y, { steps: 3 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(100);
    for (let i = 1; i <= 10; i++) { await page.mouse.move(arrow.x + i * 8, arrow.y + i * 2, { steps: 2 }); await page.waitForTimeout(40); }
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await position();
    check("dragging the gizmo moved the object", before !== after, `${before} -> ${after}`);
    check("and made the scene unsaved", (await status()) === "Unsaved");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    // Undo reloads the scene, which drops the selection; select the object again to read it.
    await page.locator("app-hierarchy li", { hasText: "GameObject" }).first().click();
    check("Ctrl+Z puts it back", (await position()) === before, `${await position()} vs ${before}`);

    // Closing the tab: the browser asks only when there is something to lose.
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    check("saved again before leaving", (await status()) === "Saved", await status());
    const askedClean = page.beforeUnloads;
    await page.reload({ waitUntil: "load" });
    check("a saved scene lets the tab go quietly", page.beforeUnloads === askedClean);
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(400);
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(200);
    const askedDirty = page.beforeUnloads;
    await page.reload({ waitUntil: "load" });
    check("unsaved work makes the browser ask first", page.beforeUnloads === askedDirty + 1);

    // Save from the three-button dialog: saves, then goes on.
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(400);
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.keyboard.press("Alt+Shift+N");
    await menu(page, "File", "Close Project");
    await dialogButton(page, "Save").click();
    await page.locator(".start-card").waitFor();
    const saved = JSON.parse(await readDisk(page, "SaveDemo", "assets/scenes/main.scene.json"));
    check("Save in the dialog writes the scene before closing", saved.roots.length >= 2, String(saved.roots.length));
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1 phase 1 — the 3D Object menu (D-3) and the D-2 render order. The debug
// probe (D-13) is installed only when the flag is set, so the scenario sets it
// in its own context; production editors never carry it.
scenario("3d objects: the six primitives, undo, persistence, and the gizmo on top (B1.1)", async () => {
    const page = await newPage("PrimitivesDemo", { probe: true });
    await openEmptyProject(page);

    const KINDS = ["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"];
    const pivot = () => page.evaluate(() => window.__wetsProbe.pivot());
    const treeNames = () => page.locator("app-hierarchy li .label").allInnerTexts();

    // DW-1.1: each of the six, from the GameObject menu, lands at the pivot and
    // is selected; one Ctrl+Z removes it in one step, Ctrl+Y brings it back.
    const origin = await pivot();
    check("the pivot starts at the origin", origin.x === 0 && origin.y === 0 && origin.z === 0, JSON.stringify(origin));

    for (const kind of KINDS) {
        // The 3D Object entry is a submenu parent: it opens on hover.
        await page.locator(".menubar-item", { hasText: "GameObject" }).click();
        await page.locator(".ctx-item", { hasText: "3D Object" }).first().hover();
        await page.locator(".ctx-item", { hasText: kind }).last().click();
        await page.waitForTimeout(250);
        check(`${kind}: created and selected`, (await page.locator("app-hierarchy li.selected .label").innerText()) === kind);

        const p = () => page.locator(".insp-body .field").nth(0).locator("input").evaluateAll(els => els.map(e => e.value).join(","));
        const placed = await p();
        check(`${kind}: sits at the pivot`, placed === "0,0,0", placed);

        await page.keyboard.press("Control+z");
        await page.waitForTimeout(300);
        check(`${kind}: one undo step removes it`, !(await treeNames()).includes(kind), (await treeNames()).join(", "));

        await page.keyboard.press("Control+y");
        await page.waitForTimeout(300);
        check(`${kind}: redo brings it back`, (await treeNames()).includes(kind), (await treeNames()).join(", "));
    }

    // DW-1.3: save, close, reopen — all six present, version 1, the mesh, the
    // material and the collider per kind (Plane/Quad carry none, D-3).
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(600);
    // Saved already, so the close goes without the three-button dialog.
    await menu(page, "File", "Close Project");
    await page.locator(".start-card").waitFor();
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(500);

    const saved = JSON.parse(await readDisk(page, "PrimitivesDemo", "assets/scenes/main.scene.json"));
    check("reopen: all six are in the scene", KINDS.every(k => saved.roots.some(r => r.name === k)), saved.roots.map(r => r.name).join(", "));
    check("the file stays format version 1", saved.version === 1, String(saved.version));
    for (const kind of KINDS.slice(0, 4)) {
        const root = saved.roots.find(r => r.name === kind);
        const mesh = root.components.find(c => c.type === "MeshFilter");
        const mat = root.components.find(c => c.type === "MeshRenderer");
        check(`${kind}: a PrimitiveMesh with its kind`, mesh?.fields.sharedMesh?.$type === "PrimitiveMesh" && typeof mesh.fields.sharedMesh.kind === "string", JSON.stringify(mesh?.fields.sharedMesh));
        check(`${kind}: an inlined material`, typeof mat?.fields.sharedMaterial === "object", JSON.stringify(mat?.fields.sharedMaterial));
        check(`${kind}: Unity's collider`, root.components.some(c => /Collider/.test(c.type)), root.components.map(c => c.type).join(", "));
    }
    for (const kind of KINDS.slice(4)) {
        const root = saved.roots.find(r => r.name === kind);
        check(`${kind}: no collider (Unity's MeshCollider is a recorded deviation)`, !root.components.some(c => /Collider/.test(c.type)), root.components.map(c => c.type).join(", "));
    }

    // DW-1.4: the gizmo's red X arrow lands over the cube (D-2's on-top layer).
    await page.locator("app-hierarchy li", { hasText: "Cube" }).first().click();
    await page.waitForTimeout(300);
    const point = await page.evaluate(() => {
        const probe = window.__wetsProbe;
        const p = probe.handlePoint("x", 1.2);
        return p ? probe.pixel(p.x, p.y) : null;
    });
    check("the gizmo's X arrow is drawn over the cube", Array.isArray(point) && point[0] > 120 && point[0] > point[1] + 60 && point[0] > point[2] + 60, JSON.stringify(point));

    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("recovery: unsaved work survives a crash; giving it up is remembered", async () => {
    const page = await newPage("CrashDemo", { autosaveMs: 300 });
    await openEmptyProject(page);
    const autosave = () => readDisk(page, "CrashDemo", ".editor/autosave.scene.json");

    await page.waitForTimeout(800);
    check("nothing is written while nothing is unsaved", (await autosave()) === null);

    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(1000);
    const copy = await autosave();
    check("a recovery copy appears while there are unsaved changes", copy !== null && JSON.parse(copy).roots.length === 1, JSON.stringify(copy?.slice(0, 80)) + " len=" + (copy === null ? "null" : JSON.parse(copy).roots.length));
    check("the Project panel does not show it", !(await page.locator(".proj").innerText()).includes("autosave"));

    // With an autosave mid-write. Its open file used to make the removal fail,
    // and the copy outlived the save.
    await slowAutosave(page, 500);
    await page.waitForTimeout(700);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(1500);
    check("saving removes it", (await autosave()) === null);
    await slowAutosave(page, 0);

    // "Crash": the tab goes away with unsaved work in it.
    await page.keyboard.press("Alt+Shift+N");
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "load" });
    await page.locator(".recent").first().click();
    await page.waitForTimeout(800);
    check("reopening offers the unsaved work back", (await dialogTitle(page).innerText()) === "Restore unsaved work?");
    await dialogButton(page, "Restore").click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(400);
    const tree = await page.locator("app-hierarchy li").count();
    check("restoring brings the objects back", tree >= 4, String(tree));
    check("and the scene is still unsaved, as it is", (await page.locator(".statusbar .accent").first().innerText()) === "Unsaved");

    // Give it up: the next opening must not ask again.
    await page.reload({ waitUntil: "load" });
    await page.locator(".recent").first().click();
    await page.waitForTimeout(800);
    check("the copy is still offered after another crash", (await dialogTitle(page).innerText()) === "Restore unsaved work?");
    await dialogButton(page, "Discard it").click();
    await page.waitForTimeout(500);
    check("refusing deletes it", (await autosave()) === null);
    check("and the scene is the saved one", (await page.locator("app-hierarchy li").count()) === 2);

    // "Don't save" in the close dialog gives it up too, with an autosave mid-write
    // as above: this is where the race first showed, about one full run in eight.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(1000);
    check("a copy exists again", (await autosave()) !== null);
    await slowAutosave(page, 500);
    await page.waitForTimeout(700);
    await menu(page, "File", "Close Project");
    await dialogButton(page, "Don't save").click();
    await page.locator(".start-card").waitFor();
    check("Don't save deletes the copy", (await autosave()) === null);
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("one tab per project; changes made outside the editor", async () => {
    const page = await newPage("TabsDemo");
    await openEmptyProject(page);
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(500);

    // A second tab on the same folder is refused.
    const other = await siblingPage(page, "TabsDemo");
    await other.getByText("Open folder…").click();
    await other.waitForTimeout(600);
    check("a second tab cannot open the same project", (await other.locator(".dlg").innerText()).includes("already open in another tab"));
    await dialogButton(other, "OK").click();
    check("it stays on the start screen", (await other.locator(".work").count()) === 0);
    await menu(page, "File", "Close Project");
    await other.getByText("Open folder…").click();
    await other.locator(".work").waitFor();
    check("once the first tab lets go, the second can open it", (await other.locator(".work").count()) === 1);
    await other.close();

    // Changed outside while the scene here is clean: reloaded quietly.
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(500);
    const external = name => page.evaluate(async ([n, text]) => {
        const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("TabsDemo")).getDirectoryHandle("assets")).getDirectoryHandle("scenes");
        const w = await (await dir.getFileHandle("main.scene.json", { create: true })).createWritable();
        await w.write(text); await w.close();
    }, [name, sceneWith(name)]);
    await page.waitForTimeout(50);
    await external("FromOutside");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    // The reload is asynchronous; under the full suite's load it lands later
    // than a fixed wait, so wait for the tree to show the new scene instead.
    for (let i = 0; i < 50; i++) {
        if ((await page.locator("app-hierarchy").innerText()).includes("FromOutside")) break;
        await page.waitForTimeout(100);
    }
    check("a clean scene reloads quietly when the file changes", (await page.locator("app-hierarchy").innerText()).includes("FromOutside"));
    check("and stays clean", (await page.locator(".statusbar .accent").first().innerText()) === "Saved");

    // Changed in both places: asked, and "keep mine" is respected and not repeated.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(100);
    await external("FromOutsideAgain");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(600);
    check("changed in both places, it asks", (await dialogTitle(page).innerText()).includes("changed on disk"));
    await dialogButton(page, "Keep mine").click();
    await page.waitForTimeout(300);
    check("keeping mine keeps my edit", !(await page.locator("app-hierarchy").innerText()).includes("FromOutsideAgain"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(600);
    check("and it does not ask again about the same change", (await page.locator(".dlg").count()) === 0);

    await page.waitForTimeout(50);
    await external("ThirdVersion");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(600);
    await dialogButton(page, "Reload from disk").click();
    await page.waitForTimeout(500);
    check("reloading takes the disk version", (await page.locator("app-hierarchy").innerText()).includes("ThirdVersion"));
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

/** Entries directly inside a path of the origin-private file system ('' = its root). */
const opfsEntries = (page, path = "") => page.evaluate(async p => {
    const root = await navigator.storage.getDirectory();
    let dir = root;
    for (const part of p.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    const out = [];
    for await (const h of dir.values()) out.push(h.kind === "directory" ? `${h.name}/` : h.name);
    return out.sort();
}, path);

/** The text of one file in the origin-private file system, or null. */
const opfsRead = (page, path) => page.evaluate(async f => {
    try {
        let dir = await navigator.storage.getDirectory();
        const parts = f.split("/");
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    } catch { return null; }
}, path);

// A project in the browser's own store (R1): the folder picker is a Chromium-only
// API, so the wizard's second option is what a non-Chromium browser gets. The
// picker is faked to OPFS by `instrument`, so both options exist here.
scenario("a project in the browser's own store: create, reopen after a reload, missing when cleared", async () => {
    const page = await newPage("BrowserStoreParent");

    await page.getByText("Create project").click();
    await page.locator("#wiz-name").fill("Кристали решітки");
    await page.locator("#wiz-id").fill("crystal-lattices");
    await page.locator(".dlg-btn.primary").click();               // step 1 → 2
    await page.locator(".dlg-btn.primary").click();               // step 2 → 3
    check("step three offers both stores", (await page.locator(".wiz-card").count()) === 2);
    check("the folder is the default", await page.locator('.wiz-card[aria-checked="true"]').innerText().then(t => t.includes("folder on this computer")));
    await page.getByText("The browser’s own storage").click();
    await shot(page, "e2e-browser-store-choice");
    await page.locator(".dlg-btn.primary").click();                 // create
    await page.locator(".work").waitFor();
    await page.waitForTimeout(900);

    check("the project opens", (await page.locator(".project-tag").innerText()).includes("Кристали"));

    // Where it lives: one project folder in the origin-private file system.
    const projects = await opfsEntries(page, "projects");
    const id = projects.find(n => n.endsWith("/"))?.slice(0, -1);
    check("one project folder in the browser store", !!id, projects.join(", "));
    const layout = await opfsEntries(page, `projects/${id}`);
    check("the layout is in the browser store",
        ["scenario.meta.json", "scripts/", "assets/"].every(f => layout.includes(f)), layout.join(", "));
    const meta = JSON.parse(await opfsRead(page, `projects/${id}/scenario.meta.json`));
    check("the identity is what was typed",
        meta.id === "crystal-lattices" && meta.name === "Кристали решітки", JSON.stringify(meta));
    check("the starting scene was written",
        (await opfsEntries(page, `projects/${id}/assets/scenes`)).includes("main.scene.json"));

    // It survives a reload, and reopens from the recent list.
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    check("after a reload nothing opens by itself", (await page.locator(".work").count()) === 0);
    check("the browser project is remembered", (await page.locator(".recent .rname").allInnerTexts()).join() === "Кристали решітки");
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    check("a browser project reopens", (await page.locator(".project-tag").innerText()).includes("Кристали"));

    // Cleared site data makes it *missing*, not an empty project that pretends to be new.
    await page.evaluate(async projectId => {
        const projects = await (await navigator.storage.getDirectory()).getDirectoryHandle("projects");
        await projects.removeEntry(projectId, { recursive: true });
    }, id);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.locator(".recent").first().click();
    await page.waitForTimeout(300);
    check("a cleared project is reported missing, not reopened empty",
        (await page.locator(".dlg").innerText()).includes("was not found"),
        (await page.locator(".dlg").innerText().catch(() => "no dialog")));
    check("and the workspace did not open", (await page.locator(".work").count()) === 0);
    await dialogButton(page, "OK").click();
    await page.waitForTimeout(200);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// No writer, no store (R1r, DW-2.2): `createWritable` is the write primitive, and
// Safari below 26 has the directory without it. A project there would open
// read-only — which is not a store — so the browser store must not be offered,
// and nothing may be created on its behalf. The picker is still faked here (the
// harness fakes it), so this is the shape every other browser gets: no location
// step, the folder path unchanged.
scenario("a browser with no createWritable is offered no browser store, and creates nothing in it", async () => {
    const page = await newPage("NoWriterParent");
    await page.addInitScript(() => {
        Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", {
            value: undefined, configurable: true,
        });
    });
    await page.goto(URL_, { waitUntil: "load" });
    await page.waitForTimeout(300);

    check("the editor still starts", await page.locator(".start-card").isVisible());
    await page.getByText("Create project").click();
    await page.locator("#wiz-name").fill("DirOnly");
    await page.locator("#wiz-id").fill("dir-only");
    await page.locator(".dlg-btn.primary").click();               // step 1 → 2
    await page.locator(".dlg-btn.primary").click();               // step 2 → 3
    check("no location choice is offered", (await page.locator(".wiz-card").count()) === 0);
    check("and the folder path is the only one left",
        (await page.locator(".wiz-pick").count()) === 1);
    await page.locator(".dlg-btn.primary").click();                 // create
    await page.waitForTimeout(1200);

    // Without a writer the disk store cannot write either, so the creation is
    // reported rather than silently leaving a half-made project.
    check("no workspace opened", (await page.locator(".work").count()) === 0);
    const dialog = await page.locator(".dlg").innerText().catch(() => "no dialog");
    check("and the failure is reported", dialog.length > 0 && dialog !== "no dialog", dialog);
    check("nothing was created in the browser store", (await opfsEntries(page, "projects").catch(() => [])) .length === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// The same, with no store at all (R1r, DW-2.2): a browser with neither the folder
// picker nor a writer must say so on its start screen, and no wizard may open.
scenario("a browser with neither store says unsupported, and opens no wizard", async () => {
    const page = await newPage("NoStoreAtAll");
    await page.addInitScript(() => {
        Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", {
            value: undefined, configurable: true,
        });
        delete window.showDirectoryPicker;
    });
    await page.goto(URL_, { waitUntil: "load" });
    await page.waitForTimeout(300);

    check("the unsupported notice is shown",
        (await page.locator(".start-unsupported").innerText()).includes("Project folders are not available"));
    check("and the create button is not there", (await page.getByText("Create project").count()) === 0);
    check("no project folder was made", (await opfsEntries(page).catch(() => [])) .length === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// A full origin (R1r, DW-2.3): the quota failure must reach the user as the named
// error and must not mark the in-memory edit saved. The write path is
// `ProjectService.write` → `handle.createWritable()`, so the scene file's writer
// is made to reject — the real path the user's Save goes through.
scenario("a quota exceeded on save reaches the user and keeps the edit unsaved", async () => {
    const page = await newPage("QuotaParent");

    // A browser-store project, created normally, with the scene already saved.
    await page.getByText("Create project").click();
    await page.locator("#wiz-name").fill("Квота");
    await page.locator("#wiz-id").fill("quota-demo");
    await page.locator(".dlg-btn.primary").click();               // step 1 → 2
    await page.locator(".dlg-btn.primary").click();               // step 2 → 3
    await page.getByText("The browser’s own storage").click();
    await page.locator(".dlg-btn.primary").click();                 // create
    await page.locator(".work").waitFor();
    await page.waitForTimeout(900);
    check("the project is open", (await page.locator(".project-tag").innerText()).includes("Квота"));

    const projects = await opfsEntries(page, "projects");
    const id = projects.find(n => n.endsWith("/"))?.slice(0, -1);
    const scenePath = `projects/${id}/assets/scenes/main.scene.json`;
    const before = await opfsRead(page, scenePath);
    check("the starting scene is on disk", !!before);

    // One edit, then the origin fills up.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(300);
    check("the edit is unsaved", (await page.locator(".statusbar .accent").first().innerText()) === "Unsaved");

    await page.evaluate(() => {
        const real = FileSystemFileHandle.prototype.createWritable;
        Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", {
            configurable: true,
            value: async function (...args) {
                if (this.name === "main.scene.json") {
                    const err = new Error("The storage quota has been exceeded.");
                    err.name = "QuotaExceededError";
                    throw err;
                }
                return real.apply(this, args);
            },
        });
    });

    await page.keyboard.press("Control+s");
    await page.waitForTimeout(700);
    const dialog = await page.locator(".dlg").innerText().catch(() => "no dialog");
    check("the save failure names the error", dialog.includes("Could not save") && dialog.includes("quota"), dialog);
    await dialogButton(page, "OK").click();
    await page.waitForTimeout(300);

    check("the edit is still unsaved", (await page.locator(".statusbar .accent").first().innerText()) === "Unsaved");
    check("and the unsaved mark is still there", (await page.locator(".project-tag .dot.unsaved").count()) === 1);
    check("the scene file was not replaced", (await opfsRead(page, scenePath)) === before);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("new project wizard: collects, validates, creates; cancelling writes nothing", async () => {
    const page = await newPage("WizParent");
    const exists = name => page.evaluate(async n => {
        try { await (await navigator.storage.getDirectory()).getDirectoryHandle(n); return true; } catch { return false; }
    }, name);

    // Cancelling at any step leaves nothing on disk — not even the parent folder, which the picker would create.
    await page.getByText("Create project").click();
    check("the wizard opens", (await dialogTitle(page).innerText()) === "New project");
    // dlgFocus moves focus in a setTimeout, once the dialog is laid out. Late in a full run,
    // with every earlier scenario's page still open, that can land after the title is
    // readable — so wait for it, briefly, instead of racing it. Focus elsewhere still fails.
    check("the title field has focus", await page.waitForFunction(() => document.activeElement?.id === "wiz-name", null, { timeout: 5000 })
        .then(() => true, () => false));
    await page.keyboard.press("Escape");
    check("cancelling creates nothing", !(await exists("WizParent")));

    await page.getByText("Create project").click();
    await page.locator("#wiz-name").fill("Будова атома");
    check("the address follows the title, transliterated", (await page.locator("#wiz-id").inputValue()) === "budova-atoma");
    await page.locator("#wiz-id").fill("Bad_Id");
    check("an invalid address is flagged", (await page.locator(".wiz-error").innerText()).includes("lowercase"));
    await page.locator(".dlg-btn.primary").click();
    check("and blocks going on", (await page.locator(".wiz-steps").innerText()).includes("Step 1 of 3"));
    await page.locator("#wiz-id").fill("budova-atoma");
    await page.locator("#wiz-desc").fill("Periodic table and shells");
    await page.locator("#wiz-cat").selectOption("demo");
    await shot(page, "e2e-wizard-1");
    await page.locator(".dlg-btn.primary").click();
    check("step two offers the starting points", (await page.locator(".wiz-card").count()) === 2);
    check("light and camera is the default", (await page.locator(".wiz-card.on strong").innerText()) === "Light and camera");
    await page.locator(".dlg-btn.primary").click();
    check("step three needs a folder first", (await page.locator(".wiz-parent").innerText()) === "No folder chosen.");
    check("the folder name follows the title", (await page.locator("#wiz-folder").inputValue()) === "Будова атома");

    // The chosen location already holds a non-empty folder of that name.
    await seed(page, "WizParent", { "Будова атома/old.txt": "x" });
    await page.getByText("Choose a folder…").click();
    await page.waitForTimeout(200);
    await page.locator(".dlg-btn.primary").click();
    await page.waitForTimeout(300);
    await shot(page, "e2e-wizard-3");
    check("a taken name is refused with a reason", (await page.locator(".wiz-error").innerText()).includes("already exists"));
    check("and the wizard stays open", (await page.locator(".wiz-steps").innerText()).includes("Step 3 of 3"));
    await page.locator("#wiz-folder").fill("Atom");
    await page.keyboard.press("Enter");
    await page.locator(".work").waitFor();
    await page.waitForTimeout(800);

    check("the project opens", (await page.locator(".project-tag").innerText()).includes("Atom"));
    const hierarchy = await page.locator("app-hierarchy").innerText();
    check("the starting scene has a camera and a light", hierarchy.includes("Camera") && hierarchy.includes("Directional Light"), hierarchy.replace(/\s+/g, " "));
    check("a fresh project is not 'unsaved'", (await page.locator(".statusbar").innerText()).includes("Saved"));

    const files = await diskState(page, "WizParent");
    check("the layout is in the new folder", ["Atom/scenario.meta.json", "Atom/scripts/Scenario.ts", "Atom/assets/scenes/main.scene.json"].every(f => files.includes(f)), files.join(", "));
    check("the existing folder was left alone", files.includes("Будова атома/old.txt"));
    const meta = JSON.parse(await readDisk(page, "WizParent", "Atom/scenario.meta.json"));
    check("the identity is what was typed", meta.id === "budova-atoma" && meta.name === "Будова атома" && meta.category === "demo"
        && meta.description === "Periodic table and shells" && meta.version === "1.0.0", JSON.stringify(meta));
    const scene = JSON.parse(await readDisk(page, "WizParent", "Atom/assets/scenes/main.scene.json"));
    check("the scene was written with both objects", scene.roots.length === 2 && scene.version === 1, JSON.stringify(scene.roots.map(r => r.name)));
    const cam = scene.roots.find(r => r.components.some(c => c.type === "Camera"));
    check("the camera looks at the scene from the back", cam && cam.transform.position.z === -10, JSON.stringify(cam?.transform.position));

    await exportFolder(page, "WizParent", "Atom", resolve(SHOTS, "wizard-project"));
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("project panel: import, save, reload, reopen, delete", async () => {
    const page = await newPage();
    await openEmptyProject(page);
    await page.locator(".proj .folders .folder", { hasText: "assets" }).first().click();
    await page.locator('.proj-btn.icon[title="New folder"]').click();
    await page.locator(".dlg-input").fill("textures");
    await page.keyboard.press("Enter");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFAAAnRAIO7Z8nYQAAAABJRU5ErkJggg==", "base64");
    await page.locator('.proj input[type="file"]').setInputFiles({ name: "checker.png", mimeType: "image/png", buffer: png });
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(600);

    let files = await diskState(page);
    check("layout files exist", ["scenario.meta.json", "scripts/Scenario.ts", "assets/scenes/main.scene.json", "assets/checker.png"].every(f => files.includes(f)), files.join(", "));

    await page.reload({ waitUntil: "load" });
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(500);
    check("the project reopens from the recent list", (await page.locator(".project-tag").innerText()).includes("DemoScenario"));
    check("its saved scene is opened with it", (await page.locator("app-hierarchy").innerText()).includes("GameObject"));

    await page.locator(".proj .folders .folder", { hasText: "assets" }).first().click();
    await page.locator(".proj .asset", { hasText: "checker.png" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Delete" }).click();
    check("deleting asks first", (await dialogTitle(page).innerText()) === "Delete from disk?");
    await page.locator(".dlg-btn.danger").click();
    await page.waitForTimeout(500);
    files = await diskState(page);
    check("delete removes the file from disk", !files.includes("assets/checker.png"));
    check("textures folder created through the dialog", files.includes("assets/textures/"), files.join(", "));
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", noErrors(page), page.logs.join(" | "));
    await shot(page, "e2e-project-panel");
});

scenario("language and theme follow the settings, and survive a reload", async () => {
    const page = await newPage("LangDemo", { settings: { language: "uk", theme: "light", density: "comfy" } });
    await page.waitForTimeout(500);
    check("the start screen is Ukrainian", (await page.locator(".start-action strong").first().innerText()) === "Створити проєкт");
    check("html lang follows", (await page.evaluate(() => document.documentElement.lang)) === "uk");
    check("light theme applied", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("light background is light", bg === "rgb(243, 244, 247)", bg);

    await page.getByText("Відкрити папку…").click();
    await dialogButton(page, "Підготувати").click();
    await page.locator(".work").waitFor();
    const bar = await page.locator(".menubar-item").allInnerTexts();
    check("menu bar is Ukrainian", bar.join(",") === "Файл,Редагування,Об’єкт,Компонент,Вікно,Довідка", bar.join(","));
    check("project panel is Ukrainian", (await page.locator(".proj .folder-group").innerText()) === "ПРОЄКТ");
    await shot(page, "e2e-ukrainian-light");

    // Plural forms: Ukrainian has three.
    for (let i = 0; i < 5; i++) await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(400);
    const status = await page.locator(".statusbar").innerText();
    check("five objects use the genitive plural", status.includes("5 об’єктів"), status.replace(/\s+/g, " "));

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    check("language survives a reload", (await page.locator(".start-action strong").first().innerText()) === "Створити проєкт");
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("preferences: reachable on every screen, language switches live, persists", async () => {
    const page = await newPage("PrefsDemo");
    const open = () => page.locator(".dlg-head .dlg-title", { hasText: /Preferences|Налаштування/ });

    // The start screen has no workspace and no menus, and Preferences are still there.
    await page.locator(".menubar .gear").click();
    check("the gear opens Preferences on the start screen", await open().isVisible());
    await page.keyboard.press("Control+,");
    await page.waitForTimeout(200);
    check("asking again does not stack dialogs", (await page.locator(".dlg").count()) === 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Esc closes it", (await page.locator(".dlg").count()) === 0);
    await page.keyboard.press("Control+,");
    check("Ctrl+, opens it", await open().isVisible());
    await page.keyboard.press("Escape");

    // The language switch on the start screen itself.
    await page.locator(".start-lang button", { hasText: "Українська" }).click();
    await page.waitForTimeout(200);
    check("the start screen's own switch changes the language", (await page.locator(".start-action strong").first().innerText()) === "Створити проєкт");
    await page.locator(".start-lang button", { hasText: "English" }).click();

    await openEmptyProject(page);
    await menu(page, "Edit", "Preferences");
    check("Edit → Preferences opens it in the workspace", await open().isVisible());
    await page.keyboard.press("Escape");

    // Language switches while the dialog is open; the scene is untouched.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.keyboard.press("Control+,");
    await page.selectOption("#prefs-language", "uk");
    await page.waitForTimeout(300);
    check("dialog title follows the language", (await page.locator(".dlg-title").innerText()) === "Налаштування");
    check("menu bar behind it follows too", (await page.locator(".menubar-item").first().innerText()) === "Файл");
    await page.locator(".seg button", { hasText: "Світла" }).click();
    check("theme changes at once", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
    await page.locator(".prefs-tab", { hasText: "Клавіші" }).click();
    check("shortcuts list is shown", (await page.locator(".prefs-keys tr").count()) > 10);
    await page.locator(".prefs-tab", { hasText: "Про програму" }).click();
    check("about shows the engine build", (await page.locator(".prefs-keys").innerText()).includes("0.1.0"));
    await page.locator(".prefs-tab", { hasText: "Загальні" }).click();
    await shot(page, "e2e-preferences");
    await page.locator(".dlg-btn.primary").click();
    await page.waitForTimeout(200);
    check("the open scene survived the language change", (await page.locator("app-hierarchy li").count()) >= 2);

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(400);
    check("language and theme persist", (await page.locator(".start-action strong").first().innerText()) === "Створити проєкт"
        && (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");

    await page.keyboard.press("Control+,");
    await page.locator(".dlg-btn", { hasText: "Скинути до типових" }).click();
    await page.waitForTimeout(200);
    check("reset returns to the browser's language and the dark theme",
        (await page.locator(".start-action strong").first().innerText()) === "Create project"
        && (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("dialogs: Esc cancels, Enter confirms, shortcuts stand down", async () => {
    const page = await newPage("DialogDemo");
    await openEmptyProject(page);
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(300);
    await page.locator("app-hierarchy li", { hasText: "GameObject" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename" }).click();
    await page.waitForTimeout(300);
    check("rename opens a dialog", await page.locator(".dlg-input").isVisible());
    check("the field has focus", await page.evaluate(() => document.activeElement?.classList.contains("dlg-input")));
    // Shortcuts must stand down: Delete while a dialog is open must not remove the object.
    await page.keyboard.press("Delete");
    await page.locator(".dlg-input").fill("Sun");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Esc closes without renaming", (await page.locator("app-hierarchy").innerText()).includes("GameObject"));
    check("the object survived Delete in the dialog", (await page.locator("app-hierarchy li").count()) >= 2);

    await page.locator("app-hierarchy li", { hasText: "GameObject" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename" }).click();
    await page.locator(".dlg-input").fill("Sun");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check("Enter renames", (await page.locator("app-hierarchy").innerText()).includes("Sun"));

    await page.locator("app-hierarchy li", { hasText: "Sun" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename" }).click();
    await page.locator(".dlg-input").fill("");
    check("an empty name cannot be confirmed", await page.locator(".dlg-btn.primary").isDisabled());
    await page.keyboard.press("Escape");
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
});

/**
 * A8: a scene file the editor can open, in the format the editor's own engine
 * writes it — a link-mode prefab instance, version 2 — plus the refusals: a
 * newer format gets `scene.tooNew`, a malformed file `scene.invalid`, and in
 * every refusal the scene already on screen is kept.
 */
const v2Linked = readFileSync(resolve(HERE, "fixtures/v2-linked.json"), "utf8");
const sceneAt = (name, root) => JSON.stringify({ name, roots: [root] });
const oneRoot = name => ({
    name, active: true,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    components: [], children: [],
});
const meta = (id, name) => JSON.stringify({ id, name, version: "1.0.0" });

scenario("scene formats: v1, an absent version and a v2 link all open", async () => {
    const page = await newPage("FmtOpen");
    await seed(page, "FmtV1", { "scenario.meta.json": meta("v1", "V1"), "assets/scenes/main.scene.json": sceneWith("SeededV1") });
    await seed(page, "FmtNoVer", { "scenario.meta.json": meta("nover", "NoVer"), "assets/scenes/main.scene.json": sceneAt("NoVersion", oneRoot("NoVersionRoot")) });
    await seed(page, "FmtV2", { "scenario.meta.json": meta("v2", "V2"), "assets/scenes/main.scene.json": v2Linked });

    for (const [folder, object] of [["FmtV1", "SeededV1"], ["FmtNoVer", "NoVersionRoot"], ["FmtV2", "FromV2"]]) {
        await pick(page, folder);
        await page.getByText("Open folder…").click();
        await page.locator(".work").waitFor();
        // Wait for the scene to reach the tree before reading it: under the full
        // suite's load the scene's arrival lags the workspace's, and a fixed
        // timeout read the tree too early (a flake, not a refusal).
        for (let i = 0; i < 50; i++) {
            if ((await page.locator("app-hierarchy").innerText()).includes(object)) break;
            await page.waitForTimeout(100);
        }
        check(`${folder}: the scene opens without questions`,
            (await page.locator(".dlg").count()) === 0 && (await page.locator("app-hierarchy").innerText()).includes(object));
        await menu(page, "File", "Close Project");
        await page.waitForTimeout(300);
    }
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    // The v2 fixture is a link to a prefab file this fixture project does not
    // carry (the editor's prefab authoring is stage 14), so the engine keeps
    // the instance as a placeholder and says so — a warning, not an error, and
    // the scene still opens. Everything else must stay silent.
    const unexpected = page.logs.filter(l => !l.includes("404") && !l.includes("fixture-holder-0001"));
    check("no page errors beyond the placeholder warning", unexpected.length === 0, unexpected.join(" | "));
});

scenario("scene formats: a newer format and a broken file are refused, the scene stays", async () => {
    const page = await newPage("FmtRefuse");
    await seed(page, "FmtKeep", { "scenario.meta.json": meta("keep", "Keep"), "assets/scenes/main.scene.json": sceneWith("SeededKeep") });
    await pick(page, "FmtKeep");
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(500);
    check("the scene is open first", (await page.locator("app-hierarchy").innerText()).includes("SeededKeep"));

    const external = (text) => page.evaluate(async t => {
        const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("FmtKeep")).getDirectoryHandle("assets");
        const scenes = await dir.getDirectoryHandle("scenes", { create: true });
        const w = await (await scenes.getFileHandle("main.scene.json", { create: true })).createWritable();
        await w.write(t); await w.close();
    }, text);

    // A file of a version this editor does not read: named, not loaded, kept.
    await external(JSON.stringify({ name: "FromV3", version: 3, roots: [oneRoot("FromV3Root")] }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(800);
    const dlgText = (await page.locator(".dlg").count()) ? await page.locator(".dlg").innerText() : "no dialog";
    check("a v3 file is refused with the too-new message",
        dlgText.includes("format v3") && dlgText.includes("reads v1, 2"), dlgText);
    await dialogButton(page, "OK").click();
    await page.waitForTimeout(300);
    check("the refusal keeps the open scene", (await page.locator("app-hierarchy").innerText()).includes("SeededKeep")
        && !(await page.locator("app-hierarchy").innerText()).includes("FromV3Root"));
    check("the refusal keeps the scene clean", (await page.locator(".statusbar .accent").first().innerText()) === "Saved");

    // Not JSON at all, and JSON that is not a scene: both keep scene.invalid.
    for (const [what, text] of [["not JSON", "this is not json"], ["not a scene", "{}"]]) {
        await external(text);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.waitForTimeout(600);
        check(`${what} keeps the scene.invalid message`, (await page.locator(".dlg").innerText()).includes("not a valid scene file")
            || (await page.locator(".dlg").innerText()).includes("not valid JSON"));
        await dialogButton(page, "OK").click();
        await page.waitForTimeout(300);
        check(`${what} keeps the open scene`, (await page.locator("app-hierarchy").innerText()).includes("SeededKeep"));
    }
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", noErrors(page), page.logs.join(" | "));
    await shot(page, "e2e-scene-formats-refused");
});

scenario("scene formats: the too-new refusal is translated (uk)", async () => {
    const page = await newPage("FmtUk", { settings: { language: "uk" } });
    await seed(page, "FmtUkKeep", { "scenario.meta.json": meta("uk", "Uk"), "assets/scenes/main.scene.json": sceneWith("SeededUk") });
    await pick(page, "FmtUkKeep");
    // Language-neutral: the start screen's "Open folder…" is the non-primary action.
    await page.locator("button.start-action:not(.primary)").click();
    await page.locator(".work").waitFor();
    await page.waitForTimeout(500);
    const external = (text) => page.evaluate(async t => {
        const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("FmtUkKeep")).getDirectoryHandle("assets");
        const scenes = await dir.getDirectoryHandle("scenes", { create: true });
        const w = await (await scenes.getFileHandle("main.scene.json", { create: true })).createWritable();
        await w.write(t); await w.close();
    }, text);
    await external(JSON.stringify({ name: "FromV3", version: 3, roots: [oneRoot("FromV3Root")] }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(800);
    check("uk: the too-new message is Ukrainian", (await page.locator(".dlg").innerText()).includes("збережено новішою версією редактора"));
    await dialogButton(page, "Гаразд").click();
    check("uk: the refusal keeps the open scene", (await page.locator("app-hierarchy").innerText()).includes("SeededUk"));
});

// B1 phase 2 — Unity's Scene navigation (D-4), asserted in the engine space the
// probe speaks. Phase 2 verified these by hand-run probes; the plan asked for a
// scenario, and this is it (the notes record the move).
scenario("navigation: orbit, zoom, dolly, pan, look, fly — the pose never drifts (B1.2)", async () => {
    const page = await newPage("NavDemo", { probe: true });
    await openEmptyProject(page);
    const pose = () => page.evaluate(() => {
        const p = window.__wetsProbe;
        const c = p.camera();
        const pivot = p.pivot();
        return {
            pos: c.position, fwd: c.forward, pivot,
            distance: Math.hypot(c.position.x - pivot.x, c.position.y - pivot.y, c.position.z - pivot.z),
        };
    });
    const canvas = await page.locator("canvas").boundingBox();
    const move = (dx, dy) => page.mouse.move(canvas.x + dx, canvas.y + dy);
    const start = await pose();
    const near0 = (v) => Math.abs(v) < 1e-9;
    check("the initial pose is the frozen one", near0(start.pos.x - 6) && near0(start.pos.y - 6) && near0(start.pos.z + 10)
        && near0(start.pivot.x) && near0(start.pivot.y) && near0(start.pivot.z), JSON.stringify(start.pos));

    // DW-2.1: Alt+LMB orbits — the distance to the pivot is exact by construction.
    await page.keyboard.down("Alt");
    await page.mouse.move(canvas.x + 700, canvas.y + 400, { steps: 3 });
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(canvas.x + 700 + i * 10, canvas.y + 400, { steps: 2 }); await page.waitForTimeout(30); }
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const orbited = await pose();
    check("orbit keeps the distance to the pivot", Math.abs(orbited.distance - start.distance) < 1e-3,
        `${start.distance} -> ${orbited.distance}`);
    check("orbit moves the camera around the pivot (Δx sign)", orbited.pos.x > start.pos.x,
        `${start.pos.x} -> ${orbited.pos.x}`);

    // DW-2.2: the wheel zooms toward the pivot; the pivot itself does not move.
    await page.mouse.move(canvas.x + 700, canvas.y + 400);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(200);
    const zoomed = await pose();
    check("the wheel zooms in", zoomed.distance < orbited.distance - 0.5, `${orbited.distance} -> ${zoomed.distance}`);
    check("zooming leaves the pivot alone", zoomed.pivot.x === orbited.pivot.x && zoomed.pivot.y === orbited.pivot.y && zoomed.pivot.z === orbited.pivot.z,
        JSON.stringify(zoomed.pivot));

    // Alt+RMB dollies by the same rule as the wheel: dragging UP zooms in.
    await page.keyboard.down("Alt");
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 8; i++) { await page.mouse.move(canvas.x + 700, canvas.y + 400 - i * 10, { steps: 2 }); await page.waitForTimeout(30); }
    await page.mouse.up({ button: "right" });
    await page.keyboard.up("Alt");
    const dollied = await pose();
    check("Alt+RMB dollies", dollied.distance < zoomed.distance - 0.5, `${zoomed.distance} -> ${dollied.distance}`);

    // DW-2.3: the middle button pans — camera and pivot travel together.
    const beforePan = await pose();
    await page.mouse.move(canvas.x + 700, canvas.y + 400, { steps: 3 });
    await page.mouse.down({ button: "middle" });
    for (let i = 1; i <= 10; i++) { await page.mouse.move(canvas.x + 700 + i * 8, canvas.y + 400, { steps: 2 }); await page.waitForTimeout(30); }
    await page.mouse.up({ button: "middle" });
    const panned = await pose();
    const dPos = Math.hypot(panned.pos.x - beforePan.pos.x, panned.pos.y - beforePan.pos.y, panned.pos.z - beforePan.pos.z);
    const dPivot = Math.hypot(panned.pivot.x - beforePan.pivot.x, panned.pivot.y - beforePan.pivot.y, panned.pivot.z - beforePan.pivot.z);
    check("pan moves the pivot", dPivot > 0.05, String(dPivot));
    check("pan moves the camera by the same vector", Math.abs(dPos - dPivot) < 1e-6, `${dPos} vs ${dPivot}`);
    check("pan keeps the forward and the distance", panned.fwd.x === beforePan.fwd.x && panned.fwd.y === beforePan.fwd.y && panned.fwd.z === beforePan.fwd.z
        && Math.abs(panned.distance - beforePan.distance) < 1e-6, JSON.stringify(panned.fwd));

    // DW-2.4: RMB looks without moving; RMB + W flies along the forward.
    const beforeLook = await pose();
    await page.mouse.move(canvas.x + 700, canvas.y + 400, { steps: 3 });
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 6; i++) { await page.mouse.move(canvas.x + 700 + i * 12, canvas.y + 400 + i * 3, { steps: 2 }); await page.waitForTimeout(30); }
    await page.mouse.up({ button: "right" });
    const looked = await pose();
    check("looking does not move the camera", looked.pos.x === beforeLook.pos.x && looked.pos.y === beforeLook.pos.y && looked.pos.z === beforeLook.pos.z,
        JSON.stringify(looked.pos));
    check("looking turns the forward", looked.fwd.x !== beforeLook.fwd.x);

    /**
     * Flies for a measured window and returns the speed it covered. Measured
     * inside the page and counted in **frames**, because the fly integrates the
     * frame dt: a loaded browser can stall whole frames, and a millisecond
     * window that contained none of them would read as "the fly does not work".
     * It also waits for the first movement, so a dropped key event cannot fake a
     * standstill.
     */
    const flySpeed = async (shift) => {
        await page.keyboard.down("w");
        if (shift) await page.keyboard.down("Shift");
        await page.mouse.down({ button: "right" });
        const measured = await page.evaluate(async () => {
            const probe = window.__wetsProbe;
            const read = () => {
                const c = probe.camera();
                return { x: c.position.x, y: c.position.y, z: c.position.z, fx: c.forward.x, fy: c.forward.y, fz: c.forward.z };
            };
            const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
            const start = read();
            let moving = false;
            for (let i = 0; i < 100 && !moving; i++) {
                await nextFrame();
                moving = dist(start, read()) > 0.01;
            }
            const a = read();
            const t0 = performance.now();
            for (let frames = 0; frames < 10; frames++) {
                await nextFrame();
                if (performance.now() - t0 > 5000) break;
            }
            const b = read();
            const seconds = Math.max((performance.now() - t0) / 1000, 0.001);
            return { moving, seconds, dist: dist(a, b), along: (b.x - a.x) * a.fx + (b.y - a.y) * a.fy + (b.z - a.z) * a.fz };
        });
        await page.mouse.up({ button: "right" });
        await page.keyboard.up("w");
        if (shift) await page.keyboard.up("Shift");
        await page.waitForTimeout(200);
        return { ...measured, speed: measured.dist / measured.seconds };
    };

    const plain = await flySpeed(false);
    check("RMB + W flies along the forward", plain.moving && plain.dist > 0.02 && plain.along > 0.9 * plain.dist,
        `${plain.dist.toFixed(3)} in ${plain.seconds.toFixed(2)}s over ${plain.moving ? "" : "no "}movement, ${plain.along.toFixed(3)} of it along the view`);

    // Shift makes the same gesture four times faster (D-4).
    const fast = await flySpeed(true);
    check("Shift flies at least three times as fast", fast.moving && fast.speed >= 3 * plain.speed,
        `${fast.speed.toFixed(2)}/s vs ${plain.speed.toFixed(2)}/s`);

    // DW-2.6: none of it is an edit.
    check("navigating does not mark the scene unsaved", (await page.locator(".statusbar .accent").first().innerText()) === "Saved");
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1 phase 3 — the orientation cube (D-5): its cones drive the camera, its
// centre toggles the projection, and its axes read in engine space.
scenario("orientation cube: cones snap the camera, the centre toggles iso (B1.3)", async () => {
    const page = await newPage("OriDemo", { probe: true });
    await openEmptyProject(page);
    await page.waitForTimeout(400);
    const pose = () => page.evaluate(() => {
        const c = window.__wetsProbe.camera();
        return { pos: c.position, fwd: c.forward };
    });
    const targets = () => page.evaluate(() => window.__wetsProbe.orientationTargets());
    const centre = () => page.evaluate(() => {
        const s = window.__wetsProbe.size();
        const r = document.querySelector("canvas").getBoundingClientRect();
        return { x: r.left + s.width - 64, y: r.top + 64 };
    });
    /**
     * Waits until the camera's forward is the given engine-space direction (the
     * snap is animated, and this browser draws with a software GL at
     * single-digit FPS, so a fixed timeout reads the pose mid-flight). Each
     * DW-3.1 row states where the camera must end, so waiting for that end is
     * the assertion itself.
     */
    const waitForForward = (x, y, z) => page.evaluate(async ([ex, ey, ez]) => {
        const until = performance.now() + 10000;
        while (performance.now() < until) {
            const f = window.__wetsProbe.camera().forward;
            if (Math.abs(f.x - ex) < 1e-6 && Math.abs(f.y - ey) < 1e-6 && Math.abs(f.z - ez) < 1e-6) return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }, [x, y, z]);
    /** Waits for the pose to hold still for half a second (no stated target). */
    const settle = () => page.evaluate(async () => {
        const read = () => {
            const f = window.__wetsProbe.camera().forward;
            return `${f.x}|${f.y}|${f.z}`;
        };
        let last = read();
        let steady = 0;
        const until = performance.now() + 10000;
        while (performance.now() < until) {
            await new Promise(r => setTimeout(r, 100));
            const now = read();
            steady = now === last ? steady + 100 : 0;
            if (steady >= 500) return true;
            last = now;
        }
        return false;
    });
    const span = () => page.evaluate(() => {
        const a = window.__wetsProbe.handlePoint("x", -1);
        const b = window.__wetsProbe.handlePoint("x", 1);
        return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null;
    });

    // DW-3.1: each cone snaps to look along −its axis, pivot untouched. The
    // order matters: the probe reports only the cones a click can reach (the
    // far side of the hub is hidden), so each is clicked from a view that faces
    // it — X, then Y, then Z, then X again, and −Z from that side view.
    const clickCone = async (label, x, y, z) => {
        const t = await targets();
        const p = t[label];
        check(`${label} is clickable on the gizmo`, !!p, JSON.stringify(Object.keys(t)));
        if (!p) return;
        await page.mouse.click(p.x, p.y);
        const arrived = await waitForForward(x, y, z);
        check(`${label} cone: forward is (${x},${y},${z})`, arrived, await fwdText());
    };
    const fwdText = () => page.evaluate(() => {
        const f = window.__wetsProbe.camera().forward;
        return `(${f.x.toFixed(4)}, ${f.y.toFixed(4)}, ${f.z.toFixed(4)})`;
    });

    await clickCone("X", -1, 0, 0);
    await clickCone("Y", 0, -1, 0);
    await clickCone("Z", 0, 0, -1);
    // Back to a side view, where −Z faces the camera again.
    await clickCone("X", -1, 0, 0);
    await clickCone("−Z", 0, 0, 1);
    const pivotNow = await page.evaluate(() => window.__wetsProbe.pivot());
    check("the pivot is still the origin", pivotNow.x === 0 && pivotNow.y === 0 && pivotNow.z === 0, JSON.stringify(pivotNow));

    // DW-3.3: after +Y (Top view) the cube reads engine space: +Z up the screen,
    // +X to the right. Unity's top view has Z up the screen in a left-handed world.
    await clickCone("Y", 0, -1, 0);
    await settle();
    const top = await targets();
    const c = await centre();
    check("Top view: +Z is above the gizmo centre", top.Z && top.Z.y < c.y - 4, `${top.Z?.y} vs ${c.y}`);
    check("Top view: +X is right of the gizmo centre", top.X && top.X.x > c.x + 4, `${top.X?.x} vs ${c.x}`);

    // DW-3.2: the centre toggles the projection and keeps the framing.
    const before = await pose();
    const perspSpan = await span();
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(400);
    const isoMode = await page.evaluate(() => window.__wetsProbe.orientationMode());
    check("the centre click turns the camera orthographic", isoMode.orthographic === true, JSON.stringify(isoMode));
    check("the label reads Iso", isoMode.label === "Iso", isoMode.label);
    // The chip is Angular-bound and updates on the next change-detection tick,
    // which a loaded page delays, so poll for it rather than reading once.
    const chipReads = async () => (await page.locator(".vp-overlay-tr .v").innerText()).trim();
    let chipIso = false;
    for (let i = 0; i < 30 && !(chipIso = (await chipReads()) === "Iso"); i++) await page.waitForTimeout(100);
    check("the corner chip says Iso", chipIso, await chipReads());
    const isoSpan = await span();
    check("the framing survives the toggle (<15%)", perspSpan && isoSpan && Math.abs(isoSpan - perspSpan) / perspSpan < 0.15,
        `${perspSpan} -> ${isoSpan}`);
    const after2 = await pose();
    check("the pose is unchanged by the toggle",
        Math.abs(after2.pos.x - before.pos.x) < 1e-6 && Math.abs(after2.pos.y - before.pos.y) < 1e-6 && Math.abs(after2.pos.z - before.pos.z) < 1e-6,
        `${JSON.stringify(after2.pos)} vs ${JSON.stringify(before.pos)}`);

    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(300);
    const perspMode = await page.evaluate(() => window.__wetsProbe.orientationMode());
    check("the centre click turns it back", perspMode.orthographic === false, JSON.stringify(perspMode));
    check("the label reads Persp", perspMode.label === "Persp", perspMode.label);

    // DW-2.6 again: looking along an axis is navigation, not an edit.
    check("the cube does not mark the scene unsaved", (await page.locator(".statusbar .accent").first().innerText()) === "Saved");
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1 phase 4 — the transform handles (D-6): snapping, Pivot/Centre, Local/Global,
// multi-object drags, and the Q/W/E/R/Y tools.
scenario("transform handles: snapping, global vs local, multi-select, the tools (B1.4)", async () => {
    const page = await newPage("HandlesDemo", { probe: true, settings: { gridSnap: 0.5 } });
    await openEmptyProject(page);

    /** One primitive from the GameObject menu, created and selected. */
    const create = async (kind) => {
        await page.locator(".menubar-item", { hasText: "GameObject" }).click();
        await page.locator(".ctx-item", { hasText: "3D Object" }).first().hover();
        await page.locator(".ctx-item", { hasText: kind }).last().click();
        await page.waitForTimeout(300);
    };
    const tf = (name) => page.evaluate(n => window.__wetsProbe.transformOf(n), name);
    const hover = () => page.evaluate(() => window.__wetsProbe.hoverAxis());
    /** A point `t` along one of the handle's own axes, in client pixels. */
    const tip = (axis, t = 0.85) => page.evaluate(([a, tt]) => window.__wetsProbe.handlePoint(a, tt), [axis, t]);
    const drag = async (from, dx, dy) => {
        await page.mouse.move(from.x, from.y, { steps: 4 });
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) {
            await page.mouse.move(from.x + dx * i / 6, from.y + dy * i / 6, { steps: 2 });
            await page.waitForTimeout(40);
        }
        await page.mouse.up();
        await page.waitForTimeout(250);
    };
    const near = (v, e, tol = 1e-6) => Math.abs(v - e) < tol;
    /**
     * A point where one handle set has an axis: the arrows are short and a plane
     * handle can sit in front of an arrow's tip, so the tip formula is only used
     * where it is known to work.
     */
    const findHandle = async (set, axis, radius = 130) => {
        const hub = await tip("X", 0);
        for (let dx = -radius; dx <= radius; dx += 20) {
            for (let dy = -radius; dy <= radius; dy += 20) {
                await page.mouse.move(hub.x + dx, hub.y + dy);
                if ((await hover()) === `${set}:${axis}`) return { x: hub.x + dx, y: hub.y + dy };
            }
        }
        return null;
    };
    /** The hierarchy renames inline (F2), not through a dialog. */
    const rename = async (name) => {
        await page.keyboard.press("F2");
        const input = page.locator("app-hierarchy input.rename-input");
        await input.fill(name);
        await input.press("Enter");
        await page.waitForTimeout(300);
    };

    // ── DW-4.1: Ctrl-held snapping uses the Preferences step (0.5 here) ──
    await create("Cube");
    const arrow = await tip("X");
    check("the X arrow is on screen", !!arrow, JSON.stringify(arrow));
    await page.mouse.move(arrow.x, arrow.y, { steps: 4 });
    await page.waitForTimeout(250);
    check("hovering finds the translate arrow", (await hover()) === "translate:X", await hover());

    await page.keyboard.down("Control");
    await drag(arrow, 40, 0);
    await page.keyboard.up("Control");
    let cube = await tf("Cube");
    const snapped = cube.position.x;
    check("a Ctrl drag lands on the 0.5 step", snapped !== 0 && near(snapped - Math.round(snapped / 0.5) * 0.5, 0),
        String(snapped));
    check("and leaves the other axes alone", cube.position.y === 0 && cube.position.z === 0,
        JSON.stringify(cube.position));

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    // Undo reloads the scene, which drops the selection; take it again.
    await page.locator("app-hierarchy li", { hasText: "Cube" }).first().click();
    cube = await tf("Cube");
    check("one undo puts the cube back", cube.position.x === 0, JSON.stringify(cube.position));
    await drag(arrow, 40, 0);
    const free = (await tf("Cube")).position.x;
    check("a free drag does not land on the step", Math.abs(free - Math.round(free / 0.5) * 0.5) > 1e-6,
        `${free} vs the snapped ${snapped}`);

    // ── DW-4.2: Global vs Local drags of an object turned 45° about Y ──
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    await create("Cube");
    void 0;
    await rename("Turned");
    await page.locator(".insp-body .field").nth(1).locator("input").nth(1).fill("45");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const before = await tf("Turned");
    await drag(await tip("X"), 40, 0);
    const afterGlobal = await tf("Turned");
    check("a Global X drag moves only along world X",
        afterGlobal.position.x !== before.position.x && near(afterGlobal.position.z, before.position.z),
        `x ${before.position.x} -> ${afterGlobal.position.x}, z ${before.position.z} -> ${afterGlobal.position.z}`);

    await page.locator(".vp-subtoolbar .chip", { hasText: "Global" }).click();
    await page.waitForTimeout(250);
    const localArrow = await findHandle("translate", "X");
    check("the object's own X arrow is reachable", !!localArrow, await hover());
    const beforeLocal = await tf("Turned");
    if (localArrow) await drag(localArrow, 40, 0);
    const afterLocal = await tf("Turned");
    const dlx = afterLocal.position.x - beforeLocal.position.x;
    const dlz = afterLocal.position.z - beforeLocal.position.z;
    check("a Local X drag moves along the object's own X", Math.abs(dlx) > 0.2 && near(Math.abs(dlx) - Math.abs(dlz), 0, 1e-6),
        `dx ${dlx.toFixed(4)}, dz ${dlz.toFixed(4)}`);

    // ── DW-4.3: two objects — Pivot/Centre and one undo for both ──
    await page.locator(".vp-subtoolbar .chip", { hasText: "Local" }).click();
    await page.waitForTimeout(250);
    await create("Cube");
    await create("Cube");
    await rename("Mover");
    await page.locator(".insp-body .field").nth(0).locator("input").nth(0).fill("4");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.locator("app-hierarchy li", { hasText: "Cube" }).first().click();
    await page.keyboard.down("Control");
    await page.locator("app-hierarchy li", { hasText: "Mover" }).first().click();
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    check("both are selected", (await page.evaluate(() => window.__wetsProbe.selection())).length === 2,
        JSON.stringify(await page.evaluate(() => window.__wetsProbe.selection())));

    // Pivot: the handle sits on the primary object (the one toggled last, Mover
    // at (4,0,0)); Centre: between the two, at (2,0,0). Both are asserted through
    // the screen position of the handle's origin against the objects' own.
    const pivotTip = await tip("X", 0);
    check("Pivot puts the handle on the active object", !!pivotTip, JSON.stringify(pivotTip));
    await page.locator(".vp-subtoolbar .chip", { hasText: "Pivot" }).click();
    await page.waitForTimeout(250);
    const centreTip = await tip("X", 0);
    check("Centre puts the handle between the two objects", !!centreTip, JSON.stringify(centreTip));
    const movedApart = Math.abs(centreTip.x - pivotTip.x) + Math.abs(centreTip.y - pivotTip.y);
    check("Centre is a different place from Pivot", movedApart > 2, `${pivotTip.x},${pivotTip.y} vs ${centreTip.x},${centreTip.y}`);

    const beforeMulti = { first: await tf("Cube"), second: await tf("Mover") };
    await drag(centreTip, 30, 0);
    const afterMulti = { first: await tf("Cube"), second: await tf("Mover") };
    const dFirst = afterMulti.first.position.x - beforeMulti.first.position.x;
    const dSecond = afterMulti.second.position.x - beforeMulti.second.position.x;
    check("the drag moves both objects by the same delta", near(dFirst - dSecond, 0, 1e-6) && dFirst !== 0,
        `${dFirst.toFixed(4)} vs ${dSecond.toFixed(4)}`);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(500);
    // The undo reloaded the scene: select both again to read them.
    await page.locator("app-hierarchy li", { hasText: "Cube" }).first().click();
    await page.keyboard.down("Control");
    await page.locator("app-hierarchy li", { hasText: "Mover" }).first().click();
    await page.keyboard.up("Control");
    await page.waitForTimeout(250);
    const undone = { first: await tf("Cube"), second: await tf("Mover") };
    check("one undo restores both", undone.first.position.x === beforeMulti.first.position.x
        && undone.second.position.x === beforeMulti.second.position.x,
        JSON.stringify([undone.first.position.x, undone.second.position.x]));

    // ── DW-4.4: Q leaves no handle and pans; Y shows all three sets ──
    await page.locator("app-hierarchy li", { hasText: "Cube" }).first().click();
    await page.waitForTimeout(250);
    const box = await page.locator("canvas").boundingBox();
    await page.keyboard.press("q");
    await page.waitForTimeout(250);
    let underQ = null;
    for (const [dx, dy] of [[500, 300], [520, 320], [560, 280], [540, 340], [600, 300]]) {
        await page.mouse.move(box.x + dx, box.y + dy);
        const h = await hover();
        if (h) underQ = h;
    }
    check("Q leaves no handle under the pointer", underQ === null, String(underQ));
    const pivotBefore = await page.evaluate(() => window.__wetsProbe.pivot());
    await page.mouse.move(box.x + 500, box.y + 300);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(box.x + 500 + i * 12, box.y + 300, { steps: 2 }); await page.waitForTimeout(40); }
    await page.mouse.up();
    const pivotAfter = await page.evaluate(() => window.__wetsProbe.pivot());
    check("the View tool's left button pans",
        Math.abs(pivotAfter.x - pivotBefore.x) > 0.05 || Math.abs(pivotAfter.z - pivotBefore.z) > 0.05,
        JSON.stringify([pivotBefore, pivotAfter]));

    await page.keyboard.press("y");
    await page.waitForTimeout(300);
    // The three sets are co-located on the same axes, so one hover finds all of
    // them only if each is reported: the probe hands back every set's axis.
    const yHub = await tip("X", 0);
    await page.mouse.move(yHub.x + 10, yHub.y, { steps: 3 });
    await page.waitForTimeout(200);
    const sets = await page.evaluate(() => window.__wetsProbe.hoverAll());
    check("Y shows the translate, rotate and scale handles",
        !!sets.translate && !!sets.rotate && !!sets.scale, JSON.stringify(sets));
    const beforeY = await tf("Cube");
    await drag(await tip("X", 0.85), 30, 0);
    const afterY = await tf("Cube");
    check("dragging in Y mode moves the object", afterY.position.x !== beforeY.position.x,
        `${beforeY.position.x} -> ${afterY.position.x}`);

    // ── DW-4.5: a snapped turn lands on the 15° step ──
    await page.keyboard.press("e");
    await page.waitForTimeout(250);
    const ring = await findHandle("rotate", "Y");
    check("the turn gizmo's Y ring is reachable", !!ring, await hover());
    if (ring) {
        const beforeRot = await tf("Cube");
        await page.keyboard.down("Control");
        await drag(ring, 30, 0);
        await page.keyboard.up("Control");
        const afterRot = await tf("Cube");
        check("a snapped turn lands on 15°",
            afterRot.euler.y !== 0 && near(afterRot.euler.y - Math.round(afterRot.euler.y / 15) * 15, 0, 1e-6),
            `${beforeRot.euler.y} -> ${afterRot.euler.y} deg`);
    }

    // ── DW-4.6: the tool keys switch the palette ──
    const tools = { w: "Move", e: "Rotate", r: "Scale", q: "View", y: "Transform" };
    for (const [key, label] of Object.entries(tools)) {
        await page.keyboard.press(key);
        await page.waitForTimeout(150);
        check(`${key.toUpperCase()} selects the ${label.toLowerCase()} tool`,
            (await page.locator(".vp-overlay-tl .chip .v").first().innerText()) === label,
            await page.locator(".vp-overlay-tl .chip .v").first().innerText());
    }
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1 phase 5 — selection input (D-10) and the orange outline (D-9).
scenario("selection: box, modifiers, and the orange outline (B1.5)", async () => {
    const page = await newPage("SelDemo", { probe: true });
    await openEmptyProject(page);

    /** One object, created and selected — nothing else, so its create is the
     * undo stack's top. */
    const create = async (kind) => {
        await page.locator(".menubar-item", { hasText: "GameObject" }).click();
        await page.locator(".ctx-item", { hasText: "3D Object" }).first().hover();
        await page.locator(".ctx-item", { hasText: kind }).last().click();
        await page.waitForTimeout(300);
    };
    /** One cube at x, named after its position. */
    const cubeAt = async (name, x) => {
        await create("Cube");
        await page.keyboard.press("F2");
        const input = page.locator("app-hierarchy input.rename-input");
        await input.fill(name);
        await input.press("Enter");
        await page.waitForTimeout(250);
        await page.locator(".insp-body .field").nth(0).locator("input").nth(0).fill(String(x));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(250);
    };
    const selection = () => page.evaluate(() => window.__wetsProbe.selection());
    const rectOf = (name) => page.evaluate(n => window.__wetsProbe.objectScreenRect(n), name);
    const centreOf = async (name) => {
        const r = await rectOf(name);
        return r ? { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) } : null;
    };
    const dragRect = async (from, to) => {
        await page.mouse.move(from.x, from.y, { steps: 4 });
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(350);
    };

    // Four cubes along X, so a rectangle can take three of them and leave one.
    for (const [name, x] of [["L3", -3], ["L1", -1], ["R1", 1], ["R3", 3]]) await cubeAt(name, x);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(600);

    const r3 = await rectOf("L3"), r1 = await rectOf("R1");
    check("all four cubes are on screen", !!r3 && !!r1, JSON.stringify([r3, r1]));

    // ── DW-5.1: a rectangle around the first three, Shift for the fourth ──
    await dragRect({ x: r3.left - 12, y: r3.top - 12 }, { x: r1.right + 12, y: r1.bottom + 12 });
    let sel = await selection();
    check("a rectangle selects the objects it covers", ["L3", "L1", "R1"].every(n => sel.includes(n)) && sel.length === 3,
        JSON.stringify(sel));
    const treeLabels = async () => (await page.locator("app-hierarchy li.selected .label").allInnerTexts()).sort().join(",");
    check("the Hierarchy agrees", await treeLabels() === ["L1", "L3", "R1"].sort().join(","), await treeLabels());

    // Shift + rectangle around the fourth adds it.
    await page.keyboard.down("Shift");
    const r4 = await rectOf("R3");
    await dragRect({ x: r4.left - 12, y: r4.top - 12 }, { x: r4.right + 12, y: r4.bottom + 12 });
    await page.keyboard.up("Shift");
    sel = await selection();
    check("Shift + rectangle adds to the selection", sel.length === 4, JSON.stringify(sel));

    // Ctrl + click on one of them removes it.
    await page.keyboard.down("Control");
    const mid = await centreOf("L1");
    await page.mouse.click(mid.x, mid.y);
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    sel = await selection();
    check("Ctrl + click removes the clicked object", sel.length === 3 && !sel.includes("L1"), JSON.stringify(sel));

    // ── DW-5.3: the orange outline, counted around a selected cube ──
    // The View tool (Q) hides the handles, so the only colour left in the
    // rectangle is the outline's.
    await page.keyboard.press("q");
    await page.waitForTimeout(250);
    const stats = async (name) => page.evaluate(n => {
        const r = window.__wetsProbe.objectScreenRect(n);
        return window.__wetsProbe.pixelStats({ left: r.left - 20, top: r.top - 20, right: r.right + 20, bottom: r.bottom + 20 });
    }, name);
    const on = await stats("R1");
    check("the outline is orange around a selected cube", on.orange >= 200, JSON.stringify(on));
    // The green axis line of the grid runs through every cube, so the check is the
    // difference a selection makes, not the raw count: with the old BoxHelper gone
    // nothing green appears that the empty scene does not already have.
    await page.mouse.click(r3.left - 60, r3.top - 60);
    await page.waitForTimeout(300);
    const bare = await stats("R1");
    check("the old green box is gone for meshes", Math.abs(on.green - bare.green) < 10,
        `selected ${on.green} vs cleared ${bare.green}`);
    await page.keyboard.press("w");
    await page.waitForTimeout(150);

    // ── DW-5.2: click, empty click, Shift+click ──
    // The View tool (Q) hides the handles, so the clicks land on the objects:
    // under W the handle sits on the active object and its centre box covers the
    // pivot. Selection still works — Q only changes what the drag does.
    await page.keyboard.press("q");
    await page.waitForTimeout(250);
    const one = await centreOf("R3");
    await page.mouse.click(one.x, one.y);
    await page.waitForTimeout(300);
    check("a click selects", (await selection()).join(",") === "R3", JSON.stringify(await selection()));
    await page.mouse.click(r3.left - 60, r3.top - 60);
    await page.waitForTimeout(300);
    check("a click on nothing clears", (await selection()).length === 0, JSON.stringify(await selection()));

    const off = await stats("R3");
    check("the outline is gone once nothing is selected", off.orange < 10, JSON.stringify(off));

    const corner = async (name) => {
        const r = await rectOf(name);
        return { x: Math.round(r.left + (r.right - r.left) * 0.25), y: Math.round(r.top + (r.bottom - r.top) * 0.25) };
    };
    const l3 = await corner("L3");
    await page.mouse.click(l3.x, l3.y);
    await page.waitForTimeout(250);
    check("a click selects the object it hit", (await selection()).join(",") === "L3", JSON.stringify(await selection()));
    await page.keyboard.down("Shift");
    const r3c = await corner("R3");
    await page.mouse.click(r3c.x, r3c.y);
    await page.waitForTimeout(250);
    await page.keyboard.up("Shift");
    check("Shift + click adds", (await selection()).sort().join(",") === "L3,R3", JSON.stringify(await selection()));
    await page.keyboard.down("Shift");
    await page.mouse.click(l3.x, l3.y);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(250);
    check("Shift + click removes again", (await selection()).join(",") === "R3", JSON.stringify(await selection()));

    // ── DW-5.4: selection is not an edit ──
    // One object created AFTER the save (and nothing else edited after it), then
    // a run of selection changes: the undo stack's top must still be that create,
    // which is what "adds no undo entry" means.
    await create("Cube");
    const treeBefore = (await page.locator("app-hierarchy li .label").allInnerTexts()).join(",");
    const beforeChanges = (await page.locator(".statusbar .accent").first().innerText());
    check("the create marks the scene unsaved", beforeChanges === "Unsaved", beforeChanges);
    for (const name of ["L1", "L3", "R3"]) {
        const c = await corner(name);
        await page.mouse.click(c.x, c.y);
        await page.waitForTimeout(150);
    }
    await dragRect({ x: 400, y: 200 }, { x: 430, y: 230 });   // a rectangle on nothing
    const fresh = await corner("Cube");
    await page.mouse.click(fresh.x, fresh.y);
    await page.waitForTimeout(250);
    check("the selection changes do not mark the scene unsaved",
        (await page.locator(".statusbar .accent").first().innerText()) === "Unsaved",
        await page.locator(".statusbar .accent").first().innerText());
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(600);
    // Had a selection change pushed an entry, this single Ctrl+Z would have undone
    // *that*, and the cube would still be in the scene.
    const tree = await page.locator("app-hierarchy li .label").allInnerTexts();
    check("the undo stack's top is still that create (the selection added nothing)",
        !tree.includes("Cube") && tree.length === treeBefore.split(",").length - 1,
        `${treeBefore} -> ${tree.join(",")}`);

    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1 phase 6 — component gizmos and the Gizmos menu (B1.6, D-11).
scenario("component gizmos: lights, camera and colliders, switched per type (B1.6)", async () => {
    const page = await newPage("GizDemo", { probe: true });
    await openEmptyProject(page);

    /** One entry from the GameObject menu (submenus open on hover). */
    const menu = async (item, sub) => {
        await page.locator(".menubar-item", { hasText: "GameObject" }).click();
        await page.waitForTimeout(150);
        if (sub) {
            await page.locator(".ctx-item", { hasText: sub }).first().hover();
            await page.waitForTimeout(150);
            await page.locator(".ctx-item", { hasText: item }).last().click();
        } else {
            await page.locator(".ctx-item", { hasText: item }).last().click();
        }
        await page.waitForTimeout(400);
    };
    // A previous scenario can leave the Gizmos menu open, which would swallow
    // every later menu-bar click; close it before anything else.
    await page.keyboard.press("Escape");
    const counts = () => page.evaluate(() => window.__wetsProbe.gizmoCounts());
    const extent = (name, kind) => page.evaluate(([n, k]) => window.__wetsProbe.gizmoExtent(n, k), [name, kind]);
    const settings = () => page.evaluate(() => window.__wetsProbe.gizmoSettings());
    const row = (label) => page.locator(".gz-row", { hasText: label }).locator("input");

    // The template's two objects: a camera and a directional light.
    await menu("Camera");
    await menu("Directional Light", "Light");
    await page.locator("app-hierarchy li .label", { hasText: "Camera" }).first().click();
    await page.waitForTimeout(300);

    // ── DW-6.1: the menu's switches, and that they survive a reload ──
    let c = await counts();
    check("the camera draws a frustum", c.cameraFrustum === 1, JSON.stringify(c));
    await page.keyboard.down("Control");
    await page.locator("app-hierarchy li .label", { hasText: "Directional Light" }).first().click();
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    c = await counts();
    check("the light draws its rays", c.cameraFrustum === 1 && c.directionalLight === 1, JSON.stringify(c));

    /**
     * Turns a kind off and waits until the scene agrees, not just the DOM: a
     * box that is already off is left alone (unchecking it again would time out
     * waiting for a state that never changes).
     */
    /** The panel's rows are only reachable while it is open. */
    const ensureOpen = async () => {
        if ((await page.locator(".gz-panel").count()) === 0) {
            await page.locator(".gz-menu .chip").click();
            await page.waitForTimeout(250);
        }
    };
    const turnOff = async (label, key) => {
        await ensureOpen();
        for (let attempt = 0; attempt < 3; attempt++) {
            if (await row(label).isChecked()) await row(label).uncheck();
            await page.waitForTimeout(400);
            if ((await counts())[key] === undefined) return;
        }
    };
    await turnOff("Camera", "cameraFrustum");
    c = await counts();
    check("unchecking Camera hides the frustum", c.cameraFrustum === undefined && c.directionalLight === 1,
        JSON.stringify(c));
    check("the light is still drawn", c.directionalLight === 1, JSON.stringify(c));

    await turnOff("Lights", "directionalLight");
    check("unchecking Lights hides the light too", (await counts()).directionalLight === undefined,
        JSON.stringify(await counts()));

    await ensureOpen();
    await row("Lights").check();
    await row("Camera").check();
    await page.waitForTimeout(300);

    // DW-6.4: gizmos are editor-owned, so the scene JSON cannot carry them.
    /** The scene text, once the editor has written it (a null stays null). */
    const sceneText = async () => {
        for (let i = 0; i < 30; i++) {
            const text = await readDisk(page, "GizDemo", "assets/scenes/main.scene.json");
            if (text !== null && text.length > 0) return text;
            await page.waitForTimeout(100);
        }
        return null;
    };
    await menu("Cube", "3D Object");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    const withGizmos = JSON.parse((await sceneText()) ?? "null");
    await page.locator(".gz-row.master input").uncheck();
    await page.waitForTimeout(400);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    const withoutGizmos = JSON.parse((await sceneText()) ?? "null");
    check("the gizmo lines never reach the scene file",
        JSON.stringify(withGizmos) === JSON.stringify(withoutGizmos),
        `${JSON.stringify(withGizmos).length} vs ${JSON.stringify(withoutGizmos).length} bytes`);
    await page.locator(".gz-row.master input").check();
    await page.waitForTimeout(300);

    /** Closes the Gizmos menu so a menu-bar click reaches the menu. */
    const closeMenu = async () => {
        if ((await page.locator(".gz-panel").count()) > 0) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(200);
        }
    };

    // ── DW-6.2: a cube's collider wireframe and the range that follows ──
    await closeMenu();
    c = await counts();
    check("a cube's collider draws one wireframe", c.boxCollider === 1, JSON.stringify(c));
    check("its wireframe spans the cube", Math.abs((await extent("Cube", "boxCollider")) - Math.sqrt(3) / 2) < 1e-3,
        String(await extent("Cube", "boxCollider")));

    await menu("Point Light", "Light");
    await page.locator("app-hierarchy li .label", { hasText: "Point Light" }).first().click();
    await page.waitForTimeout(300);
    const before = await extent("Point Light", "pointLight");
    check("the point light's circles are its range", Math.abs(before - 10) < 1e-3, String(before));
    await page.locator(".insp-body .field", { hasText: "Range" }).locator("input").first().fill("4");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const after = await extent("Point Light", "pointLight");
    check("the circles follow the range edited in the inspector", Math.abs(after - 4) < 1e-3,
        `${before} -> ${after}`);

    // ── DW-6.1 again: the menu's state survives a reload ──
    await ensureOpen();
    await page.waitForTimeout(200);
    await page.locator(".gz-row.master input").uncheck();
    await page.waitForTimeout(500);
    const everythingOff = await counts();
    check("the master switch hides everything", Object.keys(everythingOff).length === 0,
        JSON.stringify(everythingOff));
    await page.reload({ waitUntil: "load" });
    await page.locator(".recent").first().click();
    await page.locator(".work").waitFor({ state: "attached", timeout: 90000 });
    await page.waitForTimeout(600);
    const stored = await settings();
    check("the Gizmos menu's switches survive a reload",
        stored.enabled === false && stored.camera === true && stored.lights === true
        && stored.colliders === true && stored.audio === true,
        JSON.stringify(stored));

    /** Opens the menu if it is closed, so a row is always reachable. */
    const openMenu = async () => {
        if ((await page.locator(".gz-panel").count()) === 0) {
            await page.locator(".gz-menu .chip").click();
            await page.waitForTimeout(250);
        }
    };

    // ── DW-6.3: the screenshots for the report ── (the reload closed the menu)
    await openMenu();
    await page.locator(".gz-row.master input").check();
    await page.locator(".gz-row", { hasText: "Camera" }).locator("input").check();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await shot(page, "b1-gizmos-on");
    await openMenu();
    await page.locator(".gz-row.master input").uncheck();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await shot(page, "b1-gizmos-off");

    check("no page errors", noErrors(page), page.logs.join(" | "));
});
// ═══ Run ═══
const only = process.env.ONLY;
for (const [name, fn] of scenarios) {
    if (only && !name.includes(only)) continue;
    console.log(`\n▶ ${name}`);
    try { await fn(); }
    catch (err) {
        await lastPage?.screenshot({ path: `${SHOTS}/e2e-failure.png` }).catch(() => {});
        check("scenario completed", false, String(err.message ?? err).split("\n").slice(0, 12).join(" | "));
    }
}
await browser.close();
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
