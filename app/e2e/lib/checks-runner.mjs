// checks-runner.mjs — runner for app/e2e/checks/*.mjs
//
// Each check is run as its own child process:
//   node <check> [url]
// Exit 0 → PASS. Anything else, a timeout, or a spawn error → FAIL.
// Child stdout/stderr are relayed live, each line prefixed with four spaces.
// No column-0 line from a child can be mistaken for a runner result line.
//
// Exports:
//   listChecks(dir, only?) → string[]   sorted *.mjs basenames directly in dir
//   runChecks(opts)        → Promise<{ results, exitCode }>
//
// contract for checks/<ID>.mjs:
//   - receives the editor URL as process.argv[2]
//   - exits 0 on full pass, non-zero on any failure
//   - may import from "../lib/harness.mjs"
//   - run only inside editor-e2e.lock

import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { platform } from "node:process";

/**
 * Returns sorted *.mjs basenames directly in `dir`.
 * Returns [] when dir is missing or contains no *.mjs files.
 * An optional `only` string filters by substring on the basename.
 */
export function listChecks(dir, only) {
    if (!existsSync(dir)) return [];
    let names;
    try {
        names = readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile() && e.name.endsWith(".mjs"))
            .map(e => e.name)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch {
        return [];
    }
    if (only) names = names.filter(n => n.includes(only));
    return names;
}

/**
 * Kills a process tree rooted at `pid`.
 * On win32: taskkill /pid <pid> /T /F
 * On POSIX: process.kill(-pid, "SIGKILL")  (requires detached child)
 */
function killTree(pid) {
    try {
        if (platform === "win32") {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else {
            process.kill(-pid, "SIGKILL");
        }
    } catch {
        // ignore: process may have already exited
    }
}

/**
 * Runs every check in `opts.dir` matching `opts.only`, in sorted order.
 *
 * @param {object} opts
 * @param {string}   opts.dir          - directory containing checks/*.mjs
 * @param {string}   [opts.url]        - passed as argv[2] to each check
 * @param {string}   [opts.only]       - substring filter on the basename
 * @param {number}   [opts.timeoutMs]  - per-file timeout in ms (default 600000)
 * @param {function} [opts.label]      - how to label a file in result lines
 * @param {function} [opts.write]      - output sink (default process.stdout.write)
 * @returns {Promise<{ results: Array<{file, ok, reason}>, exitCode: 0|1 }>}
 */
export async function runChecks(opts) {
    const {
        dir,
        url,
        only,
        timeoutMs = 600_000,
        label = (f) => `e2e/checks/${f}`,
        write = (line) => process.stdout.write(line),
    } = opts;

    const files = listChecks(dir, only);

    if (files.length === 0) {
        write("e2e:checks: no checks ran\n");
        return { results: [], exitCode: 1 };
    }

    const results = [];

    for (const file of files) {
        const filePath = `${dir}/${file}`;
        const tag = label(file);
        const result = await runOne(filePath, url, timeoutMs, write);
        results.push({ file, ok: result.ok, reason: result.reason });
        if (result.ok) {
            write(`PASS ${tag}\n`);
        } else {
            const reasonStr = result.reason ? `  — ${result.reason}` : "";
            write(`FAIL ${tag}${reasonStr}\n`);
        }
    }

    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    write(`e2e:checks: ${passed} passed, ${failed} failed\n`);

    const exitCode = results.length > 0 && results.every(r => r.ok) ? 0 : 1;
    return { results, exitCode };
}

/**
 * Spawns one check as a child process, relays its output live (4-space prefix),
 * and resolves with { ok, reason }.
 */
function runOne(filePath, url, timeoutMs, write) {
    return new Promise((resolve) => {
        const args = url !== undefined ? [filePath, url] : [filePath];
        let child;
        try {
            child = spawn(process.execPath, args, {
                stdio: "pipe",
                // detached on POSIX so we can kill the process group
                ...(platform !== "win32" ? { detached: true } : {}),
            });
        } catch (err) {
            resolve({ ok: false, reason: `spawn error: ${err.message}` });
            return;
        }

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, timeoutMs);

        // Relay output live, 4-space prefix, line-by-line
        const relay = (stream) => {
            let buf = "";
            stream.on("data", (chunk) => {
                buf += chunk.toString();
                const lines = buf.split("\n");
                buf = lines.pop(); // last partial line
                for (const line of lines) {
                    write(`    ${line}\n`);
                }
            });
            stream.on("end", () => {
                if (buf) {
                    write(`    ${buf}\n`);
                    buf = "";
                }
            });
        };

        relay(child.stdout);
        relay(child.stderr);

        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ ok: false, reason: `spawn error: ${err.message}` });
        });

        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                resolve({ ok: false, reason: `timeout ${timeoutMs}` });
            } else if (signal !== null) {
                resolve({ ok: false, reason: `signal ${signal}` });
            } else if (code === 0) {
                resolve({ ok: true, reason: "" });
            } else {
                resolve({ ok: false, reason: `exit ${code}` });
            }
        });
    });
}
