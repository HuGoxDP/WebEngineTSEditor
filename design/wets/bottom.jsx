/* Bottom pane: Project / Console / Timeline / Code tabs */

function BottomPane({ tab, setTab, scene }) {
  const logCount = WETS_DATA.INITIAL_LOGS.length;
  const errs = WETS_DATA.INITIAL_LOGS.filter(l => l.lvl === "err").length;
  const warns = WETS_DATA.INITIAL_LOGS.filter(l => l.lvl === "warn").length;

  return (
    <div className="bot">
      <div className="pane-tabs">
        <div className={"pane-tab" + (tab === "project" ? " active" : "")} onClick={() => setTab("project")}>
          <I.Folder /> Project <span className="badge">47</span>
        </div>
        <div className={"pane-tab" + (tab === "console" ? " active" : "")} onClick={() => setTab("console")}>
          <I.Info /> Console
          {warns > 0 && <span className="badge warn">{warns}</span>}
          {errs > 0 && <span className="badge err">{errs}</span>}
        </div>
        <div className={"pane-tab" + (tab === "timeline" ? " active" : "")} onClick={() => setTab("timeline")}>
          <I.Clock /> Animation
        </div>
        <div className={"pane-tab" + (tab === "code" ? " active" : "")} onClick={() => setTab("code")}>
          <I.Script /> Code
        </div>
        <div className="pane-header-actions">
          <button className="ico-btn"><I.Kebab /></button>
        </div>
      </div>
      <div className="bot-body">
        {tab === "project" && <ProjectTab />}
        {tab === "console" && <ConsoleTab />}
        {tab === "timeline" && <TimelineTab />}
        {tab === "code" && <CodeTab />}
      </div>
    </div>
  );
}

