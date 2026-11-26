// harness.test.mjs — unit and fidelity tests for app/e2e/lib/harness.mjs
// Run with: node --test e2e/lib/harness.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import * as harness from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = resolve(HERE, "../run.mjs");
const HARNESS_URL = pathToFileURL(resolve(HERE, "harness.mjs")).href;

// Exactly 29 verbatim function exports from run.mjs
const VERBATIM_FUNCTIONS = [
    "siblingPage", "instrument",
    "pick", "seed", "diskState", "readDisk", "exportFolder",
    "slowAutosave", "slowLibraryWrite", "failNextWrite", "failReads", "holdScriptRead", "holdStampRead",
    "shot", "dialogTitle", "dialogButton", "menu", "noErrors",
    "seedScriptProject", "openEmptyProject", "sceneWith", "sceneAt", "oneRoot", "meta",
    "openLibraryProject", "addFromLibrary", "editScript", "opfsEntries", "opfsRead",
];

const TEN_LIBRARY_NAMES = [
    "Rotator", "Mover", "Clickable", "ToggleVisibility", "ShowTextOnClick",
    "QuizQuestion", "Timer", "FollowPath", "LookAtCamera", "PlayAnimation",
];

test("DW-2.1: verbatim helper fidelity against run.mjs", () => {
    const raw = readFileSync(RUN_MJS, "utf8");
    const src = raw.replace(/\r\n/g, "\n");

    assert.equal(VERBATIM_FUNCTIONS.length, 29, "must verify exactly 29 verbatim functions");

    for (const name of VERBATIM_FUNCTIONS) {
        const fn = harness[name];
        assert.equal(typeof fn, "function", `harness must export function ${name}`);
        const fnStr = fn.toString();
        assert.ok(
            src.includes(fnStr),
            `Function ${name} implementation must be verbatim in run.mjs\n` +
            `Looked for:\n${fnStr.slice(0, 100)}...`
        );
    }

    assert.ok(src.includes(harness.ROTATOR), "ROTATOR constant must match run.mjs verbatim");
    assert.ok(src.includes(harness.SCENARIO_ENTRY), "SCENARIO_ENTRY constant must match run.mjs verbatim");
    assert.deepEqual(harness.LIBRARY_NAMES, TEN_LIBRARY_NAMES, "LIBRARY_NAMES must match 10 shipped behaviors");
});

test("DW-2.2: harness import has no side effects (no playwright require or browser launch)", () => {
    const res = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(HARNESS_URL)});`,
    ], {
        env: {
            ...process.env,
            E2E_PLAYWRIGHT_DIR: "C:/nonexistent/playwright/dir",
        },
        encoding: "utf8",
    });

    assert.equal(res.status, 0, `import failed with stderr: ${res.stderr}`);
});

test("DW-2.3: dirty tests, fail-closed runCheck behavior", () => {
    // Case 1: no checks run -> exit 1, prints line saying no check ran
    {
        const script = `
            import { runCheck } from ${JSON.stringify(HARNESS_URL)};
            await runCheck(async () => {});
        `;
        const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
        assert.equal(res.status, 1, "empty runCheck must exit 1");
        assert.match(res.stdout + res.stderr, /no checks ran/i, "must print that no checks ran");
    }

    // Case 2: failing check -> exit 1, prints FAIL x — d
    {
        const script = `
            import { runCheck, check } from ${JSON.stringify(HARNESS_URL)};
            await runCheck(async () => {
                check("x", false, "d");
            });
        `;
        const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
        assert.equal(res.status, 1, "failing check must exit 1");
        assert.match(res.stdout, /FAIL\s+x\s+—\s+d/, "must print FAIL  x  — d");
    }

    // Case 3: threw error -> exit 1, prints FAIL scenario completed containing error message
    {
        const script = `
            import { runCheck } from ${JSON.stringify(HARNESS_URL)};
            await runCheck(async () => {
                throw new Error("boom");
            });
        `;
        const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
        assert.equal(res.status, 1, "thrown error in runCheck must exit 1");
        assert.match(res.stdout, /FAIL\s+scenario completed\s+—\s+boom/, "must print FAIL  scenario completed  — boom");
    }

    // Case 4: passing check -> exit 0
    {
        const script = `
            import { runCheck, check } from ${JSON.stringify(HARNESS_URL)};
            await runCheck(async () => {
                check("x", true);
            });
        `;
        const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
        assert.equal(res.status, 0, "passing runCheck must exit 0");
        assert.match(res.stdout, /PASS\s+x/, "must print PASS  x");
    }
});

test("DW-2.4: noErrors synthetic cases from run.mjs B1r5", () => {
    const withLogs = logs => ({ logs, nativeDialogs: 0 });

    assert.equal(
        harness.noErrors(withLogs(["[error] GL Driver Message (OpenGL, Error, GL_INVALID_OPERATION in glDrawElements)"])),
        false,
        "a synthetic GL Driver Message of Error severity FAILS noErrors"
    );
    assert.equal(
        harness.noErrors(withLogs(["[pageerror] TypeError: x is not a function"])),
        false,
        "a plain page error fails noErrors"
    );
    assert.equal(
        harness.noErrors(withLogs(["[warning] GL Driver Message (OpenGL, Performance, GPU stall due to ReadPixels)"])),
        true,
        "the performance note is still excused"
    );
    assert.equal(
        harness.noErrors(withLogs(["[warning] GPU stall due to ReadPixels"])),
        true,
        "the ReadPixels stall warning alone is excused"
    );
    assert.equal(
        harness.noErrors(withLogs(["[error] Failed to load resource: the server responded with a status of 404"])),
        true,
        "an asset 404 is excused"
    );
    assert.equal(
        harness.noErrors(withLogs([])),
        true,
        "an empty log passes"
    );
    assert.equal(
        harness.noErrors(withLogs([
            "[warning] GL Driver Message (OpenGL, Performance, GPU stall due to ReadPixels)",
            "[error] GL Driver Message (OpenGL, Error, GL_OUT_OF_MEMORY)",
        ])),
        false,
        "a real error among excused lines still fails"
    );
});
