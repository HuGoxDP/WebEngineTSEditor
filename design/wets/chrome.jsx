/* Menu bar, toolbar, status bar */

const { useState, useEffect, useRef } = React;

// ─── Menu bar ───────────────────────────────────────────────
const MENU_DEFS = {
  File: [
    { type: "title", label: "File" },
    { label: "New Scene",  kbd: "Ctrl+N" },
    { label: "Open Scene…", kbd: "Ctrl+O" },
    { label: "Save Scene", kbd: "Ctrl+S" },
    { label: "Save Scene As…", kbd: "Ctrl+Shift+S" },
    { type: "sep" },
    { label: "New Project" },
    { label: "Open Project…" },
    { type: "sep" },
    { label: "Build Settings…", kbd: "Ctrl+Shift+B" },
    { label: "Build And Run", kbd: "Ctrl+B" },
    { type: "sep" },
    { label: "Exit" },
  ],
  Edit: [
    { label: "Undo", kbd: "Ctrl+Z" },
    { label: "Redo", kbd: "Ctrl+Shift+Z" },
    { type: "sep" },
    { label: "Cut", kbd: "Ctrl+X" },
    { label: "Copy", kbd: "Ctrl+C" },
    { label: "Paste", kbd: "Ctrl+V" },
    { type: "sep" },
    { label: "Select All", kbd: "Ctrl+A" },
    { label: "Deselect All" },
    { label: "Duplicate", kbd: "Ctrl+D" },
    { label: "Delete", kbd: "Del" },
    { type: "sep" },
    { label: "Play", kbd: "Ctrl+P" },
    { label: "Pause", kbd: "Ctrl+Shift+P" },
    { type: "sep" },
    { label: "Preferences…" },
    { label: "Project Settings…" },
  ],
  GameObject: [
    { label: "Create Empty", kbd: "Ctrl+Shift+N" },
    { label: "Create Empty Child", kbd: "Alt+Shift+N" },
    { type: "sep" },
    { label: "3D Object", caret: true },
    { label: "2D Object", caret: true },
    { label: "Light", caret: true },
    { label: "Audio", caret: true },
    { label: "Camera" },
    { label: "UI", caret: true },
    { type: "sep" },
    { label: "Align With View", kbd: "Ctrl+Shift+F" },
    { label: "Move To View", kbd: "Ctrl+Alt+F" },
  ],
  Component: [
    { type: "title", label: "Add Component" },
    { label: "Transform" },
    { label: "Mesh Renderer" },
    { label: "Rigidbody" },
    { label: "Box Collider" },
    { label: "Sphere Collider" },
    { label: "Capsule Collider" },
    { type: "sep" },
    { label: "Camera" },
    { label: "Light" },
    { type: "sep" },
    { label: "Scripts", caret: true },
  ],
  Window: [
    { label: "Scene",     kbd: "Ctrl+1" },
    { label: "Game",      kbd: "Ctrl+2" },
    { label: "Inspector", kbd: "Ctrl+3" },
    { label: "Hierarchy", kbd: "Ctrl+4" },
    { label: "Project",   kbd: "Ctrl+5" },
    { label: "Console",   kbd: "Ctrl+`" },
    { type: "sep" },
    { label: "Animation" },
    { label: "Animator" },
    { label: "Profiler" },
    { type: "sep" },
    { label: "Layouts", caret: true },
  ],
  Help: [
    { label: "Documentation" },
    { label: "API Reference" },
    { label: "Samples & Tutorials" },
    { type: "sep" },
    { label: "Report a Bug…" },
    { label: "Check for Updates" },
    { type: "sep" },
    { label: "About WETS" },
  ],
};

function MenuBar({ branch }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(null); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const names = Object.keys(MENU_DEFS);

  return (
    <div className="menubar" ref={ref}>
      <div className="brand">
        <span className="brand-mark"></span>
        <span>WETS</span>
      </div>
      {names.map((n) => (
        <div key={n}
             className={"menubar-item" + (open === n ? " open" : "")}
             onMouseDown={(e) => { e.stopPropagation(); setOpen(open === n ? null : n); }}
             onMouseEnter={() => open && setOpen(n)}>
          {n}
          {open === n && <MenuDropdown items={MENU_DEFS[n]} onPick={() => setOpen(null)} />}
        </div>
      ))}
      <span className="spacer" />
      <span className="project-tag">
        <I.Branch /> <span>{branch}</span> <span className="dot" />
      </span>
    </div>
  );
}

