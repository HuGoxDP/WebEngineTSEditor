# WebEngineTSEditor

The graphical scenario editor for **WebEngineTS** — a Unity-like editor for authoring 3D
scenes/scenarios against the engine's component model. It is a **consumer** of the engine,
kept in its own project (the engine repo contains only the engine).

## Layout

```
app/      Angular editor application (the real, functional editor)
design/   JSX/CSS design mockup — visual reference guiding the app's redesign
```

- `app/` was extracted from the engine repo (`WebEngineTS/editor/`). It depends on the
  engine through the packed `"WebEngineTS": "./WebEngineTS-0.1.0.tgz"` and imports engine types via the
  bare `"WebEngineTS"` specifier (`SceneSerializer`, `GameObject`, component types, …).
- `design/` is a static React/JSX + CSS mockup (`wets/`, `wets.css`, `WETS Editor.html`,
  `_preview.png`) — not wired to a build; use it as the styling/UX target.

## Prerequisites

- Node.js ≥ 18, npm
- The engine must be built first, because the editor consumes its `dist/` output:

```bash
# in the engine repo
cd ../WebEngineTS
npm install && npm run build
```

## Run the editor (app/)

```bash
cd app
npm install
npm start          # ng serve on http://localhost:4200
npm run build      # production build → app/dist
```

## Run in Docker, beside the catalog

The editor is served at `/editor/` on the platform's own port, by an override in the
platform repo (the base stack still builds without this repository):

```bash
cd ../testv/virtual-lab
docker compose -f docker-compose.yml -f docker-compose.editor.yml up --build -d
# → http://localhost:${FRONTEND_PORT}/editor/
```

`Dockerfile` here builds the image; routing, headers and the CSP for `/editor/` live in
`virtual-lab/nginx/editor.conf` and `csp-editor.conf`. See `docs/integration-plan.md` §3.

If you change the engine, rebuild it (`npm run build` in `WebEngineTS`) and reinstall here
(`npm install`) so the editor picks up the new `dist/`.

## CI

`.github/workflows/ci.yml` runs on every push and pull request, and by hand:

- **Build** — `npm ci` and `npm run build` in `app/`.
- **Docker build** — `docker build .`, the image as the platform builds it, then a start-up
  check that nginx serves `/editor/` with the right base href.
- **e2e (Chromium)** — `app/e2e/run.mjs`, the editor's main test suite, against a production
  build served at `http://localhost:8044/editor/`, in Playwright's Chromium. `.shots/` is
  uploaded as an artifact when it fails. `npm run e2e:build`, the check that a project the
  editor made builds in ScenarioCreator, needs that repository beside this one and is not run.

`npm ci` checks the engine tarball against the hash in `package-lock.json`, so commit
`app/WebEngineTS-0.1.0.tgz` and the lockfile together; one without the other fails every job
with `EINTEGRITY`. That holds because CI keeps no npm cache: a warm one would install the
engine the lockfile names from the cache and never read the tarball.

To run the e2e as CI does, without `testv/virtual-lab` or Edge:

```bash
cd app
npm run build -- --base-href /editor/
# serve app/dist/browser at http://localhost:8044/editor/ (ci.yml does it with python3), then:
E2E_PLAYWRIGHT_DIR="$(npm root -g)" E2E_BROWSER_CHANNEL=chromium npm run e2e
```

`E2E_PLAYWRIGHT_DIR` is any directory `require("playwright")` resolves from (a relative one is
taken from the current directory, `app/` under `npm run e2e`), and
`E2E_BROWSER_CHANNEL=chromium` uses Playwright's Chromium (`npx playwright install chromium`)
instead of Edge. Unset, both keep the defaults: virtual-lab's Playwright and Edge. On Linux,
run it in a UTF-8 locale (`LANG=C.UTF-8`): under `C`/`POSIX`, Chromium turns a non-ASCII name
in the origin-private file system the scenarios use into an empty one, and the wizard scenario
fails for that reason alone.

## Relationship to the other projects

- **WebEngineTS** — the engine library this editor is built on.
- **ScenarioCreator** — packages scenario source into distributable `.zip` archives.
- **testv/virtual-lab** — the platform (catalog + viewer) that runs the packaged scenarios.

Data flow: **engine → editor authors scenes → ScenarioCreator packs ZIPs → platform runs them**.
