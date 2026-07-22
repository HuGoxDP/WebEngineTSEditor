/* Scene / Game viewport */

function Viewport({ view, setView, tool, playing, paused, scene, selectedId, forceView, showGizmo = true }) {
  const selected = scene.nodes.find(n => n.id === selectedId);
  const v = forceView || view;

  return (
    <div className="viewport-wrap">
      {!forceView && (
        <div className="vp-tabs">
          <div className={"vp-tab" + (v === "scene" ? " active" : "")} onClick={() => setView("scene")}>
            <I.Scene /> Scene
          </div>
          <div className={"vp-tab" + (v === "game" ? " active" : "")} onClick={() => setView("game")}>
            <I.Game /> Game
            {playing && <span style={{width: 5, height: 5, borderRadius: '50%', background: 'var(--live)'}} />}
          </div>
          <div className="spacer" />
          {v === "game" && (
            <div className="vp-aspect">
              <span>Display 1</span>
              <span className="mono">1920×1080</span>
              <I.CaretDown />
            </div>
          )}
        </div>
      )}

      {v === "scene" && <VPSubToolbar tool={tool} />}
      {forceView === "game" && (
        <div className="vp-subtoolbar">
          <button className="chip active"><span>Display 1</span><I.CaretDown className="caret" /></button>
          <button className="chip"><span className="mono">Free Aspect</span><I.CaretDown className="caret" /></button>
          <button className="chip"><span className="mono">1.0×</span></button>
          <button className="chip"><I.Eye /><span>Stats</span></button>
          <button className="chip"><span>Gizmos</span></button>
          <div className="spacer" />
          {playing && !paused && <span className="tb-live"><span className="rec" /> LIVE</span>}
        </div>
      )}

      <div className="vp-canvas">
        {v === "scene" ? (
          <SceneView tool={tool} scene={scene} selected={selected} showGizmo={showGizmo} />
        ) : (
          <GameView playing={playing} paused={paused} />
        )}
      </div>
    </div>
  );
}

function VPSubToolbar({ tool }) {
  return (
    <div className="vp-subtoolbar">
      <button className="chip active"><span>Shaded</span><I.CaretDown className="caret" /></button>
      <button className="chip"><span>2D</span></button>
      <button className="chip"><I.Light /><span>Lit</span></button>
      <button className="chip"><I.Eye /><span>Gizmos</span></button>
      <button className="chip"><I.Grid /><span>Grid</span></button>
      <div className="spacer" />
      <button className="chip"><I.Camera /><span>Main Camera</span><I.CaretDown className="caret" /></button>
      <button className="chip"><span className="mono">1.0×</span></button>
      <button className="chip"><I.More /></button>
    </div>
  );
}

function SceneView({ tool, scene, selected, showGizmo = true }) {
  // Render objects as 2D projected placeholders with grid
  return (
    <>
      <div className="grid-bg" />
      <div className="ground-line" />

      <div className="vp-overlay-tl">
        <span className="chip"><span className="k">cam</span><span className="v mono">(0.0, 2.5, −8.0)</span></span>
        <span className="chip"><span className="k">fov</span><span className="v mono">60°</span></span>
        <span className="chip"><span className="k">sel</span><span className="v mono">{selected?.name || '—'}</span></span>
      </div>

      <div className="vp-scene">
        <SceneObjects scene={scene} selected={selected} />
      </div>

      {showGizmo && (<svg className="vp-gizmo" viewBox="0 0 100 100">
        <defs>
          <marker id="arrX" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="#ff6565"/>
          </marker>
          <marker id="arrY" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="#65dc7c"/>
          </marker>
          <marker id="arrZ" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="#4fa6ff"/>
          </marker>
        </defs>
        <circle cx="50" cy="50" r="44" fill="rgba(20,22,27,0.7)" stroke="#3a3d46" strokeWidth="1"/>
        <line x1="50" y1="50" x2="84" y2="50" stroke="#ff6565" strokeWidth="2.5" markerEnd="url(#arrX)"/>
        <line x1="50" y1="50" x2="50" y2="16" stroke="#65dc7c" strokeWidth="2.5" markerEnd="url(#arrY)"/>
        <line x1="50" y1="50" x2="28" y2="72" stroke="#4fa6ff" strokeWidth="2.5" markerEnd="url(#arrZ)"/>
        <circle cx="50" cy="50" r="3" fill="#e8e8ea"/>
        <text x="86" y="54" fill="#ff6565" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="700">X</text>
        <text x="46" y="14" fill="#65dc7c" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="700">Y</text>
        <text x="20" y="80" fill="#4fa6ff" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="700">Z</text>
      </svg>)}

      <div className="vp-stats">
        <span className="k">Draw</span><span className="v">14</span>
        <span className="k">Tris</span><span className="v">24,810</span>
        <span className="k">Verts</span><span className="v">12,405</span>
        <span className="k">Batches</span><span className="v">8</span>
        <span className="k">Scene</span><span className="v accent">Shaded · Lit</span>
      </div>
    </>
  );
}

