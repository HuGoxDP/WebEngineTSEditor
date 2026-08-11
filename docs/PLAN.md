# WebEngineTSEditor — plan

Drafted 2026-08-11, against `master` (`9fbda66`, the single `init` commit).

Companion to the engine's [`design/handoff-boundary.md`](../../WebEngineTS/design/handoff-boundary.md),
which paused engine feature work in favour of the consumer repositories.

**Read before trusting this document.** I inspected `README.md`, `app/package.json` and the
shape of `app/src` (21 files: `panels/{console,hierarchy,inspector,project}`, `context-menu`,
`services`). I have **not** read the editor's source. Everything below P1 is therefore a
direction, not a specification, and should be revised by whoever reads the code first.

---

## P0 — Make it run at all (~0.5 day, blocks everything)

`app/` has **no `node_modules`**. `npm run release:local` in the engine repo skips it for that
reason ("node_modules absent — run `npm install` here when you set the project up"), which means
**this editor has never been built against a current engine.** The engine has moved a long way
since: serialization of all built-in components, prefab overrides and variants,
`ScriptableObject`, an `Animator` state machine, a `RenderBackend` seam, and the whole
asset-streaming stack.

1. `cd app && npm install` (the engine must be built first — `app` depends on
   `"WebEngineTS": "file:../../WebEngineTS"`, i.e. the engine's `dist/` directly).
2. `npm start` and see what breaks. Expect breakage: the editor was extracted from
   `WebEngineTS/editor/` and the engine's API has changed underneath it since.
3. Re-run `npm run release:local` in the engine afterwards; it will then pick the editor up on
   every future engine change instead of skipping it.

**Done when:** `ng serve` starts and the editor loads a scene against
`0.1.0-local.1786478271988`.

### One hazard to check while doing this

`app/package.json` lists **both** `three` and `WebEngineTS`, and consumes the engine through
`file:../../WebEngineTS` — the engine's `dist/` folder rather than a packed tarball.

That is the exact configuration the engine's own `CLAUDE.md` warns about under "Local linking
vs. packed tarballs": with a directory dependency, the bundler may resolve the engine's own
`node_modules/three` instead of the app's, loading **two** THREE.js instances and silently
breaking the `instanceof THREE.Mesh`-style checks the renderer relies on. The symptom is not a
crash; it is geometry or materials quietly not rendering.

Worth an early check: confirm exactly one copy of `three` ends up in the built bundle. If there
are two, switch this consumer to the packed tarball like the other two repos, and
`release:local` will need a small change to copy it here.

## P1 — Decide what the editor is for, before adding to it (~1 day of thinking)

`design/` holds a JSX/CSS mockup (`wets/`, `wets.css`, `WETS Editor.html`) described as the
styling target, and `app/` holds the working editor. Those are two different questions —
*how it looks* and *what it does* — and the second one is not written down anywhere I found.

The engine's parity plan (`WebEngineTS/design/unity-parity-plan.md`) assumes this editor
eventually replaces ScenarioCreator's authoring role. That is a large claim with a
concrete dependency chain, and it is worth confirming or dropping deliberately rather than
drifting toward it:

- **If yes**, the editor must eventually emit what ScenarioCreator emits — a runnable ZIP and,
  after `ScenarioCreator/docs/PLAN.md` P1, a `scenario.json` with content-addressed assets and
  LOD variants. That is a publish pipeline, not a UI feature.
- **If no**, it is a scene authoring tool whose output ScenarioCreator packages, and the
  publish work never lands here.

Everything below assumes the first, because the parity plan does. **Confirm it before building
on it.**

## P2 — Serialization round-trip (~2–3 days, after P0)

The engine side is done and was the prerequisite for this editor: every built-in component now
serializes, so a saved scene no longer loses its components. `SceneSerializer`,
`Prefab`, `PrefabDiff` and `ScriptableObject` are all in the installed build.

- Save and load a scene through `SceneSerializer` and confirm the round-trip is lossless for
  the components the editor can create.
- Asset references resolve by **guid**, not by path — which only works if the content carries
  stable guids. That is `ScenarioCreator/docs/PLAN.md` P2, and it is a dependency, not a
  detail: without it a saved scene finds its assets within one run and loses them on reload.

**Done when:** a scene built in the editor, saved, reloaded and run in the platform is identical.

## P3 — The generated Inspector (~1 week, after P2)

`app/src/app/panels/inspector` exists; whether it is hand-written per component or driven by
the engine's reflection metadata, I did not check. The engine exposes `getClassMeta`,
`getAllFields`, `FieldType`, and the `@SerializedField` / `Range` / `Header` / `Tooltip` /
`HideInInspector` decorators — enough to generate an inspector for any `@Serializable` type
rather than maintaining one per component.

This is Stage 4 of the engine's parity plan, and the engine half is done. If the panel is
currently hand-written, converting it is the single change that stops the editor lagging the
engine every time a component gains a field.

## P4 — Undo and play mode (large, after P3)

Named in the parity plan as editor-side work. Both are architectural: undo needs every
mutation to go through a command, and play mode needs a clean save/restore of scene state —
which P2 provides. Not worth starting until P2 and P3 are solid.

---

## Order

```
P0 ──► P1 ──► P2 ──► P3 ──► P4
```

P0 is half a day and blocks literally everything else; nothing here has run against a current
engine. P1 is a decision, not code, and it changes how much of P2–P4 belongs in this repo at
all.

## What this repo should not do

- **No engine code.** If the editor needs an engine capability, change it in `WebEngineTS` and
  re-run `release:local`. That is a real requirement and one of the three things the engine's
  handoff boundary names as grounds for resuming engine work.
- **No scenario content.** Scenario sources live in ScenarioCreator until P1 is decided
  otherwise.
- **No platform code.** Catalog, auth and storage belong to `testv/virtual-lab`.
