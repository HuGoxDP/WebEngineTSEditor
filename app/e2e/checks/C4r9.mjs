// C4r9.mjs — AC-16 black-box proof: the editor runs user scripts only in Play.
//
// A script whose `awake` creates a GameObject("Spawned") and whose `onEnable`
// leaves a marker is seeded into its own OPFS project. The check then walks the
// editor as a user: open, add component, undo/redo, save, save the script, Play,
// Stop, save the script again, replay. In every editing leg the markers must be
// empty and no `Spawned` object may exist; Play must wake each instance exactly
// once; Stop must return to edit mode on the pre-Play scene.
//
// This file is self-contained: it imports only from ../lib/harness.mjs and keeps
// its fixture and probes inline. It edits no harness, runner or other check.
// Contract: `node e2e/checks/C4r9.mjs <editor-url>` — exit 0 iff every leg passed.

import {
    newPage, seed, readDisk, check, runCheck, play, stop, save,
    selectInHierarchy, editScript, noErrors, SCENARIO_ENTRY,
} from "../lib/harness.mjs";

const FOLDER = "C4r9Parent";
const SCENE_PATH = "assets/scenes/main.scene.json";
// A script save intentionally re-registers a class. The engine's advisory is
// expected (run.mjs filters it too); every other console line is a real error.
const SWAP_ADVISORY = "already registered to a different class";

// V2/V3 differ from the seed only by a trailing comment: Babel keeps comments,
// so the compiled module is fresh and the editor swaps the registered class.
const WAKE_MARKER = `import { ScriptableBehaviour, Serializable, GameObject } from "WebEngineTS";

@Serializable({ typeName: "WakeMarker" })
export default class WakeMarker extends ScriptableBehaviour {
    public override awake(): void {
        const m = (globalThis.__c4r9 ??= { awake: [], enable: [], disable: [] });
        m.awake.push(this.gameObject.name);
        new GameObject("Spawned");
    }

    public override onEnable(): void {
        const m = (globalThis.__c4r9 ??= { awake: [], enable: [], disable: [] });
        m.enable.push(this.gameObject.name);
    }

    public override onDisable(): void {
        const m = (globalThis.__c4r9 ??= { awake: [], enable: [], disable: [] });
        m.disable.push(this.gameObject.name);
    }
}
`;
const WAKE_MARKER_V2 = WAKE_MARKER + "// C4r9: second revision\n";
const WAKE_MARKER_V3 = WAKE_MARKER + "// C4r9: third revision\n";

const TRANSFORM = () => ({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
});

// A component is serialized as { type, fields } (the editor's own format).
const MAIN_SCENE = JSON.stringify({
    name: "Main", version: 1,
    roots: [
        {
            name: "Holder", active: true, transform: TRANSFORM(),
            components: [{ type: "WakeMarker", fields: {} }], children: [],
        },
        {
            name: "Target", active: true, transform: TRANSFORM(),
            components: [], children: [],
        },
    ],
});

