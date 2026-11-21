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
    // The page pulls its fonts from Google; a network blip there fails the load
    // and pollutes "no page errors". The suite runs against the local server
    // only, so the font hosts answer with empty CSS once per context (an abort
    // would itself log a resource error).
    const ctx = page.context();
    if (!ctx.__fontsBlocked) {
        ctx.__fontsBlocked = true;
        await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    }
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

/**
 * Holds one library file's write open `ms` longer before it closes, and raises
 * `window.__libWriteClosing` when that close starts — so a scenario can act
 * while the add is still in flight (C4r5). Test instrumentation only.
 */
const slowLibraryWrite = (page, fileName, ms) => page.evaluate(([name, delay]) => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const writable = await create.apply(this, args);
        if (this.name === name) {
            const close = writable.close.bind(writable);
            writable.close = async () => {
                window.__libWriteClosing = true;
                await new Promise(r => setTimeout(r, delay));
                return close();
            };
        }
        return writable;
    };
}, [fileName, ms]);

/**
 * Makes the next write of one file throw once — a disk failure mid-add. The
 * file handle is already created by then, exactly as a real failure leaves it
 * (C4r5). Test instrumentation only.
 */
const failNextWrite = (page, fileName) => page.evaluate(name => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
        if (this.name === name && !window.__libWriteFailed) {
            window.__libWriteFailed = true;
            throw new Error("e2e: disk full");
        }
        return create.apply(this, args);
    };
}, fileName);

/**
 * Makes every read of one file throw NotAllowedError — a read failure that is
 * not a vanished file (a permission problem, a locked handle). The seam is
 * getFile, which readText goes through; listing still works (C4r2).
 * Test instrumentation only.
 */
const failReads = (page, fileName) => page.evaluate(name => {
    const get = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function (...args) {
        if (this.name === name) throw new DOMException("e2e: read refused", "NotAllowedError");
        return get.apply(this, args);
    };
}, fileName);

/**
 * Holds the first read of the project's entry script until released, so the
 * script-load step of an open can be acted inside deterministically (C4).
 * The seam is getFile, which the runtime's readText goes through. Test
 * instrumentation only.
 */
const holdScriptRead = page => page.evaluate(() => {
    const get = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function (...args) {
        if (this.name === "Scenario.ts" && !window.__scriptReadHeld) {
            window.__scriptReadHeld = true;
            return new Promise(resolve => {
                window.__releaseScriptRead = () => resolve(get.apply(this, args));
            });
        }
        return get.apply(this, args);
    };
});

/**
 * Holds the first read of one file after its write closes — the stamp read a
 * save does between its write and its reload — so a second save can be pressed
 * inside that window deterministically (C4 review R4). The seam is getFile,
 * which modifiedAt goes through. Test instrumentation only.
 */
const holdStampRead = (page, fileName) => page.evaluate(name => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const writable = await create.apply(this, args);
        if (this.name === name) {
            const close = writable.close.bind(writable);
            writable.close = async () => { const r = await close(); window.__stampWriteDone = true; return r; };
        }
        return writable;
    };
    const get = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function (...args) {
        if (this.name === name && window.__stampWriteDone && !window.__stampReadHeld) {
            window.__stampReadHeld = true;
            return new Promise(resolve => {
                window.__releaseStampRead = () => resolve(get.apply(this, args));
            });
        }
        return get.apply(this, args);
    };
}, fileName);

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
// Only the *performance* note is excused, never the whole `GL Driver Message`
// prefix: the driver reports real Error-severity GL faults under it too, and
// dropping the prefix let a broken Scene view pass the suite (B1r3).
const noErrors = page => page.logs.filter(l =>
    !l.includes("404")
    && !(l.includes("GL Driver Message") && l.includes("Performance"))
    && !l.includes("GPU stall due to ReadPixels")
).length === 0;

/** Writes a full project layout (files by project-relative path) the picker will hand back. */
async function seedScriptProject(page, files) {
  await seed(page, "ScriptParent", {
    "scenario.meta.json": JSON.stringify({ id: "script-parent", name: "ScriptParent", version: 1, createdAt: "2026-11-12T00:00:00Z" }),
    ...files,
  });
}

