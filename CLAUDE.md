# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code-code) when working with code in this repository.
The shared ecosystem map and the live task status are loaded from the sibling `.claude-shared` directory —
edit those files rather than duplicating them here.

# WebEngineTSEditor

The graphical editor — the way scenarios will be authored after ScenarioCreator retires. An Angular app in
`app/` that imports the engine only from its published tarball (`app/WebEngineTS-*.tgz`, pinned in
`app/package.json`), so the editor never sees engine source: a new engine is a new tarball plus a rebuild.

## Ecosystem / Related Projects

| Repo | Owns |
|---|---|
| **WebEngineTS** | The engine and its docs. This repo consumes its release tarball. |
| **ScenarioCreator** | Scenario content and the packaging CLI (`e2e:build` checks an editor-made project builds there). |
| **virtual-lab** | The platform — catalog, player and the Docker stack this editor is served from (`/editor/`). |
| **.claude-shared** | ROADMAP, task cards, the plans and notes of every task. |

## Layout

- `app/src/app/` — the editor itself. `screens/` the visible surfaces (start screen, workspace), `services/`
  the state: `project.service.ts` (what is open), `commands.service.ts` (what the menus do),
  `document.service.ts` (the undo history), `dialog.service.ts` (the editor's own dialogs).
- `app/e2e/` — the test suite (`run.mjs`, ~25 scenarios) and the ScenarioCreator build check
  (`scenariocreator-check.mjs`). It is the only test harness this repo has: no unit tests.
- `docs/` — the plans. `integration-plan.md` is the one that says how the editor joins the platform.

## Projects: where they live

A project is ScenarioCreator's layout (`scenario.meta.json`, `scripts/`, `assets/scenes/`). It can live in
**one of two places**, behind the same `ProjectStore` interface (`app/src/app/services/project-store.ts`):

- **A folder on the user's disk** (`FileSystemAccessStore`), opened through `showDirectoryPicker` — the
  Chromium-only API. This is the path for authors who keep projects in git. The wizard offers it only when
  the picker exists.
- **The browser's own store** (`OpfsStore`) — the origin-private file system, layout `projects/<id>/`.
  Available on every modern browser; this is what a non-Chromium author gets. The wizard offers it whenever
  `OpfsStore.available()` says the API and a writer are both there.

Two facts a session must not get wrong:

- **`createWritable` is the write primitive.** Safari below 26 has the directory but no `createWritable`, so
  a project there would open read-only — which is not a store. `OpfsStore.available()` therefore checks for
  the writer too, and the editor reports *unsupported* when **neither** store exists (no picker at all).
- **No permission calls in the interface.** OPFS has none (the standard removed them), so
  `queryPermission`/`requestPermission` live behind the disk store's implementation only.

**Recents** (`RecentProject`) carry `kind: 'disk' | 'browser'`. A disk project remembers its directory
handle and asks for permission on reopen; a browser project remembers its **id** (never a handle — it is
resolved from OPFS each time) and reports *missing* when the folder was cleared, rather than resurrecting an
empty project.

## Commands

```bash
cd app
npm ci                  # install; also checks the engine tarball against the lockfile hash
npm run build -- --base-href /editor/   # the production build the e2e and the platform serve
npm run e2e             # the suite: serve dist/browser at http://localhost:8044/editor/ first
```

`npm run e2e` needs Playwright: `E2E_PLAYWRIGHT_DIR=<dir that resolves playwright>` (default: virtual-lab's)
and `E2E_BROWSER_CHANNEL=chromium` for Playwright's own Chromium instead of Edge. Run it in a UTF-8 locale:
under `C`/`POSIX`, Chromium turns a non-ASCII name in OPFS into an empty one and the wizard scenario fails
for that reason alone. See `README.md` for the full recipe and the recorded check count.

The e2e talks to the editor only the way a user does — clicks, typing, the editor's own dialogs — and the
folder picker is faked to OPFS by `instrument()`, so a *disk* project scenario runs against real OPFS
handles. That is why adding a scenario is usually the whole test.
