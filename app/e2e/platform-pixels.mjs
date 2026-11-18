// platform-pixels.mjs — measure ONE pixel of a built scenario, rendered by the
// engine bundle ScenarioCreator ships (DW-7.5, decision D-14: the pixel check
// lives in the editor repo, verify-render.mjs stays untouched).
//
//   node app/e2e/platform-pixels.mjs <scenarioName> [--min <lum>] [--max <lum>] [--x <px>] [--y <px>]
//
// The scenario must already be built: ReleaseScenarios/<name>.zip and
// <name>.scenario.json (build-package.mjs + build-manifest.mjs in
// ScenarioCreator). The harness loads the ZIP — the artifact the platform
// actually consumes today; manifest/ZIP equivalence is verify-render's job.
//
// Result line (stdout, exactly):
//   pixels <scenarioName>: luminance=<0.xxxx> rgba=<r>,<g>,<b>,<a> at=<x>,<y>
// luminance = (0.2126r + 0.7152g + 0.0722b) / 255. Diagnostics on other lines.
// Exit: 0 measured and thresholds met, 1 threshold violated, 2 harness/load failure.
//
// Harness pattern copied from ScenarioCreator/verify-render.mjs: standalone
// bundle + importmap, POST /result back to the serving process, raw browser
// spawn on swiftshader, server.listen(0), kill+close in finally.
// Browser channel follows run.mjs: E2E_BROWSER_CHANNEL (?? "msedge"; set-but-
// empty = Playwright's headless shell), BROWSER=<exe> overrides everything.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CREATOR = resolve(HERE, "../../../ScenarioCreator");
const RELEASE = resolve(CREATOR, "ReleaseScenarios");
const ENGINE_BUNDLE = resolve(CREATOR, "node_modules", "WebEngineTS", "dist", "WebEngineTS.standalone.js");
// `??`, not `||`: set-but-empty is a choice (the headless shell), not "unset".
const CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? "msedge";

const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript",
    ".json": "application/json", ".zip": "application/zip",
};

function usage(problem) {
    console.error(`${problem}\nusage: node app/e2e/platform-pixels.mjs <scenarioName> [--min <lum>] [--max <lum>] [--x <px>] [--y <px>]`);
    process.exit(2);
}

const args = process.argv.slice(2);
let name = null, min = null, max = null, x = 320, y = 240;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--min" || a === "--max" || a === "--x" || a === "--y") {
        const v = Number(args[++i]);
        if (!Number.isFinite(v)) usage(`${a} needs a number`);
        if ((a === "--x" || a === "--y") && (!Number.isInteger(v) || v < 0)) usage(`${a} needs a non-negative integer`);
        if (a === "--min") min = v;
        else if (a === "--max") max = v;
        else if (a === "--x") x = v;
        else y = v;
    } else if (a.startsWith("-")) {
        usage(`unknown argument: ${a}`);
    } else if (name === null) {
        name = a;
    } else {
        usage("one scenario name only");
    }
}
if (!name) usage("missing scenario name");
if (min !== null && max !== null && min > max) usage("--min is above --max");

const zipPath = resolve(RELEASE, `${name}.zip`);
const manifestPath = resolve(RELEASE, `${name}.scenario.json`);
if (!existsSync(ENGINE_BUNDLE)) {
    console.error(`Engine bundle not found at ${ENGINE_BUNDLE}. Run npm install in ScenarioCreator.`);
    process.exit(2);
}
if (!existsSync(zipPath) || !existsSync(manifestPath)) {
    console.error(`Scenario "${name}" is not built. In ScenarioCreator run:\n  node build-package.mjs --scenario ${name} && node build-manifest.mjs --scenario ${name}`);
    process.exit(2);
}

/** Newest Playwright browser build under %LOCALAPPDATA%/ms-playwright, or null. */
function playwrightExe(prefix, rel) {
    if (!process.env.LOCALAPPDATA) return null;
    const root = resolve(process.env.LOCALAPPDATA, "ms-playwright");
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root).filter((d) => d.startsWith(prefix)).sort().reverse();
    for (const d of dirs) {
        const exe = resolve(root, d, rel);
        if (existsSync(exe)) return exe;
    }
    return null;
}

