// Pollen Manager — Phase 4.1 WYSIWYG editor.
//
// State model
//   wf            current workflow object, parsed
//                 wf._layout[nodeName] = {x, y}  ← sidecar, persists positions
//   selected      currently selected node name, or null
//
// Interactions
//   Drag a node            mousedown+mousemove on the node group ; on mouseup
//                          we commit wf._layout[name] and re-render edges.
//   Click a node           open inspector for that node, populate form.
//   Apply (inspector)      copy form values back into wf.nodes[selected],
//                          handle rename (move key), redraw + update raw view.
//   Add node               creates a new entry in wf.nodes with default
//                          fields ; auto-selected.
//   Delete selected        drops wf.nodes[selected] + any next: refs pointing
//                          at it.
//   Save                   PUT /api/workflow with JSON.stringify(wf, null, 2).
//   Reload                 GET /api/workflow, discard local changes.
//
// The textarea in the inspector is read-only — it's the canonical
// view of the JSON that will be PUT'd. Edit happens via the form
// or by dragging.

(() => {
  const $svg      = document.getElementById('dag');
  const $src      = document.getElementById('src');
  const $status   = document.getElementById('status');
  const $save     = document.getElementById('save');
  const $reload   = document.getElementById('reload');
  const $add      = document.getElementById('add-node');
  const $delete   = document.getElementById('delete-node');
  const $form     = document.getElementById('inspector-form');
  const $empty    = document.getElementById('inspector-empty');
  const $fName    = document.getElementById('f-name');
  const $fHost    = document.getElementById('f-host');
  const $fPort    = document.getElementById('f-port');
  const $fCons    = document.getElementById('f-consumes');
  const $fEmits   = document.getElementById('f-emits');
  const $fNext    = document.getElementById('f-next');
  const $apply    = document.getElementById('apply');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 100;
  const NODE_H = 44;
  const CANVAS_W = 800;
  const CANVAS_H = 420;

  let wf = null;
  let selected = null;
  let drag = null;     // { name, dx, dy } during a drag

  // ── status helpers ──────────────────────────────────────────
  function setStatus(msg, kind) {
    $status.textContent = msg;
    $status.className = kind || '';
  }

  // ── data <-> view ───────────────────────────────────────────
  function refreshRaw() {
    $src.value = JSON.stringify(wf, null, 2);
  }

  function ensureLayout() {
    if (!wf._layout) wf._layout = {};
    // For every node missing a layout entry, compute one via topo.
    const fallback = topoLayout(wf);
    for (const k of Object.keys(wf.nodes || {})) {
      if (!wf._layout[k]) wf._layout[k] = fallback[k];
    }
    // Drop layout entries for deleted nodes.
    for (const k of Object.keys(wf._layout)) {
      if (!wf.nodes[k]) delete wf._layout[k];
    }
  }

  // Trivial topological column layout — same as Phase 4.0.
  function topoLayout(wf) {
    const nodes = wf.nodes || {};
    const keys = Object.keys(nodes);
    if (!keys.length) return {};
    const edges = [];
    for (const k of keys) {
      for (const tgt of (nodes[k].next || [])) {
        if (nodes[tgt]) edges.push({ from: k, to: tgt });
      }
    }
    const indeg = Object.fromEntries(keys.map(k => [k, 0]));
    for (const e of edges) indeg[e.to]++;
    const rank = {};
    const queue = keys.filter(k => indeg[k] === 0);
    queue.forEach(k => rank[k] = 0);
    while (queue.length) {
      const k = queue.shift();
      for (const e of edges) {
        if (e.from === k) {
          const r = Math.max(rank[e.to] || 0, (rank[k] || 0) + 1);
          if (r !== rank[e.to]) { rank[e.to] = r; queue.push(e.to); }
        }
      }
    }
    keys.forEach(k => { if (rank[k] === undefined) rank[k] = 0; });
    const cols = {};
    for (const k of keys) { (cols[rank[k]] ||= []).push(k); }
    const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);
    const padX = 80, padY = 60;
    const stepX = colKeys.length > 1 ? (CANVAS_W - 2 * padX) / (colKeys.length - 1) : 0;
    const out = {};
    for (let ci = 0; ci < colKeys.length; ci++) {
      const col = cols[colKeys[ci]];
      const stepY = col.length > 1 ? (CANVAS_H - 2 * padY) / (col.length - 1) : 0;
      for (let i = 0; i < col.length; i++) {
        out[col[i]] = {
          x: padX + ci * stepX,
          y: col.length === 1 ? CANVAS_H / 2 : padY + i * stepY,
        };
      }
    }
    return out;
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── render ──────────────────────────────────────────────────
  function render() {
    ensureLayout();
    $svg.innerHTML = '';
    // arrow marker
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML =
      '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
      'markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="#888"/></marker>';
    $svg.appendChild(defs);

    // edges
    const nodes = wf.nodes || {};
    for (const [from, n] of Object.entries(nodes)) {
      const a = wf._layout[from];
      if (!a) continue;
      for (const to of (n.next || [])) {
        const b = wf._layout[to];
        if (!b) continue;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', 'edge');
        line.setAttribute('x1', a.x + NODE_W / 2);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x - NODE_W / 2);
        line.setAttribute('y2', b.y);
        $svg.appendChild(line);
      }
    }

    // nodes
    for (const [k, n] of Object.entries(nodes)) {
      const p = wf._layout[k];
      if (!p) continue;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'node-group' + (k === selected ? ' selected' : ''));
      g.setAttribute('data-name', k);
      g.setAttribute('transform', `translate(${p.x}, ${p.y})`);

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'node-rect');
      rect.setAttribute('x', -NODE_W / 2);
      rect.setAttribute('y', -NODE_H / 2);
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', 6);
      g.appendChild(rect);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'node-label');
      label.setAttribute('y', -2);
      label.textContent = k;
      g.appendChild(label);

      const meta = document.createElementNS(SVG_NS, 'text');
      meta.setAttribute('class', 'node-meta');
      meta.setAttribute('y', 14);
      meta.textContent = (n.host || '?') + ':' + (n.port || '?');
      g.appendChild(meta);

      g.addEventListener('mousedown', e => onNodeMouseDown(e, k));
      $svg.appendChild(g);
    }

    refreshRaw();
    syncInspector();
  }

  // ── drag ────────────────────────────────────────────────────
  function svgPoint(evt) {
    const pt = $svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform($svg.getScreenCTM().inverse());
  }

  function onNodeMouseDown(evt, name) {
    evt.preventDefault();
    const p = svgPoint(evt);
    const layout = wf._layout[name] || { x: 0, y: 0 };
    drag = { name, dx: layout.x - p.x, dy: layout.y - p.y, moved: false };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(evt) {
    if (!drag) return;
    const p = svgPoint(evt);
    const nx = Math.max(NODE_W / 2, Math.min(CANVAS_W - NODE_W / 2, p.x + drag.dx));
    const ny = Math.max(NODE_H / 2, Math.min(CANVAS_H - NODE_H / 2, p.y + drag.dy));
    wf._layout[drag.name] = { x: nx, y: ny };
    drag.moved = true;
    render();
  }

  function onMouseUp(evt) {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (drag) {
      if (!drag.moved) {
        // click without drag → select
        select(drag.name);
      }
      drag = null;
    }
  }

  // ── selection / inspector ───────────────────────────────────
  function select(name) {
    selected = name;
    $delete.disabled = !name;
    render();
  }

  function syncInspector() {
    if (!selected || !wf.nodes[selected]) {
      $form.hidden = true;
      $empty.hidden = false;
      return;
    }
    $empty.hidden = true;
    $form.hidden = false;
    const n = wf.nodes[selected];
    $fName.value  = selected;
    $fHost.value  = n.host  || '';
    $fPort.value  = n.port  || '';
    $fCons.value  = (n.consumes || []).join(', ');
    $fEmits.value = (n.emits    || []).join(', ');
    $fNext.value  = (n.next     || []).join(', ');
  }

  function applyForm() {
    if (!selected) return;
    const newName = $fName.value.trim();
    if (!newName) {
      setStatus('node name required', 'error');
      return;
    }
    if (newName !== selected && wf.nodes[newName]) {
      setStatus('name "' + newName + '" already in use', 'error');
      return;
    }
    const n = wf.nodes[selected];
    n.host = $fHost.value.trim() || '127.0.0.1';
    n.port = Number($fPort.value) || 0;
    n.consumes = splitList($fCons.value);
    n.emits    = splitList($fEmits.value);
    n.next     = splitList($fNext.value);
    if (newName !== selected) {
      // rename: move key + retarget _layout + retarget next refs
      wf.nodes[newName] = n;
      delete wf.nodes[selected];
      wf._layout[newName] = wf._layout[selected];
      delete wf._layout[selected];
      for (const k of Object.keys(wf.nodes)) {
        const nx = wf.nodes[k];
        if (Array.isArray(nx.next)) {
          nx.next = nx.next.map(t => t === selected ? newName : t);
        }
      }
      selected = newName;
    }
    setStatus('applied (unsaved)', 'ok');
    render();
  }

  function splitList(s) {
    return s.split(',').map(x => x.trim()).filter(x => x.length > 0);
  }

  // ── add / delete ────────────────────────────────────────────
  function addNode() {
    let i = 1;
    while (wf.nodes['node' + i]) i++;
    const name = 'node' + i;
    wf.nodes[name] = {
      host: '127.0.0.1',
      port: 7900 + i,
      consumes: [],
      emits: [],
      next: [],
    };
    wf._layout = wf._layout || {};
    wf._layout[name] = { x: 200 + (i * 30) % 400, y: 200 + (i * 20) % 100 };
    select(name);
    setStatus('added ' + name + ' (unsaved)', 'ok');
  }

  function deleteSelected() {
    if (!selected) return;
    const dead = selected;
    delete wf.nodes[dead];
    if (wf._layout) delete wf._layout[dead];
    for (const k of Object.keys(wf.nodes)) {
      const n = wf.nodes[k];
      if (Array.isArray(n.next)) n.next = n.next.filter(t => t !== dead);
    }
    selected = null;
    $delete.disabled = true;
    setStatus('deleted ' + dead + ' (unsaved)', 'ok');
    render();
  }

  // ── load / save ─────────────────────────────────────────────
  async function load() {
    setStatus('loading…');
    try {
      const r = await fetch('/api/workflow');
      const txt = await r.text();
      if (!r.ok) {
        setStatus('GET failed (' + r.status + ')', 'error');
        return;
      }
      wf = JSON.parse(txt);
      if (!wf.nodes) wf.nodes = {};
      selected = null;
      $delete.disabled = true;
      render();
      setStatus('loaded · ' + Object.keys(wf.nodes).length + ' node(s)', 'ok');
    } catch (e) {
      setStatus('load error: ' + e.message, 'error');
    }
  }

  async function save() {
    setStatus('saving…');
    try {
      const body = JSON.stringify(wf, null, 2);
      const r = await fetch('/api/workflow', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const reply = await r.json();
      if (!r.ok) {
        setStatus('PUT failed: ' + (reply.error || r.status), 'error');
        return;
      }
      setStatus('saved → ' + reply.path + ' (' + reply.bytes + ' bytes)', 'ok');
    } catch (e) {
      setStatus('save error: ' + e.message, 'error');
    }
  }

  // ── wiring ──────────────────────────────────────────────────
  $save.addEventListener('click', save);
  $reload.addEventListener('click', load);
  $add.addEventListener('click', addNode);
  $delete.addEventListener('click', deleteSelected);
  $apply.addEventListener('click', applyForm);

  // Clicking empty SVG deselects.
  $svg.addEventListener('mousedown', e => {
    if (e.target === $svg) select(null);
  });

  load();
})();
