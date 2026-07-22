/* WETS Editor — main app, panel registry, tweaks */

const { useState: useS, useEffect: useE, useMemo: useM, useRef: useR } = React;

const TWEAKS_DEFAULT = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "amber",
  "density": "compact",
  "radius": 3,
  "fontSize": 12,
  "mono": "JetBrains Mono",
  "showStatus": true,
  "showMenuBar": true,
  "gridSize": 40,
  "showGizmoCube": true,
  "animatePlay": true
}/*EDITMODE-END*/;

const ACCENTS = {
  amber:  { a: "#ff9f2a", a2: "#ffb14a", a3: "#e18a1a", bg: "rgba(255,159,42,0.14)", bg2: "rgba(255,159,42,0.22)" },
  cyan:   { a: "#3dd8e0", a2: "#5fe4ea", a3: "#1fbac0", bg: "rgba(61,216,224,0.14)", bg2: "rgba(61,216,224,0.22)" },
  violet: { a: "#a78bfa", a2: "#c4b5fd", a3: "#8b5cf6", bg: "rgba(167,139,250,0.14)", bg2: "rgba(167,139,250,0.22)" },
  lime:   { a: "#b3e84a", a2: "#c7f06a", a3: "#8fc024", bg: "rgba(179,232,74,0.14)", bg2: "rgba(179,232,74,0.22)" },
  pink:   { a: "#ff6fae", a2: "#ff8fc0", a3: "#e8508f", bg: "rgba(255,111,174,0.14)", bg2: "rgba(255,111,174,0.22)" },
};

const DENSITIES = {
  compact:   { row: 22, ctrl: 20, pad: 6 },
  comfy:     { row: 26, ctrl: 24, pad: 8 },
  spacious:  { row: 30, ctrl: 28, pad: 10 },
};

const LIGHT_THEME = {
  "--bg-0": "#f3f4f7", "--bg-1": "#ffffff", "--bg-2": "#eceef3",
  "--bg-3": "#e2e4ea", "--bg-4": "#d3d6de", "--bg-5": "#bec2cc",
  "--line": "#dcdee4", "--line-2": "#c8ccd4",
  "--fg-0": "#1e2026", "--fg-1": "#41434a", "--fg-2": "#6b6e77", "--fg-3": "#9a9da5",
};

const DEFAULT_LAYOUT = {
  slots: {
    left:   ["hierarchy"],
    center: ["scene", "game"],
    right:  ["inspector"],
    bottom: ["project", "console", "timeline", "code"],
  },
  active: { left: "hierarchy", center: "scene", right: "inspector", bottom: "project" },
  widthL: 260, widthR: 320, heightB: 280,
};

