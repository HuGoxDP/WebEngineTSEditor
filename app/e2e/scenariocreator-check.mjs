// Does a project made by the editor survive the rest of the chain?
//
//   npm run e2e         # first: the wizard scenario exports a project to .shots/wizard-project
//   npm run e2e:build   # then: build it with ScenarioCreator and run it in the engine
//
// What it proves, in order: ScenarioCreator compiles the project's TypeScript and
// accepts its scenario.meta.json; the ZIP and the streaming manifest both load in
// the engine (headless Edge, via ScenarioCreator's own verify-render.mjs) and
// agree on what they built; and the scene the editor saved is really in there —
// the object count comes from the fixture's own scene JSON (the wizard's is two:
// a camera and a light).
//
// Fixtures (DW-7.5/7.6): .shots/wizard-project is required; .shots/pixels-lit,
// .shots/pixels-dark and .shots/catalog are optional and skipped with a note
// until run.mjs exports them. The pixels fixtures additionally run
// platform-pixels.mjs against the built ZIP (lit: --min 0.3, dark: --max 0.05).
// Every fixture's ZIP path + SHA-256 is printed before cleanup, for the report.
//
// Each project is copied into ../../ScenarioCreator/Scenarios/_EditorCheck*,
// which is another repository's working tree, and removed — with everything the
// build wrote for it — when that fixture is done, whether or not it passed. One
// fixture failing never skips another's cleanup.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../.shots");
const CREATOR = resolve(HERE, "../../../ScenarioCreator");
const RELEASE = resolve(CREATOR, "ReleaseScenarios");

const FIXTURES = [
    { key: "wizard-project", name: "_EditorCheck", required: true },
    { key: "pixels-lit", name: "_EditorCheckLit", pixel: ["--min", "0.3"] },
    { key: "pixels-dark", name: "_EditorCheckDark", pixel: ["--max", "0.05"] },
    { key: "catalog", name: "_EditorCheckCatalog" },
];

if (!existsSync(resolve(SHOTS, "wizard-project", "scenario.meta.json"))) {
    console.error("No exported project. Run `npm run e2e` first — its wizard scenario writes one to .shots/wizard-project.");
    process.exit(2);
}
if (!existsSync(resolve(CREATOR, "node_modules"))) {
    console.error("ScenarioCreator has no node_modules. Run `npm install` there first.");
    process.exit(2);
}

const run = (script, args) =>
    execFileSync(process.execPath, [resolve(CREATOR, script), ...args], { cwd: CREATOR, encoding: "utf8" });

function cleanup(name) {
    // The streaming manifest names the content-addressed objects it wrote; take back exactly those.
    const manifest = resolve(RELEASE, `${name}.scenario.json`);
    if (existsSync(manifest)) {
        const objects = new Set(readFileSync(manifest, "utf8").match(/objects\/[0-9a-f]{2}\/[0-9a-f]+\.[A-Za-z0-9]+/g) ?? []);
        for (const object of objects) rmSync(resolve(RELEASE, object), { force: true });
    }
    rmSync(resolve(RELEASE, `${name}.zip`), { force: true });
    rmSync(manifest, { force: true });
    rmSync(resolve(CREATOR, "Scenarios", name), { recursive: true, force: true });
}

let failed = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
    if (!ok) failed++;
};

/** Every game object in the fixture's own scene JSONs, children included. */
function sceneObjectCount(project) {
    const scenesDir = resolve(project, "assets", "scenes");
    if (!existsSync(scenesDir)) return null;
    let total = 0;
    const count = (go) => { total++; for (const child of go.children ?? []) count(child); };
    for (const file of readdirSync(scenesDir).filter((n) => n.endsWith(".scene.json"))) {
        const scene = JSON.parse(readFileSync(resolve(scenesDir, file), "utf8"));
        for (const root of scene.roots ?? []) count(root);
    }
    return total;
}

const tail = (err) => String(err.stdout ?? err.message).split("\n").slice(-6).join(" | ");