function findBrowser() {
    if (process.env.BROWSER) {
        if (existsSync(process.env.BROWSER)) return process.env.BROWSER;
        throw new Error(`BROWSER is set but does not exist: ${process.env.BROWSER}`);
    }
    if (CHANNEL === "chromium") {
        const exe = playwrightExe("chromium-", path.join("chrome-win64", "chrome.exe"));
        if (exe) return exe;
        throw new Error("E2E_BROWSER_CHANNEL=chromium but no Playwright Chromium under %LOCALAPPDATA%/ms-playwright. Set BROWSER=<exe>.");
    }
    if (CHANNEL === "") {
        const exe = playwrightExe("chromium_headless_shell-", path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe"));
        if (exe) return exe;
        throw new Error("E2E_BROWSER_CHANNEL='' but no Playwright headless shell under %LOCALAPPDATA%/ms-playwright. Set BROWSER=<exe>.");
    }
    if (CHANNEL !== "msedge") {
        // ponytail: raw spawn knows three channels; run.mjs can pass any
        // Playwright channel. Add a mapping here when another one is needed,
        // or point BROWSER at the executable.
        throw new Error(`Unsupported E2E_BROWSER_CHANNEL "${CHANNEL}". Use msedge, chromium, empty (headless shell), or BROWSER=<exe>.`);
    }
    const candidates = [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    try {
        const out = execFileSync("where.exe", ["msedge.exe"], { encoding: "utf8" });
        const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (first && existsSync(first)) return first;
    } catch { /* fall through */ }
    throw new Error("No browser found. Set BROWSER=<path to msedge.exe or chrome.exe>.");
}

// The window is the render surface: Application._resize() sizes the backend to
// window.innerWidth/innerHeight, so --window-size=640,480 plus pixelRatio=1 in
// the harness makes the drawing buffer exactly 640x480 and (x, y) buffer coords.
const HARNESS = `<!doctype html>
<meta charset="utf-8">
<title>platform pixel check</title>
<style>html,body{margin:0;background:#111} canvas{display:block}</style>
<script type="importmap">
{ "imports": { "WebEngineTS": "/engine.js" } }
</script>
<canvas id="c" width="640" height="480"></canvas>
<script type="module">
import { Application } from "/engine.js";

const NAME = ${JSON.stringify(name)};
const X = ${x}, Y = ${y};
const payload = { ok: false };

// The engine's own statement that a frame reached the screen (verify-render's
// wait, copied): -1 until the first frame actually drew.
function waitForFirstFrame(scenario, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const started = performance.now();
        (function poll() {
            if (scenario.timeToFirstFrame >= 0) return resolve(scenario.timeToFirstFrame);
            if (performance.now() - started > timeoutMs) return resolve(-1);
            requestAnimationFrame(poll);
        })();
    });
}

const canvas = document.getElementById("c");
const app = new Application(canvas);
app.pixelRatio = 1; // buffer pixels == CSS pixels, whatever the display scale

try {
    const buf = await (await fetch("/r/" + NAME + ".zip")).arrayBuffer();
    const scenario = await app.loadScenarioFromBuffer(buf);
    const ttff = await waitForFirstFrame(scenario);
    if (ttff < 0) throw new Error("no frame rendered within 60s");
    // A few more frames so one-shot scenario setup has settled.
    await new Promise((done) => { let n = 0; (function tick() { if (++n > 5) return done(); requestAnimationFrame(tick); })(); });

    // Pixel route (D-14): _internalThreeRenderer is the engine's documented
    // @internal escape hatch to THREE.WebGLRenderer; _render() is TS-private
    // but a plain method in the shipped bundle. Render + readPixels in the
    // SAME task is the pattern Application.captureFrame itself uses, so the
    // frame is readable without preserveDrawingBuffer (plan assumption).
    const three = app._internalThreeRenderer;
    if (!three) throw new Error("Application._internalThreeRenderer is null — backend is not WebGL");
    app._render();
    const gl = three.getContext();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (X >= gl.drawingBufferWidth || Y >= gl.drawingBufferHeight) {
        throw new Error("pixel " + X + "," + Y + " outside drawing buffer " + gl.drawingBufferWidth + "x" + gl.drawingBufferHeight);
    }
    const px = new Uint8Array(4);
    // WebGL's origin is bottom-left; (X, Y) is measured from the top-left.
    gl.readPixels(X, gl.drawingBufferHeight - 1 - Y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    Object.assign(payload, {
        ok: true, rgba: [...px], ttff: Math.round(ttff),
        size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        renderer: gl.getParameter(gl.VERSION),
    });
} catch (err) {
    payload.error = String(err && err.message || err);
}

await fetch("/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
});
document.title = "done";
</script>`;

async function main() {
    const browser = findBrowser(); // before anything is opened, so a miss exits cleanly
    let resolveResult;
    const resultPromise = new Promise((resolve) => { resolveResult = resolve; });

    const server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/result") {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                res.writeHead(204);
                res.end();
                try { resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
                catch (err) { resolveResult({ error: `bad result payload: ${err.message}` }); }
            });
            return;
        }
        const url = new URL(req.url, "http://localhost").pathname;
        if (url === "/" || url === "/index.html") {
            res.writeHead(200, { "content-type": MIME[".html"] });
            res.end(HARNESS);
            return;
        }
        if (url === "/engine.js") {
            res.writeHead(200, { "content-type": MIME[".js"] });
            res.end(readFileSync(ENGINE_BUNDLE));
            return;
        }
        if (url.startsWith("/r/")) {
            const abs = path.join(RELEASE, url.slice(3));
            if (abs.startsWith(RELEASE) && existsSync(abs) && statSync(abs).isFile()) {
                res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
                res.end(readFileSync(abs));
                return;
            }
        }
        res.writeHead(404);
        res.end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const profile = mkdtempSync(path.join(tmpdir(), "platform-pixels-"));
    const flags = [
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--window-size=640,480",
        "--no-first-run", "--no-default-browser-check",
        "--disable-extensions", "--disable-background-networking",
        `--user-data-dir=${profile}`,
        base,
    ];
    // The headless shell is headless by nature; --headless=new is for the rest.
    if (!process.env.HEADFUL && !browser.includes("headless-shell")) flags.unshift("--headless=new", "--disable-gpu-sandbox");

    console.log(`[pixels] ${browser}`);
    console.log(`[pixels] ${name} from ${zipPath} at ${base}`);

    const child = spawn(browser, flags, { stdio: "ignore" });
    const timeoutMs = Number(process.env.RENDER_TIMEOUT_MS ?? 300000);
    const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ error: `timed out after ${timeoutMs}ms` }), timeoutMs));

    let payload;
    try {
        payload = await Promise.race([resultPromise, timeout]);
    } finally {
        child.kill();
        server.close();
        // Best-effort, as verify-render: Windows holds the profile briefly.
        try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            rmSync(profile, { recursive: true, force: true });
        } catch { /* left behind in %TEMP%; harmless */ }
    }

    if (!payload || payload.error || !payload.ok) {
        console.error(`[pixels] harness failed: ${payload?.error ?? "no result"}`);
        process.exit(2);
    }

    const [r, g, b, a] = payload.rgba;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    console.log(`pixels ${name}: luminance=${luminance.toFixed(4)} rgba=${r},${g},${b},${a} at=${x},${y}`);
    console.log(`[pixels] renderer: ${payload.renderer}`);
    console.log(`[pixels] buffer ${payload.size.join("x")}, ttff ${payload.ttff}ms`);

    let code = 0;
    if (min !== null && luminance < min) {
        console.error(`[pixels] FAIL luminance ${luminance.toFixed(4)} < --min ${min}`);
        code = 1;
    }
    if (max !== null && luminance > max) {
        console.error(`[pixels] FAIL luminance ${luminance.toFixed(4)} > --max ${max}`);
        code = 1;
    }
    process.exit(code);
}

await main().catch((err) => {
    console.error(`[pixels] harness failed: ${err.message}`);
    process.exit(2);
});