runCheck(async () => {
    const page = await newPage(FOLDER);

    await seed(page, FOLDER, {
        "scenario.meta.json": JSON.stringify(
            { id: "c4r9-parent", name: FOLDER, version: "1.0.0" }, null, 2) + "\n",
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        "scripts/components/WakeMarker.ts": WAKE_MARKER,
        [SCENE_PATH]: MAIN_SCENE,
    });

    // Probes read live page state — never a Node-side copy of the marker object.
    const marks = () => page.evaluate(
        () => globalThis.__c4r9 ?? { awake: [], enable: [], disable: [] });
    const spawnedInMemory = () => page.evaluate(
        () => globalThis.__wetsEngine.SceneManager.activeScene
            .getRootGameObjects().filter(o => o.name === "Spawned").length);
    const treeNames = () => page.locator("app-hierarchy li .label").allInnerTexts();
    const savedScene = async () => {
        const text = await readDisk(page, FOLDER, SCENE_PATH);
        return text === null ? null : JSON.parse(text);
    };
    const savedRoots = async () => (await savedScene())?.roots.map(r => r.name) ?? [];

    const empty = m => m.awake.length === 0 && m.enable.length === 0 && m.disable.length === 0;
    const sorted = a => [...a].sort();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // Store the current constructor on the page so a rebuild can be observed.
    const rememberCtor = () => page.evaluate(() => {
        window.__c4r9Prev = globalThis.__wetsEngine.TypeRegistry.get("WakeMarker");
    });
    const waitRebuild = async leg => {
        let happened = true;
        try {
            await page.waitForFunction(
                () => globalThis.__wetsEngine.TypeRegistry.get("WakeMarker") !== window.__c4r9Prev,
                null, { timeout: 30000 },
            );
        } catch {
            happened = false;
        }
        check(`${leg}: rebuild happened`, happened);
        await page.waitForTimeout(500);
    };

    // 1. open — the editor boots in edit mode; deserializing must not wake scripts.
    await page.getByText("Open folder…").click();
    await page.waitForFunction(() => {
        const text = document.querySelector("app-hierarchy")?.innerText ?? "";
        return text.includes("Holder") && text.includes("Target");
    }, null, { timeout: 30000 });
    await page.waitForTimeout(1000);

    const mOpen = await marks();
    check("open: no awake on open", mOpen.awake.length === 0, JSON.stringify(mOpen));
    check("open: no onEnable on open", mOpen.enable.length === 0, JSON.stringify(mOpen));
    check("open: no onDisable on open", mOpen.disable.length === 0, JSON.stringify(mOpen));
    const spOpen = await spawnedInMemory();
    check("open: nothing spawned in memory", spOpen === 0, String(spOpen));
    const treeOpen = await treeNames();
    check("open: no Spawned in hierarchy",
        !treeOpen.some(n => n.trim() === "Spawned"), treeOpen.join(","));

    // 2. add — adding a component is an edit-world operation.
    await selectInHierarchy(page, "Target");
    await page.locator(".insp-body .add-comp").first().click();
    await page.waitForTimeout(300);
    const addItems = page.locator(".add-list li:not(.lib-head)");
    const addTexts = await addItems.allInnerTexts();
    const addIndex = addTexts.findIndex(t => t.trim() === "WakeMarker");
    check("add: WakeMarker is offered", addIndex >= 0, addTexts.join(","));
    if (addIndex >= 0) {
        await addItems.nth(addIndex).click();
        await page.waitForFunction(
            () => document.querySelector(".insp-body")?.innerText?.includes("WakeMarker") ?? false,
            null, { timeout: 30000 },
        );
    }
    await page.waitForTimeout(500);
    const mAdd = await marks();
    check("add: no awake on add", empty(mAdd), JSON.stringify(mAdd));
    const spAdd = await spawnedInMemory();
    check("add: nothing spawned in memory", spAdd === 0, String(spAdd));
    const treeAdd = await treeNames();
    check("add: no Spawned in hierarchy",
        !treeAdd.some(n => n.trim() === "Spawned"), treeAdd.join(","));

    // 3. undo/redo — neither history direction may run user code.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    const mUndo = await marks();
    check("undo: no awake on undo", empty(mUndo), JSON.stringify(mUndo));
    const spUndo = await spawnedInMemory();
    check("undo: nothing spawned in memory", spUndo === 0, String(spUndo));

    await page.keyboard.press("Control+y");
    await page.waitForTimeout(300);
    const mRedo = await marks();
    check("undo: no awake on redo", empty(mRedo), JSON.stringify(mRedo));
    const spRedo = await spawnedInMemory();
    check("undo: nothing spawned in memory after redo", spRedo === 0, String(spRedo));
    await selectInHierarchy(page, "Target");
    check("undo: WakeMarker is back on Target",
        (await page.locator(".insp-body").innerText()).includes("WakeMarker"));

    // 4. save — the scene on disk must hold exactly the two authored roots.
    await save(page);
    const rootsSaved = await savedRoots();
    check("save: roots are Holder and Target",
        same(rootsSaved, ["Holder", "Target"]), JSON.stringify(rootsSaved));
    const scriptedSaved = ((await savedScene())?.roots ?? [])
        .filter(r => r.components?.some(c => c.type === "WakeMarker"))
        .map(r => r.name).sort();
    check("save: both roots hold WakeMarker",
        same(scriptedSaved, ["Holder", "Target"]), JSON.stringify(scriptedSaved));
    const mSave = await marks();
    check("save: no awake on save", empty(mSave), JSON.stringify(mSave));

    // 5. script save — a class swap rebuilds the scene, still in edit mode.
    await rememberCtor();
    await editScript(page, "WakeMarker.ts", WAKE_MARKER_V2);
    await waitRebuild("script save");
    const mScript = await marks();
    check("script save: no awake on rebuild", empty(mScript), JSON.stringify(mScript));
    const spScript = await spawnedInMemory();
    check("script save: nothing spawned in memory", spScript === 0, String(spScript));
    const treeScript = await treeNames();
    check("script save: no Spawned in hierarchy",
        !treeScript.some(n => n.trim() === "Spawned"), treeScript.join(","));

    // 6. play — the engine's wake pass runs once per script instance.
    await play(page);
    await page.waitForTimeout(1500);
    const mPlay = await marks();
    check("play: awake once per script instance",
        same(sorted(mPlay.awake), ["Holder", "Target"]), JSON.stringify(mPlay.awake));
    check("play: onEnable once per script instance",
        same(sorted(mPlay.enable), ["Holder", "Target"]), JSON.stringify(mPlay.enable));
    const spPlay = await spawnedInMemory();
    check("play: two Spawned objects in memory", spPlay === 2, String(spPlay));
    const treePlay = await treeNames();
    check("play: hierarchy lists two Spawned rows",
        treePlay.filter(n => n.trim() === "Spawned").length === 2, treePlay.join(","));
    await page.waitForTimeout(1000);
    const mPlayLater = await marks();
    check("play: no double wake",
        same(mPlayLater.awake, mPlay.awake) && same(mPlayLater.enable, mPlay.enable),
        JSON.stringify(mPlayLater));

    // 7. stop — teardown pairs onDisable and restores the pre-Play scene.
    await stop(page);
    await page.waitForTimeout(500);
    const mStop = await marks();
    check("stop: awake marks unchanged", same(mStop.awake, mPlay.awake), JSON.stringify(mStop.awake));
    check("stop: enable marks unchanged", same(mStop.enable, mPlay.enable), JSON.stringify(mStop.enable));
    check("stop: onDisable once per script instance",
        same(sorted(mStop.disable), ["Holder", "Target"]), JSON.stringify(mStop.disable));
    const spStop = await spawnedInMemory();
    check("stop: nothing spawned in memory", spStop === 0, String(spStop));
    const treeStop = await treeNames();
    check("stop: roots are Holder and Target",
        same(treeStop.map(n => n.trim()).sort(), ["Holder", "Target"]), treeStop.join(","));
    check("stop: engine is back in edit mode",
        (await page.evaluate(() => globalThis.__wetsEngine.Application.isPlaying)) === false);

    // 8. after stop — a rebuild and a save in edit mode are both inert.
    await rememberCtor();
    await editScript(page, "WakeMarker.ts", WAKE_MARKER_V3);
    await waitRebuild("after stop");
    const mAfter = await marks();
    check("after stop: marks unchanged",
        same(mAfter.awake, mStop.awake)
        && same(mAfter.enable, mStop.enable)
        && same(mAfter.disable, mStop.disable), JSON.stringify(mAfter));
    const spAfter = await spawnedInMemory();
    check("after stop: nothing spawned in memory", spAfter === 0, String(spAfter));
    await save(page);
    const rootsAfter = await savedRoots();
    check("after stop: saved roots are still Holder and Target",
        same(rootsAfter, ["Holder", "Target"]), JSON.stringify(rootsAfter));

    // 9. replay — the second Play wakes the same instances again.
    await play(page);
    await page.waitForTimeout(1500);
    const mReplay = await marks();
    check("replay: four awake marks", mReplay.awake.length === 4, JSON.stringify(mReplay.awake));
    check("replay: each instance woke twice",
        mReplay.awake.filter(n => n === "Holder").length === 2
        && mReplay.awake.filter(n => n === "Target").length === 2,
        JSON.stringify(mReplay.awake));
    await stop(page);
    const spReplay = await spawnedInMemory();
    check("replay: stop cleared Spawned", spReplay === 0, String(spReplay));

    // 10. clean — no dialogs, and nothing unexpected in the console.
    check("clean: no native dialogs", page.nativeDialogs === 0, String(page.nativeDialogs));
    check("clean: no unexpected page errors",
        noErrors(page) || page.logs.every(l => l.includes(SWAP_ADVISORY)),
        page.logs.join(" | "));
});
