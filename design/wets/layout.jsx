/* Layout engine: docked panels with tab-dragging, resize, close */

const { useState: useLS, useEffect: useLE, useRef: useLR, useCallback: useLC } = React;

/* ── panel registry is filled by app.jsx (setPanel) ── */
const PANELS = {};
function registerPanel(id, def) { PANELS[id] = def; }
window.registerPanel = registerPanel;
window.PANELS = PANELS;

/* ── Slot: renders tab header + active panel body ── */
function Slot({ slotId, tabs, activeId, onSetActive, onClose, onDragStart, onDragOver, onDrop, ctx, registry, extraHeader }) {
  const active = tabs.find(t => t === activeId) || tabs[0];
  const def = active ? (registry[active] || PANELS[active]) : null;
  const [hover, setHover] = useLS(false);

  return (
    <div className={"slot" + (hover ? " drop-hover" : "")}
         onDragOver={(e) => { if (onDragOver) { e.preventDefault(); setHover(true); onDragOver(e, slotId); } }}
         onDragLeave={() => setHover(false)}
         onDrop={(e) => { setHover(false); if (onDrop) onDrop(e, slotId); }}>
      <div className="slot-tabs">
        {tabs.map(id => {
          const pd = registry[id] || PANELS[id];
          if (!pd) return null;
          const Ico = pd.icon;
          return (
            <div key={id}
                 className={"slot-tab" + (id === active ? " active" : "")}
                 draggable
                 onDragStart={(e) => { e.dataTransfer.setData("text/x-wets-tab", id + "|" + slotId); e.dataTransfer.effectAllowed = "move"; onDragStart && onDragStart(id, slotId); }}
                 onMouseDown={() => onSetActive(slotId, id)}
                 title="Drag to move, × to close">
              {Ico && <span className="ti"><Ico /></span>}
              <span className="tl">{pd.title}</span>
              {pd.badge && <span className={"tb " + (pd.badgeCls || "")}>{pd.badge(ctx)}</span>}
              <span className="tx" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(slotId, id); }} title="Close">×</span>
            </div>
          );
        })}
        {tabs.length === 0 && <div className="slot-empty">Drop a panel here</div>}
        <div className="slot-filler" />
        {extraHeader}
      </div>
      <div className="slot-body">
        {def && def.render(ctx)}
      </div>
    </div>
  );
}

/* ── Resize handle ── */
function ResizeH({ orientation, onDelta, style }) {
  const startRef = useLR(null);
  const onDown = (e) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, y: e.clientY };
    const move = (ev) => {
      const d = orientation === "col" ? ev.clientX - startRef.current.x : ev.clientY - startRef.current.y;
      startRef.current = { x: ev.clientX, y: ev.clientY };
      onDelta(d);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = orientation === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };
  return <div className={"rh " + orientation} style={style} onMouseDown={onDown} />;
}

/* ── DockWorkspace: grid of 4 slots with drag between + resize ── */
function DockWorkspace({ layout, setLayout, ctx, registry, extraHeaders }) {
  const { slots, active, widthL, widthR, heightB } = layout;

  const setActive = (slot, id) => setLayout(L => ({ ...L, active: { ...L.active, [slot]: id } }));

  const closeTab = (slot, id) => {
    setLayout(L => {
      const newTabs = L.slots[slot].filter(t => t !== id);
      const newActive = { ...L.active };
      if (L.active[slot] === id) newActive[slot] = newTabs[0] || null;
      return { ...L, slots: { ...L.slots, [slot]: newTabs }, active: newActive };
    });
  };

  const onDrop = (e, targetSlot) => {
    const data = e.dataTransfer.getData("text/x-wets-tab");
    if (!data) return;
    const [id, fromSlot] = data.split("|");
    if (fromSlot === targetSlot) return;
    setLayout(L => {
      const fromTabs = L.slots[fromSlot].filter(t => t !== id);
      const toTabs = [...L.slots[targetSlot].filter(t => t !== id), id];
      const newActive = { ...L.active, [targetSlot]: id };
      if (L.active[fromSlot] === id) newActive[fromSlot] = fromTabs[0] || null;
      return {
        ...L,
        slots: { ...L.slots, [fromSlot]: fromTabs, [targetSlot]: toTabs },
        active: newActive,
      };
    });
  };

  const showLeft   = slots.left.length  > 0;
  const showRight  = slots.right.length > 0;
  const showBottom = slots.bottom.length > 0;

  const cols = [
    showLeft   ? widthL + "px" : null,
    "1fr",
    showRight  ? widthR + "px" : null,
  ].filter(Boolean).join(" ");

  return (
    <div className="dock" style={{ gridTemplateColumns: cols, gridTemplateRows: showBottom ? `1fr ${heightB}px` : "1fr" }}>
      {showLeft && (
        <div className="dock-col dock-left" style={{ gridRow: showBottom ? "1 / span 2" : "1" }}>
          <Slot slotId="left" tabs={slots.left} activeId={active.left}
                onSetActive={setActive} onClose={closeTab}
                onDragOver={() => {}} onDrop={onDrop} ctx={ctx} registry={registry} extraHeader={extraHeaders?.left} />
          <ResizeH orientation="col"
            style={{ right: -3 }}
            onDelta={(d) => setLayout(L => ({ ...L, widthL: Math.max(180, Math.min(500, L.widthL + d)) }))} />
        </div>
      )}
      <div className="dock-center">
        <Slot slotId="center" tabs={slots.center} activeId={active.center}
              onSetActive={setActive} onClose={closeTab}
              onDragOver={() => {}} onDrop={onDrop} ctx={ctx} registry={registry} extraHeader={extraHeaders?.center} />
      </div>
      {showRight && (
        <div className="dock-col dock-right" style={{ gridRow: showBottom ? "1 / span 2" : "1" }}>
          <Slot slotId="right" tabs={slots.right} activeId={active.right}
                onSetActive={setActive} onClose={closeTab}
                onDragOver={() => {}} onDrop={onDrop} ctx={ctx} registry={registry} extraHeader={extraHeaders?.right} />
          <ResizeH orientation="col"
            style={{ left: -3 }}
            onDelta={(d) => setLayout(L => ({ ...L, widthR: Math.max(220, Math.min(600, L.widthR - d)) }))} />
        </div>
      )}
      {showBottom && (
        <div className="dock-bottom" style={{ gridColumn: showLeft && showRight ? "2" : (showLeft ? "2" : (showRight ? "1" : "1")) }}>
          <ResizeH orientation="row"
            style={{ top: -3, left: 0, right: 0 }}
            onDelta={(d) => setLayout(L => ({ ...L, heightB: Math.max(120, Math.min(600, L.heightB - d)) }))} />
          <Slot slotId="bottom" tabs={slots.bottom} activeId={active.bottom}
                onSetActive={setActive} onClose={closeTab}
                onDragOver={() => {}} onDrop={onDrop} ctx={ctx} registry={registry} extraHeader={extraHeaders?.bottom} />
        </div>
      )}
    </div>
  );
}

window.DockWorkspace = DockWorkspace;
window.Slot = Slot;
