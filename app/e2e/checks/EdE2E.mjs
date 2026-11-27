// EdE2E.mjs — smoke test for the editor check harness (AC-9)
//
// Opens the editor, creates a seeded project, verifies the start page loads
// and project structure opens correctly.

import { newPage, seed, check, noErrors, closeBrowser, SCENARIO_ENTRY } from "../lib/harness.mjs";

console.log("EdE2E smoke test starting...");

const page = await newPage("EdE2EDemo", { probe: true });

// Verify title / start screen
await page.waitForSelector("app-start", { timeout: 15000 });
check("editor start screen is visible", true);

// Seed and open project
await seed(page, "EdE2EDemo", {
    "scenario.meta.json": JSON.stringify({ id: "ed-e2e-demo", name: "EdE2EDemo", version: "1.0.0" }, null, 2) + "\n",
    "scripts/Scenario.ts": SCENARIO_ENTRY,
    "assets/scenes/main.scene.json": JSON.stringify({ name: "Main", version: 1, roots: [] }, null, 2) + "\n",
});

await page.getByText("Open folder…").click();
await page.waitForFunction(
    () => document.querySelector("app-hierarchy") !== null,
    null, { timeout: 15000 },
);

check("no page errors during smoke test", noErrors(page), page.logs.join(" | "));

await closeBrowser();
console.log("EdE2E smoke test passed.");
process.exit(0);
