/* Inspector panel */

function Inspector({ node, onChange, onAddComponent, onRename, onToggleActive }) {
  if (!node) {
    return (
      <div style={{display: 'flex', flexDirection: 'column', height: '100%'}}>
        <div className="pane-tabs">
          <div className="pane-tab active"><I.Info /> Inspector</div>
          <div className="pane-header-actions">
            <button className="ico-btn"><I.Lock /></button>
            <button className="ico-btn"><I.Kebab /></button>
          </div>
        </div>
        <div style={{flex: 1, display: 'grid', placeItems: 'center', color: 'var(--fg-3)', fontSize: 11, textAlign: 'center', padding: 20}}>
          <div>
            <div style={{fontSize: 32, marginBottom: 8, opacity: 0.5}}><I.Cube /></div>
            Select a GameObject to inspect.
          </div>
        </div>
      </div>
    );
  }

  const catalog = WETS_DATA.COMPONENT_CATALOG;

  return (
    <div style={{display: 'flex', flexDirection: 'column', height: '100%'}}>
      <div className="pane-tabs">
        <div className="pane-tab active"><I.Info /> Inspector</div>
        <div className="pane-header-actions">
          <button className="ico-btn" title="Lock inspector"><I.Lock /></button>
          <button className="ico-btn"><I.Kebab /></button>
        </div>
      </div>

      <div className="insp-head">
        <span className={"enable " + (node.active ? "on" : "")} onClick={onToggleActive}>
          {node.active && <I.Check />}
        </span>
        <span className="ico"><I.Cube /></span>
        <input className="name-input" value={node.name} onChange={e => onRename(e.target.value)} spellCheck={false} />
        <label className="static">
          <span className="box" /> Static
          <I.CaretDown />
        </label>
      </div>

      <div className="insp-meta">
        <span>Tag</span>
        <span className="pill">{node.kind === "player" ? "Player" : "Untagged"}<I.CaretDown /></span>
        <span>Layer</span>
        <span className="pill">Default<I.CaretDown /></span>
      </div>

      <div className="insp-body">
        {node.components.map((ck, i) => (
          <CompSection key={ck + i} componentKey={ck} def={catalog[ck]} values={node.state[ck] || {}} onChange={onChange} />
        ))}

        <div className="add-comp-wrap">
          <button className="add-comp" onClick={onAddComponent}>
            <I.Plus /> Add Component
          </button>
        </div>
      </div>
    </div>
  );
}

function CompSection({ componentKey, def, values, onChange }) {
  const [open, setOpen] = useState(true);
  const [enabled, setEnabled] = useState(true);
  if (!def) return null;
  const Ico = I[def.icon] || I.Cube;

  return (
    <div className="comp">
      <div className="comp-head" onClick={() => setOpen(!open)}>
        <span className={"caret " + (open ? "open" : "")}><I.Caret /></span>
        {!def.removable && def.fields.some(f => f.key === "enabled") ? null : (
          <span className={"enable-cb " + (enabled ? "on" : "")} onClick={(e) => { e.stopPropagation(); setEnabled(!enabled); }} />
        )}
        <span className="ico"><Ico /></span>
        <span className="title">{def.title}</span>
        <div className="actions">
          <button className="a-btn" onClick={(e) => e.stopPropagation()}><I.Info /></button>
          <button className="a-btn" onClick={(e) => e.stopPropagation()}><I.Kebab /></button>
        </div>
      </div>
      {open && (
        <div className="comp-body">
          {def.fields.map(f => (
            <FieldRow key={f.key} f={f} value={values[f.key]} onChange={(v) => onChange(componentKey, f.key, v)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FieldRow({ f, value, onChange }) {
  if (f.type === "vec3") {
    const v = value || [0, 0, 0];
    return (
      <div className="field">
        <label title={f.label}>{f.label}</label>
        <div className="vec n3">
          {["x", "y", "z"].map((a, i) => (
            <React.Fragment key={a}>
              <span className={"axis " + a}>{a.toUpperCase()}</span>
              <div className="wrap">
                <input type="number" className="in num" step={f.step} value={v[i]}
                  onChange={e => { const nv = [...v]; nv[i] = parseFloat(e.target.value) || 0; onChange(nv); }} />
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }
  if (f.type === "number") {
    return (
      <div className="field">
        <label>{f.label}</label>
        <input type="number" className="in num" step={f.step} min={f.min} value={value ?? 0}
          onChange={e => onChange(parseFloat(e.target.value) || 0)} />
      </div>
    );
  }
  if (f.type === "range") {
    return (
      <div className="field">
        <label>{f.label}</label>
        <div className="range-wrap">
          <input type="range" min={f.min} max={f.max} step={f.step} value={value ?? 0}
            onChange={e => onChange(parseFloat(e.target.value))} />
          <input type="number" className="in num" min={f.min} max={f.max} step={f.step} value={value ?? 0}
            onChange={e => onChange(parseFloat(e.target.value) || 0)} />
        </div>
      </div>
    );
  }
  if (f.type === "bool") {
    return (
      <div className="field">
        <label>{f.label}</label>
        <span className={"cb " + (value ? "on" : "")} onClick={() => onChange(!value)} />
      </div>
    );
  }
  if (f.type === "color") {
    return (
      <div className="field">
        <label>{f.label}</label>
        <div className="color">
          <span className="swatch"><span className="fill" style={{background: value || "#000"}} /></span>
          <input className="hex" value={(value || "#000000").toUpperCase()} onChange={e => onChange(e.target.value)} />
          <input className="alpha" type="number" min={0} max={255} defaultValue={255} />
        </div>
      </div>
    );
  }
  if (f.type === "enum") {
    return (
      <div className="field">
        <label>{f.label}</label>
        <div className="select">
          <select value={value ?? 0} onChange={e => onChange(parseInt(e.target.value))}>
            {f.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
          </select>
        </div>
      </div>
    );
  }
  if (f.type === "asset" || f.type === "ref") {
    const Ico = f.type === "ref" ? I.Cube : (f.assetType === "mesh" ? I.Mesh : f.assetType === "material" ? I.Material : I.File);
    return (
      <div className="field">
        <label>{f.label}</label>
        <div className="ref">
          <span className="ref-ico"><Ico /></span>
          <span className="ref-label">{value || "None"}</span>
          <span className="ref-pick"><I.More /></span>
        </div>
      </div>
    );
  }
  return (
    <div className="field">
      <label>{f.label}</label>
      <input className="in" value={String(value ?? "")} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

window.Inspector = Inspector;
