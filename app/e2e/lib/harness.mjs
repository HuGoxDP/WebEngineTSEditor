// harness.mjs — shared e2e test helper library for app/e2e/checks/*.mjs
// Extracted from app/e2e/run.mjs at a1f8619.
//
// Adapted paths/exports (from run.mjs):
//   - HERE: points to app/e2e/lib/
//   - E2E: default gains an extra '../' (resolve(HERE, "../../../../testv/virtual-lab/e2e"))
//   - SHOTS: resolve(HERE, "../../../.shots")
//   - CHANNEL: process.env.E2E_BROWSER_CHANNEL ?? "msedge"
//   - URL_: process.argv[2] ?? "http://localhost:8044/editor/"
//   - newPage: gets its browser from a lazy browser()
//   - lazy browser(): playwright is imported/launched on first use, not at import time
//
// New exports:
//   - check(name, ok, detail)
//   - runCheck(fn)
//   - play(page), stop(page), save(page)
//   - selectInHierarchy(page, name, nth)
//   - transformOf(page, name)
//   - browser(), closeBrowser()

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TESTV = resolve(HERE, "../../../../testv/virtual-lab/e2e");
const DEFAULT_VL = resolve(HERE, "../../../../virtual-lab/e2e");
const E2E = resolve(process.env.E2E_PLAYWRIGHT_DIR || (existsSync(DEFAULT_TESTV) ? DEFAULT_TESTV : DEFAULT_VL));
const CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? "msedge";
const SHOTS = resolve(HERE, "../../../.shots");
const URL_ = process.argv[2] ?? "http://localhost:8044/editor/";

let _browser = null;
let lastPage = null;
let totalChecks = 0;
let failedChecks = 0;

/** Lazy Playwright browser instance. */
async function browser() {
    if (!_browser) {
        mkdirSync(SHOTS, { recursive: true });
        const reqPath = resolve(E2E, "package.json");
        const { chromium } = createRequire(reqPath)("playwright");
        _browser = await chromium.launch({
            channel: CHANNEL || undefined,
            args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
        });
    }
    return _browser;
}

async function closeBrowser() {
    if (_browser) {
        for (const context of _browser.contexts()) await context.close().catch(() => {});
        await _browser.close().catch(() => {});
        _browser = null;
        lastPage = null;
    }
}