function SceneObjects({ scene, selected }) {
  // very rough axonometric projection
  const project = (x, y, z) => {
    // iso-ish
    const px = (x - z) * 22;
    const py = -(y * 28) + (x + z) * 11;
    return { px, py };
  };

  const objs = scene.nodes.filter(n =>
    ["cube", "player", "camera", "light"].includes(n.kind)
  );

  return (
    <>
      {/* ground faux-plane */}
      <svg className="ground-shape" style={{position: 'absolute', left: '50%', top: '58%', width: 900, height: 500, transform: 'translate(-50%, -50%)', pointerEvents: 'none'}} viewBox="-450 -250 900 500">
        <defs>
          <linearGradient id="groundG" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2b2d34" stopOpacity="0.5"/>
            <stop offset="100%" stopColor="#1a1b20" stopOpacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="-440,-10 440,-10 260,110 -260,110" fill="url(#groundG)" stroke="#3a3d46" strokeWidth="0.5"/>
      </svg>

      {objs.map(n => {
        const [x, y, z] = n.state.transform.pos;
        const [sx, sy, sz] = n.state.transform.scl;
        const { px, py } = project(x, y, z);
        const isSel = selected?.id === n.id;
        const c = n.state.mesh?.color || (n.kind === "light" ? "#ffcf4a" : n.kind === "camera" ? "#4fa6ff" : "#a07040");

        if (n.kind === "light") {
          return (
            <div key={n.id} className={"obj" + (isSel ? " selected" : "")} style={{transform: `translate(${px}px, ${py}px)`}}>
              <svg width="50" height="50" viewBox="-25 -25 50 50" style={{overflow: 'visible'}}>
                <circle cx="0" cy="0" r="7" fill="#ffcf4a" opacity="0.9"/>
                <circle cx="0" cy="0" r="14" fill="none" stroke="#ffcf4a" strokeWidth="1" strokeDasharray="2 2" opacity="0.6"/>
                {[...Array(8)].map((_, i) => {
                  const a = (i / 8) * Math.PI * 2;
                  return <line key={i} x1={Math.cos(a)*10} y1={Math.sin(a)*10} x2={Math.cos(a)*20} y2={Math.sin(a)*20} stroke="#ffcf4a" strokeWidth="1.5" opacity="0.7"/>;
                })}
                {isSel && <circle cx="0" cy="0" r="22" fill="none" stroke="#ff9f2a" strokeWidth="1.5" className="obj-wire"/>}
              </svg>
              {isSel && <div className="obj-label">{n.name}</div>}
            </div>
          );
        }

        if (n.kind === "camera") {
          return (
            <div key={n.id} className={"obj" + (isSel ? " selected" : "")} style={{transform: `translate(${px}px, ${py}px)`}}>
              <svg width="64" height="50" viewBox="-32 -25 64 50" style={{overflow: 'visible'}}>
                <path d="M-14,-10 L14,-10 L14,10 L-14,10 Z" fill="#2a2c33" stroke="#4fa6ff" strokeWidth="1.5" className="obj-wire"/>
                <path d="M14,-6 L26,-12 L26,12 L14,6 Z" fill="#2a2c33" stroke="#4fa6ff" strokeWidth="1.5" className="obj-wire"/>
                <path d="M-14,-10 L-30,-25 L-30,25 L-14,10" fill="none" stroke="#4fa6ff" strokeWidth="1" strokeDasharray="3 2" opacity="0.5"/>
                <path d="M14,-10 L30,-25 M14,10 L30,25 M-30,-25 L30,-25 M-30,25 L30,25" stroke="#4fa6ff" strokeWidth="0.8" strokeDasharray="3 2" opacity="0.4"/>
                {isSel && <rect x="-22" y="-18" width="44" height="36" fill="none" stroke="#ff9f2a" strokeWidth="1.5"/>}
              </svg>
              {isSel && <div className="obj-label">{n.name}</div>}
            </div>
          );
        }

        // cubes / player
        const w = Math.abs(sx) * 36;
        const h = Math.abs(sy) * 36;
        const d = Math.abs(sz) * 22;
        return (
          <div key={n.id} className={"obj" + (isSel ? " selected" : "")} style={{transform: `translate(${px}px, ${py}px)`}}>
            <svg width={w + d + 10} height={h + d + 10} viewBox={`${-(w+d)/2-5} ${-(h+d)/2-5} ${w+d+10} ${h+d+10}`} style={{overflow: 'visible'}}>
              {/* top */}
              <polygon
                points={`${-w/2},${-h/2} ${w/2},${-h/2} ${w/2+d/2},${-h/2-d/2} ${-w/2+d/2},${-h/2-d/2}`}
                fill={shade(c, 1.25)} stroke={isSel ? "#ff9f2a" : "#17181c"} strokeWidth="1" className="obj-wire"/>
              {/* side */}
              <polygon
                points={`${w/2},${-h/2} ${w/2},${h/2} ${w/2+d/2},${h/2-d/2} ${w/2+d/2},${-h/2-d/2}`}
                fill={shade(c, 0.75)} stroke={isSel ? "#ff9f2a" : "#17181c"} strokeWidth="1" className="obj-wire"/>
              {/* front */}
              <polygon
                points={`${-w/2},${-h/2} ${w/2},${-h/2} ${w/2},${h/2} ${-w/2},${h/2}`}
                fill={c} stroke={isSel ? "#ff9f2a" : "#17181c"} strokeWidth="1" className="obj-wire"/>
            </svg>
            {isSel && (
              <>
                <div className="obj-label">{n.name}</div>
                {/* gizmo handles */}
                <svg style={{position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 160, height: 160, pointerEvents: 'none', overflow: 'visible'}} viewBox="-80 -80 160 160">
                  <line x1="0" y1="0" x2="60" y2="0" stroke="#ff6565" strokeWidth="2"/>
                  <polygon points="60,-4 72,0 60,4" fill="#ff6565"/>
                  <line x1="0" y1="0" x2="0" y2="-60" stroke="#65dc7c" strokeWidth="2"/>
                  <polygon points="-4,-60 0,-72 4,-60" fill="#65dc7c"/>
                  <line x1="0" y1="0" x2="-42" y2="42" stroke="#4fa6ff" strokeWidth="2"/>
                  <polygon points="-42,38 -52,52 -38,42" fill="#4fa6ff"/>
                  <rect x="-3" y="-3" width="6" height="6" fill="#ff9f2a"/>
                </svg>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function shade(hex, f) {
  const h = hex.replace('#', '');
  const r = Math.min(255, Math.round(parseInt(h.slice(0,2),16) * f));
  const g = Math.min(255, Math.round(parseInt(h.slice(2,4),16) * f));
  const b = Math.min(255, Math.round(parseInt(h.slice(4,6),16) * f));
  return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
}

function GameView({ playing, paused }) {
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!playing || paused) return;
    const id = setInterval(() => {
      setScore(s => s + Math.floor(Math.random() * 5));
      setTime(t => t + 0.1);
    }, 100);
    return () => clearInterval(id);
  }, [playing, paused]);

  return (
    <div className="vp-gameview">
      <div className="game-frame">
        <div className="hud">
          <span className="label">SCORE</span>
          <span className="big mono">{String(score).padStart(6, '0')}</span>
          <span className="label" style={{marginTop: 8}}>TIME</span>
          <span className="big mono">{time.toFixed(1)}s</span>
        </div>
        <div className="crosshair" />
        <div className="chars">
          <div className="player-stub" style={playing && !paused ? {
            animation: 'bobby 0.8s ease-in-out infinite alternate'
          } : {}} />
        </div>
        {!playing && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'grid', placeItems: 'center',
            background: 'rgba(10,11,14,0.55)', backdropFilter: 'blur(2px)',
            color: '#fff',
          }}>
            <div style={{textAlign: 'center'}}>
              <div style={{fontSize: 42, marginBottom: 8, color: 'var(--accent)'}}><I.Play /></div>
              <div style={{fontSize: 13, fontWeight: 600, letterSpacing: '0.15em'}}>PRESS PLAY TO START</div>
              <div style={{fontSize: 11, color: 'var(--fg-2)', marginTop: 4}} className="mono">Ctrl + P</div>
            </div>
          </div>
        )}
        {paused && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'grid', placeItems: 'center',
            background: 'rgba(10,11,14,0.4)',
          }}>
            <div style={{color: 'var(--accent)', fontSize: 13, fontWeight: 700, letterSpacing: '0.2em'}}>▌▌ PAUSED</div>
          </div>
        )}
      </div>
      <style>{`@keyframes bobby { to { transform: translateY(-8px); } }`}</style>
    </div>
  );
}

window.Viewport = Viewport;
