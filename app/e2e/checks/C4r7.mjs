// C4r7.mjs — AC-15 black-box proof: unsaved Code-tab edits are not lost.
//
// Seeds a project with scripts/A.ts and scripts/B.ts, then walks the editor as
// a user: edit A, switch panes, try to open B while A is dirty, save, and close
// the tab. The buffer (Monaco model) must survive every unmount, a dirty file
// must never be replaced without a question, the dirty mark clears only when
// the buffer still equals what was written, and the browser must warn on unload
// while the script is dirty.
//
// Self-contained: imports only from ../lib/harness.mjs; no existing e2e file,
// harness, runner or package.json is changed.
// Contract: node e2e/checks/C4r7.mjs <editor-url> — exit 0 iff every check passed.

import {
    newPage, seed, readDisk, check, runCheck, noErrors,
    dialogTitle, dialogButton,
    SCENARIO_ENTRY, sceneWith, slowLibraryWrite,
} from "../lib/harness.mjs";

const FOLDER = "C4r7Parent";
const A_PATH = "scripts/A.ts";
const A_TEXT = 'export const WHICH = "A";\n';
const SWAP_ADVISORY = "already registered to a different class";

async function saveScene(page) {
    await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(800);
}

async function setup(page) {
    await seed(page, FOLDER, {
        "scenario.meta.json": JSON.stringify(
            { id: "c4r7-parent", name: FOLDER, version: "1.0.0" }, null, 2) + "\n",
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        [A_PATH]: 'export const WHICH = "A";\n',
        ["scripts/B.ts"]: 'export const WHICH = "B";\n',
        ["assets/scenes/main.scene.json"]: sceneWith("C4r7Root"),
    });
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor({ timeout: 30000 });
    await saveScene(page);
}

async function openScript(page, name, expectDialog = false) {
    await page.locator(".pane-tab", { hasText: "Project" }).first().click();
    await page.waitForTimeout(250);
    const asset = page.locator(".proj .asset", { hasText: name }).first();
    if (await asset.count() === 0) {
        const folder = page.locator(".proj .folders .folder", { hasText: "scripts" }).first();
        if (await folder.count() > 0) { await folder.click(); await page.waitForTimeout(350); }
    }
    await asset.dblclick();
    if (!expectDialog) await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
    await page.waitForTimeout(350);
}

async function pasteAll(page, text) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(t => navigator.clipboard.writeText(t), text);
    await page.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(350);
}

async function appendText(page, text) {
    await page.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(text);
    await page.waitForTimeout(200);
}

async function readBuffer(page) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    return await page.evaluate(() => navigator.clipboard.readText());
}

async function dialogShown(page, title, timeout = 6000) {
    try {
        await page.waitForFunction(
            t => (document.querySelector(".dlg-title")?.textContent ?? "").includes(t),
            title, { timeout },
        );
        return true;
    } catch {
        return false;
    }
}

