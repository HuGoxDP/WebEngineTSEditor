// End-to-end check of the editor, run against a live URL in a real browser.
//
//   npm run e2e                    # against the Docker deployment, :8044/editor/
//   npm run e2e -- http://localhost:4200/
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
 * A fresh browser context per scenario: its own IndexedDB, localStorage and project folder.
 * `settings` seeds the editor preferences before it starts; English unless a scenario says otherwise.
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
        window.showDirectoryPicker = async () => {
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle(name, { create: true });
        };
    }, folderName);
    await page.goto(URL_, { waitUntil: "load" });
    return page;
}

/** Every file under the demo folder, with sizes — what is really on "disk". */
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

const shot = async (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

// ═══ Scenarios ═══
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario("project panel: open, lay out, import, save, reload, reopen, delete", async () => {
    const page = await newPage();
    await page.getByText("Open project folder…").click();
    await page.getByText("Set up as a scenario project").click();
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
    await page.waitForTimeout(1200);
    check("project name shown after reload", (await page.locator(".project-tag").innerText()).includes("DemoScenario"));
    await page.locator(".proj .folders .folder", { hasText: "scenes" }).first().click();
    await page.locator(".proj .asset", { hasText: "main.scene.json" }).dblclick();
    await page.waitForTimeout(500);
    check("saved scene reopens with its object", (await page.locator("app-hierarchy").innerText()).includes("GameObject"));

    await page.locator(".proj .folders .folder", { hasText: "assets" }).first().click();
    await page.locator(".proj .asset", { hasText: "checker.png" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Delete" }).click();
    check("deleting asks first", await page.locator(".dlg", { hasText: "Delete from disk?" }).isVisible());
    await page.locator(".dlg-btn.danger").click();
    await page.waitForTimeout(500);
    files = await diskState(page);
    check("delete removes the file from disk", !files.includes("assets/checker.png"));
    check("textures folder created through the dialog", files.includes("assets/textures/"), files.join(", "));
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", page.logs.filter(l => !l.includes("404")).length === 0, page.logs.join(" | "));
    await shot(page, "e2e-project-panel");
});

scenario("language and theme follow the settings, and survive a reload", async () => {
    const page = await newPage("LangDemo", { settings: { language: "uk", theme: "light", density: "comfy" } });
    await page.waitForTimeout(500);
    const menu = await page.locator(".menubar-item").allInnerTexts();
    check("menu bar is Ukrainian", menu.join(",") === "Файл,Редагування,Об’єкт,Компонент,Вікно,Довідка", menu.join(","));
    check("project panel is Ukrainian", (await page.locator(".proj-empty .title").innerText()) === "Проєкт не відкрито");
    check("html lang follows", (await page.evaluate(() => document.documentElement.lang)) === "uk");
    check("light theme applied", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("light background is light", bg === "rgb(243, 244, 247)", bg);
    await shot(page, "e2e-ukrainian-light");

    // Plural forms: Ukrainian has three.
    for (let i = 0; i < 5; i++) await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(400);
    const status = await page.locator(".statusbar").innerText();
    check("five objects use the genitive plural", status.includes("5 об’єктів"), status.replace(/\s+/g, " "));

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    check("language survives a reload", (await page.locator(".menubar-item").first().innerText()) === "Файл");
    check("no page errors", page.logs.filter(l => !l.includes("404")).length === 0, page.logs.join(" | "));
});

scenario("dialogs: Esc cancels, Enter confirms, shortcuts stand down", async () => {
    const page = await newPage("DialogDemo");
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
        check(`scenario completed`, false, String(err.message ?? err).split("\n").slice(0, 12).join(" | ")); }
}
await browser.close();
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
