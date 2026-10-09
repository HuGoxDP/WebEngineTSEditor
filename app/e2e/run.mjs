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
// WebEngineTS/scripts/shoot.mjs does — nothing is downloaded.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E = resolve(HERE, "../../../testv/virtual-lab/e2e");
const SHOTS = resolve(HERE, "../../.shots");
const URL_ = process.argv[2] ?? "http://localhost:8044/editor/";

const { chromium } = createRequire(resolve(E2E, "package.json"))("playwright");
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
    if (!ok) failed++;
};

const browser = await chromium.launch({
    channel: "msedge",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

let lastPage = null;

/**
 * A fresh browser context per scenario: its own IndexedDB, localStorage and
 * folders. `settings` seeds the editor preferences before it starts; English
 * unless a scenario says otherwise. The folder the picker returns is
 * `window.__pickFolder`, which a scenario can change between opens.
 */
async function newPage(folderName = "DemoScenario", { viewport = { width: 1600, height: 900 }, settings = { language: "en" } } = {}) {
    const context = await browser.newContext({ viewport, locale: "en-US" });
    const page = await context.newPage();
    lastPage = page;
    page.logs = [];
    page.nativeDialogs = 0;
    page.on("console", m => { if (m.type() === "error" || m.type() === "warning") page.logs.push(`[${m.type()}] ${m.text()}`); });
    page.on("pageerror", e => page.logs.push(`[pageerror] ${e.message}`));
    // The editor has its own dialogs; a native one means something still calls alert/confirm/prompt.
    page.on("dialog", d => { page.nativeDialogs++; d.dismiss(); });
    await page.addInitScript(s => { if (!localStorage.getItem("wets:settings:v1")) localStorage.setItem("wets:settings:v1", JSON.stringify(s)); }, settings);
    await page.addInitScript(name => {
        window.__pickFolder = name;
        window.showDirectoryPicker = async () => {
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle(window.__pickFolder, { create: true });
        };
    }, folderName);
    await page.goto(URL_, { waitUntil: "load" });
    return page;
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
    check("closing with unsaved changes asks", (await dialogTitle(page).innerText()) === "Discard unsaved changes?");
    await dialogButton(page, "Cancel").click();
    await page.waitForTimeout(200);
    check("cancelling keeps the project open", (await page.locator(".work").count()) === 1);

    // A new scene has no file; the default name is already taken by another scene.
    await menu(page, "File", "New Scene");
    await dialogButton(page, "Discard").click();
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
    await dialogButton(page, "Discard").click().catch(() => {});
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
