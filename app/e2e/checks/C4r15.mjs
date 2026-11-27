// C4r15.mjs — AC-13: ToggleVisibility hides/shows renderers, not GameObject activity.
//
// The editor's Play loop does not feed Input to scripts yet (EdInput, MS-3), so
// this check wires Input itself the way Application does: Input._init(canvas)
// installs the DOM listeners (Application.ts:416) and Input._resetFrame() ends
// each one-frame pulse (Application.ts:1042). A real keydown/keyup event goes
// through those listeners; one scene._update() pass runs the scripts while the
// key is down, exactly as the engine loop does (Application.ts:955-962).
//
// Self-contained: new file, imports only from ../lib/harness.mjs. Contract:
//   node e2e/checks/C4r15.mjs <editor-url> — exit 0 iff every check passed.

import {
    newPage, seed, check, runCheck, noErrors, play, stop,
    SCENARIO_ENTRY, sceneWith, addFromLibrary,
} from "../lib/harness.mjs";

const FOLDER = "C4r15Visibility";
const ROOT = "Spinner";
const CHILD = "C4r15Child";
const KEY = "KeyV";

await runCheck(async () => {
    const page = await newPage(FOLDER, { probe: true });
    await seed(page, FOLDER, {
        "scenario.meta.json": JSON.stringify(
            { id: "c4r15-visibility", name: FOLDER, version: "1.0.0" }, null, 2) + "\n",
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        "assets/scenes/main.scene.json": sceneWith(ROOT),
    });
    await page.getByText("Open folder…").click();
    await page.waitForFunction(
        () => document.querySelector("app-hierarchy")?.innerText?.includes("Spinner") ?? false,
        null, { timeout: 30000 },
    );
    await page.locator("app-hierarchy li", { hasText: ROOT }).first().click();
    await addFromLibrary(page, "ToggleVisibility");
    await page.waitForFunction(
        () => window.__wetsProbe?.scriptClass("ToggleVisibility") != null,
        null, { timeout: 30000 },
    );
    check("ToggleVisibility library class is registered", true);

    // Build the target hierarchy with the engine namespace the editor exposes.
    // The engine namespace is the same instance every project script imports.
    const wired = await page.evaluate(([rootName, childName]) => {
        const eng = window.__wetsEngine;
        const scene = eng.SceneManager.activeScene;
        const root = scene.findGameObject(rootName);
        const canvas = document.querySelector("canvas[data-engine]");
        if (!root || !canvas) return `root/canvas missing: ${!!root}/${!!canvas}`;
        eng.Input._init(canvas); // Application.ts:416 — DOM -> Input
        const child = new eng.GameObject(childName);
        child.transform.setParent(root.transform, false);
        root.addComponent(eng.MeshRenderer);
        child.addComponent(eng.MeshRenderer);
        class Watch extends eng.ScriptableBehaviour {
            update() { window.__c4r15Ticks = (window.__c4r15Ticks || 0) + 1; }
        }
        root.addComponent(Watch);
        return null;
    }, [ROOT, CHILD]);
    check("Input wired; root and child each have a renderer", wired === null, String(wired));

    await play(page);

    const state = () => page.evaluate(([rootName, childName]) => {
        const eng = window.__wetsEngine;
        const scene = eng.SceneManager.activeScene;
        const root = scene.findGameObject(rootName);
        const child = scene.findGameObject(childName);
        const renderers = root ? root.getComponentsInChildren(eng.Renderer, true) : [];
        return {
            rootActive: root?.activeSelf ?? null,
            childActive: child?.activeSelf ?? null,
            childParent: child?.transform.parent?.gameObject?.name ?? null,
            renderers: renderers.length,
            enabled: renderers.map(r => r.enabled),
            visible: renderers.map(r => r.isActiveAndEnabled),
            ticks: window.__c4r15Ticks || 0,
        };
    }, [ROOT, CHILD]);

    // One frame of input: keydown -> one update pass -> frame reset -> keyup.
    // Synchronous in the page: the editor's RAF loop cannot interleave a pulse.
    const pulse = (code) => page.evaluate((keyCode) => {
        const eng = window.__wetsEngine;
        const scene = eng.SceneManager.activeScene;
        window.dispatchEvent(new KeyboardEvent("keydown", { code: keyCode, bubbles: true }));
        try { scene._update(); } finally { eng.Input._resetFrame(); }
        window.dispatchEvent(new KeyboardEvent("keyup", { code: keyCode, bubbles: true }));
        eng.Input._resetFrame();
    }, code);

    const before = await state();
    check("both renderers start enabled; object and child are active",
        before.renderers === 2 && before.enabled.every(Boolean)
        && before.rootActive === true && before.childActive === true
        && before.childParent === ROOT, JSON.stringify(before));

    await pulse(KEY);
    const hidden = await state();
    check("first key-down hides both renderers",
        hidden.enabled.length === 2 && hidden.enabled.every(v => v === false), JSON.stringify(hidden));
    check("hidden object and child stay active",
        hidden.rootActive === true && hidden.childActive === true, JSON.stringify(hidden));
    check("scripts keep updating while hidden",
        hidden.ticks > before.ticks, `${before.ticks} -> ${hidden.ticks}`);

    await pulse(KEY);
    const shown = await state();
    check("second key-down shows both renderers again",
        shown.enabled.length === 2 && shown.enabled.every(Boolean), JSON.stringify(shown));
    check("object and child are still active after the second press",
        shown.rootActive === true && shown.childActive === true, JSON.stringify(shown));
    check("scripts keep updating after the second press",
        shown.ticks > hidden.ticks, `${hidden.ticks} -> ${shown.ticks}`);

    await stop(page);
    check("no unexpected page errors", noErrors(page), page.logs.join(" | "));
});
