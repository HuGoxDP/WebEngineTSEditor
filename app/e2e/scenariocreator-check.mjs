// Does a project made by the editor survive the rest of the chain?
//
//   npm run e2e         # first: the wizard scenario exports a project to .shots/wizard-project
//   npm run e2e:build   # then: build it with ScenarioCreator and run it in the engine
//
// What it proves, in order: ScenarioCreator compiles the project's TypeScript and
// accepts its scenario.meta.json; the ZIP and the streaming manifest both load in
// the engine (headless Edge, via ScenarioCreator's own verify-render.mjs) and
// agree on what they built; and the scene the editor saved is really in there —
// two objects, a camera and a light.
//
// It copies the project into ../../ScenarioCreator/Scenarios/_EditorCheck, which
// is another repository's working tree, and removes it — and everything the build
// wrote for it — when it is done, whether or not it passed.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "../../.shots/wizard-project");
const CREATOR = resolve(HERE, "../../../ScenarioCreator");
const NAME = "_EditorCheck";
const SCENARIO_DIR = resolve(CREATOR, "Scenarios", NAME);
const RELEASE = resolve(CREATOR, "ReleaseScenarios");

if (!existsSync(resolve(PROJECT, "scenario.meta.json"))) {
    console.error("No exported project. Run `npm run e2e` first — its wizard scenario writes one to .shots/wizard-project.");
    process.exit(2);
}
if (!existsSync(resolve(CREATOR, "node_modules"))) {
    console.error("ScenarioCreator has no node_modules. Run `npm install` there first.");
    process.exit(2);
}

const run = (script, args) =>
    execFileSync(process.execPath, [resolve(CREATOR, script), ...args], { cwd: CREATOR, encoding: "utf8" });

function cleanup() {
    // The streaming manifest names the content-addressed objects it wrote; take back exactly those.
    const manifest = resolve(RELEASE, `${NAME}.scenario.json`);
    if (existsSync(manifest)) {
        const objects = new Set(readFileSync(manifest, "utf8").match(/objects\/[0-9a-f]{2}\/[0-9a-f]+\.[A-Za-z0-9]+/g) ?? []);
        for (const object of objects) rmSync(resolve(RELEASE, object), { force: true });
    }
    rmSync(resolve(RELEASE, `${NAME}.zip`), { force: true });
    rmSync(manifest, { force: true });
    rmSync(SCENARIO_DIR, { recursive: true, force: true });
}

let failed = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
    if (!ok) failed++;
};

try {
    cleanup();
    cpSync(PROJECT, SCENARIO_DIR, { recursive: true });

    try {
        run("build-package.mjs", ["--scenario", NAME]);
        check("ScenarioCreator builds the project", existsSync(resolve(RELEASE, `${NAME}.zip`)));
    } catch (err) {
        check("ScenarioCreator builds the project", false, String(err.stdout ?? err.message).split("\n").slice(-6).join(" | "));
        throw err;
    }

    run("build-manifest.mjs", ["--scenario", NAME]);
    const meta = JSON.parse(readFileSync(resolve(PROJECT, "scenario.meta.json"), "utf8"));
    const scenarioJson = JSON.parse(readFileSync(resolve(RELEASE, `${NAME}.scenario.json`), "utf8"));
    check("the manifest carries the id the wizard set", scenarioJson.id === meta.id, `${scenarioJson.id} vs ${meta.id}`);

    const out = run("verify-render.mjs", ["--scenario", NAME]);
    const lines = out.split("\n");
    check("the ZIP renders in the engine", lines.some(l => /^\s*zip\s+id=/.test(l)), out.split("\n").slice(-8).join(" | "));
    check("the manifest renders in the engine", lines.some(l => /^\s*manifest\s+id=/.test(l)));
    check("both paths agree on what they built", lines.some(l => l.includes("MATCH")));
    check("the scene's two objects were built", lines.filter(l => /objects=2\b/.test(l)).length === 2, lines.filter(l => l.includes("objects=")).join(" | "));
} catch (err) {
    if (!failed) check("the chain ran", false, String(err.stdout ?? err.message).split("\n").slice(-6).join(" | "));
} finally {
    cleanup();
}

console.log(failed === 0 ? "\nThe editor's project builds and runs." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