function MenuDropdown({ items, onPick }) {
  return (
    <div className="dropdown shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) => {
        if (it.type === "sep") return <div key={i} className="sep" />;
        if (it.type === "title") return <div key={i} className="mi-title">{it.label}</div>;
        return (
          <div key={i} className={"mi" + (it.disabled ? " disabled" : "")} onClick={onPick}>
            <span>{it.label}</span>
            {it.caret && <span className="caret"><I.Caret /></span>}
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Toolbar ────────────────────────────────────────────────
function Toolbar({ state, setState }) {
  const { playing, paused, tool, pivot, space, snap, historyIdx, historyMax } = state;

  const setTool = (t) => setState({ ...state, tool: t });
  const togglePlay = () => setState({ ...state, playing: !playing, paused: false });
  const togglePause = () => playing && setState({ ...state, paused: !paused });
  const stepOnce = () => playing && setState({ ...state, paused: true });

  return (
    <div className="toolbar">
      {/* Tool group */}
      <div className="tb-group">
        <button className={"tb-btn" + (tool === "hand" ? " active" : "")} onClick={() => setTool("hand")} title="Hand (Q)"><I.Hand /></button>
        <button className={"tb-btn" + (tool === "move" ? " active" : "")} onClick={() => setTool("move")} title="Move (W)"><I.Move /></button>
        <button className={"tb-btn" + (tool === "rotate" ? " active" : "")} onClick={() => setTool("rotate")} title="Rotate (E)"><I.Rotate /></button>
        <button className={"tb-btn" + (tool === "scale" ? " active" : "")} onClick={() => setTool("scale")} title="Scale (R)"><I.Scale /></button>
        <button className={"tb-btn" + (tool === "rect" ? " active" : "")} onClick={() => setTool("rect")} title="Rect (T)"><I.Rect /></button>
      </div>

      <div className="tb-sep" />

      {/* Pivot / space */}
      <button className="tb-select" onClick={() => setState({ ...state, pivot: pivot === "Pivot" ? "Center" : "Pivot" })} title="Pivot">
        <span>{pivot}</span><I.CaretDown />
      </button>
      <button className="tb-select" onClick={() => setState({ ...state, space: space === "Local" ? "Global" : "Local" })} title="Space">
        <span>{space}</span><I.CaretDown />
      </button>

      <div className="tb-sep" />

      {/* Undo / Redo */}
      <div className="tb-group">
        <button className="tb-btn" disabled={historyIdx === 0} onClick={() => setState({ ...state, historyIdx: Math.max(0, historyIdx - 1) })} title="Undo (Ctrl+Z)"><I.Undo /></button>
        <button className="tb-btn" disabled={historyIdx === historyMax} onClick={() => setState({ ...state, historyIdx: Math.min(historyMax, historyIdx + 1) })} title="Redo (Ctrl+Shift+Z)"><I.Redo /></button>
      </div>

      <div className="tb-sep" />

      {/* Play controls */}
      <div className="tb-group">
        <button
          className={"tb-btn" + (playing ? " playing" : "")}
          onClick={togglePlay}
          title={playing ? "Stop (Ctrl+P)" : "Enter Play Mode (Ctrl+P)"}>
          {playing ? <I.Stop /> : <I.Play />}
        </button>
        <button className={"tb-btn" + (paused ? " active" : "")} onClick={togglePause} disabled={!playing} title="Pause (Ctrl+Shift+P)"><I.Pause /></button>
        <button className="tb-btn" onClick={stepOnce} disabled={!playing} title="Step"><I.Step /></button>
      </div>

      <div className="tb-sep" />

      {/* Snap */}
      <button className={"tb-btn" + (snap ? " active" : "")} onClick={() => setState({ ...state, snap: !snap })} title="Snap to grid">
        <I.Magnet /><span style={{fontSize: 10}}>0.5</span>
      </button>

      <div className="tb-spacer" />

      {playing && <span className="tb-live"><span className="rec" /> LIVE</span>}

      {/* Search */}
      <div className="tb-search">
        <I.Search />
        <input placeholder="Search t:script, h:Player…" />
        <span className="kbd">⌘K</span>
      </div>

      {/* Layout picker */}
      <button className="tb-select" title="Layout presets">
        <I.Layers /><span>Default</span><I.CaretDown />
      </button>

      <button className="tb-btn" title="Cloud sync"><I.Cloud /></button>
      <button className="tb-btn" title="Account"><div style={{
        width: 20, height: 20, borderRadius: '50%',
        background: 'linear-gradient(135deg, #ff9f2a, #e18a1a)',
        display: 'grid', placeItems: 'center',
        fontSize: 9, fontWeight: 700, color: '#17181c'
      }}>MK</div></button>
    </div>
  );
}

// ─── Status bar ─────────────────────────────────────────────
function StatusBar({ state, counts }) {
  return (
    <div className="statusbar">
      <span className="st">
        <span className="dot ok" />
        <span>Ready</span>
      </span>
      <span className="divider-v" />
      <span className="st">
        <I.Cpu />
        <span>{state.playing && !state.paused ? "61.4" : "—"} FPS</span>
      </span>
      <span className="st">
        <I.Clock />
        <span>Δt {state.playing && !state.paused ? "16.3ms" : "0.0ms"}</span>
      </span>
      <span className="st">
        <span>Draw {counts.drawCalls}</span>
      </span>
      <span className="st">
        <span>Tris {counts.tris.toLocaleString()}</span>
      </span>
      <span className="st">
        <span>Verts {counts.verts.toLocaleString()}</span>
      </span>
      <span className="divider-v" />
      <span className="st">
        <I.Cube />
        <span>{counts.gos} GameObjects · {counts.comps} Components</span>
      </span>

      <span className="spacer" />

      {state.dirty && <span className="st" style={{color: 'var(--accent)'}}>● Unsaved</span>}
      <span className="st branch"><I.Branch /> main</span>
      <span className="st"><I.Wifi /> synced</span>
      <span className="st">TypeScript 5.6.3</span>
      <span className="st">WebEngineTS 0.1.0</span>
    </div>
  );
}

Object.assign(window, { MenuBar, Toolbar, StatusBar });
