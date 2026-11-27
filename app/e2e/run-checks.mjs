// run-checks.mjs — CLI for npm run e2e:checks
//
// Usage:
//   node e2e/run-checks.mjs [editor-url]
//   npm run e2e:checks -- [editor-url]
//
// Knobs (environment variables):
//   ONLY                   substring filter on check basenames
//   E2E_CHECK_TIMEOUT_MS   per-file timeout in ms (positive integer, default 600000)
//   E2E_CHECKS_DIR         directory of checks (default: <this file's dir>/checks)
//
// contract for checks/<ID>.mjs (each is run as its own process):
//   - receives the editor URL as process.argv[2] when provided
//   - exits 0 on full pass, non-zero on any failure
//   - may import from "../lib/harness.mjs"
//   - run only inside editor-e2e.lock (wk.sh lock editor-e2e <slot> <task>)

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./lib/checks-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
const only = process.env.ONLY;
const dir = process.env.E2E_CHECKS_DIR ?? resolve(HERE, "checks");

let timeoutMs = 600_000;
if (process.env.E2E_CHECK_TIMEOUT_MS !== undefined) {
    const raw = Number(process.env.E2E_CHECK_TIMEOUT_MS);
    if (!Number.isInteger(raw) || raw <= 0) {
        process.stderr.write(`e2e:checks: E2E_CHECK_TIMEOUT_MS must be a positive integer, got: ${JSON.stringify(process.env.E2E_CHECK_TIMEOUT_MS)}\n`);
        process.exit(1);
    }
    timeoutMs = raw;
}

const { exitCode } = await runChecks({
    dir,
    url,
    only,
    timeoutMs,
    label: (f) => `e2e/checks/${f}`,
    write: (line) => process.stdout.write(line),
});

process.exit(exitCode);
