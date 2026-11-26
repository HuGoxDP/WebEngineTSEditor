// checks-runner.test.mjs — tests for checks-runner and run-checks CLI
// Run with: node --test e2e/lib/checks-runner.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { listChecks, runChecks } from "./checks-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "../run-checks.mjs");

function createTempDir() {
    return mkdtempSync(join(tmpdir(), "ed-checks-test-"));
}

test("listChecks: empty, missing, non-.mjs files, subdirectories, only filter", () => {
    // Missing directory
    assert.deepEqual(listChecks("/path/to/nowhere/nonexistent"), []);

    // Empty directory
    const dir = createTempDir();
    try {
        assert.deepEqual(listChecks(dir), []);

        // Add non-.mjs files and subdirectories
        writeFileSync(join(dir, "README.md"), "# notes");
        writeFileSync(join(dir, "test.js"), "console.log(1)");
        writeFileSync(join(dir, "check-a.mjs"), "process.exit(0)");
        writeFileSync(join(dir, "check-b.mjs"), "process.exit(0)");
        writeFileSync(join(dir, "other-c.mjs"), "process.exit(0)");
        mkdirSync(join(dir, "nested.mjs")); // directory ending in .mjs should be ignored
        mkdirSync(join(dir, "subdir"));

        // Sorted list of *.mjs files
        assert.deepEqual(listChecks(dir), ["check-a.mjs", "check-b.mjs", "other-c.mjs"]);

        // with only filter
        assert.deepEqual(listChecks(dir, "check"), ["check-a.mjs", "check-b.mjs"]);
        assert.deepEqual(listChecks(dir, "other"), ["other-c.mjs"]);
        assert.deepEqual(listChecks(dir, "nomatch"), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runChecks: pass, exit code fail, throw fail, stderr but exit 0, timeout, output prefixing", async () => {
    const dir = createTempDir();
    try {
        // 1. Passing check (writes stdout, exits 0)
        writeFileSync(join(dir, "01-pass.mjs"), `
            console.log("hello from 01");
            process.exit(0);
        `);

        // 2. Failing check with exit code 2
        writeFileSync(join(dir, "02-fail-code.mjs"), `
            console.log("failing with 2");
            process.exit(2);
        `);

        // 3. Throws / unhandled error
        writeFileSync(join(dir, "03-throw.mjs"), `
            throw new Error("unhandled boom");
        `);

        // 4. Writes to stderr but exits 0 -> PASS
        writeFileSync(join(dir, "04-stderr-ok.mjs"), `
            console.error("warning on stderr");
            process.exit(0);
        `);

        // 5. Times out
        writeFileSync(join(dir, "05-timeout.mjs"), `
            await new Promise(r => setTimeout(r, 5000));
        `);

        const outputs = [];
        const writeSink = (str) => outputs.push(str);

        const { results, exitCode } = await runChecks({
            dir,
            timeoutMs: 500, // fast timeout for test
            label: (f) => `test/${f}`,
            write: writeSink,
        });

        assert.equal(exitCode, 1, "overall exit code must be 1 when failures exist");
        assert.equal(results.length, 5, "all 5 checks ran");

        // Verify result objects
        assert.deepEqual(results[0], { file: "01-pass.mjs", ok: true, reason: "" });
        assert.deepEqual(results[1], { file: "02-fail-code.mjs", ok: false, reason: "exit 2" });
        assert.equal(results[2].file, "03-throw.mjs");
        assert.equal(results[2].ok, false);
        assert.match(results[2].reason, /exit 1/);
        assert.deepEqual(results[3], { file: "04-stderr-ok.mjs", ok: true, reason: "" });
        assert.deepEqual(results[4], { file: "05-timeout.mjs", ok: false, reason: "timeout 500" });

        const fullOutput = outputs.join("");

        // Result lines
        assert.match(fullOutput, /PASS test\/01-pass\.mjs/);
        assert.match(fullOutput, /FAIL test\/02-fail-code\.mjs\s+—\s+exit 2/);
        assert.match(fullOutput, /FAIL test\/03-throw\.mjs\s+—\s+exit 1/);
        assert.match(fullOutput, /PASS test\/04-stderr-ok\.mjs/);
        assert.match(fullOutput, /FAIL test\/05-timeout\.mjs\s+—\s+timeout 500/);

        // Child output line prefixing (4 spaces)
        assert.match(fullOutput, / {4}hello from 01/);
        assert.match(fullOutput, / {4}failing with 2/);
        assert.match(fullOutput, / {4}warning on stderr/);

        // Summary line
        assert.match(fullOutput, /e2e:checks: 2 passed, 3 failed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runChecks: all passing gives exitCode 0", async () => {
    const dir = createTempDir();
    try {
        writeFileSync(join(dir, "pass1.mjs"), "process.exit(0);");
        writeFileSync(join(dir, "pass2.mjs"), "process.exit(0);");

        const outputs = [];
        const { results, exitCode } = await runChecks({
            dir,
            write: (s) => outputs.push(s),
        });

        assert.equal(exitCode, 0);
        assert.equal(results.length, 2);
        assert.ok(results.every(r => r.ok));
        assert.match(outputs.join(""), /e2e:checks: 2 passed, 0 failed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runChecks: fail-closed when no checks ran or directory missing", async () => {
    const outputs = [];
    const { results, exitCode } = await runChecks({
        dir: "/nonexistent/checks",
        write: (s) => outputs.push(s),
    });

    assert.equal(exitCode, 1, "must exit 1 when no checks ran");
    assert.deepEqual(results, []);
    assert.match(outputs.join(""), /e2e:checks: no checks ran/);
});

test("runChecks: fail-closed when ONLY filter matches nothing", async () => {
    const dir = createTempDir();
    try {
        writeFileSync(join(dir, "check1.mjs"), "process.exit(0);");
        const outputs = [];
        const { results, exitCode } = await runChecks({
            dir,
            only: "doesnotexist",
            write: (s) => outputs.push(s),
        });

        assert.equal(exitCode, 1);
        assert.deepEqual(results, []);
        assert.match(outputs.join(""), /e2e:checks: no checks ran/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("DW-1.2: CLI with invalid E2E_CHECK_TIMEOUT_MS prints error to stderr and exits 1", () => {
    for (const val of ["invalid", "-10", "0", "1.5"]) {
        const res = spawnSync(process.execPath, [CLI_PATH], {
            env: {
                ...process.env,
                E2E_CHECK_TIMEOUT_MS: val,
            },
            encoding: "utf8",
        });

        assert.equal(res.status, 1, `CLI with timeout ${val} should exit 1`);
        assert.match(res.stderr, /E2E_CHECK_TIMEOUT_MS must be a positive integer/);
    }
});