let fixturesRun = 0, fixturesFailed = 0;
for (const fixture of FIXTURES) {
    const project = resolve(SHOTS, fixture.key);
    if (!existsSync(resolve(project, "scenario.meta.json"))) {
        console.log(`SKIP  ${fixture.key} — no .shots/${fixture.key} export yet`);
        continue;
    }
    fixturesRun++;
    const failedBefore = failed;
    const { name } = fixture;
    console.log(`\n— ${fixture.key} (${name})`);

    try {
        cleanup(name);
        cpSync(project, resolve(CREATOR, "Scenarios", name), { recursive: true });

        try {
            run("build-package.mjs", ["--scenario", name]);
            check("ScenarioCreator builds the project", existsSync(resolve(RELEASE, `${name}.zip`)));
        } catch (err) {
            check("ScenarioCreator builds the project", false, tail(err));
            throw err;
        }

        run("build-manifest.mjs", ["--scenario", name]);
        const meta = JSON.parse(readFileSync(resolve(project, "scenario.meta.json"), "utf8"));
        const scenarioJson = JSON.parse(readFileSync(resolve(RELEASE, `${name}.scenario.json`), "utf8"));
        check("the manifest carries the id the wizard set", scenarioJson.id === meta.id, `${scenarioJson.id} vs ${meta.id}`);

        const out = run("verify-render.mjs", ["--scenario", name]);
        const lines = out.split("\n");
        check("the ZIP renders in the engine", lines.some(l => /^\s*zip\s+id=/.test(l)), out.split("\n").slice(-8).join(" | "));
        check("the manifest renders in the engine", lines.some(l => /^\s*manifest\s+id=/.test(l)));
        check("both paths agree on what they built", lines.some(l => l.includes("MATCH")));
        // C4r8 (D-4): an unresolvable component becomes a MissingComponent and
        // the engine warns `Unknown component type "<type>"`. The object count
        // alone passed with the component missing, so it proved nothing about
        // the Library-added script actually running on the platform.
        const unknownTypes = [...new Set([...out.matchAll(/Unknown component type "([^"]+)"/g)].map(m => m[1]))];
        check("no component went missing on the platform", unknownTypes.length === 0,
            `Unknown component type: ${unknownTypes.join(", ")}`);
        if (fixture.key === "wizard-project") {
            check("the scene's two objects were built", lines.filter(l => /objects=2\b/.test(l)).length === 2, lines.filter(l => l.includes("objects=")).join(" | "));
        } else {
            const expected = sceneObjectCount(project);
            check(
                `the scene's ${expected ?? "?"} objects (from the fixture's scene JSON) were built`,
                expected !== null && lines.filter(l => new RegExp(`objects=${expected}\\b`).test(l)).length === 2,
                lines.filter(l => l.includes("objects=")).join(" | ")
            );
        }

        // The report line (DW-7.6): where the ZIP is and what it hashes to,
        // while it still exists — cleanup below removes it.
        const zipPath = resolve(RELEASE, `${name}.zip`);
        if (existsSync(zipPath)) {
            const sha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
            console.log(`zip ${fixture.key}: ${zipPath} sha256=${sha}`);
        }

        if (fixture.pixel) {
            try {
                const pOut = execFileSync(
                    process.execPath,
                    [resolve(HERE, "platform-pixels.mjs"), name, ...fixture.pixel],
                    { encoding: "utf8" }
                );
                const line = pOut.split("\n").find((l) => l.startsWith("pixels "));
                check(`${fixture.key} pixel threshold (${fixture.pixel.join(" ")})`, Boolean(line), tail({ message: pOut }));
                if (line) console.log(line);
            } catch (err) {
                check(`${fixture.key} pixel threshold (${fixture.pixel.join(" ")})`, false,
                    `${String(err.stdout ?? "").trim()} ${String(err.stderr ?? err.message).trim()}`.split("\n").slice(-6).join(" | "));
            }
        }
    } catch (err) {
        if (failed === failedBefore) check("the chain ran", false, tail(err));
    } finally {
        cleanup(name);
    }
    if (failed > failedBefore) fixturesFailed++;
}

console.log(`\ne2e:build: ${fixturesRun} fixtures, ${fixturesFailed} failed`);
process.exit(failed === 0 ? 0 : 1);