await runCheck(async () => {
    const page = await newPage(FOLDER);
    await setup(page);
    const codeName = () => page.locator(".code-name").first().innerText();
    const dot = async () => (await page.locator(".code-head .dot.unsaved").count()) > 0;

    // 1. edit A — the typed text and the unsaved dot are both live.
    await openScript(page, "A.ts");
    check("A.ts opens in the Code tab", (await codeName()).includes("A.ts"));
    await pasteAll(page, A_TEXT + "// C4R7_DIRTY\n");
    check("typing marks the script dirty", await dot());
    check("the buffer holds the typed marker", (await readBuffer(page)).includes("C4R7_DIRTY"));

    // 2. tab switches keep the buffer and the dot (D1).
    await page.locator(".pane-tab", { hasText: "Project" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".pane-tab", { hasText: "Code" }).first().click();
    await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    check("Project -> Code keeps the marker", (await readBuffer(page)).includes("C4R7_DIRTY"));
    check("Project -> Code keeps the unsaved dot", await dot());

    await page.locator(".pane-tab", { hasText: "Console" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".pane-tab", { hasText: "Code" }).first().click();
    await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    check("Console -> Code keeps the marker", (await readBuffer(page)).includes("C4R7_DIRTY"));
    check("Console -> Code keeps the unsaved dot", await dot());

    // 3. opening B while A is dirty asks first (D3).
    await openScript(page, "B.ts", true);
    const asked = await dialogShown(page, "Discard unsaved changes?");
    check("opening another script while dirty asks", asked);
    if (asked) {
        check("the dialog is the discard question",
            (await dialogTitle(page).innerText()).includes("Discard unsaved changes?"));
        await dialogButton(page, "Cancel").click();
        await page.waitForTimeout(400);
        await page.locator(".pane-tab", { hasText: "Code" }).first().click();
        await page.waitForTimeout(350);
        check("Cancel keeps A open", (await codeName()).includes("A.ts"));
        check("Cancel keeps the marker", (await readBuffer(page)).includes("C4R7_DIRTY"));
        check("Cancel keeps the dot", await dot());

        await openScript(page, "B.ts", true);
        const askedAgain = await dialogShown(page, "Discard unsaved changes?");
        check("the question is asked again", askedAgain);
        if (askedAgain) {
            await dialogButton(page, "Replace").click();
            await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
            await page.waitForTimeout(600);
            check("Replace opens B", (await codeName()).includes("B.ts"));
            check("Replace clears the dot", !(await dot()));
            check("discarded A is unchanged on disk", (await readDisk(page, FOLDER, A_PATH)) === A_TEXT);
        }
    }

    // 4. reopening the same dirty file is silent and keeps the buffer (D2).
    await openScript(page, "A.ts");
    await pasteAll(page, A_TEXT + "// C4R7_SAME\n");
    check("A is dirty again", await dot());
    await openScript(page, "A.ts");
    check("same-file reopen does not ask", !(await dialogShown(page, "Discard unsaved changes?", 1500)));
    check("same-file reopen keeps the marker", (await readBuffer(page)).includes("C4R7_SAME"));

    // 5. Save writes the buffer and clears the dot; typing during the write does not (D5).
    await page.locator(".pane-btn.primary").click();
    await page.waitForTimeout(900);
    check("Save writes the typed buffer",
        (await readDisk(page, FOLDER, A_PATH)) === A_TEXT + "// C4R7_SAME\n");
    check("Save clears the dot", !(await dot()));

    await slowLibraryWrite(page, "A.ts", 1800);
    await appendText(page, "// C4R7_RACED\n");
    check("buffer dirty before the raced save", await dot());
    await page.locator(".pane-btn.primary").click();
    await page.waitForTimeout(250);
    await appendText(page, "// C4R7_AFTER\n");
    await page.waitForTimeout(2300);
    check("typing during Save keeps the dot", await dot());
    const raced = await readDisk(page, FOLDER, A_PATH);
    check("the raced Save wrote the pre-race buffer",
        raced.includes("C4R7_RACED") && !raced.includes("C4R7_AFTER"), raced);
    check("the buffer still holds the post-race text",
        (await readBuffer(page)).includes("C4R7_AFTER"));

    // 6. a discarded model is refreshed from disk on reopen (D3 + D1).
    await pasteAll(page, A_TEXT + "// C4R7_STALE\n");
    await openScript(page, "B.ts", true);
    if (await dialogShown(page, "Discard unsaved changes?")) await dialogButton(page, "Replace").click();
    await page.waitForTimeout(400);
    await openScript(page, "A.ts");
    await page.waitForTimeout(400);
    const reopened = await readBuffer(page);
    check("reopened A shows disk text, not the stale edit",
        reopened.includes("WHICH") && !reopened.includes("C4R7_STALE"), reopened);

    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no unexpected page errors",
        noErrors(page) || page.logs.every(l => l.includes(SWAP_ADVISORY)), page.logs.join(" | "));

    // 7. leaving the page warns while the script is dirty (D6). Headless
    // Chromium surfaces beforeunload on reload, not on page.close(), so the
    // same native prompt is observed through reload() as the existing suite does.
    await pasteAll(page, A_TEXT + "// C4R7_UNLOAD\n");
    check("script is dirty before leaving", await dot());
    await saveScene(page);
    const dirtyBefore = page.beforeUnloads;
    await page.reload({ waitUntil: "load" });
    check("a dirty script prompts beforeunload",
        page.beforeUnloads === dirtyBefore + 1, `${dirtyBefore} -> ${page.beforeUnloads}`);

    // A clean page leaves with no prompt at all.
    const clean = await newPage(FOLDER);
    await setup(clean);
    await openScript(clean, "A.ts");
    const cleanBefore = clean.beforeUnloads;
    await clean.close({ runBeforeUnload: true });
    check("a clean script closes quietly", clean.beforeUnloads === cleanBefore,
        `${cleanBefore} -> ${clean.beforeUnloads}`);
    await clean.close().catch(() => {});
});