/** From the start screen: open the (empty) folder the picker returns and accept the set-up. */
async function openEmptyProject(page) {
    await page.getByText("Open folder…").click();
    await dialogButton(page, "Set up").click();
    // Late in a full run every earlier scenario's page is still open and the
    // software GL is slow; the same 90 s the reload waits use (B1.6).
    await page.locator(".work").waitFor({ timeout: 90000 });
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

// B1r5 #6 (B1r3's missing proof): the filter itself, fed synthetic lines.
// The old filter excused the whole `GL Driver Message` prefix, so an
// Error-severity GL fault passed the suite silently; these checks fail on
// that old filter and pin the narrow one. Pure logic — no page needed.
scenario("harness: noErrors excuses only performance notes, never GL errors (B1r5)", async () => {
    const withLogs = lines => ({ logs: lines });
    check("a synthetic GL Driver Message of Error severity FAILS noErrors",
        noErrors(withLogs(["[error] GL Driver Message (OpenGL, Error, GL_INVALID_OPERATION in glDrawElements)"])) === false);
    check("a plain page error fails noErrors",
        noErrors(withLogs(["[pageerror] TypeError: x is not a function"])) === false);
    check("the performance note is still excused",
        noErrors(withLogs(["[warning] GL Driver Message (OpenGL, Performance, GPU stall due to ReadPixels)"])) === true);
    check("the ReadPixels stall warning alone is excused",
        noErrors(withLogs(["[warning] GPU stall due to ReadPixels"])) === true);
    check("an asset 404 is excused",
        noErrors(withLogs(["[error] Failed to load resource: the server responded with a status of 404"])) === true);
    check("an empty log passes", noErrors(withLogs([])) === true);
    check("a real error among excused lines still fails",
        noErrors(withLogs([
            "[warning] GL Driver Message (OpenGL, Performance, GPU stall due to ReadPixels)",
            "[error] GL Driver Message (OpenGL, Error, GL_OUT_OF_MEMORY)",
        ])) === false);
});

// C4 phase 2: the script runtime. A project whose saved scene names a component
// script opens with that component attached: the scripts are compiled and linked
// before the scene is read, exactly as a reload on the platform runs them. The
// engine is resolved through the runtime's Blob-URL shim, so the script and the editor
// share one TypeRegistry — a class a script exports reaches the scene the editor
// deserializes.
const ROTATOR = `import { ScriptableBehaviour, Serializable, SerializedField, Time } from "WebEngineTS";

@Serializable({ typeName: "Rotator" })
export default class Rotator extends ScriptableBehaviour {
    @SerializedField() public speed = 1;

    protected override update(): void {
        this.transform.position.x += this.speed * Time.deltaTime;
    }
}
`;
const SCENARIO_ENTRY = `import { ScenarioBehaviour, SceneSerializer } from "WebEngineTS";

const SCENE = "scenes/main.scene.json";

export default class Scenario extends ScenarioBehaviour {
    override async awake(): Promise<void> {
        const blob = await this.context.assets.getAsset(SCENE);
        SceneSerializer.deserializeScene(JSON.parse(await blob.text()));
    }
}
`;

scenario("a component script loads, attaches to its object, and swaps on save", async () => {
  const page = await newPage("ScriptParent");
  const scene = {
    name: "Main", version: 1,
    roots: [{
      name: "Spinner", active: true,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      components: [{ type: "Rotator", fields: { speed: 3 } }],
      children: [],
    }],
  };
  await seed(page, "ScriptParent", {
    "scenario.meta.json": JSON.stringify({ id: "script-parent", name: "ScriptParent", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "scripts/components/Rotator.ts": ROTATOR,
    "assets/scenes/main.scene.json": JSON.stringify(scene),
  });

  // Open through the picker, like any existing project: the picker is faked to
  // OPFS by `instrument`, so this reads the files just seeded.
  await page.getByText("Open folder…").click();
  await page.locator(".work").waitFor({ timeout: 30000 });
  // The scripts load before the scene, so the object's component is a real
  // component by the time the hierarchy shows it.
  await page.waitForFunction(
    () => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false,
    null, { timeout: 30000 },
  );

  check("the scene opened with the object the script drives",
    (await page.locator("app-hierarchy").innerText()).includes("Spinner"));
  await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
  await page.waitForTimeout(400);
  const body = () => page.locator(".insp-body").innerText();
  check("the component is attached, not a placeholder",
    (await body()).includes("Rotator"), (await body()).slice(0, 160));
  const fieldValues = () => page.locator(".insp-body .field input")
    .evaluateAll(els => els.map(e => e.value));
  check("and its saved field is shown",
    (await fieldValues()).includes("3"), JSON.stringify(await fieldValues()));

  // Open the script, change the default, save — the class is swapped.
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .folders .folder", { hasText: "components" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .asset", { hasText: "Rotator.ts" }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
  check("the Code tab opened on the script", (await page.locator(".code-name").innerText()).includes("Rotator.ts"));

  // Pasted, not typed: Monaco's auto-closing brackets rewrite a typed source,
  // and the file on disk would no longer be the text the author meant.
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const edited = ROTATOR.replace("public speed = 1;", "public speed = 5;");
  await page.evaluate(text => navigator.clipboard.writeText(text), edited);
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(700);
  await page.locator(".pane-btn.primary").click();
  await page.waitForTimeout(2500);
  const onDisk = await readDisk(page, "ScriptParent", "scripts/components/Rotator.ts");
  check("the file on disk holds the new default", onDisk.includes("public speed = 5"));
  check("the typed file is what was typed", JSON.stringify(onDisk).indexOf("public speed = 5;") > 0 && !onDisk.includes("speed = 1;"), JSON.stringify(onDisk).slice(0, 400));
  check("the workspace is still open after the swap", (await page.locator(".work").count()) === 1);
  check("the object is still there", (await page.locator("app-hierarchy").innerText()).includes("Spinner"));

  // DW-2.2: a fresh object of the same script sees the new default. The class
  // was replaced, not re-registered.
  // The engine canvas, not Monaco's own (the Code tab is open by now).
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Alt+Shift+N");
  await page.waitForTimeout(600);
  await page.locator("app-hierarchy li", { hasText: "GameObject" }).last().click();
  await page.waitForTimeout(300);
  await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".add-list li", { hasText: "Rotator" }).first().click();
  await page.waitForTimeout(600);
  const added = () => page.locator(".insp-body .field input").evaluateAll(els => els.map(e => e.value));
  check("a new object gets the script's new default",
    (await added()).includes("5"), JSON.stringify(await added()));

  // The engine's own advisory about the refused duplicate registration is what
  // a reload swap looks like from its side: `register` refuses the second
  // class, and the editor answers with `TypeRegistry.replace` — which is what
  // the message asks for. Everything else in the console must be quiet.
  const swapError = "[TypeRegistry] Type name \"Rotator\" is already registered to a different class";
  check("nothing but the swap advisory in the console",
    page.logs.filter(l => !l.includes("404") && !l.includes(swapError)).length === 0,
    page.logs.join(" | "));
  await shot(page, "e2e-script-runtime");
});

// C4 DW-2.3: a scene saved with a scripted component reloads into the same
// class after a full editor reload. Nothing about the script runtime is cached
// across sessions: the page starts empty, the scripts are compiled and linked
// again (fresh blob URLs), and the saved field value comes back with them.
scenario("a saved scripted component survives a full editor reload (DW-2.3)", async () => {
  const page = await newPage("ReloadParent");
  await seed(page, "ReloadParent", {
    "scenario.meta.json": JSON.stringify({ id: "reload-parent", name: "ReloadParent", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "scripts/components/Rotator.ts": ROTATOR,
    "assets/scenes/main.scene.json": JSON.stringify({
      name: "Main", version: 1,
      roots: [{
        name: "Spinner", active: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [{ type: "Rotator", fields: { speed: 3 } }],
        children: [],
      }],
    }),
  });
  await page.getByText("Open folder…").click();
  await page.waitForFunction(() => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false, null, { timeout: 30000 });

  // Set a saved field value through the inspector and save the scene.
  await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
  await page.waitForTimeout(400);
  const speedInput = page.locator(".insp-body .comp", { hasText: "Rotator" }).first()
    .locator(".field", { hasText: "speed" }).locator("input").first();
  await speedInput.fill("6");
  await speedInput.blur();
  await page.waitForTimeout(300);
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  const savedScene = JSON.parse(await readDisk(page, "ReloadParent", "assets/scenes/main.scene.json"));
  const savedComp = savedScene.roots[0].components.find(c => c.type === "Rotator");
  check("the scene was saved with the class name and the edited field",
    savedComp && savedComp.fields.speed === 6, JSON.stringify(savedScene.roots[0].components));

  // A full reload: OPFS keeps the files, the page keeps nothing else. A saved
  // scene leaves quietly — no "leave this page?" prompt.
  const askedBefore = page.beforeUnloads;
  await page.reload({ waitUntil: "load" });
  check("a saved scene lets the reload go quietly", page.beforeUnloads === askedBefore);
  await page.locator(".recent").first().click();
  await page.waitForFunction(() => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false, null, { timeout: 30000 });

  // The component is the real class again, not a Missing script placeholder,
  // and the value the author saved is what the inspector shows.
  await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
  await page.waitForTimeout(500);
  const body = () => page.locator(".insp-body").innerText();
  check("after the reload the component is the real class", (await body()).includes("Rotator"), (await body()).slice(0, 160));
  check("and not a Missing script placeholder", !(await body()).includes("Missing script"), (await body()).slice(0, 160));
  const fieldValues = () => page.locator(".insp-body .field input").evaluateAll(els => els.map(e => e.value));
  check("the saved field value survived the reload", (await fieldValues()).includes("6"), JSON.stringify(await fieldValues()));

  // The runtime was built fresh: edit the script, save, and the swap still
  // works — which it could not if a stale blob URL or class had been cached.
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .folders .folder", { hasText: "components" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .asset", { hasText: "Rotator.ts" }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(text => navigator.clipboard.writeText(text), ROTATOR.replace("public speed = 1;", "public speed = 5;"));
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(700);
  await page.locator(".pane-btn.primary").click();
  await page.waitForTimeout(2500);
  check("the edited script is on disk after the reload",
    (await readDisk(page, "ReloadParent", "scripts/components/Rotator.ts")).includes("public speed = 5;"));
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Alt+Shift+N");
  await page.waitForTimeout(600);
  await page.locator("app-hierarchy li", { hasText: "GameObject" }).last().click();
  await page.waitForTimeout(300);
  await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".add-list li", { hasText: "Rotator" }).first().click();
  await page.waitForTimeout(600);
  check("a new object gets the freshly compiled class's new default",
    (await fieldValues()).includes("5"), JSON.stringify(await fieldValues()));
  await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
  await page.waitForTimeout(400);
  check("the saved object kept its saved value through the swap",
    (await fieldValues()).includes("6"), JSON.stringify(await fieldValues()));

  // One swap advisory is the engine's side of a reload swap (as in the phase-2
  // scenario); the fresh compile after the page reload must add nothing.
  const swapError = "[TypeRegistry] Type name \"Rotator\" is already registered to a different class";
  check("nothing but the swap advisory in the console",
    page.logs.filter(l => !l.includes("404") && !l.includes(swapError)).length === 0,
    page.logs.join(" | "));
  check("no native dialogs were used", page.nativeDialogs === 0);
  await shot(page, "e2e-script-reload");
});

// C4 phase 3: a script that does not compile never breaks the scene, says so in
// the Console with the line, and its class stays loaded; a component whose class
// is missing says that, with the data it kept.
const BROKEN_ROTATOR = `import { ScriptableBehaviour, Serializable } from "WebEngineTS";

@Serializable({ typeName: "Rotator" })
export default class Rotator extends ScriptableBehaviour {
    public speed = 1;

    protected override update(): void {
        this.transform.position.x += this.speed * Time.deltaTime)   // ) is one too many
    }
}
`;
const GOOD_ROTATOR = `import { ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

@Serializable({ typeName: "Rotator" })
export default class Rotator extends ScriptableBehaviour {
    @SerializedField() public speed = 2;
}
`;

scenario("a broken script keeps its class, points at its line, and the scene is intact", async () => {
  const page = await newPage("BrokenParent");
  await seed(page, "BrokenParent", {
    "scenario.meta.json": JSON.stringify({ id: "broken", name: "BrokenParent", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": "export {};\n",
    "scripts/components/Rotator.ts": GOOD_ROTATOR,
    "assets/scenes/main.scene.json": JSON.stringify({
      name: "Main", version: 1,
      roots: [{
        name: "Spinner", active: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [{ type: "Rotator", fields: { speed: 4 } }],
        children: [],
      }],
    }),
  });
  await page.getByText("Open folder…").click();
  await page.waitForFunction(() => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false, null, { timeout: 30000 });
  const sceneBefore = await readDisk(page, "BrokenParent", "assets/scenes/main.scene.json");

  // Break the script through the editor, and save.
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .folders .folder", { hasText: "components" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .asset", { hasText: "Rotator.ts" }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(text => navigator.clipboard.writeText(text), BROKEN_ROTATOR);
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(600);
  await page.locator(".pane-btn.primary").click();
  await page.waitForTimeout(2500);

  // The Console names the line, and the row is a jump target.
  await page.locator(".pane-tab", { hasText: "Console" }).first().click();
  await page.waitForTimeout(400);
  const consoleText = await page.locator(".cons-list").innerText();
  check("the Console names the file and the line", /Rotator\.ts:\d+/.test(consoleText), consoleText.slice(0, 240));
  check("and the row is clickable", (await page.locator(".log .src.jump").count()) > 0);

  // The component survived the broken save: the class stays loaded, and the
  // object keeps it and its saved value — select it again, as the author would.
  await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
  await page.waitForTimeout(500);
  const body = () => page.locator(".insp-body").innerText();
  check("the component is still there", (await body()).includes("Rotator"), (await body()).slice(0, 160));
  check("with its saved value", (await page.locator(".insp-body .field input").evaluateAll(els => els.map(e => e.value))).includes("4"));
  check("the scene file is untouched", (await readDisk(page, "BrokenParent", "assets/scenes/main.scene.json")) === sceneBefore);

  // Clicking the row opens the file at that line.
  await page.locator(".log .src.jump").first().click();
  await page.waitForTimeout(900);
  check("the click opened the script", (await page.locator(".code-name").innerText()).includes("Rotator.ts"));
  check("the file on disk is the broken one",
    (await readDisk(page, "BrokenParent", "scripts/components/Rotator.ts")).includes("is one too many"));
  await shot(page, "e2e-script-broken");
});

scenario("a component whose class is gone says Missing script and keeps its data", async () => {
  const page = await newPage("MissingParent");
  await seed(page, "MissingParent", {
    "scenario.meta.json": JSON.stringify({ id: "missing", name: "MissingParent", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": "export {};\n",
    "assets/scenes/main.scene.json": JSON.stringify({
      name: "Main", version: 1,
      roots: [{
        name: "Holder", active: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [{ type: "Rotator", fields: { speed: 7, name: "kept" } }],
        children: [],
      }],
    }),
  });

  await page.getByText("Open folder…").click();
  await page.waitForFunction(() => document.querySelector("app-hierarchy")?.innerText?.includes("Holder") ?? false, null, { timeout: 30000 });
  await page.locator("app-hierarchy li", { hasText: "Holder" }).first().click();
  await page.waitForTimeout(500);

  const body = () => page.locator(".insp-body").innerText();
  check("the title names the class the scene used", (await body()).includes("Rotator"), (await body()).slice(0, 200));
  check("and it is marked as a missing script", (await body()).includes("Missing script"));
  const rows = await page.locator(".missing-fields th, .missing-fields td").allInnerTexts();
  check("the saved fields are shown read-only",
    rows.join(" ").includes("speed") && rows.join(" ").includes("7"), rows.join(" | "));
  // The Transform is hand-rolled and is not the script: only an app-component-section counts.
  const editable = await page.locator("app-component-section .field input").count();
  check("and nothing is editable", editable === 0, String(editable));

  // Saving does not lose the data: the engine writes a placeholder back exactly
  // as it read it, so the scene keeps the component and its fields.
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Alt+Shift+N");
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(900);
  const after = await readDisk(page, "MissingParent", "assets/scenes/main.scene.json");
  check("the saved scene keeps the component and its fields",
    after.includes("Rotator") && after.includes("speed") && after.includes("kept"), after.slice(0, 240));
  await shot(page, "e2e-missing-script");
});

// C4 phase 4 (D5): the library. "Add component → Library" offers ten shipped
// behaviours; adding one copies its source into scripts/library/<Name>.ts — a
// permanent project file — reloads the script runtime, and attaches the class
// to the selection, which survives the scene rebuild the reload performs.
const LIBRARY_NAMES = [
    "Rotator", "Mover", "Clickable", "ToggleVisibility", "ShowTextOnClick",
    "QuizQuestion", "Timer", "FollowPath", "LookAtCamera", "PlayAnimation",
];

/** Seeds a project with one bare object and opens it; returns the page. */
async function openLibraryProject(page, folder) {
    await seed(page, folder, {
        "scenario.meta.json": JSON.stringify({ id: folder.toLowerCase(), name: folder, version: "1.0.0" }, null, 2) + "\n",
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        "assets/scenes/main.scene.json": sceneWith("Spinner"),
    });
    await page.getByText("Open folder…").click();
    await page.waitForFunction(
        () => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false,
        null, { timeout: 30000 },
    );
    await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
    await page.waitForTimeout(400);
}

/** Opens the add menu, clicks a Library entry, waits for the attach to land. */
async function addFromLibrary(page, name) {
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-list li", { hasText: name }).first().click();
    await page.waitForFunction(
        n => document.querySelector(".insp-body")?.innerText?.includes(n) ?? false,
        name, { timeout: 30000 },
    );
    await page.waitForTimeout(300);
}

scenario("library: add Rotator, edit its speed, and the object rotates in play (DW-4.1)", async () => {
    const page = await newPage("LibraryParent", { probe: true });
    await openLibraryProject(page, "LibraryParent");

    // The Library section offers all ten, once each, under its own header.
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    const menuText = await page.locator(".add-list").innerText();
    check("the Library section is there", /library/i.test(menuText), menuText.slice(0, 200));
    const offered = await page.locator(".add-list li").allInnerTexts();
    check("all ten behaviours are offered",
        LIBRARY_NAMES.every(n => offered.filter(t => t.trim() === n).length === 1), offered.join(","));
    await page.locator(".add-list li", { hasText: "Rotator" }).first().click();
    await page.waitForFunction(
        () => document.querySelector(".insp-body")?.innerText?.includes("Rotator") ?? false,
        null, { timeout: 30000 },
    );
    await page.waitForTimeout(300);

    // The source landed as a permanent project file, and the selection survived
    // the rebuild the reload performed (the probe only reads selected objects).
    const source = await readDisk(page, "LibraryParent", "scripts/library/Rotator.ts");
    check("the source was copied to scripts/library/Rotator.ts",
        source !== null && source.includes('@Serializable({ typeName: "Rotator" })') && source.includes("public speed = 90"),
        String(source).slice(0, 200));
    check("the object is still selected after the reload",
        (await page.evaluate(() => window.__wetsProbe.transformOf("Spinner"))) !== null);

    // speed is inspector-editable: change it, and it persists through a save.
    const speedInput = page.locator(".insp-body .comp", { hasText: "Rotator" }).first()
        .locator(".field", { hasText: "speed" }).locator("input").first();
    check("speed shows the shipped default", (await speedInput.inputValue()) === "90", await speedInput.inputValue());
    await speedInput.fill("180");
    await speedInput.blur();
    await page.waitForTimeout(300);
    check("speed is editable", (await speedInput.inputValue()) === "180", await speedInput.inputValue());

    // Play: the object really rotates, at the edited speed. Stop restores.
    const eulerBefore = await page.evaluate(() => window.__wetsProbe.transformOf("Spinner").euler);
    await page.locator(".tb-btn[title='Play']").click();
    await page.waitForFunction(
        () => Math.abs(window.__wetsProbe.transformOf("Spinner")?.euler.y ?? 0) > 5,
        null, { timeout: 10000 },
    );
    const eulerDuring = await page.evaluate(() => window.__wetsProbe.transformOf("Spinner").euler);
    check("the object rotates in play", Math.abs(eulerDuring.y - eulerBefore.y) > 5,
        JSON.stringify({ before: eulerBefore, during: eulerDuring }));
    await page.locator(".tb-btn[title='Stop']").click();
    await page.waitForTimeout(500);
    // Stop clears the selection and restores the snapshot: re-select to read.
    await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
    await page.waitForTimeout(300);
    const eulerAfter = await page.evaluate(() => window.__wetsProbe.transformOf("Spinner")?.euler ?? null);
    check("stop restores the pre-play pose", eulerAfter !== null && Math.abs(eulerAfter.y) < 0.01,
        JSON.stringify(eulerAfter));

    await page.keyboard.press("Control+s");
    await page.waitForTimeout(800);
    const saved = JSON.parse(await readDisk(page, "LibraryParent", "assets/scenes/main.scene.json"));
    const comp = saved.roots[0].components.find(c => c.type === "Rotator");
    check("the saved scene holds Rotator with the edited speed", comp && comp.fields.speed === 180,
        JSON.stringify(saved.roots[0].components));
    await shot(page, "e2e-library-rotator");
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("library: second and third adds keep working, nothing offered twice (DW-4.3)", async () => {
    const page = await newPage("LibraryAgain", { probe: true });
    await openLibraryProject(page, "LibraryAgain");

    for (const name of ["Rotator", "Mover", "Timer"]) {
        await addFromLibrary(page, name);
        const source = await readDisk(page, "LibraryAgain", `scripts/library/${name}.ts`);
        check(`${name}: the source is on disk`, source !== null && source.includes(`typeName: "${name}"`), String(source).slice(0, 120));
        check(`${name}: attached to the still-selected object`,
            (await page.evaluate(() => window.__wetsProbe.transformOf("Spinner"))) !== null);
    }
    const body = await page.locator(".insp-body").innerText();
    check("all three components are on the object",
        ["Rotator", "Mover", "Timer"].every(n => body.includes(n)), body.slice(0, 300));

    // Installed entries leave the Library section and appear once, in Scripts.
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    let items = await page.locator(".add-list li").allInnerTexts();
    for (const name of ["Rotator", "Mover", "Timer"]) {
        check(`${name} is offered exactly once now`, items.filter(t => t.trim() === name).length === 1, items.join(","));
    }
    const libHead = items.findIndex(t => t.trim().toUpperCase() === "LIBRARY");
    check("the Library section offers only the seven left",
        LIBRARY_NAMES.filter(n => !["Rotator", "Mover", "Timer"].includes(n)).every(n => items.includes(n))
        && libHead >= 0 && !items.slice(libHead + 1).some(t => ["Rotator", "Mover", "Timer"].includes(t.trim())),
        items.join(","));
    // The filter narrows both sections without duplicating an entry.
    await page.locator(".add-menu input").fill("rot");
    await page.waitForTimeout(300);
    items = await page.locator(".add-list li").allInnerTexts();
    check("filtering shows Rotator once, from Scripts", items.filter(t => t.trim() === "Rotator").length === 1, items.join(","));
    await page.locator(".add-menu .cancel").click();

    // An installed behaviour attaches again through Scripts — no reload, no
    // second registration, and the console stays quiet throughout.
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-menu input").fill(""); // cancel kept the filter
    await page.waitForTimeout(300);
    await page.locator(".add-list li", { hasText: "Mover" }).first().click();
    await page.waitForTimeout(600);
    const movers = await page.locator(".insp-body .comp", { hasText: "Mover" }).count();
    check("a second Mover attaches from Scripts", movers === 2, String(movers));
    check("no page errors, no duplicate-registration advisory", noErrors(page), page.logs.join(" | "));
    await shot(page, "e2e-library-repeat");
});

// C4r5, blocker 1: an add whose target is deleted while the library file is
// still being written must abort — no attach to the destroyed object, no
// history entry, no selection change — and the written file stays.
scenario("library: deleting the target mid-add aborts cleanly, first undo restores it (C4r5)", async () => {
    const page = await newPage("LibraryMidflight", { probe: true });
    await openLibraryProject(page, "LibraryMidflight");
    await slowLibraryWrite(page, "LookAtCamera.ts", 1500);

    // Start the add, then delete the target while the file write is in flight.
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-list li", { hasText: "LookAtCamera" }).first().click();
    await page.waitForFunction(() => window.__libWriteClosing === true, null, { timeout: 15000 });
    await page.keyboard.press("Delete");
    await page.waitForFunction(
        () => !(document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false),
        null, { timeout: 5000 },
    );

    // Let the write land and the reload/rebuild/attach attempt run its course.
    await page.waitForFunction(() => window.__wetsProbe.scriptClass("LookAtCamera") !== null, null, { timeout: 30000 });
    await page.waitForTimeout(1000);

    const src = await readDisk(page, "LibraryMidflight", "scripts/library/LookAtCamera.ts");
    check("the written library file stays", src !== null && src.includes('typeName: "LookAtCamera"'), String(src).slice(0, 120));
    const tree = await page.locator("app-hierarchy li .label").allInnerTexts();
    check("no ghost object in the hierarchy", !tree.includes("Spinner"), tree.join(","));
    const sel = await page.evaluate(() => window.__wetsProbe.selection());
    check("the destroyed object is not selected", sel.length === 0, JSON.stringify(sel));
    const comps = await page.locator(".insp-body .comp", { hasText: "LookAtCamera" }).count();
    check("no inspector component for the destroyed object", comps === 0, String(comps));

    // The delete must be the FIRST undo step: no 'Add LookAtCamera' on top of it.
    await page.keyboard.press("Control+z");
    await page.waitForFunction(
        () => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false,
        null, { timeout: 5000 },
    );
    check("Ctrl+Z restores the deleted object as the first undo step", true);

    await page.locator("app-hierarchy li", { hasText: "Spinner" }).first().click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(800);
    const saved = JSON.parse(await readDisk(page, "LibraryMidflight", "assets/scenes/main.scene.json"));
    check("the saved scene is clean: Spinner back, no LookAtCamera",
        saved.roots.length === 1 && saved.roots[0].name === "Spinner" && saved.roots[0].components.length === 0,
        JSON.stringify(saved.roots).slice(0, 240));
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// C4r5, blocker 2a: a stale library file whose class never registered (here a
// zero-byte leftover) must not hide the entry — the Library still offers it,
// and adding heals the file. A healthy installed file is never overwritten.
scenario("library: a stale empty file stays offered and the add heals it (C4r5)", async () => {
    const page = await newPage("LibraryStale", { probe: true });
    const customRotator = `import { ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";
// user-edited: keep me
@Serializable({ typeName: "Rotator" })
export default class Rotator extends ScriptableBehaviour {
    @SerializedField() public speed = 45;
}
`;
    await seed(page, "LibraryStale", {
        "scripts/library/LookAtCamera.ts": "",
        "scripts/library/Rotator.ts": customRotator,
    });
    await openLibraryProject(page, "LibraryStale");

    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-menu input").fill("lookat");
    await page.waitForTimeout(300);
    const items = await page.locator(".add-list li").allInnerTexts();
    check("the stale entry is still offered", items.filter(t => t.trim() === "LookAtCamera").length === 1, items.join(","));
    await page.locator(".add-list li", { hasText: "LookAtCamera" }).first().click();
    await page.waitForFunction(
        () => document.querySelector(".insp-body")?.innerText?.includes("LookAtCamera") ?? false,
        null, { timeout: 30000 },
    );
    await page.waitForTimeout(300);
    const healed = await readDisk(page, "LibraryStale", "scripts/library/LookAtCamera.ts");
    check("the add heals the empty file", healed !== null && healed.includes('typeName: "LookAtCamera"'), String(healed).slice(0, 120));
    check("the object is still selected", (await page.evaluate(() => window.__wetsProbe.transformOf("Spinner"))) !== null);

    // The author's own Rotator attaches through Scripts and is never rewritten.
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-menu input").fill("rotator");
    await page.waitForTimeout(300);
    const rotItems = await page.locator(".add-list li").allInnerTexts();
    check("the healthy installed file is offered once, from Scripts",
        rotItems.filter(t => t.trim() === "Rotator").length === 1, rotItems.join(","));
    await page.locator(".add-list li", { hasText: "Rotator" }).first().click();
    await page.waitForFunction(
        () => document.querySelector(".insp-body")?.innerText?.includes("Rotator") ?? false,
        null, { timeout: 30000 },
    );
    const kept = await readDisk(page, "LibraryStale", "scripts/library/Rotator.ts");
    check("the author's non-empty library file is never overwritten", kept === customRotator, String(kept).slice(0, 160));
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// C4r5, blocker 2b: a write that fails mid-add leaves a zero-byte file behind
// (the handle is created before the writable). The catch must remove that
// partial — it was created by this add and is empty — keep the error dialog,
// and the next add must succeed.
scenario("library: a failed write removes its own partial file, the retry heals (C4r5)", async () => {
    const page = await newPage("LibraryFailed", { probe: true });
    await openLibraryProject(page, "LibraryFailed");
    await failNextWrite(page, "LookAtCamera.ts");

    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-list li", { hasText: "LookAtCamera" }).first().click();
    await dialogTitle(page).waitFor({ timeout: 15000 });
    check("the failure is shown in the error dialog",
        (await dialogTitle(page).innerText()) === "Something went wrong"
        && (await page.locator(".dlg-msg").last().innerText()).includes("disk full"),
        await page.locator(".dlg-msg").last().innerText());
    await dialogButton(page, "OK").click();
    await page.waitForTimeout(300);

    const state = await diskState(page, "LibraryFailed");
    check("the partial file this add created is removed", !state.includes("scripts/library/LookAtCamera.ts"), state.join(","));

    // The entry is offered again and the retry (the write no longer fails) heals.
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-menu input").fill("lookat");
    await page.waitForTimeout(300);
    const items = await page.locator(".add-list li").allInnerTexts();
    check("the entry is offered again after the failure", items.filter(t => t.trim() === "LookAtCamera").length === 1, items.join(","));
    await page.locator(".add-list li", { hasText: "LookAtCamera" }).first().click();
    await page.waitForFunction(
        () => document.querySelector(".insp-body")?.innerText?.includes("LookAtCamera") ?? false,
        null, { timeout: 30000 },
    );
    const healed = await readDisk(page, "LibraryFailed", "scripts/library/LookAtCamera.ts");
    check("the retry writes the source and attaches", healed !== null && healed.includes('typeName: "LookAtCamera"'), String(healed).slice(0, 120));
    // The one expected failure log is the dialog's own console.error; nothing else.
    const expected = page.logs.filter(l => l.includes("e2e: disk full"));
    const unexpected = page.logs.filter(l => !l.includes("e2e: disk full") && !l.includes("404") && !l.includes("GL Driver Message") && !l.includes("GPU stall"));
    check("the failure is logged exactly once, nothing else errors",
        expected.length === 1 && unexpected.length === 0, page.logs.join(" | "));
});

// C4r5, blocker 2b guard: the catch must never delete a file the add did not
// create — the author's own non-empty script survives a failed write.
scenario("library: a failed write never deletes the author's existing file (C4r5)", async () => {
    const page = await newPage("LibraryOwned", { probe: true });
    const owned = `// the author's own draft — not a behaviour yet\nexport const draft = true;\n`;
    await seed(page, "LibraryOwned", { "scripts/library/LookAtCamera.ts": owned });
    await openLibraryProject(page, "LibraryOwned");
    await failNextWrite(page, "LookAtCamera.ts");

    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".add-menu input").fill("lookat");
    await page.waitForTimeout(300);
    await page.locator(".add-list li", { hasText: "LookAtCamera" }).first().click();
    await dialogTitle(page).waitFor({ timeout: 15000 });
    await dialogButton(page, "OK").click();
    await page.waitForTimeout(300);
    const kept = await readDisk(page, "LibraryOwned", "scripts/library/LookAtCamera.ts");
    check("the author's existing file survives the failed write", kept === owned, String(kept));
});

// C4r4, F1+F2: every form of the engine import resolves. The clause-level
// rewrite this replaces spanned statements — a sibling import first, or a
// comment mentioning the word `import`, turned the engine's import into
// `from undefined`, which is a SyntaxError, so the module never loaded and the
// component showed as missing; a default import read an undefined binding, and
// `export *`, `export { X } from` and a dynamic `import()` never bound at all.
// The rewrite is now the engine's own token regex pointed at one shim module,
// so the browser resolves each form. One marker per form is read at module
// evaluation: a broken form shows as a false, or as a class that never
// registers.
const IMPORT_SIBLING = `export class Stats { public value = 42; }
`;
const IMPORT_STAR = `export * from "WebEngineTS";
`;
const IMPORT_REEXPORT = `export { ScriptableBehaviour as SB } from "WebEngineTS";
`;
const IMPORT_FORMS = `import { Stats } from "./sibling";
// import order matters — a comment that mentions the word import
import WebEngine, { Vector3, Serializable, SerializedField } from "WebEngineTS";
import * as Engine from "WebEngineTS";
import { SceneManager } from "./star";
import { SB } from "./reexport";

// Each entry is one import form, evaluated at module load: a form that does not
// bind (or a syntax error the broken rewrite produced) shows up here, and the
// class below never registers when the module itself fails.
const dynamic = await import("WebEngineTS");
const MARKERS = [
    WebEngine !== undefined,                                     // default import
    typeof Vector3 === "function",                                // named import
    Engine !== undefined && Engine.GameObject !== undefined,      // namespace import
    typeof Stats === "function",                                  // sibling import first
    SceneManager !== undefined,                                   // export * via a module
    typeof SB === "function",                                     // export { X } from
    dynamic.GameObject !== undefined,                             // dynamic import()
].join(",");

@Serializable({ typeName: "Forms" })
export default class Forms extends SB {
    @SerializedField() public markers = MARKERS;
}
`;
scenario("every form of the engine import resolves — sibling first, default, namespace, star, dynamic", async () => {
  const page = await newPage("ImportForms", { probe: true });
  const scene = {
    name: "Main", version: 1,
    roots: [{
      name: "Form", active: true,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      components: [{ type: "Forms", fields: {} }],
      children: [],
    }],
  };
  await seed(page, "ImportForms", {
    "scenario.meta.json": JSON.stringify({ id: "forms", name: "ImportForms", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "scripts/components/sibling.ts": IMPORT_SIBLING,
    "scripts/components/star.ts": IMPORT_STAR,
    "scripts/components/reexport.ts": IMPORT_REEXPORT,
    "scripts/components/Forms.ts": IMPORT_FORMS,
    "assets/scenes/main.scene.json": JSON.stringify(scene),
  });
  await page.getByText("Open folder…").click();
  await page.waitForFunction(
    () => document.querySelector("app-hierarchy")?.innerText?.includes("Form") ?? false,
    null, { timeout: 30000 },
  );

  // A module that failed to evaluate cannot register: the component would read
  // "Missing script", exactly the old `from undefined` produced.
  await page.locator("app-hierarchy li", { hasText: "Form" }).first().click();
  await page.waitForTimeout(500);
  const body = () => page.locator(".insp-body").innerText();
  check("the class from the module that uses every form is attached",
    (await body()).includes("Forms") && !(await body()).includes("Missing script"),
    (await body()).slice(0, 200));
  check("the class is in the registry", await page.evaluate(() => window.__wetsProbe.scriptClass("Forms") !== null));

  // One marker per form, evaluated when the module ran.
  const markers = await page.locator(".insp-body .field input").evaluateAll(els => els.map(e => e.value));
  const forms = (await markers.find(v => (v || "").includes(",")) ?? "").split(",");
  check("the default import bound",
    forms[0] === "true", JSON.stringify(forms));
  check("a named import bound alongside it",
    forms[1] === "true", JSON.stringify(forms));
  check("the namespace import has the engine's exports",
    forms[2] === "true", JSON.stringify(forms));
  check("a sibling import before the engine's still made it in",
    forms[3] === "true", JSON.stringify(forms));
  check("a module that only does export * resolved",
    forms[4] === "true", JSON.stringify(forms));
  check("a module that re-exports a name resolved",
    forms[5] === "true", JSON.stringify(forms));
  check("a dynamic import() resolved",
    forms[6] === "true", JSON.stringify(forms));
  check("no page errors", noErrors(page), page.logs.join(" | "));
  await shot(page, "e2e-import-forms");
});

// C4r4, F3: editing a base module reaches the modules that import it, and F4:
// a module whose code did not change is not evaluated again, so the class it
// exports keeps its object identity. `Enemy` extends `BaseMover` — the probe
// reports the class token of each, and of the parent `Enemy` extends. The proof
// is in the identity: an importer left on the old base keeps the old parent
// token, and a base evaluated twice mints a second class object that is not the
// one the registry holds.
const F3_BASE = `import { ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

@Serializable({ typeName: "BaseMover" })
export default class BaseMover extends ScriptableBehaviour {
    @SerializedField() public speed = 1;
    // MARK_STEP
}
`;
const F3_ENEMY = `import { ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";
import BaseMover from "./Base";

@Serializable({ typeName: "Enemy" })
export default class Enemy extends BaseMover {
    @SerializedField() public label = "idle";
}
`;
const editScript = async (page, name, text) => {
  // The first edit leaves the bottom pane on the Code tab; the Project panel is
  // only mounted while its own tab is active, so the second edit must ask for it.
  await page.locator(".pane-tab", { hasText: "Project" }).first().click();
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .folders .folder", { hasText: "components" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .asset", { hasText: name }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(t => navigator.clipboard.writeText(t), text);
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(600);
  await page.locator(".pane-btn.primary").click();
};
scenario("editing a base module reaches its importer, and leaves the other class its identity", async () => {
  const page = await newPage("F3Parent", { probe: true });
  const scene = {
    name: "Main", version: 1,
    roots: [{
      name: "Enemy1", active: true,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      components: [{ type: "Enemy", fields: {} }, { type: "BaseMover", fields: {} }],
      children: [],
    }],
  };
  await seed(page, "F3Parent", {
    "scenario.meta.json": JSON.stringify({ id: "f3", name: "F3Parent", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "scripts/components/Base.ts": F3_BASE,
    "scripts/components/Enemy.ts": F3_ENEMY,
    "assets/scenes/main.scene.json": JSON.stringify(scene),
  });
  await page.getByText("Open folder…").click();
  await page.waitForFunction(
    () => document.querySelector("app-hierarchy")?.innerText?.includes("Enemy1") ?? false,
    null, { timeout: 30000 },
  );
  const classes = () => page.evaluate(() => ({
    base: window.__wetsProbe.scriptClass("BaseMover"),
    enemy: window.__wetsProbe.scriptClass("Enemy"),
  }));

  const first = await classes();
  check("both classes registered", first.base !== null && first.enemy !== null, JSON.stringify(first));
  check("Enemy extends BaseMover", first.enemy.parent === "BaseMover", first.enemy.parent);
  check("and its parent is the very class the registry holds",
    first.enemy.parentToken === first.base.token, `${first.enemy.parentToken} vs ${first.base.token}`);

  // Edit the base module only. Its importers must be re-linked against the new
  // class, so Enemy's parent token moves with it (F3).
  await editScript(page, "Base.ts", F3_BASE.replace("// MARK_STEP", "// MARK_STEP2\n    public tag = \"v2\";"));
  await page.waitForFunction(old => window.__wetsProbe.scriptClass("BaseMover")?.token !== old, first.base.token, { timeout: 20000 });
  await page.waitForTimeout(800);                       // the importer is re-imported in the same pass
  const second = await classes();
  check("the base class was replaced",
    second.base.token !== first.base.token, `${first.base.token} → ${second.base.token}`);
  check("the importer was re-linked against the new base",
    second.enemy.parentToken === second.base.token, `${second.enemy.parentToken} vs ${second.base.token}`);

  // Edit the importer only. The base module is untouched, so the class it
  // exported — the same object Enemy extends and the registry holds — stays
  // (F4: no second evaluation of an unchanged dependency).
  await editScript(page, "Enemy.ts", F3_ENEMY.replace('public label = "idle";', 'public label = "hunting";'));
  await page.waitForFunction(old => window.__wetsProbe.scriptClass("Enemy")?.token !== old, second.enemy.token, { timeout: 20000 });
  const third = await classes();
  check("the importer was replaced",
    third.enemy.token !== second.enemy.token, `${second.enemy.token} → ${third.enemy.token}`);
  check("and the untouched base kept its class object",
    third.base.token === second.base.token, `${second.base.token} → ${third.base.token}`);
  check("the new importer extends that same class, not a second copy",
    third.enemy.parentToken === third.base.token, `${third.enemy.parentToken} vs ${third.base.token}`);
  check("the scene still holds the object",
    (await page.locator("app-hierarchy").innerText()).includes("Enemy1"));
  // Re-registering a class under a name the registry already holds is the swap
  // itself: the engine's registry refuses the second constructor and the editor
  // answers with `TypeRegistry.replace` — the same advisory the phase-2 scenario
  // tolerates. Everything else in the console must be quiet.
  const swap = "already registered to a different class";
  check("nothing but the swap advisories in the console",
    page.logs.filter(l => !l.includes(swap) && !l.includes("404") && !l.includes("GL Driver Message") && !l.includes("GPU stall")).length === 0,
    page.logs.join(" | "));
  await shot(page, "e2e-base-edit-reaches-importers");
});

// C4 phase 1: the Code tab. A script file is a file like any other — it opens
// in the Code tab, types, saves back through the project store, and an edit of
// a source never marks the scene unsaved (only its own file). Monaco's own
// editor is what the tab renders, and the platform CSP allows its blob workers
// (`worker-src 'self' blob:`).
scenario("a script file opens in the Code tab, edits, and saves", async () => {
  const page = await newPage("CodeParent");
  await openEmptyProject(page);
  await page.waitForTimeout(600);

  // The layout already ships one script; open it from the Project panel —
  // the panel shows the project root first, so `scripts` is opened like a
  // folder click in the other scenarios.
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(600);
  const script = page.locator(".proj .asset", { hasText: "Scenario.ts" }).first();
  check("a script file is listed in the project panel", (await script.count()) === 1);
  await script.dblclick();
  await page.waitForTimeout(1500);

  check("the Code tab opened", (await page.locator(".pane-tab", { hasText: "Code" }).first().getAttribute("class")).includes("active"));
  check("the file's text is in the editor",
    (await page.evaluate(() => document.querySelector(".code-name")?.textContent ?? "")) .includes("Scenario.ts"));
  check("the scene is not marked unsaved by opening a source",
    (await page.locator(".statusbar .accent").first().innerText()) !== "Unsaved");

  // Type into Monaco and save. Monaco's textarea is the real input.
  const before = await readDisk(page, "CodeParent", "scripts/Scenario.ts");
  check("the file on disk is the one opened", before.includes("Scenario extends ScenarioBehaviour"), before.slice(0, 80));
  // Monaco's own textarea takes the keys; focusing it is enough, and no click
  // has to be stable for it.
  await page.locator(".monaco-editor").waitFor({ timeout: 15000 });
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.type("\n// C4 phase 1: the Code tab saves\n");
  await page.waitForTimeout(400);
  check("editing marks the file unsaved", (await page.locator(".pane-tab .dot.unsaved").count()) > 0);
  check("and the scene still is not", (await page.locator(".statusbar .accent").first().innerText()) !== "Unsaved");

  await page.locator(".pane-btn.primary").click();                       // Save
  await page.waitForTimeout(700);
  check("saving clears the file's mark", (await page.locator(".pane-tab .dot.unsaved").count()) === 0);

  const after = await readDisk(page, "CodeParent", "scripts/Scenario.ts");
  check("the file on disk holds the edit", after.includes("C4 phase 1: the Code tab saves"), after.slice(0, 120));

  // A reload reopens the project, and the file is what was saved.
  await page.reload({ waitUntil: "load" });
  await page.locator(".recent").first().click();
  await page.locator(".work").waitFor();
  await page.waitForTimeout(600);
  check("the edited file is still there after a reload",
    (await readDisk(page, "CodeParent", "scripts/Scenario.ts")).includes("C4 phase 1: the Code tab saves"));

  check("no page errors", noErrors(page), page.logs.join(" | "));
  await shot(page, "e2e-code-tab");
});

// C4 phase 5: outside edits to scripts are seen on window focus — recompiled
// quietly when the buffer is clean, asked about when it is dirty, and a save
// over an outside-changed file asks before it overwrites. Same OPFS-write +
// focus pattern as the scene's "changes made outside" scenario.
scenario("an outside edit to a script recompiles on focus", async () => {
  const page = await newPage("OutsideScript", { probe: true });
  await seed(page, "OutsideScript", {
    "scenario.meta.json": JSON.stringify({ id: "outside-script", name: "OutsideScript", version: 1 }),
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "scripts/components/Rotator.ts": ROTATOR,
    "assets/scenes/main.scene.json": sceneWith("Seeded"),
  });
  await page.getByText("Open folder…").click();
  await page.locator(".work").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => window.__wetsProbe.scriptClass("Rotator") !== null, null, { timeout: 30000 });
  const token = await page.evaluate(() => window.__wetsProbe.scriptClass("Rotator").token);

  // Changed on the "disk", the Code tab never opened it.
  await seed(page, "OutsideScript", { "scripts/components/Rotator.ts": ROTATOR.replace("public speed = 1;", "public speed = 7;") });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const swapped = await page.waitForFunction(old => window.__wetsProbe.scriptClass("Rotator")?.token !== old, token, { timeout: 30000 })
    .then(() => true, () => false);
  check("the outside edit recompiles the script", swapped);
  check("no dialog was needed", (await page.locator(".dlg").count()) === 0);
  // A fresh object of the class sees the disk's new default.
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Alt+Shift+N");
  await page.waitForTimeout(600);
  await page.locator("app-hierarchy li", { hasText: "GameObject" }).last().click();
  await page.waitForTimeout(300);
  await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".add-list li", { hasText: "Rotator" }).first().click();
  await page.waitForTimeout(600);
  const added = await page.locator(".insp-body .field input").evaluateAll(els => els.map(e => e.value));
  check("a new object gets the outside edit's default", added.includes("7"), JSON.stringify(added));
  check("no native dialogs were used", page.nativeDialogs === 0);
  // The swap advisory is what a reload looks like from the engine's side —
  // `register` refuses the second class and the editor answers with
  // `TypeRegistry.replace`, exactly as in the save-and-swap scenario.
  const swapError = "[TypeRegistry] Type name \"Rotator\" is already registered to a different class";
  check("nothing but the swap advisory in the console",
    page.logs.filter(l => !l.includes("404") && !l.includes(swapError)).length === 0,
    page.logs.join(" | "));
});

scenario("an outside edit to an open dirty script asks; keep mine and reload both respected", async () => {
  const page = await newPage("OutsideDirty");
  await openEmptyProject(page);
  await page.waitForTimeout(600);
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(600);
  await page.locator(".proj .asset", { hasText: "Scenario.ts" }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
  const original = await readDisk(page, "OutsideDirty", "scripts/Scenario.ts");
  check("the Code tab is clean after opening", (await page.locator(".dot.unsaved").count()) === 0);

  // Mine: an unsaved edit appended at the file's end (Monaco opens the cursor
  // at 1:1, and the buffer read below looks at the end of the file).
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// mine\n");
  await page.waitForTimeout(400);
  check("the buffer is dirty", (await page.locator(".dot.unsaved").count()) > 0);

  // Theirs: the file changes on disk underneath.
  const diskText = original + "\n// from outside\n";
  await seed(page, "OutsideDirty", { "scripts/Scenario.ts": diskText });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(800);
  check("changed in both places, it asks", (await dialogTitle(page).innerText()) === "Scenario.ts changed on disk");
  await dialogButton(page, "Keep mine").click();
  await page.waitForTimeout(500);
  // Monaco renders only the lines in view, and setValue scrolls back to the
  // top — so go to the file's end first (where every marker here sits), then
  // read. The view-lines carry non-breaking spaces and sit in DOM order, not
  // line order; normalise both.
  const buffer = async () => {
    await page.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(200);
    return page.evaluate(() => [...document.querySelectorAll(".view-lines .view-line")]
      .map(e => ({ top: e.offsetTop, text: e.textContent }))
      .sort((a, b) => a.top - b.top).map(l => l.text).join("\n").replace(/\u00a0/g, " "));
  };
  check("keep mine keeps my buffer", (await buffer()).includes("// mine"));
  check("and the disk still holds the outside edit", (await readDisk(page, "OutsideDirty", "scripts/Scenario.ts")) === diskText);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(800);
  check("the same change is not asked about again", (await page.locator(".dlg").count()) === 0);
  check("the buffer is still mine and still dirty", (await buffer()).includes("// mine") && (await page.locator(".dot.unsaved").count()) > 0);

  // A second outside change asks again; this time the disk version is taken.
  const diskText2 = original + "\n// from outside again\n";
  await seed(page, "OutsideDirty", { "scripts/Scenario.ts": diskText2 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(800);
  check("a new outside change asks again", (await page.locator(".dlg").count()) === 1);
  await dialogButton(page, "Reload from disk").click();
  await page.waitForTimeout(800);
  check("reload takes the disk text into the buffer", (await buffer()).includes("// from outside again") && !(await buffer()).includes("// mine"));
  check("the reloaded buffer is not marked unsaved", (await page.locator(".dot.unsaved").count()) === 0);
  check("no native dialogs were used", page.nativeDialogs === 0);
  check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("saving over an outside-changed script asks before it overwrites", async () => {
  const page = await newPage("OutsideSave");
  await openEmptyProject(page);
  await page.waitForTimeout(600);
  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(600);
  await page.locator(".proj .asset", { hasText: "Scenario.ts" }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });
  const original = await readDisk(page, "OutsideSave", "scripts/Scenario.ts");

  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.type("\n// my save\n");
  await page.waitForTimeout(400);
  const diskText = original + "\n// from outside\n";
  await seed(page, "OutsideSave", { "scripts/Scenario.ts": diskText });

  // Ctrl+S is Monaco's own command, wired to the same save the button uses.
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  check("saving over an outside change asks", (await dialogTitle(page).innerText()) === "Replace the changed file?");
  await dialogButton(page, "Cancel").click();
  await page.waitForTimeout(500);
  check("cancel leaves the disk untouched", (await readDisk(page, "OutsideSave", "scripts/Scenario.ts")) === diskText);
  check("and the buffer stays dirty", (await page.locator(".dot.unsaved").count()) > 0);

  // Confirming replaces — with a say, never silently.
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  check("it asks again while the file is still changed outside", (await page.locator(".dlg").count()) === 1);
  await dialogButton(page, "Replace").click();
  await page.waitForTimeout(800);
  const saved = await readDisk(page, "OutsideSave", "scripts/Scenario.ts");
  check("confirming writes my buffer", saved.includes("// my save") && !saved.includes("// from outside"), saved.slice(-120));
  check("the mark is cleared", (await page.locator(".dot.unsaved").count()) === 0);
  check("no native dialogs were used", page.nativeDialogs === 0);
  check("no page errors", noErrors(page), page.logs.join(" | "));
});

// C4 review R4: two rapid saves of one dirty script must coalesce. The second
// press lands inside the first save's write→stamp window (held there by the
// seam), where an unguarded save sees the editor's own just-written file as an
// outside change and asks to replace it — and two unguarded reloads revoke each
// other's Blob URLs mid-import. One save, one reload, newest code registered.
scenario("a double save coalesces: one reload, no spurious import error, no self-overwrite ask (C4 review R4)", async () => {
  const page = await newPage("DoubleSave", { probe: true });
  await seed(page, "DoubleSave", {
    "scenario.meta.json": JSON.stringify({ id: "double-save", name: "DoubleSave", version: 1 }),
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "scripts/components/Rotator.ts": ROTATOR,
    "assets/scenes/main.scene.json": sceneWith("Seeded"),
  });
  await page.getByText("Open folder…").click();
  await page.locator(".work").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => window.__wetsProbe.scriptClass("Rotator") !== null, null, { timeout: 30000 });
  const token = await page.evaluate(() => window.__wetsProbe.scriptClass("Rotator").token);

  await page.locator(".proj .folders .folder", { hasText: "scripts" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .folders .folder", { hasText: "components" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".proj .asset", { hasText: "Rotator.ts" }).first().dblclick();
  await page.locator(".monaco-editor").waitFor({ timeout: 20000 });

  // Pasted, not typed: Monaco's auto-closing brackets rewrite a typed source.
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(text => navigator.clipboard.writeText(text), ROTATOR.replace("public speed = 1;", "public speed = 5;"));
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(700);
  check("the buffer is dirty before the double save", (await page.locator(".dot.unsaved").count()) > 0);

  // Hold the first save between its write and its stamp read, then press save
  // again inside that window — the race, made deterministic.
  await holdStampRead(page, "Rotator.ts");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.__stampReadHeld === true, null, { timeout: 15000 });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);
  const asks = await page.locator(".dlg").count();
  check("the second save does not ask to replace the editor's own write",
    asks === 0, asks ? await dialogTitle(page).innerText() : "");
  // Unfixed: the ask is up; answer it so the rest of the race plays out and is
  // recorded too. Fixed: nothing to answer.
  if (asks) await dialogButton(page, "Replace").click();
  // G2: a focus event inside the same window must stand down too — the focus
  // check would read the save's own write as an outside change and ask.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(300);
  check("a focus check mid-save does not ask either", (await page.locator(".dlg").count()) === 0);
  await page.evaluate(() => window.__releaseStampRead());
  const swapped = await page.waitForFunction(old => window.__wetsProbe.scriptClass("Rotator")?.token !== old, token, { timeout: 30000 })
    .then(() => true, () => false);
  check("the class is swapped to the newest code", swapped);
  await page.waitForTimeout(1500);
  check("the mark is cleared", (await page.locator(".dot.unsaved").count()) === 0);
  check("the disk holds the newest code",
    (await readDisk(page, "DoubleSave", "scripts/components/Rotator.ts")).includes("public speed = 5;"));

  // A fresh object of the class sees the new default — what is registered is
  // the newest class, not a stale or half-imported module. The shortcut guard
  // stands down inside a TEXTAREA, and Monaco's is one — blur it explicitly so
  // the canvas click's focus is what the keydown sees.
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Alt+Shift+N");
  await page.locator("app-hierarchy li", { hasText: "GameObject" }).last().waitFor({ timeout: 10000 });
  await page.locator("app-hierarchy li", { hasText: "GameObject" }).last().click();
  await page.waitForTimeout(300);
  await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".add-list li", { hasText: "Rotator" }).first().click();
  await page.waitForTimeout(600);
  const added = await page.locator(".insp-body .field input").evaluateAll(els => els.map(e => e.value));
  check("a new object gets the newest default", added.includes("5"), JSON.stringify(added));

  // The runtime's load summary is an info row; identical repeats collapse into
  // a ×n counter, so count the counter too. Open loaded once; the double save
  // must add exactly one more, with no import-failure note.
  await page.locator(".pane-tab", { hasText: "Console" }).first().click();
  await page.waitForTimeout(400);
  // The swap advisory is the engine's own note about the intended replacement
  // (the same one the other reload scenarios filter); an import failure is not.
  const swapError = "[TypeRegistry] Type name \"Rotator\" is already registered to a different class";
  const errRows = (await page.locator(".cons-list .log.error").allInnerTexts()).filter(t => !t.includes(swapError));
  check("no Console error row", errRows.length === 0, errRows.join(" | "));
  const loads = await page.evaluate(() => [...document.querySelectorAll(".cons-list .log.info")]
    .filter(e => (e.querySelector(".msg")?.textContent ?? "").includes("module(s) loaded"))
    .map(e => ({ text: e.querySelector(".msg").textContent, n: Number((e.querySelector(".rep")?.textContent ?? "×1").slice(1)) })));
  const reloads = loads.reduce((n, l) => n + l.n, 0);
  check("one reload for the double save (the open's plus one)", reloads === 2, JSON.stringify(loads));
  check("no spurious import-failure note", loads.every(l => l.text.includes("notes: none")), JSON.stringify(loads));
  check("nothing but the swap advisory in the console",
    page.logs.filter(l => !l.includes("404") && !l.includes(swapError)).length === 0,
    page.logs.join(" | "));
  check("no native dialogs were used", page.nativeDialogs === 0);
  await shot(page, "e2e-double-save");
});

// C4r2: a script read that fails is only silent when the file is gone. The
// whole project cleared under the editor is the supported case; any other
// failure is a problem the author must see in the Console.
scenario("a script file that vanished mid-reload is skipped silently", async () => {
  const page = await newPage("OutsideVanish");
  await seed(page, "OutsideVanish", {
    "scenario.meta.json": JSON.stringify({ id: "outside-vanish", name: "OutsideVanish", version: 1 }),
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "assets/scenes/main.scene.json": sceneWith("Seeded"),
  });
  await page.getByText("Open folder…").click();
  await page.locator(".work").waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);

  // Listed, then gone before the read: the file disappears under the reload.
  const get = await page.evaluateHandle(() => FileSystemFileHandle.prototype.getFile);
  await page.evaluate(orig => {
    FileSystemFileHandle.prototype.getFile = function (...args) {
      if (this.name === "Scenario.ts") throw new DOMException("gone", "NotFoundError");
      return orig.apply(this, args);
    };
  }, get);
  // A real outside change to another script drives the focus reload; the
  // vanished one must not cost a Console row or break the reload.
  await seed(page, "OutsideVanish", { "scripts/Other.ts": "export const other = 1;\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(1500);
  await page.evaluate(orig => { FileSystemFileHandle.prototype.getFile = orig; }, get);

  await page.locator(".pane-tab", { hasText: "Console" }).first().click();
  await page.waitForTimeout(400);
  const consoleText = await page.locator(".cons-list").innerText();
  check("no read error reached the Console", !consoleText.includes("Scenario.ts"), consoleText.slice(0, 240));
  check("the editor is still usable", await page.locator(".work").isVisible());
  await page.locator("canvas[data-engine]").first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Alt+Shift+N");
  await page.waitForTimeout(600);
  check("an object can still be created", (await page.locator("app-hierarchy li", { hasText: "GameObject" }).count()) > 0);
  check("no native dialogs were used", page.nativeDialogs === 0);
  check("no page errors", noErrors(page), page.logs.join(" | "));
});

scenario("a script read failure other than a vanished file reaches the Console", async () => {
  const page = await newPage("OutsideReadFail");
  await seed(page, "OutsideReadFail", {
    "scenario.meta.json": JSON.stringify({ id: "outside-readfail", name: "OutsideReadFail", version: 1 }),
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "assets/scenes/main.scene.json": sceneWith("Seeded"),
  });
  await page.getByText("Open folder…").click();
  await page.locator(".work").waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);

  await failReads(page, "Scenario.ts");
  await seed(page, "OutsideReadFail", { "scripts/Other.ts": "export const other = 1;\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(1500);

  await page.locator(".pane-tab", { hasText: "Console" }).first().click();
  await page.waitForTimeout(400);
  const consoleText = await page.locator(".cons-list").innerText();
  check("the failure reached the Console as an error",
    (await page.locator(".log.error .msg", { hasText: "Scenario.ts" }).count()) > 0, consoleText.slice(0, 240));
  check("the row names the read, not a compile", consoleText.includes("could not be read"), consoleText.slice(0, 240));
  check("the row is a jump to the file", (await page.locator(".log .src.jump").count()) > 0);
  check("no page errors", noErrors(page), page.logs.join(" | "));
  check("no native dialogs were used", page.nativeDialogs === 0);
});

// C4r1: the engine the page runs is the installed tarball's — not a committed
// copy that release:local never refreshes. BuildInfo.builtAt is stamped into
// the dist at engine build time, so equality with node_modules' copy proves
// the identity of what actually executes.
scenario("the running engine is the installed tarball (BuildInfo)", async () => {
  const dist = readFileSync(resolve(HERE, "../node_modules/webenginets/dist/WebEngineTS.esm.js"), "utf8");
  const builtAt = dist.match(/_BUILT_AT = "([^"]+)"/)?.[1];
  const version = dist.match(/const _VERSION = "([^"]+)"/)?.[1];
  check("the installed engine is a stamped build", !!builtAt && !!version, `builtAt=${builtAt} version=${version}`);

  const page = await newPage("BuildIdentity");
  await openEmptyProject(page);
  const running = await page.evaluate(() => {
    const b = globalThis.__wetsEngine?.BuildInfo;
    return b ? { builtAt: b.builtAt, version: b.version, isBuild: b.isBuild } : null;
  });
  check("the page publishes its engine's BuildInfo", running !== null);
  check("the running builtAt is the installed package's", running?.builtAt === builtAt, `${running?.builtAt} vs ${builtAt}`);
  check("the running version is the installed package's", running?.version === version, `${running?.version} vs ${version}`);
  check("the running engine is a build, not sources", running?.isBuild === true);
  check("no page errors", noErrors(page), page.logs.join(" | "));
});

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
    // DW-1.3 strengthened (B1r): the exact D-3 kind/args and collider type per
    // primitive, not "some string kind and some collider".
    const ARGS = { Cube: [1], Sphere: [0.5, 32], Capsule: [0.5, 2, 32], Cylinder: [0.5, 2, 32], Plane: [10, 10, 1, 1], Quad: [1, 1] };
    const COLLIDER = { Cube: "BoxCollider", Sphere: "SphereCollider", Capsule: "CapsuleCollider", Cylinder: "CapsuleCollider" };
    for (const kind of KINDS.slice(0, 4)) {
        const root = saved.roots.find(r => r.name === kind);
        const mesh = root.components.find(c => c.type === "MeshFilter");
        const mat = root.components.find(c => c.type === "MeshRenderer");
        check(`${kind}: a PrimitiveMesh with its kind`, mesh?.fields.sharedMesh?.$type === "PrimitiveMesh" && typeof mesh.fields.sharedMesh.kind === "string", JSON.stringify(mesh?.fields.sharedMesh));
        check(`${kind}: an inlined material`, typeof mat?.fields.sharedMaterial === "object", JSON.stringify(mat?.fields.sharedMaterial));
        check(`${kind}: Unity's collider`, root.components.some(c => /Collider/.test(c.type)), root.components.map(c => c.type).join(", "));
        check(`${kind}: the D-3 mesh kind and args`, mesh?.fields.sharedMesh?.kind === kind && JSON.stringify(mesh.fields.sharedMesh.args) === JSON.stringify(ARGS[kind]), JSON.stringify(mesh?.fields.sharedMesh));
        check(`${kind}: Unity's exact collider type`, root.components.filter(c => /Collider/.test(c.type)).map(c => c.type).join() === COLLIDER[kind], root.components.map(c => c.type).join(", "));
    }
    for (const kind of KINDS.slice(4)) {
        const root = saved.roots.find(r => r.name === kind);
        const mesh = root.components.find(c => c.type === "MeshFilter");
        const mat = root.components.find(c => c.type === "MeshRenderer");
        check(`${kind}: no collider (Unity's MeshCollider is a recorded deviation)`, !root.components.some(c => /Collider/.test(c.type)), root.components.map(c => c.type).join(", "));
        check(`${kind}: the D-3 mesh kind and args`, mesh?.fields.sharedMesh?.kind === kind && JSON.stringify(mesh.fields.sharedMesh.args) === JSON.stringify(ARGS[kind]), JSON.stringify(mesh?.fields.sharedMesh));
        check(`${kind}: an inlined material`, typeof mat?.fields.sharedMaterial === "object", JSON.stringify(mat?.fields.sharedMaterial));
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
    // The copy lands on the next autosave tick plus its write; under load that
    // can take longer than a fixed sleep. Poll, then assert the same thing.
    let copyAgain = null;
    for (let i = 0; i < 50 && copyAgain === null; i++) {
        await page.waitForTimeout(300);
        copyAgain = await autosave();
    }
    check("a copy exists again", copyAgain !== null);
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
    await page.locator(".dlg-btn.primary").click();
    // The refusal is asynchronous (it stats the picked folder), and late in a
    // full run — every earlier scenario's page is still open — that lands well
    // after the fixed 300 ms this used to wait. Wait for the error instead.
    for (let i = 0; i < 50; i++) {
        if ((await page.locator(".wiz-error").count()) > 0) break;
        await page.waitForTimeout(100);
    }
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

    // DW-4.2: the exported project carries a library behaviour too, so the
    // ScenarioCreator build check compiles scripts/library/ as well. Attach to
    // the existing Camera — no new object, the two-object scene stays two.
    await page.locator("app-hierarchy li", { hasText: "Camera" }).first().click();
    await page.waitForTimeout(300);
    await addFromLibrary(page, "Rotator");
    check("the wizard project holds the library source",
        (await readDisk(page, "WizParent", "Atom/scripts/library/Rotator.ts")) !== null);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(800);
    const withLibrary = JSON.parse(await readDisk(page, "WizParent", "Atom/assets/scenes/main.scene.json"));
    check("the saved wizard scene keeps two objects, one with Rotator",
        withLibrary.roots.length === 2 && withLibrary.roots.some(r => r.components.some(c => c.type === "Rotator")),
        JSON.stringify(withLibrary.roots.map(r => [r.name, r.components.map(c => c.type)])));

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

// C4: opening a project runs its script load and then resets the scene to load
// the saved one. The workspace must not appear — and its shortcuts must not be
// live — until that is done, or an edit made in the gap is wiped by the reset.
// The entry script's read is held so the gap is wide and deterministic.
scenario("an open settles its scene before the workspace accepts edits (C4)", async () => {
    const page = await newPage("SettleDemo");
    await holdScriptRead(page);
    await page.getByText("Open folder…").click();
    await dialogButton(page, "Set up").click();
    for (let i = 0; i < 50 && !(await page.evaluate(() => window.__scriptReadHeld === true)); i++) await page.waitForTimeout(100);
    check("the open reaches its script load", await page.evaluate(() => window.__scriptReadHeld === true));
    check("while it settles, no workspace is shown", (await page.locator(".work").count()) === 0);
    await page.keyboard.press("Alt+Shift+N");
    await page.evaluate(() => window.__releaseScriptRead?.());
    await page.locator(".work").waitFor();
    await page.waitForTimeout(400);
    check("the workspace opens clean", (await page.locator("app-hierarchy").innerText()).includes("Default Scene"));
    check("no edit was lost to the settle", (await page.locator(".statusbar .accent").first().innerText()) === "Saved");
    check("no phantom object from the gap", (await page.locator("app-hierarchy").innerText()).match(/GameObject/g) === null);
    // Now that it is open, the shortcut works.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(300);
    check("once open, the shortcut creates", (await page.locator("app-hierarchy").innerText()).includes("GameObject"));
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// C4 review R4-G3: the settle guard must hold for a project SWITCH too, not
// only for an open from the start screen. On 2400f86 status never leaves
// 'open' during _enter, so the workspace, its menus and its shortcuts stay
// live through the new project's script load — an Alt+Shift+N in that gap
// creates an object the scene reset then wipes, and Open Project is still
// clickable mid-settle. Failing-first by construction: with the workspace
// still mounted, the ".work"/menubar checks below see it, and the keypress
// leaves a GameObject in the hierarchy that the fixed code never creates.
// The entry script's read is held (armed AFTER the first project is open, so
// the hold catches the switch's load, not the first open's).
scenario("a project switch settles before the workspace accepts edits (C4 review R4-G3)", async () => {
    const page = await newPage("SwitchFrom");
    // The first project carries a script the second does not: its outside-edit
    // stamp must not survive the switch, or the next focus check reads the old
    // project's file as "deleted outside" and reloads for nothing.
    await seed(page, "SwitchFrom", {
        "scenario.meta.json": JSON.stringify({ id: "switch-from", name: "SwitchFrom", version: 1 }),
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        "scripts/components/Extra.ts": "export {};\n",
        "assets/scenes/main.scene.json": sceneWith("FromAnchor"),
    });
    await seed(page, "SwitchTo", {
        "scenario.meta.json": JSON.stringify({ id: "switch-to", name: "SwitchTo", version: 1 }),
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        "assets/scenes/main.scene.json": sceneWith("ToAnchor"),
    });
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor({ timeout: 30000 });
    for (let i = 0; i < 50 && !(await page.locator("app-hierarchy").innerText()).includes("FromAnchor"); i++) await page.waitForTimeout(100);
    check("the first project is open and settled", (await page.locator("app-hierarchy").innerText()).includes("FromAnchor"));

    // Switch through the menu, the way an author does. The second project's
    // entry-script read is held, so the settle gap is wide and deterministic.
    await holdScriptRead(page);
    await pick(page, "SwitchTo");
    await menu(page, "File", "Open Project");
    for (let i = 0; i < 50 && !(await page.evaluate(() => window.__scriptReadHeld === true)); i++) await page.waitForTimeout(100);
    check("the switch reaches its script load", await page.evaluate(() => window.__scriptReadHeld === true));
    await page.waitForTimeout(250);
    check("while the switch settles, no workspace is shown", (await page.locator(".work").count()) === 0);
    check("and no menu offers Open Project mid-settle", (await page.locator(".menubar-item").count()) === 0);
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(300);
    check("the create shortcut is inert in the gap",
        (await page.locator("app-hierarchy li", { hasText: "GameObject" }).count()) === 0);
    await page.evaluate(() => window.__releaseScriptRead?.());
    await page.locator(".work").waitFor({ timeout: 30000 });
    for (let i = 0; i < 50 && !(await page.locator("app-hierarchy").innerText()).includes("ToAnchor"); i++) await page.waitForTimeout(100);
    check("the second project opens clean", (await page.locator("app-hierarchy").innerText()).includes("ToAnchor"));
    check("the project tag names the new project", (await page.locator(".project-tag").innerText()).includes("SwitchTo"));
    check("no phantom object from the gap", (await page.locator("app-hierarchy").innerText()).match(/GameObject/g) === null);
    check("no edit was lost to the settle", (await page.locator(".statusbar .accent").first().innerText()) === "Saved");

    // The previous project's stamps are gone: a focus check finds nothing
    // changed and nothing deleted, so it must not reload. Two loads in the
    // Console — the first open's and the switch's — and no third.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(800);
    await page.locator(".pane-tab", { hasText: "Console" }).first().click();
    await page.waitForTimeout(400);
    const loads = await page.evaluate(() => [...document.querySelectorAll(".cons-list .log.info")]
        .filter(e => (e.querySelector(".msg")?.textContent ?? "").includes("module(s) loaded"))
        .map(e => ({ text: e.querySelector(".msg").textContent, n: Number((e.querySelector(".rep")?.textContent ?? "×1").slice(1)) })));
    const reloads = loads.reduce((n, l) => n + l.n, 0);
    check("a focus check after the switch does not reload the old project's scripts", reloads === 2, JSON.stringify(loads));
    check("no Console error row", (await page.locator(".cons-list .log.error").count()) === 0);

    // Now that it is open, the shortcut works — and what it creates stays:
    // nothing after the settle resets the scene again.
    await page.locator("canvas").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Alt+Shift+N");
    await page.waitForTimeout(400);
    check("once open, the shortcut creates and the object stays",
        (await page.locator("app-hierarchy").innerText()).includes("GameObject"));
    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", noErrors(page), page.logs.join(" | "));
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

    // ── B1r2: a single object's Scale handle seats on its own axes in Global ──
    // The scenario ends in Centre mode; Centre also moves the position on a
    // scale drag, so go back to Pivot first.
    await page.locator(".vp-subtoolbar .chip", { hasText: "Center" }).click();
    await page.waitForTimeout(250);
    await create("Cube");
    await rename("Seat");
    await page.locator(".insp-body .field").nth(1).locator("input").nth(1).fill("45");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    // An unrotated twin at the same spot: its scale X is world X whatever the
    // fix, so it is the reference direction. Both readings go through the
    // uppercase (handle) path from the same origin, so pre-fix the two client
    // directions coincide exactly.
    await create("Cube");
    await rename("Ref");
    await page.keyboard.press("r");
    await page.waitForTimeout(300);
    const normDir = (a, b) => {
        if (!a || !b) return null;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        return len > 1e-6 ? { x: dx / len, y: dy / len } : null;
    };
    const axisDir = () => page.evaluate(() => {
        const p = window.__wetsProbe;
        return [p.handlePoint("X", 0), p.handlePoint("X", 1)];
    });
    const refDir = normDir(...(await axisDir()));
    await page.locator("app-hierarchy li", { hasText: "Seat" }).first().click();
    // The re-seat happens in the frame loop after the selection revision moves;
    // under load a fixed sleep can read the proxy before it is re-seated on Seat.
    let seatDir = null;
    for (let i = 0; i < 120 && (!seatDir || !refDir || seatDir.x * refDir.x + seatDir.y * refDir.y >= 0.985); i++) {
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        seatDir = normDir(...(await axisDir()));
    }
    const seatDot = seatDir && refDir ? seatDir.x * refDir.x + seatDir.y * refDir.y : null;
    check("the Scale handle's X axis follows the cube's own rotation, not world X",
        seatDot !== null && seatDot < 0.985, JSON.stringify({ seatDir, refDir }));
    // Drag along the handle's own client direction. The write-back is a
    // per-component ratio in either space, so the scale VALUES alone cannot tell
    // pre-fix from post-fix; the seat orientation (seatDot above) is the
    // discriminator, and it is required here too. Pre-fix seatDot ≈ 1 → fails.
    const dragDir = seatDir;
    const seatBefore = await tf("Seat");
    const scaleHandle = await findHandle("scale", "X");
    if (scaleHandle && dragDir) {
        await drag(scaleHandle, dragDir.x * 60, dragDir.y * 60);
    }
    const seatAfter = await tf("Seat");
    const d = seatAfter.localScale, b = seatBefore.localScale;
    check("a scale drag along the seated axis changes only localScale.x and leaves the pose alone",
        seatDot !== null && seatDot < 0.985 && !!scaleHandle && !!dragDir
        && Math.abs(d.x - b.x) > 1e-3 && near(d.y, b.y, 1e-3) && near(d.z, b.z, 1e-3)
        && near(seatAfter.localPosition.x, seatBefore.localPosition.x, 1e-3)
        && near(seatAfter.localPosition.y, seatBefore.localPosition.y, 1e-3)
        && near(seatAfter.localPosition.z, seatBefore.localPosition.z, 1e-3)
        && near(seatAfter.localRotation.x, seatBefore.localRotation.x, 1e-3)
        && near(seatAfter.localRotation.y, seatBefore.localRotation.y, 1e-3)
        && near(seatAfter.localRotation.z, seatBefore.localRotation.z, 1e-3)
        && near(seatAfter.localRotation.w, seatBefore.localRotation.w, 1e-3),
        JSON.stringify({ scaleHandle, dragDir, before: b, after: d }));

    // ── B1r5 #1: the Y (combined) tool's Global scale is uniform ──
    // Unity's Transform tool offers only the uniform handle in Global
    // (TransformHandle.cs, s_Default's scale = Handle.XYZ). Three still draws
    // per-axis boxes on the identity-seated proxy, so a box drag must apply
    // ONE ratio to all three local axes. Pre-fix only localScale.x changed —
    // the equal-ratio check below fails on the old code.
    // The entry state is already Pivot/Global (the B1r2 tail restored Pivot),
    // and #1's ratios are pivot-independent, so no chip is touched here.
    await page.locator("app-hierarchy li", { hasText: "Seat" }).first().click();
    await page.keyboard.press("y");
    await page.waitForTimeout(300);
    // The drag must land on a point ONLY the scale set claims: claimPointer
    // hands the press to the first of translate→rotate→scale that hits, so a
    // point shared with translate would drag-translate instead. Pre-fix no
    // exclusive scale point exists at all — three's scale pickers are
    // translate's cones verbatim (TransformControls.js:1383-1408 vs
    // :1263-1288) and the XYZ box sits inside rotate's XYZE sphere (:1337) —
    // so the reachability check is red before the combined-set size fix.
    // Post-fix the enlarged cones reach past translate's picker extent and
    // rotate's E ring; the scan radius covers that outer band.
    const hoverScaleAxis = async (want, radius = 260) => {
        const hub = await tip("X", 0);
        for (let dx = -radius; dx <= radius; dx += 20) {
            for (let dy = -radius; dy <= radius; dy += 20) {
                await page.mouse.move(hub.x + dx, hub.y + dy);
                const all = await page.evaluate(() => window.__wetsProbe.hoverAll());
                if (all.scale === want && !all.translate && !all.rotate) return { x: hub.x + dx, y: hub.y + dy };
            }
        }
        return null;
    };
    let uniHandle = await hoverScaleAxis("X");
    if (!uniHandle) uniHandle = await hoverScaleAxis("XYZ");
    if (!uniHandle) uniHandle = await hoverScaleAxis("Y");
    if (!uniHandle) uniHandle = await hoverScaleAxis("Z");
    check("the combined tool's Global scale box is reachable", !!uniHandle,
        JSON.stringify(await page.evaluate(() => window.__wetsProbe.hoverAll())));
    const uniBefore = await tf("Seat");
    if (uniHandle) await drag(uniHandle, 60, 0);
    const uniAfter = await tf("Seat");
    const ub = uniBefore.localScale, ua = uniAfter.localScale;
    const rx = ua.x / ub.x, ry = ua.y / ub.y, rz = ua.z / ub.z;
    check("a combined Global scale drag is uniform: x, y and z share one ratio",
        !!uniHandle && Math.abs(rx - 1) > 1e-3
        && near(rx, ry, 1e-3) && near(rx, rz, 1e-3),
        JSON.stringify({ before: ub, after: ua, ratios: [rx, ry, rz] }));

    // ── B1r5 #2: a Centre scale carries the offset through the seated axes ──
    // Parent turned 45° about Y, child at local (3,0,0); select the parent,
    // R + Center + Global, scale X by k. Unity (TransformManipulator.cs,
    // TransformData.SetScaleDelta): pivot + R·((R⁻¹·(pos−pivot)) ⊙ ratio) —
    // for a parent at the origin the child sits at (2.12,0,−2.12), C is the
    // midpoint (1.06,0,−1.06), and k=2 puts the parent at (−1.06,0,1.06),
    // not along world X alone. Pre-fix the z component stays put and the
    // formula check fails.
    await create("Cube");
    await rename("Arm");
    await page.locator(".insp-body .field").nth(1).locator("input").nth(1).fill("45");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    // The child must be a REAL child (the menu-bar create makes roots): the
    // object's context menu places it at Arm's local zero, then it is renamed
    // so tf() cannot hit the duplicate "Cube" roots from the earlier drags.
    await page.locator("app-hierarchy li", { hasText: "Arm" }).first().click({ button: "right" });
    await page.waitForTimeout(200);
    await page.locator(".ctx-item", { hasText: "3D Object" }).first().hover();
    await page.waitForTimeout(200);
    await page.locator(".ctx-item", { hasText: "Cube" }).last().click();
    await page.waitForTimeout(300);
    await rename("ArmKid");
    await page.locator(".insp-body .field").nth(0).locator("input").nth(0).fill("3");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.locator("app-hierarchy li", { hasText: "Arm" }).first().click();
    await page.keyboard.press("r");
    // The chip shows the CURRENT mode: in Pivot it reads "Pivot", and clicking
    // it toggles to Center (workspace.component.ts:84-91).
    await page.locator(".vp-subtoolbar .chip", { hasText: "Pivot" }).click();
    await page.waitForTimeout(300);
    const armT = await tf("Arm");
    const kidT = await tf("ArmKid");
    check("the child sits at local (3,0,0) under the turned parent",
        near(kidT.localPosition.x, 3, 1e-3) && near(kidT.localPosition.y, 0, 1e-3) && near(kidT.localPosition.z, 0, 1e-3),
        JSON.stringify(kidT.localPosition));
    // The Centre pivot C: midpoint of the two world origins. Both cubes are
    // unit-sized and centred on their origins, so their bounds centres are
    // the origins — the mirror cannot shift a symmetric box's centre.
    const C = {
        x: (armT.position.x + kidT.position.x) / 2,
        y: (armT.position.y + kidT.position.y) / 2,
        z: (armT.position.z + kidT.position.z) / 2,
    };
    const rotQ = (v, q) => {
        const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
        return {
            x: v.x + q.w * tx + q.y * tz - q.z * ty,
            y: v.y + q.w * ty + q.z * tx - q.x * tz,
            z: v.z + q.w * tz + q.x * ty - q.y * tx,
        };
    };
    const centreHandle = await findHandle("scale", "X");
    check("the seated Centre scale handle is reachable", !!centreHandle, await hover());
    const armBefore = await tf("Arm");
    if (centreHandle) await drag(centreHandle, 60, 0);
    const armAfter = await tf("Arm");
    const k = armAfter.localScale.x / armBefore.localScale.x;
    check("the Centre scale drag actually scaled", Math.abs(k - 1) > 0.05, String(k));
    const R = armBefore.rotation;
    const inv = { x: -R.x, y: -R.y, z: -R.z, w: R.w };
    const off = { x: armBefore.position.x - C.x, y: armBefore.position.y - C.y, z: armBefore.position.z - C.z };
    const inSeat = rotQ(off, inv);
    const scaledOff = rotQ({ x: inSeat.x * k, y: inSeat.y, z: inSeat.z }, R);
    const want = { x: C.x + scaledOff.x, y: C.y + scaledOff.y, z: C.z + scaledOff.z };
    const got = armAfter.position;
    check("the parent lands at C + R·((R⁻¹(p−C)) ⊙ ratio), not on a world axis",
        !!centreHandle && Math.abs(k - 1) > 0.05
        && near(got.x, want.x, 1e-3) && near(got.y, want.y, 1e-3) && near(got.z, want.z, 1e-3),
        JSON.stringify({ k, want, got }));

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
    // The checkbox keeps focus, and the shortcut guard stands down inside
    // inputs — click away first or Ctrl+S is a no-op and this save never lands.
    await page.locator(".pane-tab").first().click();
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
    // The Point Light and its range edit came after the last save: leave the
    // scene dirty and a slow run's autosave writes a copy, whose recovery
    // dialog then blocks every click after the reopen. Save it away first —
    // clicking the pane tab because the master checkbox still has focus and
    // the shortcut guard stands down inside inputs.
    await page.locator(".pane-tab").first().click();
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(500);
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

// B1r — DW-1.2: creation from the Hierarchy "+" and an object's context menu.
scenario("create placement: Hierarchy + makes a root at the pivot, the context menu a child at local zero (B1r DW-1.2)", async () => {
    const page = await newPage("CreateDemo", { probe: true });
    await openEmptyProject(page);

    const tf = (name) => page.evaluate(n => window.__wetsProbe.transformOf(n), name);
    const pivot = () => page.evaluate(() => window.__wetsProbe.pivot());
    const near3 = (v, e, tol = 1e-2) => Math.abs(v.x - e.x) < tol && Math.abs(v.y - e.y) < tol && Math.abs(v.z - e.z) < tol;
    const row = (name) => page.locator("app-hierarchy li", { hasText: name }).first();
    /** Inline rename (F2) of the selected row; avoids duplicate-name shadowing. */
    const rename = async (name) => {
        await page.keyboard.press("F2");
        const input = page.locator("app-hierarchy input.rename-input");
        await input.fill(name);
        await input.press("Enter");
        await page.waitForTimeout(300);
    };
    /** The Hierarchy "+" opens the shared create menu; it always makes a ROOT. */
    const createFromPlus = async (item, sub) => {
        await page.locator("app-hierarchy .create-btn").click();
        await page.waitForTimeout(200);
        if (sub) {
            await page.locator(".ctx-item", { hasText: sub }).first().hover();
            await page.waitForTimeout(200);
        }
        await page.locator(".ctx-item", { hasText: item }).last().click();
        await page.waitForTimeout(300);
    };

    // ── Hierarchy "+" ──
    const origin = await pivot();
    await createFromPlus("Create Empty");
    await rename("PlusRoot");
    const plusT = await tf("PlusRoot");
    check("Hierarchy + Create Empty lands at the pivot", near3(plusT.localPosition, origin), JSON.stringify(plusT.localPosition));
    check("and is a root row (padding-left 22px)", (await row("PlusRoot").evaluate(el => el.style.paddingLeft)) === "22px", await row("PlusRoot").evaluate(el => el.style.paddingLeft));
    check("and is selected", (await page.evaluate(() => window.__wetsProbe.selection())).join() === "PlusRoot", JSON.stringify(await page.evaluate(() => window.__wetsProbe.selection())));

    // A parent away from the origin, turned and scaled: the child must still be
    // at LOCAL zero with identity rotation and unit scale (Unity SetParentAndAlign).
    await page.locator(".menubar-item", { hasText: "GameObject" }).click();
    await page.locator(".ctx-item", { hasText: "3D Object" }).first().hover();
    await page.waitForTimeout(200);
    await page.locator(".ctx-item", { hasText: "Cube" }).last().click();
    await page.waitForTimeout(300);
    await rename("Holder");
    const fillField = async (field, axis, value) => {
        await page.locator(".insp-body .field").nth(field).locator("input").nth(axis).fill(String(value));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(200);
    };
    await fillField(0, 0, 3); await fillField(0, 1, 1); await fillField(0, 2, 2);
    await fillField(1, 1, 45);
    await fillField(2, 0, 2); await fillField(2, 1, 2); await fillField(2, 2, 2);
    const holder = await tf("Holder");
    check("the parent is at (3,1,2), 45 deg about Y, scaled 2", near3(holder.position, { x: 3, y: 1, z: 2 }) && near3(holder.localScale, { x: 2, y: 2, z: 2 }), JSON.stringify(holder));

    // ── The object's context menu ──
    await row("Holder").click({ button: "right" });
    await page.waitForTimeout(200);
    await page.locator(".ctx-item", { hasText: "Create Empty" }).last().click();
    await page.waitForTimeout(300);
    await rename("Kid");
    const kid = await tf("Kid");
    check("context-menu Create Empty is a child at local zero", near3(kid.localPosition, { x: 0, y: 0, z: 0 }), JSON.stringify(kid.localPosition));
    check("the child keeps the parent's world position", near3(kid.position, holder.position), JSON.stringify(kid.position));
    check("the child has identity local rotation", near3(kid.localRotation, { x: 0, y: 0, z: 0 }, 1e-3) && Math.abs(kid.localRotation.w - 1) < 1e-3, JSON.stringify(kid.localRotation));
    check("the child has unit local scale", near3(kid.localScale, { x: 1, y: 1, z: 1 }), JSON.stringify(kid.localScale));
    check("the child row sits one level deeper (padding-left 36px)", (await row("Kid").evaluate(el => el.style.paddingLeft)) === "36px", await row("Kid").evaluate(el => el.style.paddingLeft));

    // A 3D Object from the same context menu gets the same alignment.
    await row("Holder").click({ button: "right" });
    await page.waitForTimeout(200);
    await page.locator(".ctx-item", { hasText: "3D Object" }).first().hover();
    await page.waitForTimeout(200);
    await page.locator(".ctx-item", { hasText: "Sphere" }).last().click();
    await page.waitForTimeout(300);
    const sphere = await tf("Sphere");
    check("context-menu 3D Object is a child at local zero too", near3(sphere.localPosition, { x: 0, y: 0, z: 0 }) && near3(sphere.localScale, { x: 1, y: 1, z: 1 }), JSON.stringify(sphere.localPosition));

    // With a child selected, "+" still makes a ROOT, never a sibling/child.
    await row("Kid").click();
    await page.waitForTimeout(200);
    await createFromPlus("Create Empty");
    await rename("PlusRoot2");
    const plus2 = await tf("PlusRoot2");
    check("with a child selected, + still creates a root at the pivot", near3(plus2.localPosition, origin), JSON.stringify(plus2.localPosition));
    check("and that root is not indented", (await row("PlusRoot2").evaluate(el => el.style.paddingLeft)) === "22px", await row("PlusRoot2").evaluate(el => el.style.paddingLeft));

    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1r4 — the eight review proofs: gizmo centre/axes, right objects, icons.
scenario("component gizmos: the review proofs (B1r4)", async () => {
    const page = await newPage("GizmoProof", { probe: true });

    // Seeded through the scene file: exact poses, collider fields and one
    // inactive parent without clicking through the Inspector for each.
    const H = Math.SQRT1_2; // cos/sin 45 deg
    const go = (name, extra) => ({
        name, active: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [], children: [], ...extra,
    });
    const at = (x, y, z) => ({ x, y, z });
    const scene = {
        name: "Seeded", version: 1,
        roots: [
            go("PL", { transform: { position: at(5, 2, -3), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(1, 1, 1) }, components: [{ type: "PointLight", fields: { range: 10 } }] }),
            // minDistance 0 keeps exactly ONE circle (the max one); 500 is the default max.
            go("Audio", { transform: { position: at(-4, 1, 6), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(1, 1, 1) }, components: [{ type: "AudioSource", fields: { minDistance: 0, maxDistance: 500 } }] }),
            go("Cap", { transform: { position: at(0, 3, 0), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(1, 1, 1) }, components: [{ type: "CapsuleCollider", fields: {} }] }),
            go("Cap2", { transform: { position: at(0, 3, 0), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(2, 2, 2) }, components: [{ type: "CapsuleCollider", fields: {} }] }),
            go("Spot", { transform: { position: at(2, 4, 1), rotation: { x: H, y: 0, z: 0, w: H }, scale: at(1, 1, 1) }, components: [{ type: "SpotLight", fields: { range: 10, spotAngle: 60 } }] }),
            go("BoxRot", { transform: { position: at(1, 0, 0), rotation: { x: 0, y: 0, z: H, w: H }, scale: at(2, 2, 2) }, components: [{ type: "BoxCollider", fields: { center: at(0, 1, 0) } }] }),
            go("Twin", { components: [
                { type: "BoxCollider", fields: { size: at(1, 1, 1) } },
                { type: "BoxCollider", fields: { size: at(3, 3, 3) } },
            ] }),
            go("HiddenParent", { active: false, children: [
                go("HiddenLight", { components: [{ type: "PointLight", fields: { range: 5 } }] }),
            ] }),
            go("Unsel", { components: [{ type: "PointLight", fields: { range: 5 } }] }),
            // B1r5 #3: circle normals must be MEASURED from the drawn basis —
            // a sphere's three great circles and a turned sun's end disc prove it.
            go("Sph", { transform: { position: at(6, 1, 2), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(1, 1, 1) }, components: [{ type: "SphereCollider", fields: { radius: 2 } }] }),
            go("Sun", { transform: { position: at(-2, 5, -5), rotation: { x: H, y: 0, z: 0, w: H }, scale: at(1, 1, 1) }, components: [{ type: "DirectionalLight", fields: {} }] }),
            // B1r5 #4: a tall capsule reads as a capsule — side lines join the caps.
            go("CapTall", { transform: { position: at(8, 2, -2), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(1, 1, 1) }, components: [{ type: "CapsuleCollider", fields: { radius: 0.5, height: 4 } }] }),
            // B1r5 #6 (B1r4 #9): 60 spheres × 3 circles × 24 segments × 2 verts
            // = 8640 vertices — past the 8192 pool, which must grow, not truncate.
            ...Array.from({ length: 60 }, (_, i) => go(`Bulk${i}`, {
                transform: { position: at(20 + i * 2, 0, 20), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: at(1, 1, 1) },
                components: [{ type: "SphereCollider", fields: { radius: 1 } }],
            })),
        ],
    };
    await seed(page, "GizmoProof", {
        "scenario.meta.json": JSON.stringify({ id: "gizmoproof", name: "GizmoProof", version: "1.0.0" }),
        "assets/scenes/main.scene.json": JSON.stringify(scene),
    });
    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor();
    // Wait for the scene to reach the tree before reading it (the FmtOpen lesson:
    // under load the scene's arrival lags the workspace's).
    for (let i = 0; i < 50; i++) {
        if ((await page.locator("app-hierarchy").innerText()).includes("BoxRot")) break;
        await page.waitForTimeout(100);
    }

    // Rotate a vector by a quaternion (the engine's rotation convention), so
    // expectations are derived, never sign-guessed.
    const rotate = (v, q) => {
        const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
        return {
            x: v.x + q.w * tx + q.y * tz - q.z * ty,
            y: v.y + q.w * ty + q.z * tx - q.x * tz,
            z: v.z + q.w * tz + q.x * ty - q.y * tx,
        };
    };
    const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
    const near3 = (v, e, tol = 1e-2) => !!v && Math.abs(v.x - e.x) < tol && Math.abs(v.y - e.y) < tol && Math.abs(v.z - e.z) < tol;
    const nearR = (r, e) => Math.abs(r - e) < Math.max(1e-2, Math.abs(e) * 1e-2);
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const info = (name, kind) => page.evaluate(([n, k]) => window.__wetsProbe.gizmoInfo(n, k), [name, kind]);
    const icons = () => page.evaluate(() => window.__wetsProbe.iconCounts());

    // Nothing selected: the proofs must hold for unselected objects too.
    await page.locator("app-hierarchy li.scene-root").click();
    await page.waitForTimeout(300);

    // 1 — point light off the origin: three circles on the object, radius = range.
    const pl = await info("PL", "PointLight");
    const plRec = pl[0];
    check("point light: one record with three circles", pl.length === 1 && plRec?.circles.length === 3, JSON.stringify(pl));
    check("point light: circles centred on the object, radius = range",
        !!plRec && plRec.circles.every(c => near3(c.center, { x: 5, y: 2, z: -3 }) && nearR(c.radius, 10)), JSON.stringify(plRec?.circles));
    const plDistinct = !!plRec && plRec.circles.length === 3
        && Math.abs(dot(plRec.circles[0].normal, plRec.circles[1].normal)) < 0.1
        && Math.abs(dot(plRec.circles[0].normal, plRec.circles[2].normal)) < 0.1
        && Math.abs(dot(plRec.circles[1].normal, plRec.circles[2].normal)) < 0.1;
    check("point light: three distinct planes", plDistinct, JSON.stringify(plRec?.circles.map(c => c.normal)));

    // 2 — AudioSource off the origin: one XY circle (minDistance 0), radius = maxDistance.
    const au = await info("Audio", "AudioSource");
    check("audio: one circle centred on the object with radius = maxDistance",
        au.length === 1 && au[0].circles.length === 1
        && near3(au[0].circles[0].center, { x: -4, y: 1, z: 6 }) && nearR(au[0].circles[0].radius, 500), JSON.stringify(au));
    check("audio: the circle lies in the XY plane", !!au[0] && near3(au[0].circles[0].normal, { x: 0, y: 0, z: 1 }), JSON.stringify(au[0]?.circles[0]?.normal));

    // 3 — capsule twins: the scaled one is twice the unscaled one, same centre.
    const cap = await info("Cap", "CapsuleCollider");
    const cap2 = await info("Cap2", "CapsuleCollider");
    check("capsule: one record each, centred on the object",
        cap.length === 1 && cap2.length === 1 && near3(cap[0]?.center, { x: 0, y: 3, z: 0 }) && near3(cap2[0]?.center, { x: 0, y: 3, z: 0 }),
        JSON.stringify([cap[0]?.center, cap2[0]?.center]));
    check("capsule: scaling 2 doubles the half-height",
        !!cap[0] && !!cap2[0] && cap[0].half.y > 0 && nearR(cap2[0].half.y, cap[0].half.y * 2),
        JSON.stringify([cap[0]?.half, cap2[0]?.half]));

    // 4 — spot rotated 90 deg about X points down: end circle on the rotated forward.
    const spotT = await page.evaluate(() => window.__wetsProbe.transformOf("Spot"));
    const fwd = rotate({ x: 0, y: 0, z: 1 }, spotT.rotation);
    check("the seeded spot points down", near3(fwd, { x: 0, y: -1, z: 0 }), JSON.stringify(fwd));
    const sp = await info("Spot", "SpotLight");
    const spC = sp[0]?.circles[0];
    check("spot: end circle centre = position + range * forward",
        sp.length === 1 && !!spC && near3(spC.center, add(spotT.position, fwd, 10)), JSON.stringify(spC?.center));
    check("spot: end circle normal parallel to forward", !!spC && Math.abs(Math.abs(dot(spC.normal, fwd)) - 1) < 1e-2, JSON.stringify(spC?.normal));
    check("spot: end circle radius = range * tan(spotAngle/2)", !!spC && nearR(spC.radius, 10 * Math.tan(Math.PI / 6)), JSON.stringify(spC?.radius));

    // 5 — BoxCollider local centre scaled then rotated: pos + rotate((0,2,0)).
    const boxT = await page.evaluate(() => window.__wetsProbe.transformOf("BoxRot"));
    const bx = await info("BoxRot", "BoxCollider");
    check("box: local centre scaled and rotated into place",
        bx.length === 1 && near3(bx[0]?.center, add(boxT.position, rotate({ x: 0, y: 2, z: 0 }, boxT.rotation))), JSON.stringify(bx[0]?.center));
    check("box: half-extents follow the scale", bx.length === 1 && near3(bx[0]?.half, { x: 1, y: 1, z: 1 }), JSON.stringify(bx[0]?.half));

    // 6 — two colliders of one type: two wireframes; disable the first, one stays.
    const twins = await info("Twin", "BoxCollider");
    const halves = twins.map(r => r.half.x).sort((a, b) => a - b);
    check("two BoxColliders draw two distinct wireframes", twins.length === 2 && nearR(halves[0], 0.5) && nearR(halves[1], 1.5), JSON.stringify(halves));
    const disabled = await page.evaluate(() => window.__wetsProbe.setComponentEnabled("Twin", "BoxCollider", 0, false));
    // At least two frames so the controller rebuilds before the read-back.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(200);
    const twinsAfter = await info("Twin", "BoxCollider");
    check("disabling the first leaves the second",
        disabled && twinsAfter.length === 1 && nearR(twinsAfter[0]?.half.x, 1.5), JSON.stringify(twinsAfter.map(r => r.half)));

    // 7 — inactive parent: no gizmo, no icon for the child.
    const hidden = await info("HiddenLight", "PointLight");
    const hiddenIcons = await icons();
    const hiddenTf = await page.evaluate(() => window.__wetsProbe.transformOf("HiddenLight"));
    check("an inactive parent's light draws no gizmo", hidden.length === 0, JSON.stringify(hidden));
    check("an inactive parent's light has no icon",
        !!hiddenTf && (hiddenIcons.PointLight ?? 0) === 2, JSON.stringify(hiddenIcons));

    // 8 — an unselected light still has an icon (production bundle, registry names),
    // and its Drawn record flips `selected` with the selection.
    check("an unselected light has an icon", (await icons()).PointLight >= 2, JSON.stringify(await icons()));
    check("an unselected light's record is not selected", (await info("Unsel", "PointLight"))[0]?.selected === false, JSON.stringify(await info("Unsel", "PointLight")));
    await page.locator("app-hierarchy li", { hasText: "Unsel" }).first().click();
    // The selected flag is written by the gizmo rebuild one or two frames after
    // the selection effect runs; under load a fixed sleep can read too early.
    const selSettled = async (want) => {
        for (let i = 0; i < 120; i++) {
            if ((await info("Unsel", "PointLight"))[0]?.selected === want) return true;
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        }
        return false;
    };
    await selSettled(true);
    check("selecting it marks the record selected", (await info("Unsel", "PointLight"))[0]?.selected === true, JSON.stringify(await info("Unsel", "PointLight")));
    await page.locator("app-hierarchy li.scene-root").click();
    await selSettled(false);
    check("deselecting clears the record's selected flag", (await info("Unsel", "PointLight"))[0]?.selected === false, JSON.stringify(await info("Unsel", "PointLight")));

    // 9 — B1r5 #3: the sphere's three circles lie in three MEASURED planes.
    // A basis bug (the old _circlePoint('yz') returning XZ) collapses two
    // normals onto one plane; with the normal recorded from u × v of the
    // actual vertex basis, the pairwise dot check catches it.
    const sph = await info("Sph", "SphereCollider");
    const sphC = sph[0]?.circles ?? [];
    const sphDistinct = sphC.length === 3
        && Math.abs(dot(sphC[0].normal, sphC[1].normal)) < 0.1
        && Math.abs(dot(sphC[0].normal, sphC[2].normal)) < 0.1
        && Math.abs(dot(sphC[1].normal, sphC[2].normal)) < 0.1;
    check("sphere: three circles in three distinct measured planes", sph.length === 1 && sphDistinct,
        JSON.stringify(sphC.map(c => c.normal)));
    check("sphere: circles centred on the object with radius = radius field",
        sphC.length === 3 && sphC.every(c => near3(c.center, { x: 6, y: 1, z: 2 }) && nearR(c.radius, 2)),
        JSON.stringify(sphC));

    // 10 — B1r5 #3: the sun turned X90 points down; its end disc's measured
    // normal must be parallel to the ROTATED forward, not a world-fixed axis.
    const sunT = await page.evaluate(() => window.__wetsProbe.transformOf("Sun"));
    const sunFwd = rotate({ x: 0, y: 0, z: 1 }, sunT.rotation);
    const sun = await info("Sun", "DirectionalLight");
    const sunC = sun[0]?.circles[0];
    check("sun: end disc centre = position + 1.5 * rotated forward",
        sun.length === 1 && !!sunC && near3(sunC.center, add(sunT.position, sunFwd, 1.5)), JSON.stringify(sunC?.center));
    check("sun: end disc normal parallel to the rotated forward (measured)",
        !!sunC && Math.abs(Math.abs(dot(sunC.normal, sunFwd)) - 1) < 1e-2,
        JSON.stringify({ normal: sunC?.normal, fwd: sunFwd }));

    // 11 — B1r5 #4: the tall capsule: half.y = height/2 = 2, and the side
    // lines put vertices at local (±r, 0, 0) — the mid-height waist a
    // figure-8 of cap circles never reaches. half.x = r proves the sides
    // exist (the caps' circles alone would too, so also check the extent
    // covers the waist through half.y while half.x stays r).
    const tall = await info("CapTall", "CapsuleCollider");
    check("tall capsule: one record, half-height = height/2",
        tall.length === 1 && nearR(tall[0]?.half.y, 2), JSON.stringify(tall[0]?.half));
    check("tall capsule: half.x = radius (the side lines at ±r)",
        tall.length === 1 && nearR(tall[0]?.half.x, 0.5) && nearR(tall[0]?.half.z, 0.5),
        JSON.stringify(tall[0]?.half));
    // The waist proof: the cap circles span ±(h) ± r in Y only around the cap
    // centres; the side lines are the only geometry at local y = 0, x = ±r.
    // The record's six circles (3 per cap) must all sit at the cap centres,
    // and each cap must carry all three measured planes {X, Y, Z}: the old
    // figure-8 drew TWO circles per cap (normals Y and Z only) plus diameters,
    // so the count and the per-cap normal set both fail on the old shape.
    const capCircles = tall[0]?.circles ?? [];
    const topCap = { x: 8, y: 2 + 1.5, z: -2 }, botCap = { x: 8, y: 2 - 1.5, z: -2 };
    const capNormals = (cap) => capCircles.filter(c => near3(c.center, cap)).map(c => c.normal);
    const hasPlane = (ns, axis) => ns.some(n => Math.abs(Math.abs(dot(n, axis)) - 1) < 0.1);
    const planesXYZ = (ns) => ns.length === 3
        && hasPlane(ns, { x: 1, y: 0, z: 0 }) && hasPlane(ns, { x: 0, y: 1, z: 0 }) && hasPlane(ns, { x: 0, y: 0, z: 1 });
    check("tall capsule: six circles, all at the two cap centres (no waist rings)",
        capCircles.length === 6 && capCircles.every(c => near3(c.center, topCap) || near3(c.center, botCap)),
        JSON.stringify(capCircles.map(c => c.center)));
    check("tall capsule: each cap carries the X, Y and Z planes (ring + two arcs)",
        planesXYZ(capNormals(topCap)) && planesXYZ(capNormals(botCap)),
        JSON.stringify({ top: capNormals(topCap), bot: capNormals(botCap) }));

    // 12 — B1r5 #6 (B1r4 #9): 60 spheres = 8640 vertices > the 8192 pool.
    // Every record must still be drawn (the pool grows); truncation drops
    // the tail records' vertices and the last spheres read empty. The records
    // are built BEFORE the flush, so the buffer itself is read back too: its
    // draw count must cover the whole kind (8784 with Sph) and its last vertex
    // must be Bulk59's.
    const bulkFirst = await info("Bulk0", "SphereCollider");
    const bulkLast = await info("Bulk59", "SphereCollider");
    check("past 8192 vertices: the first sphere still draws three circles",
        bulkFirst.length === 1 && bulkFirst[0].circles.length === 3 && nearR(bulkFirst[0].extent, 1),
        JSON.stringify(bulkFirst.map(r => r.circles.length)));
    check("past 8192 vertices: the LAST sphere draws too (the pool grew, no truncation)",
        bulkLast.length === 1 && bulkLast[0].circles.length === 3 && nearR(bulkLast[0].extent, 1)
        && near3(bulkLast[0].center, { x: 20 + 59 * 2, y: 0, z: 20 }),
        JSON.stringify(bulkLast));
    // Each circle closes at its first vertex c + u·r. The kind's pool also
    // holds Sph (3 circles × 48 verts), so 61 spheres flush 61 × 144 = 8784
    // vertices. Bulk59 is the last root; its third circle (u = local Y) ends
    // at (138,1,20). A truncated buffer stops at 8192, mid-Bulk56.
    const buf = await page.evaluate(() => window.__wetsProbe.gizmoBufferStats("SphereCollider"));
    check("past 8192 vertices: the buffer draws all 8784 and ends on Bulk59's last circle",
        !!buf && buf.drawn === 8784 && buf.capacity >= 8784
        && near3(buf.last, { x: 138, y: 1, z: 20 }),
        JSON.stringify(buf));

    check("no page errors", noErrors(page), page.logs.join(" | "));
});
// B1.7 — DW-7.1…7.4: lighting, draw modes and the grid are view state; the
// picture matches what the platform will show.
scenario("lighting and view: dark without a light, wireframe, the grid (B1.7)", async () => {
    const page = await newPage("ViewDemo", { probe: true });
    await openEmptyProject(page);
    await page.keyboard.press("Escape");

    const menuGo = async (item, sub) => {
        await page.locator(".menubar-item", { hasText: "GameObject" }).click();
        await page.waitForTimeout(150);
        if (sub) {
            await page.locator(".ctx-item", { hasText: sub }).first().hover();
            await page.waitForTimeout(150);
        }
        await page.locator(".ctx-item", { hasText: item }).last().click();
        await page.waitForTimeout(400);
    };
    const chip = title => page.locator(`.vp-subtoolbar .chip[title="${title}"]`);
    const probe = fn => page.evaluate(fn);
    const lum = rgba => rgba ? (0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]) / 255 : -1;
    const pixelAt = (x, y) => page.evaluate(([px, py]) => window.__wetsProbe.pixel(px, py), [x, y]);
    const rectOf = name => page.evaluate(n => window.__wetsProbe.objectScreenRect(n), name);
    const centreOf = async name => {
        const r = await rectOf(name);
        return r ? { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) } : null;
    };
    const sceneText = async () => {
        for (let i = 0; i < 30; i++) {
            const text = await readDisk(page, "ViewDemo", "assets/scenes/main.scene.json");
            if (text !== null && text.length > 0) return text;
            await page.waitForTimeout(100);
        }
        return null;
    };

    // Gizmos off for the whole scenario: their lines would sit over the very
    // pixels the luminance checks read (the light's rays cross the cube).
    await page.locator(".gz-menu .chip").click();
    await page.waitForTimeout(250);
    await page.locator(".gz-row.master input").uncheck();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await menuGo("Cube", "3D Object");
    await page.keyboard.press("q"); // View tool: no handles over the cube
    await page.waitForTimeout(250);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    const baseline = await sceneText();
    check("the cube was saved", baseline !== null && JSON.parse(baseline).roots.some(r => r.name === "Cube"));

    // ── DW-7.1: lighting on by default, a light-less scene is dark ──
    check("lighting starts on", await probe(() => window.__wetsProbe.lightingOn()) === true);
    check("the no-light hint is visible", await page.locator(".vp-nolight-hint").isVisible());
    check("the hint says what the platform will show",
        (await page.locator(".vp-nolight-hint").innerText()).includes("No light in the scene"));
    let c = await centreOf("Cube");
    const dark = lum(await pixelAt(c.x, c.y));
    check("with no light the cube is dark (lum < 0.05)", dark >= 0 && dark < 0.05, String(dark));

    await chip("Lighting").click();
    await page.waitForTimeout(300);
    const litByHeadlight = lum(await pixelAt(c.x, c.y));
    check("lighting off shows the cube lit by the headlight (lum > 0.3)", litByHeadlight > 0.3, String(litByHeadlight));
    check("the hint is gone while lighting is off", (await page.locator(".vp-nolight-hint").count()) === 0);
    check("the toggle does not mark the scene unsaved", (await page.locator(".statusbar").innerText()).includes("Saved"));
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    check("lighting state never reaches the scene file", (await sceneText()) === baseline);

    // Not undoable: Ctrl+Z undoes the cube's create, not the toggle.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    const names = await page.locator("app-hierarchy li .label").allInnerTexts();
    check("undo undoes the create, not the lighting toggle", !names.includes("Cube")
        && await probe(() => window.__wetsProbe.lightingOn()) === false, names.join(","));
    await page.keyboard.press("Control+y");
    await page.waitForTimeout(400);

    // A real light: lighting on shows it, and the hint goes away.
    await menuGo("Directional Light", "Light");
    await chip("Lighting").click(); // back on
    await page.waitForTimeout(300);
    check("adding a light removes the hint", (await page.locator(".vp-nolight-hint").count()) === 0);
    c = await centreOf("Cube");
    const litByScene = lum(await pixelAt(c.x, c.y));
    check("with the scene's own light the cube is lit (lum > 0.3)", litByScene > 0.3, String(litByScene));

    // ── DW-7.2: the lighting-off override leaves nothing behind ──
    const info0 = await probe(() => window.__wetsProbe.threeInfo());
    await chip("Lighting").click();
    await page.waitForTimeout(200);
    await pixelAt(c.x, c.y); // forces a lighting-off frame
    const info1 = await probe(() => window.__wetsProbe.threeInfo());
    check("no headlight children survive the frame", info0.children === info1.children, JSON.stringify([info0, info1]));
    check("the scene light keeps its visible flag", JSON.stringify(info0.lightsVisible) === JSON.stringify(info1.lightsVisible)
        && info1.lightsVisible.length > 0 && info1.lightsVisible.every(v => v === true), JSON.stringify([info0, info1]));
    await chip("Lighting").click(); // on again
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    const withLight = await sceneText();

    // ── DW-7.3: wireframe is an override, not a material edit ──
    await page.keyboard.press("Escape"); // no selection outline over the edges
    await chip("Grid").click(); // grid off: a uniform background to compare with
    await page.waitForTimeout(250);
    const box = await page.locator("canvas").boundingBox();
    const bg = await pixelAt(Math.round(box.x + 30), Math.round(box.y + 30));
    await chip("Wireframe").click();
    await page.waitForTimeout(300);
    const r = await rectOf("Cube");
    // A 5×5 sample grid over the middle 60% of the rect: a face diagonal can
    // cross any single point (the centre included), so the interior claim is
    // "most interior pixels read as background", not one lucky pixel.
    const bgLum = lum(bg);
    let interiorBg = 0;
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            const p = await pixelAt(
                Math.round(r.left + (r.right - r.left) * (0.2 + 0.15 * i)),
                Math.round(r.top + (r.bottom - r.top) * (0.2 + 0.15 * j)));
            if (Math.abs(lum(p) - bgLum) < 0.03) interiorBg++;
        }
    }
    check("wireframe: the interior reads as background", interiorBg >= 15, `${interiorBg}/25 interior pixels, bg=${JSON.stringify(bg)}`);
    let edgeLit = 0;
    for (let x = Math.round(r.left); x <= Math.round(r.right); x++) {
        if (lum(await pixelAt(x, c.y)) > 0.3) edgeLit++;
    }
    check("wireframe: the edges are drawn", edgeLit >= 2, String(edgeLit));
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(400);
    check("wireframe never reaches the scene file", (await sceneText()) === withLight);
    await chip("Shaded").click();
    await page.waitForTimeout(300);
    const filled = lum(await pixelAt(c.x, c.y));
    check("shaded back: the cube is filled again", filled > 0.3, String(filled));
    await chip("Grid").click(); // grid on
    await page.waitForTimeout(250);

    // ── DW-7.4: the grid toggle and its step ──
    check("the grid step starts at 1", await probe(() => window.__wetsProbe.gridStep()) === 1);
    // The grid is finite (±25 units) and its lines are antialiased, so a single
    // scan row can miss them entirely. Count grey-ish pixels over a 2D region
    // in the left third of the view — empty ground, away from the cube (which
    // sits centre-right) and the orientation cube (top-right corner).
    const greyCount = async () => {
        let n = 0;
        for (let y = 90; y <= 390; y += 15) {
            for (let x = 16; x <= 316; x += 15) {
                const p = await pixelAt(Math.round(box.x + x), Math.round(box.y + y));
                if (p && Math.max(p[0], p[1], p[2]) >= 10
                    && Math.abs(p[0] - p[1]) < 20 && Math.abs(p[1] - p[2]) < 20) n++;
            }
        }
        return n;
    };
    const gridOn = await greyCount();
    check("grid on: grid-colour pixels in the empty area", gridOn > 0, String(gridOn));
    await chip("Grid").click();
    await page.waitForTimeout(250);
    const gridOff = await greyCount();
    check("grid hidden: no grid-colour pixels left", gridOff === 0, String(gridOff));
    await chip("Grid").click();
    await page.waitForTimeout(250);

    await page.keyboard.press("Control+,");
    await page.locator(".prefs-tab", { hasText: "Editor" }).click();
    await page.locator("#prefs-grid-size").fill("0.5");
    await page.locator("#prefs-grid-size").press("Tab");
    await page.waitForTimeout(300);
    check("Preferences grid step 0.5 halves the spacing (probe read-back)",
        await probe(() => window.__wetsProbe.gridStep()) === 0.5, String(await probe(() => window.__wetsProbe.gridStep())));
    await page.locator(".dlg-btn.primary").click();
    await page.waitForTimeout(200);

    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("no page errors", noErrors(page), page.logs.join(" | "));
});

// B1.7 — DW-7.5/7.6: the platform fixtures, made through the wizard and the
// GameObject menu like any author would, exported for `npm run e2e:build`.
scenario("platform fixtures: lit, dark and catalog exports (B1.7)", async () => {
    const page = await newPage("FixtureParent");

    const makeProject = async (title, id, folder, template) => {
        await page.getByText("Create project").click();
        await page.locator("#wiz-name").fill(title);
        await page.locator("#wiz-id").fill(id);
        await page.locator(".dlg-btn.primary").click();
        if (template === "empty") await page.locator(".wiz-card", { hasText: "Empty scene" }).click();
        await page.locator(".dlg-btn.primary").click();
        await page.getByText("Choose a folder…").click();
        await page.waitForTimeout(400);
        await page.locator("#wiz-folder").fill(folder);
        await page.keyboard.press("Enter");
        await page.locator(".work").waitFor({ timeout: 90000 });
        await page.waitForTimeout(800);
    };
    const menuGo = async (item, sub) => {
        await page.locator(".menubar-item", { hasText: "GameObject" }).click();
        await page.waitForTimeout(150);
        if (sub) {
            await page.locator(".ctx-item", { hasText: sub }).first().hover();
            await page.waitForTimeout(150);
        }
        await page.locator(".ctx-item", { hasText: item }).last().click();
        await page.waitForTimeout(400);
    };
    const fillField = async (field, axis, value) => {
        await page.locator(".insp-body .field").nth(field).locator("input").nth(axis).fill(String(value));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(200);
    };
    /** A cube scaled 2 at (0,1,0): big enough to cover the platform canvas's
     * centre pixel (320,240 of 640×480) from the camera at (0,1,−10). */
    const fixtureCube = async () => {
        await menuGo("Cube", "3D Object");
        await fillField(0, 1, 1);
        await fillField(2, 0, 2); await fillField(2, 1, 2); await fillField(2, 2, 2);
    };
    const saveAndClose = async (folder, key, roots) => {
        // The Inspector's number input keeps focus after a fill, and the
        // shortcut guard stands down inside inputs — click the pane tab first,
        // like a user clicking away before saving.
        await page.locator(".pane-tab").first().click();
        await page.keyboard.press("Control+s");
        await page.waitForTimeout(600);
        const scene = JSON.parse(await readDisk(page, "FixtureParent", `${folder}/assets/scenes/main.scene.json`));
        check(`${key}: the scene holds ${roots} objects`, scene.roots.length === roots, JSON.stringify(scene.roots.map(r => r.name)));
        await exportFolder(page, "FixtureParent", folder, resolve(SHOTS, key));
        await menu(page, "File", "Close Project");
        await page.locator(".start-card").waitFor();
        await page.waitForTimeout(300);
    };

    // pixels-lit: the wizard's camera and sun, plus the cube.
    await makeProject("Pixels Lit", "pixels-lit", "Lit", "lightCamera");
    await fixtureCube();
    await saveAndClose("Lit", "pixels-lit", 3);

    // pixels-dark: no light at all; the camera is placed by hand like an
    // author would (the UI creates it at the pivot, inside the cube).
    await makeProject("Pixels Dark", "pixels-dark", "Dark", "empty");
    await fixtureCube();
    await menuGo("Camera");
    await page.locator("app-hierarchy li .label", { hasText: "Camera" }).first().click();
    await page.waitForTimeout(300);
    await fillField(0, 1, 1);
    await fillField(0, 2, -10);
    await saveAndClose("Dark", "pixels-dark", 2);

    // catalog: the six primitives, a light and a camera — stage-6 features
    // only, arranged across the camera's view at (0,1,−10).
    await makeProject("Catalog", "catalog", "Catalog", "lightCamera");
    await menuGo("Plane", "3D Object");
    const PLACE = { Cube: [-3, 0.5, 0], Sphere: [-1.5, 0.5, 0], Capsule: [0, 1, 0], Cylinder: [1.5, 1, 0], Quad: [3, 0.5, 0] };
    for (const [kind, [x, y, z]] of Object.entries(PLACE)) {
        await menuGo(kind, "3D Object");
        await fillField(0, 0, x); await fillField(0, 1, y); await fillField(0, 2, z);
    }
    await saveAndClose("Catalog", "catalog", 8);

    check("no native dialogs were used", page.nativeDialogs === 0, String(page.nativeDialogs));
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
    // Every context the scenario opened is closed before the next one starts.
    // A live context keeps a whole editor running - its WebGL renderer, its
    // requestAnimationFrame loop, its workers - and the suite opens ~30 of them.
    // Left open they accumulate: measured over 14 project opens, the time from
    // "Open folder" to a visible workspace grew 192 ms -> 20463 ms, which is the
    // late-suite `.work` timeout the whole suite kept flaking on (ROADMAP T2).
    // Closed, the same 14 opens stay between 250 and 890 ms. No timeout is
    // raised and no check retried: every scenario still gets the same 30 s.
    for (const context of browser.contexts()) await context.close().catch(() => {});
    lastPage = null;
}
await browser.close();
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
