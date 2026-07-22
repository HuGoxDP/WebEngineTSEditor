/* Hierarchy panel */

const { useMemo: useMemoH } = React;

function Hierarchy({ scene, selectedId, onSelect, onCreate, playing }) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(() => {
    const s = new Set();
    scene.nodes.forEach(n => { if (n.expanded) s.add(n.id); });
    return s;
  });

  const toggle = (id) => {
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  // Flatten tree respecting parent/expanded
  const rows = useMemoH(() => {
    const byParent = {};
    scene.nodes.forEach(n => {
      const p = n.parent || "__root";
      (byParent[p] = byParent[p] || []).push(n);
    });
    const out = [];
    const walk = (parent, depth) => {
      const list = byParent[parent] || [];
      for (const n of list) {
        const hasChildren = !!byParent[n.id];
        out.push({ n, depth, hasChildren });
        if (hasChildren && expanded.has(n.id)) walk(n.id, depth + 1);
      }
    };
    walk("__root", 0);
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      return out.filter(r => r.n.name.toLowerCase().includes(q));
    }
    return out;
  }, [scene, expanded, filter]);

  const iconFor = (kind) => {
    const map = { camera: "Camera", light: "Light", player: "Player", cube: "Cube", group: "Folder", trigger: "Collider" };
    return I[map[kind] || "Cube"];
  };

  return (
    <div style={{display: 'flex', flexDirection: 'column', height: '100%'}}>
      <div className="pane-tabs">
        <div className="pane-tab active"><I.Layers /> Hierarchy <span className="badge">{scene.nodes.length}</span></div>
        <div className="pane-header-actions">
          <button className="ico-btn" title="Panel menu"><I.Kebab /></button>
        </div>
      </div>

      <div className="hier-toolbar">
        <button className="create-btn" onClick={onCreate}><I.Plus /> Create</button>
        <div className="h-search">
          <I.Search />
          <input placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} />
        </div>
      </div>

      <div className="scene-header">
        <I.Scene />
        <span className="name">{scene.name}</span>
        <span className="mono" style={{color: 'var(--fg-2)', fontSize: 10}}>.scene.json</span>
        {scene.dirty && <span className="dirty" title="Unsaved changes" />}
      </div>

      <div className="pane-body">
        <ul className="tree">
          {rows.map(({ n, depth, hasChildren }) => {
            const Ico = iconFor(n.kind);
            return (
              <li key={n.id}
                  className={
                    (selectedId === n.id ? "selected " : "") +
                    (!n.active ? "inactive " : "") +
                    (playing && n.id === "n3" ? "playing-row" : "")
                  }
                  style={{paddingLeft: 6 + depth * 14}}
                  onClick={() => onSelect(n.id)}>
                <span
                  className={"caret " + (hasChildren ? (expanded.has(n.id) ? "open" : "") : "empty")}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(n.id); }}>
                  <I.Caret />
                </span>
                <span className="go-ico"><Ico /></span>
                <span className="label">{n.name}</span>
                {n.kind === "trigger" && <span className="flags"><span className="flag" title="Trigger"><I.Collider /></span></span>}
                {n.kind === "light" && <span className="flags"><span className="flag"><I.Eye /></span></span>}
              </li>
            );
          })}
          {rows.length === 0 && (
            <li style={{color: 'var(--fg-3)', fontSize: 11, height: 'auto', padding: '12px'}}>No GameObjects match filter.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

window.Hierarchy = Hierarchy;