/* ── Project ─────────────────────────────────────────────── */
function ProjectTab() {
  const [folder, setFolder] = useState("Assets/Scripts");
  const [selected, setSelected] = useState(null);

  const folders = WETS_DATA.FOLDERS;
  const assets = WETS_DATA.ASSETS[folder] || [];

  const crumbs = folder.split("/");

  return (
    <div className="proj">
      <div className="folders">
        <div className="folder" style={{fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'default', height: 22}}>
          Favorites
        </div>
        <div className="folder nested" style={{color: 'var(--fg-2)'}}><I.Search /> All Scripts</div>
        <div className="folder nested" style={{color: 'var(--fg-2)'}}><I.Search /> All Materials</div>
        <div className="folder" style={{fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'default', height: 22, marginTop: 6}}>
          Project
        </div>
        {folders.map(f => (
          <div key={f.id}
               className={"folder" + (f.level === 1 ? " nested" : "") + (folder === f.id ? " active" : "")}
               onClick={() => setFolder(f.id)}>
            <span className="caret open"><I.Caret /></span>
            {folder === f.id || f.expanded ? <I.FolderOpen /> : <I.Folder />}
            <span>{f.label}</span>
          </div>
        ))}
      </div>

      <div className="files">
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sep">›</span>}
              <span className={"c" + (i === crumbs.length - 1 ? " here" : "")}>{c}</span>
            </React.Fragment>
          ))}
          <span style={{marginLeft: 'auto', color: 'var(--fg-3)'}}>{assets.length} items</span>
        </div>

        <div className="grid">
          {assets.map((a, i) => {
            const tCls = a.type === "folder" ? "folder" : a.type === "material" ? "material" : a.type === "mesh" ? "mesh" : a.type === "tex" ? "tex" : a.type === "script" ? "script" : a.type === "prefab" ? "prefab" : a.type === "audio" ? "audio" : "";
            const Ico = {
              folder: I.FolderOpen, scene: I.Scene, script: I.Script, material: I.Material,
              mesh: I.Mesh, tex: I.Texture, prefab: I.Prefab, audio: I.Audio,
            }[a.type] || I.File;
            return (
              <div key={i} className={"asset" + (selected === i ? " selected" : "")} onClick={() => setSelected(i)}>
                <span className={"thumb " + tCls} style={a.tint ? {background: a.tint, borderColor: 'transparent'} : {}}>
                  <Ico />
                </span>
                <span className="label">{a.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Console ─────────────────────────────────────────────── */
function ConsoleTab() {
  const logs = WETS_DATA.INITIAL_LOGS;
  const [filter, setFilter] = useState({ info: true, warn: true, err: true });

  const visible = logs.filter(l => filter[l.lvl]);

  return (
    <div className="console">
      <div style={{display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', background: 'var(--bg-1)', borderBottom: '1px solid var(--line)'}}>
        <button className="create-btn" style={{height: 20, padding: '0 6px', fontSize: 10}}><I.Trash /> Clear</button>
        <div className="tb-sep" />
        <button className={"chip" + (filter.info ? " active" : "")} style={chipStyle} onClick={() => setFilter(f => ({...f, info: !f.info}))}>
          <I.Info style={{color: 'var(--info)'}}/> <span>{logs.filter(l => l.lvl === 'info').length}</span>
        </button>
        <button className={"chip" + (filter.warn ? " active" : "")} style={chipStyle} onClick={() => setFilter(f => ({...f, warn: !f.warn}))}>
          <I.Warn style={{color: 'var(--warn)'}}/> <span>{logs.filter(l => l.lvl === 'warn').length}</span>
        </button>
        <button className={"chip" + (filter.err ? " active" : "")} style={chipStyle} onClick={() => setFilter(f => ({...f, err: !f.err}))}>
          <I.Err style={{color: 'var(--err)'}}/> <span>{logs.filter(l => l.lvl === 'err').length}</span>
        </button>
        <div style={{flex: 1}} />
        <div className="h-search" style={{height: 20, width: 200}}>
          <I.Search />
          <input placeholder="Filter logs…" />
        </div>
        <button className="create-btn" style={{height: 20, padding: '0 6px', fontSize: 10, marginLeft: 4}}>Collapse</button>
        <button className="create-btn" style={{height: 20, padding: '0 6px', fontSize: 10}}>Clear on Play</button>
      </div>

      <div style={{flex: 1, overflow: 'auto'}}>
        {visible.map((l, i) => {
          const IcoL = l.lvl === 'info' ? I.Info : l.lvl === 'warn' ? I.Warn : I.Err;
          return (
            <div key={i} className={"log " + l.lvl}>
              <span className="time">{l.t}</span>
              <span className="lvl"><IcoL /></span>
              <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{l.msg}</span>
              <span className="src">{l.src}</span>
              <span className="pin">{l.pin}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
const chipStyle = { height: 20, padding: '0 6px', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', color: 'var(--fg-1)', cursor: 'pointer' };

/* ── Timeline ────────────────────────────────────────────── */
function TimelineTab() {
  const tl = WETS_DATA.INITIAL_TIMELINE;
  const pxPerSec = 70;
  const width = tl.duration * pxPerSec;
  const playX = tl.playhead * pxPerSec;

  return (
    <div style={{display: 'flex', flexDirection: 'column', height: '100%'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', background: 'var(--bg-1)', borderBottom: '1px solid var(--line)'}}>
        <button className="tb-btn" style={{height: 20}}><I.Play /></button>
        <button className="tb-btn" style={{height: 20}}><I.Pause /></button>
        <button className="tb-btn" style={{height: 20}}><I.Stop /></button>
        <div className="tb-sep" />
        <button className="tb-btn active" style={{height: 20, color: 'var(--err)'}}><span style={{width: 7, height: 7, borderRadius: '50%', background: 'var(--err)'}}/> REC</button>
        <div className="tb-sep" />
        <span className="mono" style={{fontSize: 10, color: 'var(--fg-2)'}}>PlayerController</span>
        <I.CaretDown />
        <div style={{flex: 1}} />
        <span className="mono" style={{fontSize: 10, color: 'var(--fg-1)'}}>{tl.playhead.toFixed(2)}s / {tl.duration.toFixed(2)}s</span>
        <div className="tb-sep" />
        <button className="create-btn" style={{height: 20, fontSize: 10}}><I.Keyframe/> Add Key</button>
      </div>

      <div className="timeline" style={{flex: 1, minHeight: 0}}>
        <div className="tl-tracks">
          <div style={{height: 22, borderBottom: '1px solid var(--line)', background: 'var(--bg-2)'}}/>
          {tl.tracks.map((t, i) => (
            <div key={i} className="track">
              {t.kind === 'anim' && <I.Keyframe style={{color: 'var(--accent)'}}/>}
              {t.kind === 'audio' && <I.Audio style={{color: 'var(--ok)'}}/>}
              {t.kind === 'event' && <I.Info style={{color: '#c084fc'}}/>}
              <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1}}>{t.name}</span>
              {i === 0 && <span className="rec" />}
            </div>
          ))}
        </div>

        <div className="tl-lane-wrap">
          <div style={{width: width, position: 'relative'}}>
            <div className="tl-ruler">
              {[...Array(Math.ceil(tl.duration) + 1)].map((_, i) => (
                <React.Fragment key={i}>
                  <div className="tick" style={{left: i * pxPerSec}} />
                  <div className="tick-label" style={{left: i * pxPerSec}}>{i}.0s</div>
                </React.Fragment>
              ))}
            </div>
            <div className="tl-lanes">
              {tl.tracks.map((t, i) => (
                <div key={i} className="lane">
                  {(t.clips || []).map((c, ci) => (
                    <div key={ci} className={"clip " + t.color}
                         style={{left: c.start * pxPerSec, width: (c.end - c.start) * pxPerSec}}>
                      {t.name.split(' / ').pop()}
                    </div>
                  ))}
                  {(t.keys || []).map((k, ki) => (
                    <div key={ki} className="keyframe" style={{left: k * pxPerSec}} />
                  ))}
                </div>
              ))}
            </div>
            <div className="playhead" style={{left: playX}} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Code ───────────────────────────────────────────────── */
function CodeTab() {
  const scripts = WETS_DATA.FAKE_SCRIPTS;
  const names = Object.keys(scripts);
  const [file, setFile] = useState(names[0]);

  return (
    <div className="code">
      <div className="files-col">
        <div style={{padding: '4px 10px', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.08em'}}>
          Assets/Scripts
        </div>
        {names.map(n => (
          <div key={n} className={"f" + (n === file ? " active" : "")} onClick={() => setFile(n)}>
            <I.Script /> <span>{n}</span>
          </div>
        ))}
      </div>
      <div className="editor">
        <CodePre source={scripts[file]} />
      </div>
    </div>
  );
}

function CodePre({ source }) {
  const lines = source.split('\n');
  return (
    <pre>
      {lines.map((raw, i) => (
        <div key={i} className={"line" + (i === 12 ? " cur" : "")}>
          <span className="ln mono">{i + 1}</span>
          <code className="mono" dangerouslySetInnerHTML={{__html: hl(raw)}} />
        </div>
      ))}
    </pre>
  );
}

/** super-dumb TS highlighter */
function hl(s) {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/(\/\/.*$)/g, '<span class="c">$1</span>')
    .replace(/("[^"]*"|'[^']*'|`[^`]*`)/g, '<span class="s">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="n">$1</span>')
    .replace(/(@[A-Za-z_][A-Za-z0-9_]*)/g, '<span class="d">$1</span>')
    .replace(/\b(import|from|export|class|extends|public|private|protected|return|if|new|const|let|var|this|null|true|false|async|await|void|number|string|boolean)\b/g, '<span class="k">$1</span>')
    .replace(/\b(Behaviour|GameObject|Vector3|Rigidbody|KeyCode|Input|Range|Field|Serializable)\b/g, '<span class="t">$1</span>');
}

window.BottomPane = BottomPane;
Object.assign(window, { ProjectTab, ConsoleTab, TimelineTab, CodeTab });
