// C4r18.mjs — AC-14: a script written into the project folder outside the
// editor is loaded when the editor window regains focus. The formerly unstamped
// file must be treated as new so the runtime recompiles and registers its class,
// which Add Component then offers.

import {
    newPage, seed, check, noErrors, runCheck,
    SCENARIO_ENTRY, sceneWith,
} from "../lib/harness.mjs";

const OUTSIDE_SCRIPT = `import { ScriptableBehaviour, Serializable } from "WebEngineTS";

@Serializable({ typeName: "OutsideComer" })
export default class OutsideComer extends ScriptableBehaviour {
}
`;

await runCheck(async () => {
    const page = await newPage("FocusNewScript", { probe: true });
    await seed(page, "FocusNewScript", {
        "scenario.meta.json": JSON.stringify(
            { id: "focus-new-script", name: "FocusNewScript", version: "1.0.0" }, null, 2) + "\n",
        "scripts/Scenario.ts": SCENARIO_ENTRY,
        "assets/scenes/main.scene.json": sceneWith("Seeded"),
    });

    await page.getByText("Open folder…").click();
    await page.locator(".work").waitFor({ timeout: 30000 });
    await page.waitForFunction(
        () => window.__wetsProbe?.scriptClass("OutsideComer") === null,
        null, { timeout: 30000 },
    );
    check("the class is not registered before the file exists", true);

    // Written outside the editor — only into the project folder on "disk".
    await seed(page, "FocusNewScript", {
        "scripts/components/OutsideComer.ts": OUTSIDE_SCRIPT,
    });

    // The editor window regains focus.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    const registered = await page.waitForFunction(
        () => window.__wetsProbe?.scriptClass("OutsideComer") !== null,
        null, { timeout: 30000 },
    ).then(() => true, () => false);
    check("focus loads the unstamped script and registers its class", registered);

    // AC-14's user-visible side: Add Component offers the class.
    await page.locator("app-hierarchy li", { hasText: "Seeded" }).first().click();
    await page.locator(".insp-body .add-comp", { hasText: "Add component" }).first().click();
    await page.waitForTimeout(400);
    const offered = await page.locator(".add-list li", { hasText: "OutsideComer" }).count();
    check("Add Component offers the loaded class", offered > 0);

    check("no dialog was needed", (await page.locator(".dlg").count()) === 0);
    check("no native dialogs were used", page.nativeDialogs === 0);
    check("no page errors", noErrors(page), page.logs.join(" | "));
});
