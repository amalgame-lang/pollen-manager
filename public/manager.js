// Pollen Manager — Phase 4.1.1 WYSIWYG editor.
//
// State
//   wf            current workflow object, parsed
//                 wf._layout[nodeName] = {x, y}  ← sidecar
//   selected      currently selected node name, or null
//
// Drag is incremental — render() is NOT called on every
// mousemove. We mutate only the dragged node's transform + the
// edges incident on it. The full render() runs on data changes
// (load / save / add / delete / apply / select).

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
  const NODE_W = 110;
  const NODE_H = 46;
  const CANVAS_W = 800;
  const CANVAS_H = 420;

  const $modeEdit  = document.getElementById('mode-edit');
  const $modeWatch = document.getElementById('mode-watch');

  let wf = null;
  let selected = null;
  let dirty = false;       // unsaved changes vs server
  let drag = null;         // { name, dx, dy, moved, $g } during a drag
  let mode = 'edit';       // 'edit' | 'watch'

  // DOM index by node name → { g, edgesFrom: [<line>], edgesTo: [<line>] }
  const nodeIndex = new Map();

  // ── status helpers ──────────────────────────────────────────
  function setStatus(msg, kind) {
    $status.textContent = msg;
    $status.className = kind || '';
  }

  function markDirty() {
    dirty = true;
    $save.classList.add('pulse');
  }

  function markClean() {
    dirty = false;
    $save.classList.remove('pulse');
  }

  // ── layout helpers ──────────────────────────────────────────
  function ensureLayout() {
    if (!wf._layout) wf._layout = {};
    const fallback = topoLayout(wf);
    for (const k of Object.keys(wf.nodes || {})) {
      if (!wf._layout[k]) wf._layout[k] = fallback[k];
    }
    for (const k of Object.keys(wf._layout)) {
      if (!wf.nodes[k]) delete wf._layout[k];
    }
  }

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
    const padX = 90, padY = 70;
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

  // ── render (full rebuild — call on data changes) ────────────
  function render() {
    ensureLayout();
    nodeIndex.clear();
    $svg.innerHTML = '';

    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML =
      // Bigger, brighter arrow — was too subtle before. The tip
      // (refX=10) lands right where the line ends (at the
      // destination node's left edge), and orient="auto" rotates
      // it with the line direction so curved layouts still work.
      '<marker id="arrow" viewBox="0 0 12 10" refX="10" refY="5" ' +
      'markerWidth="9" markerHeight="9" orient="auto">' +
      '<path d="M 0 0 L 12 5 L 0 10 L 3 5 z" fill="#9ba0a8"/></marker>' +
      '<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">' +
      '<path d="M 40 0 L 0 0 0 40" fill="none" stroke="#2a2d34" stroke-width="0.5" opacity="0.6"/>' +
      '</pattern>';
    $svg.appendChild(defs);

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('class', 'canvas-bg');
    bg.setAttribute('width', CANVAS_W);
    bg.setAttribute('height', CANVAS_H);
    bg.setAttribute('fill', 'url(#grid)');
    $svg.appendChild(bg);

    // Pre-register nodes so we can index edges.
    for (const k of Object.keys(wf.nodes)) {
      nodeIndex.set(k, { g: null, edgesFrom: [], edgesTo: [] });
    }

    // Edges first, so nodes draw on top.
    for (const [from, n] of Object.entries(wf.nodes)) {
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
        line.dataset.from = from;
        line.dataset.to = to;
        $svg.appendChild(line);
        nodeIndex.get(from).edgesFrom.push(line);
        if (nodeIndex.get(to)) nodeIndex.get(to).edgesTo.push(line);
      }
    }

    for (const [k, n] of Object.entries(wf.nodes)) {
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
      rect.setAttribute('rx', 4);
      g.appendChild(rect);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'node-label');
      label.setAttribute('y', -3);
      label.textContent = k;
      g.appendChild(label);

      const meta = document.createElementNS(SVG_NS, 'text');
      meta.setAttribute('class', 'node-meta');
      meta.setAttribute('y', 14);
      meta.textContent = (n.host || '?') + ':' + (n.port || '?');
      g.appendChild(meta);

      // Count badge (top-right corner). Hidden in Edit mode.
      const badgeG = document.createElementNS(SVG_NS, 'g');
      badgeG.setAttribute('class', 'node-badge');
      const bx = NODE_W / 2 - 4;
      const by = -NODE_H / 2 + 4;
      const badgeBg = document.createElementNS(SVG_NS, 'circle');
      badgeBg.setAttribute('class', 'badge-bg');
      badgeBg.setAttribute('cx', bx);
      badgeBg.setAttribute('cy', by);
      badgeBg.setAttribute('r', 9);
      const badgeText = document.createElementNS(SVG_NS, 'text');
      badgeText.setAttribute('class', 'badge-text');
      badgeText.setAttribute('x', bx);
      badgeText.setAttribute('y', by + 3);
      badgeText.textContent = '0';
      badgeG.appendChild(badgeBg);
      badgeG.appendChild(badgeText);
      g.appendChild(badgeG);

      // Breakpoint dot (top-left corner). Visible when this
      // node's name is in the breakpoints set ; toggled via
      // right-click. Counter-positioned to the count badge.
      const bpG = document.createElementNS(SVG_NS, 'g');
      bpG.setAttribute('class', 'node-bp');
      const bpDot = document.createElementNS(SVG_NS, 'circle');
      bpDot.setAttribute('class', 'bp-dot');
      bpDot.setAttribute('cx', -NODE_W / 2 + 4);
      bpDot.setAttribute('cy', -NODE_H / 2 + 4);
      bpDot.setAttribute('r', 5);
      bpG.appendChild(bpDot);
      g.appendChild(bpG);
      if (breakpoints.has(k)) g.classList.add('has-bp');

      g.addEventListener('mousedown', e => onNodeMouseDown(e, k));
      g.addEventListener('contextmenu', e => {
        e.preventDefault();
        toggleBreakpoint(k);
      });
      $svg.appendChild(g);
      const idx = nodeIndex.get(k);
      idx.g = g;
      idx.badge = badgeText;
      idx.badgeG = badgeG;
    }

    refreshRaw();
    syncInspector();
  }

  function refreshRaw() {
    $src.value = JSON.stringify(wf, null, 2);
  }

  // ── incremental drag update (no full render) ────────────────
  function moveNode(name, x, y) {
    wf._layout[name] = { x, y };
    const entry = nodeIndex.get(name);
    if (!entry || !entry.g) return;
    entry.g.setAttribute('transform', `translate(${x}, ${y})`);
    for (const line of entry.edgesFrom) {
      line.setAttribute('x1', x + NODE_W / 2);
      line.setAttribute('y1', y);
    }
    for (const line of entry.edgesTo) {
      line.setAttribute('x2', x - NODE_W / 2);
      line.setAttribute('y2', y);
    }
  }

  // ── drag ────────────────────────────────────────────────────
  function svgPoint(evt) {
    const pt = $svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform($svg.getScreenCTM().inverse());
  }

  function onNodeMouseDown(evt, name) {
    evt.preventDefault();
    evt.stopPropagation();
    // In Watch mode, nodes are inert — no drag, no selection.
    // The DAG is a read-only schematic for the live dashboard.
    if (mode === 'watch') return;
    const p = svgPoint(evt);
    const layout = wf._layout[name] || { x: 0, y: 0 };
    const entry = nodeIndex.get(name);
    drag = {
      name,
      dx: layout.x - p.x,
      dy: layout.y - p.y,
      moved: false,
      $g: entry && entry.g,
    };
    if (drag.$g) drag.$g.classList.add('dragging');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(evt) {
    if (!drag) return;
    const p = svgPoint(evt);
    const nx = clamp(p.x + drag.dx, NODE_W / 2, CANVAS_W - NODE_W / 2);
    const ny = clamp(p.y + drag.dy, NODE_H / 2, CANVAS_H - NODE_H / 2);
    moveNode(drag.name, nx, ny);
    if (!drag.moved) {
      drag.moved = true;
      markDirty();
    }
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (!drag) return;
    if (drag.$g) drag.$g.classList.remove('dragging');
    if (!drag.moved) {
      select(drag.name);
    } else {
      refreshRaw();        // sync the raw view once at the end
    }
    drag = null;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── selection / inspector ───────────────────────────────────
  function select(name) {
    if (selected === name) { syncInspector(); return; }
    const prev = selected;
    selected = name;
    $delete.disabled = !name;
    // Toggle .selected class on the affected nodes only.
    if (prev) {
      const e = nodeIndex.get(prev);
      if (e && e.g) e.g.classList.remove('selected');
    }
    if (name) {
      const e = nodeIndex.get(name);
      if (e && e.g) e.g.classList.add('selected');
    }
    syncInspector();
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
      setStatus(`name "${newName}" already in use`, 'error');
      return;
    }
    const n = wf.nodes[selected];
    const host = $fHost.value.trim();
    const port = Number($fPort.value);
    if (host) n.host = host; else delete n.host;
    if (port) n.port = port; else delete n.port;
    setOrDeleteArray(n, 'consumes', splitList($fCons.value));
    setOrDeleteArray(n, 'emits',    splitList($fEmits.value));
    setOrDeleteArray(n, 'next',     splitList($fNext.value));

    if (newName !== selected) {
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
    setStatus('applied — click Save to persist', 'ok');
    markDirty();
    render();
  }

  function setOrDeleteArray(obj, key, arr) {
    if (arr.length === 0) {
      // Preserve absence: don't add an empty array if the node
      // never had one to begin with.
      if (!Array.isArray(obj[key])) return;
      delete obj[key];
      return;
    }
    obj[key] = arr;
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
    };
    wf._layout = wf._layout || {};
    wf._layout[name] = { x: 200 + (i * 30) % 400, y: 200 + (i * 25) % 100 };
    selected = name;
    markDirty();
    setStatus(`added ${name} — click Save to persist`, 'ok');
    render();
  }

  function deleteSelected() {
    if (!selected) return;
    const dead = selected;
    delete wf.nodes[dead];
    if (wf._layout) delete wf._layout[dead];
    for (const k of Object.keys(wf.nodes)) {
      const n = wf.nodes[k];
      if (Array.isArray(n.next)) {
        const filtered = n.next.filter(t => t !== dead);
        setOrDeleteArray(n, 'next', filtered);
      }
    }
    selected = null;
    $delete.disabled = true;
    markDirty();
    setStatus(`deleted ${dead} — click Save to persist`, 'ok');
    render();
  }

  // ── load / save ─────────────────────────────────────────────
  async function load() {
    setStatus('loading…');
    try {
      const r = await fetch('/api/workflow');
      const txt = await r.text();
      if (!r.ok) {
        setStatus(`GET failed (${r.status})`, 'error');
        return;
      }
      wf = JSON.parse(txt);
      if (!wf.nodes) wf.nodes = {};
      selected = null;
      $delete.disabled = true;
      markClean();
      render();
      const n = Object.keys(wf.nodes).length;
      setStatus(`loaded · ${n} node${n === 1 ? '' : 's'}`, 'ok');
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
        setStatus(`PUT failed: ${reply.error || r.status}`, 'error');
        return;
      }
      markClean();
      setStatus(`saved · ${reply.bytes} bytes → ${reply.path}`, 'ok');
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

  // Empty SVG click → deselect.
  $svg.addEventListener('mousedown', e => {
    if (e.target === $svg || e.target.classList.contains('canvas-bg')) {
      select(null);
    }
  });

  // Submit-on-Enter inside inspector → Apply (without page reload).
  $form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      applyForm();
    }
  });

  // Confirm before nav away with unsaved.
  window.addEventListener('beforeunload', e => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Mode toggle: Edit vs Watch ──────────────────────────────
  // Edit  → polling OFF, drag/inspector/add/delete/save/apply enabled.
  // Watch → polling ON, DAG is read-only, inspector hidden, no dirty
  //         changes possible (so polling can refresh the workflow
  //         from disk without clobbering unsaved work).
  //
  // Switching Edit → Watch when dirty prompts the user — Watch mode
  // refreshes the wf from /api/workflow, which would silently lose
  // local edits otherwise.

  function setMode(next) {
    if (next === mode) return;
    if (next === 'watch' && dirty) {
      const choice = confirm(
        'You have unsaved changes. Switching to Watch mode will discard them. Continue?'
      );
      if (!choice) return;
    }
    mode = next;
    $modeEdit.classList.toggle('active',  mode === 'edit');
    $modeWatch.classList.toggle('active', mode === 'watch');
    $modeEdit.setAttribute('aria-selected',  mode === 'edit'  ? 'true' : 'false');
    $modeWatch.setAttribute('aria-selected', mode === 'watch' ? 'true' : 'false');
    document.body.dataset.mode = mode;

    // Edit-only buttons.
    $add.disabled    = mode !== 'edit';
    $apply.disabled  = mode !== 'edit';
    $delete.disabled = mode !== 'edit' || !selected;
    $save.disabled   = mode !== 'edit';

    // Read-only form inputs in Watch mode.
    [$fName, $fHost, $fPort, $fCons, $fEmits, $fNext].forEach(el => {
      el.readOnly = mode === 'watch';
    });

    if (mode === 'watch') {
      // Fresh state from disk + start live executions polling.
      // Debug interception is controlled separately by the
      // #debug-toggle checkbox — Watch is observation-only.
      selected = null;
      stopLive();
      liveRecords = [];
      liveLastIds = new Set();
      lastSeenTs = 0;
      load().then(() => startLive());
    } else {
      stopLive();
      $liveList.innerHTML = '<li class="placeholder">Switch to <strong>Watch</strong> mode to see live executions.</li>';
      $liveMeta.textContent = '';
      liveRecords = [];
      liveLastIds = new Set();
      lastSeenTs = 0;
      resetNodeStats();
    }
  }

  $modeEdit .addEventListener('click', () => setMode('edit'));
  $modeWatch.addEventListener('click', () => setMode('watch'));

  // ── Live executions panel (Phase 4.2) ───────────────────────
  const $liveList   = document.getElementById('live-list');
  const $liveMeta   = document.getElementById('live-meta');
  const $cleanup    = document.getElementById('cleanup');

  let livePollTimer = null;
  let liveLastIds = new Set();   // for "new-since-last-poll" flash
  let nodeStats = new Map();     // role → { count, lastTs }
  let liveRecords = [];          // accumulated records, client-side window
  let lastSeenTs = 0;            // largest record.timestamp we have, for ?since=
  const CLIENT_CAP = 200;        // window size kept in memory + shown

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString('en-GB', { hour12: false });
  }

  function shortId(s) {
    if (!s || s.length < 8) return s || '';
    return s.slice(0, 8);
  }

  function makeLiveRow(r) {
    const rec = r.record || {};
    const ts = fmtTime(rec.timestamp);
    const arrow = rec.topicOut
      ? `${rec.topicIn || '∅'} → ${rec.topicOut}`
      : `${rec.topicIn || '∅'} → terminal`;
    const term = !rec.topicOut;
    const li = document.createElement('li');
    li.className = 'live-row' + (term ? ' terminal' : '');
    li.dataset.role = r.role;
    li.dataset.mid = r.messageId;
    li.dataset.file = r.file;
    li.innerHTML =
      `<span class="t">${escapeAttr(ts)}</span>` +
      `<span class="role">${escapeAttr(r.role)}</span>` +
      `<span class="mid">${escapeAttr(shortId(r.messageId))}</span>` +
      `<span class="topics">${escapeAttr(arrow)}</span>`;
    const role = r.role;
    li.addEventListener('mouseenter', () => highlightNode(role, true));
    li.addEventListener('mouseleave', () => highlightNode(role, false));
    return li;
  }

  function renderLive(records) {
    if (!records.length) {
      $liveList.replaceChildren();
      const empty = document.createElement('li');
      empty.className = 'placeholder';
      empty.textContent = 'No executions yet.';
      $liveList.appendChild(empty);
      $liveMeta.textContent = '0 records';
      resetNodeStats();
      return;
    }
    $liveMeta.textContent = `${records.length} record${records.length === 1 ? '' : 's'}`;

    // First render after start (or after clear) — wipe + build all.
    const isInitial = !liveLastIds.size;
    if (isInitial) {
      $liveList.replaceChildren();
      const frag = document.createDocumentFragment();
      for (const r of records) frag.appendChild(makeLiveRow(r));
      $liveList.appendChild(frag);
    } else {
      // Incremental : only prepend rows whose file isn't already
      // in the DOM. Keep existing DOM stable so mouseover/scroll
      // state isn't blown away every poll. The records array is
      // already newest-first (server gives it that way + we
      // prepend new ones in pollLive). So we walk from the head
      // and stop at the first known file.
      const frag = document.createDocumentFragment();
      const newRecords = [];
      for (const r of records) {
        if (liveLastIds.has(r.file)) break;
        const li = makeLiveRow(r);
        frag.appendChild(li);
        newRecords.push(r);
        li.classList.add('flash');  // CSS animation, no JS timer needed
      }
      if (newRecords.length > 0) {
        $liveList.insertBefore(frag, $liveList.firstChild);
        // Trim from the tail if we exceeded the client cap.
        while ($liveList.children.length > CLIENT_CAP) {
          $liveList.removeChild($liveList.lastChild);
        }
        // Flash matching nodes + edges for the truly-new ones.
        for (const r of newRecords) {
          flashNode(r.role);
          const rec = r.record || {};
          if (rec.topicOut) {
            const node = wf && wf.nodes && wf.nodes[r.role];
            if (node && Array.isArray(node.next)) {
              for (const tgt of node.next) flashEdge(r.role, tgt);
            }
          }
        }
      }
    }

    // Rebuild aggregated stats + sync badges. O(N) on the window.
    nodeStats.clear();
    for (const r of records) {
      const role = r.role;
      const st = nodeStats.get(role) || { count: 0, lastTs: 0 };
      st.count += 1;
      const ts = (r.record && r.record.timestamp) || 0;
      if (ts > st.lastTs) st.lastTs = ts;
      nodeStats.set(role, st);
    }
    syncBadges();

    // Update tracking set for the next diff.
    liveLastIds = new Set(records.map(r => r.file));
  }

  function syncBadges() {
    for (const [role, entry] of nodeIndex.entries()) {
      if (!entry || !entry.badgeG) continue;
      const st = nodeStats.get(role);
      if (st && st.count > 0) {
        entry.badge.textContent = st.count > 99 ? '99+' : String(st.count);
        entry.badgeG.classList.add('on');
      } else {
        entry.badge.textContent = '0';
        entry.badgeG.classList.remove('on');
      }
    }
  }

  function resetNodeStats() {
    nodeStats.clear();
    syncBadges();
  }

  // Restart a CSS animation without forcing a sync reflow via
  // getBoundingClientRect (which made the whole page reflow on
  // each new poll record — visible jank, scrollbar oscillation).
  // requestAnimationFrame schedules the re-add for the next
  // frame, the browser does its own layout pass naturally.
  function restartFlash(el, className, durationMs) {
    el.classList.remove(className);
    requestAnimationFrame(() => {
      el.classList.add(className);
      setTimeout(() => el.classList.remove(className), durationMs);
    });
  }

  function flashNode(role) {
    const e = nodeIndex.get(role);
    if (!e || !e.g) return;
    restartFlash(e.g, 'flash', 1400);
  }

  function flashEdge(from, to) {
    const e = nodeIndex.get(from);
    if (!e) return;
    for (const line of e.edgesFrom) {
      if (line.dataset.to !== to) continue;
      restartFlash(line, 'flash', 1400);
    }
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function highlightNode(name, on) {
    const e = nodeIndex.get(name);
    if (!e || !e.g) return;
    e.g.classList.toggle('flash-hi', on);
  }

  async function pollLive() {
    try {
      const url = lastSeenTs > 0
        ? `/api/executions?since=${lastSeenTs}`
        : '/api/executions';
      const r = await fetch(url);
      if (!r.ok) return;
      const fresh = await r.json();
      if (fresh.length === 0) return;   // nothing new — skip render churn

      // Server returns newest-first. We prepend to liveRecords +
      // trim to CLIENT_CAP. Records by `file` are deduped (just in
      // case the server returns one we already have from a prior
      // poll that lost a race).
      const seen = new Set(liveRecords.map(r => r.file));
      const toAdd = fresh.filter(r => !seen.has(r.file));

      // Track the highest timestamp seen so the next poll asks for
      // strictly-newer-than.
      for (const r of toAdd) {
        const ts = (r.record && r.record.timestamp) || 0;
        if (ts > lastSeenTs) lastSeenTs = ts;
      }

      liveRecords = toAdd.concat(liveRecords).slice(0, CLIENT_CAP);
      renderLive(liveRecords);
    } catch (e) {
      // network glitch, silent retry next tick
    }
  }

  function startLive() {
    pollLive();
    livePollTimer = setInterval(pollLive, 2000);
  }
  function stopLive() {
    if (livePollTimer) clearInterval(livePollTimer);
    livePollTimer = null;
  }

  // ── Debug bridge poll (Phase 4.5.3, refined 4.5.3.1) ────────
  // The Debug toggle in the header is the explicit opt-in :
  //   off → no polling of /api/debug/pauses, the bar stays hidden,
  //         Pollen DEBUG_PAUSE entries pile up in the manager
  //         registry until the 60s recv timeout on the node side
  //         (where they get CANCEL'd). Safe in prod : nothing the
  //         operator does in Watch can step / cancel a real flow.
  //   on  → polling 1Hz, bar shows the first active pause, Step
  //         / Continue / Cancel + F-keys live. Plus the
  //         currently paused role is glowed on the DAG.
  // Independent of the Edit/Watch mode — debug can be intercepted
  // in either, the toggle is the only switch.
  const $dbgBar       = document.getElementById('debug-bar');
  const $dbgInfo      = document.getElementById('debug-bar-info');
  const $dbgStepOver  = document.getElementById('dbg-step-over');
  const $dbgStepInto  = document.getElementById('dbg-step-into');
  const $dbgContinue  = document.getElementById('dbg-continue');
  const $dbgCancel    = document.getElementById('dbg-cancel');
  const $dbgToggle    = document.getElementById('debug-toggle');
  const $bpSummary    = document.getElementById('bp-summary');
  const $bpList       = document.getElementById('bp-list');
  const $bpCopy       = document.getElementById('bp-copy');
  const $bpClear      = document.getElementById('bp-clear');
  let dbgPollTimer = null;
  let dbgActive = null;  // { session, role } of the currently shown pause
  let dbgPausedRole = null;  // role with the .paused class on DAG, for cleanup
  // Client-side breakpoints — set via right-click on a DAG node,
  // persisted in localStorage. They're DISPLAY-ONLY today : the
  // operator copies the string to their --debug-bp CLI arg via
  // the [⎘] button. Phase 4.5.5 will wire them into a UI-driven
  // "Inject debug msg" form so no CLI is required.
  const BP_STORAGE_KEY = 'pollen-manager:bp';
  let breakpoints = new Set();
  try {
    const stored = localStorage.getItem(BP_STORAGE_KEY);
    if (stored) breakpoints = new Set(JSON.parse(stored));
  } catch (e) { /* corrupt storage, ignore */ }

  function clearPausedHighlight() {
    if (!dbgPausedRole) return;
    const e = nodeIndex.get(dbgPausedRole);
    if (e && e.g) e.g.classList.remove('paused');
    dbgPausedRole = null;
  }

  function setPausedHighlight(role) {
    if (dbgPausedRole === role) return;
    clearPausedHighlight();
    const e = nodeIndex.get(role);
    if (e && e.g) e.g.classList.add('paused');
    dbgPausedRole = role;
  }

  async function pollDebug() {
    try {
      const r = await fetch('/api/debug/pauses');
      if (!r.ok) return;
      const list = await r.json();
      if (!list.length) {
        if (dbgActive) {
          dbgActive = null;
          $dbgBar.hidden = true;
          clearPausedHighlight();
        }
        return;
      }
      const p = list[0];
      const env = p.raw && p.raw.envelope || {};
      const mid = env.messageId ? env.messageId.slice(0, 8) : '?';
      const topicIn = (env.topic && env.topic.uuid) || '?';
      const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
      $dbgInfo.textContent = `${p.role} · session ${p.session} · mid ${mid} · topic ${topicIn}${more}`;
      $dbgBar.hidden = false;
      dbgActive = { session: p.session, role: p.role };
      setPausedHighlight(p.role);
    } catch (e) { /* silent retry */ }
  }

  async function sendDebugCmd(cmd) {
    if (!dbgActive) return;
    const { session, role } = dbgActive;
    try {
      const r = await fetch('/api/debug/cmd', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, role, cmd }),
      });
      const reply = await r.json();
      if (!r.ok) {
        setStatus(`debug cmd failed: ${reply.error || r.status}`, 'error');
        return;
      }
      setStatus(`debug → ${cmd.replace('DEBUG_', '')} (${role})`, 'ok');
      // The active pause is gone — refresh immediately.
      dbgActive = null;
      $dbgBar.hidden = true;
      clearPausedHighlight();
      pollDebug();
    } catch (e) {
      setStatus('debug cmd error: ' + e.message, 'error');
    }
  }

  $dbgStepOver.addEventListener('click', () => sendDebugCmd('DEBUG_STEP_OVER'));
  $dbgStepInto.addEventListener('click', () => sendDebugCmd('DEBUG_STEP_INTO'));
  $dbgContinue.addEventListener('click', () => sendDebugCmd('DEBUG_CONTINUE'));
  $dbgCancel  .addEventListener('click', () => sendDebugCmd('DEBUG_CANCEL'));

  // Keyboard shortcuts (Phase 4.5.5 will refine when not in
  // an input). For now, only fire when a pause is active.
  window.addEventListener('keydown', e => {
    if (!dbgActive) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'F5')          { e.preventDefault(); sendDebugCmd('DEBUG_CONTINUE');  }
    else if (e.key === 'F10')    { e.preventDefault(); sendDebugCmd('DEBUG_STEP_OVER'); }
    else if (e.key === 'F11')    { e.preventDefault(); sendDebugCmd('DEBUG_STEP_INTO'); }
    else if (e.key === 'Escape') { e.preventDefault(); sendDebugCmd('DEBUG_CANCEL');    }
  });

  function startDebugPoll() {
    if (dbgPollTimer) return;
    pollDebug();
    dbgPollTimer = setInterval(pollDebug, 1000);
  }
  function stopDebugPoll() {
    if (dbgPollTimer) clearInterval(dbgPollTimer);
    dbgPollTimer = null;
    dbgActive = null;
    $dbgBar.hidden = true;
    clearPausedHighlight();
  }

  $dbgToggle.addEventListener('change', () => {
    if ($dbgToggle.checked) startDebugPoll();
    else stopDebugPoll();
  });

  // ── Breakpoints UI ──────────────────────────────────────────
  function toggleBreakpoint(name) {
    if (breakpoints.has(name)) breakpoints.delete(name);
    else breakpoints.add(name);
    saveBreakpoints();
    syncBpSummary();
    const e = nodeIndex.get(name);
    if (e && e.g) e.g.classList.toggle('has-bp', breakpoints.has(name));
  }

  function saveBreakpoints() {
    try {
      localStorage.setItem(BP_STORAGE_KEY,
        JSON.stringify([...breakpoints]));
    } catch (e) { /* ignore quota errors */ }
  }

  function bpCsv() {
    return [...breakpoints].join(',');
  }

  function syncBpSummary() {
    if (breakpoints.size === 0) {
      $bpSummary.hidden = true;
      return;
    }
    $bpSummary.hidden = false;
    $bpList.textContent = bpCsv();
  }

  $bpCopy.addEventListener('click', async () => {
    if (breakpoints.size === 0) return;
    const arg = `--debug-bp ${bpCsv()}`;
    try {
      await navigator.clipboard.writeText(arg);
      setStatus(`copied: ${arg}`, 'ok');
    } catch (e) {
      setStatus('clipboard write failed: ' + e.message, 'error');
    }
  });

  $bpClear.addEventListener('click', () => {
    if (breakpoints.size === 0) return;
    // Visual clear : walk every node group and drop the .has-bp class.
    for (const [name, entry] of nodeIndex.entries()) {
      if (entry && entry.g) entry.g.classList.remove('has-bp');
    }
    breakpoints.clear();
    saveBreakpoints();
    syncBpSummary();
    setStatus('breakpoints cleared', 'ok');
  });

  // Initial sync (in case breakpoints came from localStorage).
  syncBpSummary();

  // Polling is driven entirely by the Edit/Watch mode toggle —
  // started in setMode('watch'), stopped in setMode('edit').

  // Cleanup button — purges old executions via /api/cleanup.
  $cleanup.addEventListener('click', async () => {
    if (!confirm('Purge executions older than the configured retention?')) return;
    setStatus('purging…');
    try {
      const r = await fetch('/api/cleanup', { method: 'POST' });
      const reply = await r.json();
      if (!r.ok) {
        setStatus(`cleanup failed: ${reply.error || r.status}`, 'error');
        return;
      }
      setStatus(`purged ${reply.purged} record${reply.purged === 1 ? '' : 's'}`, 'ok');
      // Reset the local cache so next poll re-fetches what's left.
      liveRecords = [];
      liveLastIds = new Set();
      lastSeenTs = 0;
      resetNodeStats();
      if (mode === 'watch') pollLive();
    } catch (e) {
      setStatus('cleanup error: ' + e.message, 'error');
    }
  });

  // Initial state: Edit mode. Load the workflow, leave polling off.
  document.body.dataset.mode = 'edit';
  load();
})();