async function newPage(folderName = "DemoScenario", { viewport = { width: 1600, height: 900 }, settings = { language: "en" }, autosaveMs = 0, probe = false } = {}) {
    const b = await browser();
    const context = await b.newContext({ viewport, locale: "en-US" });
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

const check = (name, ok, detail = "") => {
    totalChecks++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
    if (!ok) failedChecks++;
};

async function runCheck(fn) {
    try {
        await fn();
    } catch (err) {
        if (lastPage) {
            try {
                mkdirSync(SHOTS, { recursive: true });
                const base = basename(process.argv[1] ?? "check", ".mjs");
                await shot(lastPage, `e2e-failure-${base}`);
            } catch {
                // ignore screenshot failure
            }
        }
        check("scenario completed", false, err.message);
    } finally {
        await closeBrowser();
    }

    if (totalChecks === 0) {
        check("scenario completed", false, "no checks ran");
    }
    process.exit(failedChecks === 0 ? 0 : 1);
}

async function play(page) {
    await page.locator(".tb-btn[title='Play']").click();
    await page.locator(".tb-btn[title='Stop']:not([disabled])").waitFor({ timeout: 10000 });
}

async function stop(page) {
    await page.locator(".tb-btn[title='Stop']").click();
    await page.locator(".tb-btn[title='Play']:not([disabled])").waitFor({ timeout: 10000 });
}

async function save(page) {
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(800);
}

async function selectInHierarchy(page, name, nth = 0) {
    await page.locator("app-hierarchy li", { hasText: name }).nth(nth).click();
    await page.waitForTimeout(300);
}

async function transformOf(page, name) {
    return page.evaluate(n => window.__wetsProbe?.transformOf(n) ?? null, name);
}


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

const LIBRARY_NAMES = [
    "Rotator", "Mover", "Clickable", "ToggleVisibility", "ShowTextOnClick",
    "QuizQuestion", "Timer", "FollowPath", "LookAtCamera", "PlayAnimation",
];

async function siblingPage(page, folderName) {
    const sibling = await page.context().newPage();
    await instrument(sibling, folderName, null, 0);
    await sibling.goto(URL_, { waitUntil: "load" });
    return sibling;
}

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

const pick = (page, folder) => page.evaluate(f => { window.__pickFolder = f; }, folder);

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

const readDisk = (page, folder, path) => page.evaluate(async ([name, file]) => {
    try {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        const parts = file.split("/");
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    } catch { return null; }
}, [folder, path]);

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

const failReads = (page, fileName) => page.evaluate(name => {
    const get = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function (...args) {
        if (this.name === name) throw new DOMException("e2e: read refused", "NotAllowedError");
        return get.apply(this, args);
    };
}, fileName);

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

const shot = async (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

const dialogTitle = page => page.locator(".dlg-title").last();

const dialogButton = (page, text) => page.locator(".dlg-btn", { hasText: text }).last();

const menu = async (page, bar, item) => {
    await page.locator(".menubar-item", { hasText: bar }).click();
    await page.locator(".ctx-item", { hasText: item }).click();
};

const noErrors = page => page.logs.filter(l =>
    !l.includes("404")
    && !(l.includes("GL Driver Message") && l.includes("Performance"))
    && !l.includes("GPU stall due to ReadPixels")
).length === 0;

async function seedScriptProject(page, files) {
  await seed(page, "ScriptParent", {
    "scenario.meta.json": JSON.stringify({ id: "script-parent", name: "ScriptParent", version: 1, createdAt: "2026-11-12T00:00:00Z" }),
    ...files,
  });
}

async function openEmptyProject(page) {
    await page.getByText("Open folder…").click();
    await dialogButton(page, "Set up").click();
    // Late in a full run every earlier scenario's page is still open and the
    // software GL is slow; the same 90 s the reload waits use (B1.6).
    await page.locator(".work").waitFor({ timeout: 90000 });
}

const sceneWith = name => JSON.stringify({
    name: "Seeded", version: 1,
    roots: [{
        name, active: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [], children: [],
    }],
});

const sceneAt = (name, root) => JSON.stringify({ name, roots: [root] });

const oneRoot = name => ({
    name, active: true,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    components: [], children: [],
});

const meta = (id, name) => JSON.stringify({ id, name, version: "1.0.0" });

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

const opfsEntries = (page, path = "") => page.evaluate(async p => {
    const root = await navigator.storage.getDirectory();
    let dir = root;
    for (const part of p.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    const out = [];
    for await (const h of dir.values()) out.push(h.kind === "directory" ? `${h.name}/` : h.name);
    return out.sort();
}, path);

const opfsRead = (page, path) => page.evaluate(async f => {
    try {
        let dir = await navigator.storage.getDirectory();
        const parts = f.split("/");
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    } catch { return null; }
}, path);

export {
    HERE,
    E2E,
    CHANNEL,
    SHOTS,
    URL_,
    browser,
    closeBrowser,
    newPage,
    check,
    runCheck,
    play,
    stop,
    save,
    selectInHierarchy,
    transformOf,
    ROTATOR,
    SCENARIO_ENTRY,
    LIBRARY_NAMES,
    siblingPage,
    instrument,
    pick,
    seed,
    diskState,
    readDisk,
    exportFolder,
    slowAutosave,
    slowLibraryWrite,
    failNextWrite,
    failReads,
    holdScriptRead,
    holdStampRead,
    shot,
    dialogTitle,
    dialogButton,
    menu,
    noErrors,
    seedScriptProject,
    openEmptyProject,
    sceneWith,
    sceneAt,
    oneRoot,
    meta,
    openLibraryProject,
    addFromLibrary,
    editScript,
    opfsEntries,
    opfsRead
};