function App() {
  const [t, setT] = (window.useTweaks ? window.useTweaks(TWEAKS_DEFAULT) : [TWEAKS_DEFAULT, () => {}]);

  // Apply theme vars
  useE(() => {
    const r = document.documentElement;
    const accent = ACCENTS[t.accent] || ACCENTS.amber;
    r.style.setProperty("--accent", accent.a);
    r.style.setProperty("--accent-600", accent.a2);
    r.style.setProperty("--accent-700", accent.a3);
    r.style.setProperty("--accent-bg", accent.bg);
    r.style.setProperty("--accent-bg-strong", accent.bg2);

    const d = DENSITIES[t.density] || DENSITIES.compact;
    r.style.setProperty("--row-h", d.row + "px");
    r.style.setProperty("--ctrl-h", d.ctrl + "px");
    r.style.setProperty("--pad", d.pad + "px");

    r.style.setProperty("--radius", (t.radius ?? 3) + "px");
    r.style.setProperty("--radius-lg", ((t.radius ?? 3) + 2) + "px");
    r.style.setProperty("--fs", (t.fontSize || 12) + "px");
    r.style.setProperty("--fs-sm", ((t.fontSize || 12) - 1) + "px");
    r.style.setProperty("--fs-xs", ((t.fontSize || 12) - 2) + "px");
    r.style.setProperty("--mono", (t.mono || "JetBrains Mono") + ", ui-monospace, monospace");
    r.style.setProperty("--grid-size", (t.gridSize || 40) + "px");

    if (t.theme === "light") {
      Object.entries(LIGHT_THEME).forEach(([k, v]) => r.style.setProperty(k, v));
      document.body.classList.add("theme-light");
    } else {
      Object.keys(LIGHT_THEME).forEach(k => r.style.removeProperty(k));
      document.body.classList.remove("theme-light");
    }
  }, [t]);

  // Editor state
  const [scene, setScene] = useS(() => structuredClone(WETS_DATA.INITIAL_SCENE));
  const [selectedId, setSelectedId] = useS("n3");
  const [editorState, setEditorState] = useS({
    playing: false, paused: false,
    tool: "move",
    pivot: "Pivot", space: "Local", snap: false,
    historyIdx: 5, historyMax: 8,
    dirty: true,
  });
  const [view, setView] = useS("scene");

  const selectedNode = scene.nodes.find(n => n.id === selectedId);

  const updateComponent = (cKey, field, val) => {
    setScene(s => {
      const next = structuredClone(s);
      const node = next.nodes.find(n => n.id === selectedId);
      if (!node) return s;
      node.state[cKey] = node.state[cKey] || {};
      node.state[cKey][field] = val;
      next.dirty = true;
      return next;
    });
    setEditorState(es => ({ ...es, dirty: true, historyIdx: Math.min(es.historyMax, es.historyIdx + 1) }));
  };

  const renameSelected = (name) => {
    setScene(s => {
      const next = structuredClone(s);
      const node = next.nodes.find(n => n.id === selectedId);
      if (node) node.name = name;
      next.dirty = true;
      return next;
    });
  };

  const toggleActive = () => {
    setScene(s => {
      const next = structuredClone(s);
      const node = next.nodes.find(n => n.id === selectedId);
      if (node) node.active = !node.active;
      return next;
    });
  };

  const createObject = () => {
    setScene(s => {
      const next = structuredClone(s);
      const id = "n" + (next.nodes.length + 1);
      next.nodes.push({
        id, name: "GameObject", kind: "cube", parent: null, expanded: false, active: true,
        components: ["transform", "meshRenderer", "boxCollider"],
        state: {
          transform: { pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1] },
          meshRenderer: { mesh: "Cube", material: "Default-Material", castShadows: true, receiveShadows: true, color: "#cccccc" },
          boxCollider: { isTrigger: false, size: [1,1,1], center: [0,0,0] },
        },
      });
      return next;
    });
  };

  const counts = useM(() => ({
    drawCalls: 14, tris: 24810, verts: 12405,
    gos: scene.nodes.length,
    comps: scene.nodes.reduce((a, n) => a + n.components.length, 0),
  }), [scene]);

  // Layout state — kept in localStorage so user can rearrange
  const [layout, setLayout] = useS(() => {
    try {
      const saved = localStorage.getItem("wets-layout");
      if (saved) return JSON.parse(saved);
    } catch {}
    return DEFAULT_LAYOUT;
  });
  useE(() => { try { localStorage.setItem("wets-layout", JSON.stringify(layout)); } catch {} }, [layout]);

  // Register all panels — runs every render so closures are fresh
  const registry = useM(() => ({
    hierarchy: {
      title: "Hierarchy", icon: I.Layers,
      render: () => <Hierarchy scene={scene} selectedId={selectedId} onSelect={setSelectedId}
        onCreate={createObject} playing={editorState.playing && !editorState.paused && t.animatePlay} />,
    },
    inspector: {
      title: "Inspector", icon: I.Info,
      render: () => <Inspector node={selectedNode} onChange={updateComponent}
        onAddComponent={() => {}} onRename={renameSelected} onToggleActive={toggleActive} />,
    },
    scene: {
      title: "Scene", icon: I.Scene,
      render: () => <Viewport forceView="scene" view="scene" setView={() => {}} tool={editorState.tool}
        playing={editorState.playing} paused={editorState.paused} scene={scene} selectedId={selectedId} showGizmo={t.showGizmoCube} />,
    },
    game: {
      title: "Game", icon: I.Game,
      render: () => <Viewport forceView="game" view="game" setView={() => {}} tool={editorState.tool}
        playing={editorState.playing && t.animatePlay} paused={editorState.paused} scene={scene} selectedId={selectedId} />,
    },
    project: {
      title: "Project", icon: I.Folder,
      badge: () => "47",
      render: () => <ProjectTab />,
    },
    console: {
      title: "Console", icon: I.Info,
      badge: () => String(WETS_DATA.INITIAL_LOGS.filter(l => l.lvl === "err" || l.lvl === "warn").length),
      render: () => <ConsoleTab />,
    },
    timeline: {
      title: "Animation", icon: I.Clock,
      render: () => <TimelineTab />,
    },
    code: {
      title: "Code", icon: I.Script,
      render: () => <CodeTab />,
    },
  }), [scene, selectedId, selectedNode, editorState, t]);

  // Expose to layout.jsx
  useE(() => {
    Object.keys(registry).forEach(k => { window.PANELS[k] = registry[k]; });
  }, [registry]);

  const ctx = {};

  // Helper to let user re-open closed tabs
  const openTab = (id, slot = "bottom") => {
    setLayout(L => {
      // if already open somewhere, just activate
      for (const s of ["left","center","right","bottom"]) {
        if (L.slots[s].includes(id)) return { ...L, active: { ...L.active, [s]: id } };
      }
      return {
        ...L,
        slots: { ...L.slots, [slot]: [...L.slots[slot], id] },
        active: { ...L.active, [slot]: id },
      };
    });
  };

  const resetLayout = () => setLayout(DEFAULT_LAYOUT);

  // which panels are currently docked somewhere (for tweaks toggles)
  const isOpen = (id) => ["left","center","right","bottom"].some(s => layout.slots[s].includes(id));
  const togglePanel = (id) => {
    if (isOpen(id)) {
      setLayout(L => {
        const out = { slots: { ...L.slots }, active: { ...L.active } };
        for (const s of ["left","center","right","bottom"]) {
          out.slots[s] = L.slots[s].filter(x => x !== id);
          if (out.active[s] === id) out.active[s] = out.slots[s][0] || null;
        }
        return { ...L, ...out };
      });
    } else {
      // pick reasonable default slot
      const pref = { hierarchy: "left", inspector: "right", scene: "center", game: "center" }[id] || "bottom";
      openTab(id, pref);
    }
  };

  return (
    <div className={"app density-" + t.density}>
      {t.showMenuBar && <MenuBar branch="main" />}
      <Toolbar state={editorState} setState={setEditorState} />

      <DockWorkspace layout={layout} setLayout={setLayout} ctx={ctx} registry={registry} />

      {t.showStatus && <StatusBar state={editorState} counts={counts} />}

      {window.TweaksPanel && (
        <TweaksPanel title="Tweaks">
          <TweakSection title="Theme">
            <TweakRadio label="Mode" value={t.theme} options={[{value:"dark",label:"Dark"},{value:"light",label:"Light"}]} onChange={v => setT({theme: v})} />
            <TweakSelect label="Accent" value={t.accent} options={Object.keys(ACCENTS).map(k => ({value: k, label: k[0].toUpperCase() + k.slice(1)}))} onChange={v => setT({accent: v})} />
          </TweakSection>
          <TweakSection title="Layout & type">
            <TweakRadio label="Density" value={t.density} options={[{value:"compact",label:"Compact"},{value:"comfy",label:"Comfy"},{value:"spacious",label:"Roomy"}]} onChange={v => setT({density: v})} />
            <TweakSlider label="Corner radius" value={t.radius} min={0} max={10} step={1} onChange={v => setT({radius: v})} />
            <TweakSlider label="Font size" value={t.fontSize} min={10} max={16} step={1} onChange={v => setT({fontSize: v})} />
            <TweakSlider label="Scene grid size" value={t.gridSize} min={20} max={120} step={10} onChange={v => setT({gridSize: v})} />
            <TweakSelect label="Mono font" value={t.mono} options={[
              {value: "JetBrains Mono", label: "JetBrains Mono"},
              {value: "ui-monospace", label: "System"},
            ]} onChange={v => setT({mono: v})} />
          </TweakSection>
          <TweakSection title="Chrome">
            <TweakToggle label="Menu bar"  value={t.showMenuBar} onChange={v => setT({showMenuBar: v})} />
            <TweakToggle label="Status bar" value={t.showStatus} onChange={v => setT({showStatus: v})} />
            <TweakToggle label="Scene gizmo cube" value={t.showGizmoCube} onChange={v => setT({showGizmoCube: v})} />
            <TweakToggle label="Animate Play mode" value={t.animatePlay} onChange={v => setT({animatePlay: v})} />
          </TweakSection>
          <TweakSection title="Panels (click to toggle)">
            <div className="tweak-panel-grid">
              {["hierarchy","inspector","scene","game","project","console","timeline","code"].map(id => (
                <button key={id}
                  className={"tpg-btn" + (isOpen(id) ? " on" : "")}
                  onClick={() => togglePanel(id)}>
                  {isOpen(id) ? "●" : "○"} {PANELS[id]?.title || id}
                </button>
              ))}
            </div>
            <TweakButton label="Reset layout" onClick={resetLayout} />
          </TweakSection>
          <TweakSection title="Help">
            <div style={{fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.5, padding: '4px 0'}}>
              Drag any tab header (Scene, Project, Code…) into another pane to re-dock it. Click × on a tab to close it. Drag the edges between panes to resize.
            </div>
          </TweakSection>
        </TweaksPanel>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
