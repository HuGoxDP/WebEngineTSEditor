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
//                                  `npm root -g`; default ../testv/virtual-lab/e2e
//   E2E_BROWSER_CHANNEL=chromium   Playwright's own Chromium instead of Edge; an
//                                  empty value uses its headless shell. Default msedge.
//
// On Linux, run it under a UTF-8 locale (LANG=C.UTF-8): under C/POSIX, Chromium
// empties non-ASCII names in the origin-private file system, and the wizard
// scenario fails for that alone. CI (.github/workflows/ci.yml) runs it this way.

import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
async function newPage(folderName = "DemoScenario", { viewport = { width: 1600, height: 900 }, settings = { language: "en" }, autosaveMs = 0 } = {}) {
    const context = await browser.newContext({ viewport, locale: "en-US" });
    const page = await context.newPage();
    await instrument(page, folderName, settings, autosaveMs);
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
const noErrors = page => page.logs.filter(l => !l.includes("404")).length === 0;

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
    const page = await newPage("SaveDemo");
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

    // Pressing a handle without dragging changes nothing, so it must not make the scene unsaved.
    await page.mouse.move(800, 388, { steps: 3 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);
    check("pressing a handle without dragging is not an edit", (await status()) === "Saved");
    check("and does not deselect the object", (await position()) === before, await position());

    await page.mouse.move(800, 388, { steps: 3 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(100);
    for (let i = 1; i <= 10; i++) { await page.mouse.move(800 + i * 8, 388 + i * 2, { steps: 2 }); await page.waitForTimeout(40); }
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
    check("a recovery copy appears while there are unsaved changes", copy !== null && JSON.parse(copy).roots.length === 1);
    check("the Project panel does not show it", !(await page.locator(".proj").innerText()).includes("autosave"));

    await page.keyboard.press("Control+s");
    await page.waitForTimeout(600);
    check("saving removes it", (await autosave()) === null);

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

    // "Don't save" in the close dialog gives it up too.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(1000);
    check("a copy exists again", (await autosave()) !== null);
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
    await page.waitForTimeout(800);
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
    check("the title field has focus", await page.waitForFunction(() => document.activeElement?.id === "wiz-name", null, { timeout: 1000 })
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
