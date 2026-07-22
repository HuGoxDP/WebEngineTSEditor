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
  engine through `"WebEngineTS": "file:../../WebEngineTS"` and imports engine types via the
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

If you change the engine, rebuild it (`npm run build` in `WebEngineTS`) and reinstall here
(`npm install`) so the editor picks up the new `dist/`.

## Relationship to the other projects

- **WebEngineTS** — the engine library this editor is built on.
- **ScenarioCreator** — packages scenario source into distributable `.zip` archives.
- **testv/virtual-lab** — the platform (catalog + viewer) that runs the packaged scenarios.

Data flow: **engine → editor authors scenes → ScenarioCreator packs ZIPs → platform runs them**.
