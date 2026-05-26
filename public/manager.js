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
  const $fGroup   = document.getElementById('f-group');
  const $fCons    = document.getElementById('f-consumes');
  const $fEmits   = document.getElementById('f-emits');
  const $fNext    = document.getElementById('f-next');
  const $apply    = document.getElementById('apply');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 110;
  const NODE_H = 46;
  // Phase 5.7.7 — bigger virtual canvas so big workflows have
  // breathing room. The SVG element stretches via CSS to fill the
  // viewport ; viewBox below matches these dims so the layout
  // doesn't get squeezed into a 800×420 box.
  const CANVAS_W = 1600;
  const CANVAS_H = 900;

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
    pushSnapshot();
  }

  function markClean() {
    dirty = false;
    $save.classList.remove('pulse');
  }

  // Phase 5.7.14 — Undo / Redo. Snapshot stack of wf JSON serial.
  // markDirty pushes after each mutation ; undo pops to previous,
  // redo replays popped states. Bounded to MAX_HISTORY to keep
  // memory linear in operator session length.
  const MAX_HISTORY = 80;
  let history = [];
  let future  = [];
  let applyingSnapshot = false;

  function pushSnapshot() {
    if (applyingSnapshot || !wf) return;
    const snap = JSON.stringify(wf);
    if (history.length > 0 && history[history.length - 1] === snap) return;
    history.push(snap);
    if (history.length > MAX_HISTORY) history.shift();
    future = []; // any new action invalidates redo stack
    updateUndoRedoButtons();
  }

  function applySnapshot(snap) {
    applyingSnapshot = true;
    wf = JSON.parse(snap);
    // Re-derive any in-memory caches that lived alongside wf.
    selected = null;
    selectedStepIdx = -1;
    if (typeof clearFocus === 'function') clearFocus();
    render();
    // markDirty pulses Save ; we DO want dirty to be true since the
    // in-memory wf no longer matches the disk file.
    dirty = true;
    $save.classList.add('pulse');
    applyingSnapshot = false;
    updateUndoRedoButtons();
  }

  function undo() {
    if (history.length < 2) {
      setStatus('nothing to undo', 'error');
      return;
    }
    future.push(history.pop());
    applySnapshot(history[history.length - 1]);
    setStatus(`undo (${history.length - 1} more · ${future.length} to redo)`, 'ok');
  }

  function redo() {
    if (future.length === 0) {
      setStatus('nothing to redo', 'error');
      return;
    }
    const snap = future.pop();
    history.push(snap);
    applySnapshot(snap);
    setStatus(`redo (${future.length} more · ${history.length - 1} to undo)`, 'ok');
  }

  function updateUndoRedoButtons() {
    const $u = document.getElementById('undo');
    const $r = document.getElementById('redo');
    if ($u) $u.disabled = history.length < 2;
    if ($r) $r.disabled = future.length === 0;
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

  // Phase 5.5f — derive DAG edges from the v2 tree so the SVG
  // canvas shows the actual routing (call → next, fan_out splits,
  // if branches, for/while loops). For v1 workflows we fall back
  // to the per-node `next: [...]` arrays.
  function deriveEdgesFromTree(wf) {
    const nodes = wf.nodes || {};
    const out = [];
    function emit(from, to, kind, label) {
      if (!nodes[from] || !nodes[to]) return;
      out.push({ from, to, kind: kind || 'flow', label: label || '' });
    }
    // walk(step, frontier) emits edges from each `frontier` source
    // up to and inside `step`. Returns the new frontier — i.e. the
    // node names that follow-up steps would dispatch from.
    function walk(step, frontier, label) {
      if (!step || typeof step !== 'object') return frontier;
      const t = step.type;
      if (t === 'sequence') {
        let cur = frontier;
        // The branch label (when/elseif/else/for ...) only tags the
        // FIRST dispatchable step of the sequence — that's the
        // conditional edge. Subsequent steps inside are reached
        // unconditionally from there.
        let pending = label;
        const steps = Array.isArray(step.steps) ? step.steps : [];
        for (const s of steps) {
          const isSet = s && typeof s === 'object' && s.type === 'set';
          const emitLabel = isSet ? '' : pending;
          if (!isSet) pending = '';
          cur = walk(s, cur, emitLabel);
        }
        return cur;
      }
      if (t === 'call') {
        if (step.node) {
          frontier.forEach(f => emit(f, step.node, 'call', label || ''));
          return [step.node];
        }
        return frontier;
      }
      if (t === 'fan_out') {
        const targets = Array.isArray(step.nodes) ? step.nodes : [];
        const eff = label || 'fan_out';
        frontier.forEach(f => targets.forEach(tt => emit(f, tt, 'fan_out', eff)));
        return targets.slice();
      }
      if (t === 'if') {
        const branches = Array.isArray(step.branches) ? step.branches : [];
        branches.forEach((b, i) => {
          const isElse = !(b && (b.cond !== undefined || b.op !== undefined));
          const branchLabel = isElse ? 'else'
                            : (i === 0 ? 'when' : 'elseif');
          if (b && b.then) walk(b.then, frontier, branchLabel);
        });
        // Frontier dies past an if : the runtime's role walker can't
        // resume from buried branch targets, so any step that comes
        // after won't actually fire for them. Returning [] avoids
        // phantom edges if the user appends more steps.
        return [];
      }
      if (t === 'for') {
        const eff = `for ${step.var || 'item'}`;
        if (step.do) walk(step.do, frontier, eff);
        // Same reasoning as `if` — for.do targets are buried.
        return [];
      }
      if (t === 'while') {
        // Self-loop on each frontier node — while continues at the
        // same role until cond becomes false.
        frontier.forEach(f => emit(f, f, 'while', 'while'));
        return frontier;
      }
      // set / end / unknown — passthrough.
      return frontier;
    }
    walk(wf.tree, [], '');
    return out;
  }

  // Phase 5.7 polish — which role owns each `set` step.
  // After a `call(X)`, all subsequent `set` steps in the same
  // (sub-)sequence belong to X until the next dispatcher (call /
  // fan_out / if / for / while). Walks the tree with the same
  // semantics deriveEdgesFromTree uses.
  function setsPerRole(wf) {
    const out = {};
    if (!wf || !wf.tree) return out;
    function add(role, step) {
      if (!role) return;
      (out[role] || (out[role] = [])).push(step);
    }
    function walk(action, currentOwner) {
      if (!action || typeof action !== 'object') return currentOwner;
      const t = action.type;
      if (t === 'sequence') {
        let cur = currentOwner;
        for (const s of action.steps || []) cur = walk(s, cur);
        return cur;
      }
      if (t === 'call') return action.node || currentOwner;
      if (t === 'fan_out') {
        const targets = Array.isArray(action.nodes) ? action.nodes : [];
        // Subsequent sets in the same sub-sequence apply to each
        // fan_out target. We attribute to the first for visual
        // simplicity ; the runtime applies them per-target anyway.
        return targets[0] || currentOwner;
      }
      if (t === 'set') {
        add(currentOwner, action);
        return currentOwner;
      }
      if (t === 'if') {
        for (const br of (action.branches || [])) {
          if (br && br.then) walk(br.then, currentOwner);
        }
        return currentOwner;
      }
      if (t === 'for') {
        if (action.do) walk(action.do, currentOwner);
        return currentOwner;
      }
      return currentOwner;
    }
    walk(wf.tree, null);
    return out;
  }

  function topoLayout(wf) {
    const nodes = wf.nodes || {};
    const keys = Object.keys(nodes);
    if (!keys.length) return {};
    const edges = [];
    // v2 with a tree → derive ; v1 with per-node next[] → flat.
    if (wf.tree && typeof wf.tree === 'object') {
      const derived = deriveEdgesFromTree(wf);
      derived.forEach(e => edges.push({ from: e.from, to: e.to }));
    } else {
      for (const k of keys) {
        for (const tgt of (nodes[k].next || [])) {
          if (nodes[tgt]) edges.push({ from: k, to: tgt });
        }
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

    // Phase 5.7.9 — group-aware sort within each column so nodes
    // sharing a group land next to each other. The group hulls then
    // form clean rectangles spanning multiple ranks instead of a
    // patchwork.
    //
    // Algo : assign every group a stable slot index by first
    // appearance across columns (so 'billing' always sits at the
    // same vertical relative position whether or not its members
    // appear in every column). Ungrouped nodes keep their natural
    // order at the bottom of each column.
    const groupSlot = new Map();
    let nextSlot = 0;
    for (const ck of colKeys) {
      for (const k of cols[ck]) {
        const g = nodes[k].group;
        if (g && !groupSlot.has(g)) groupSlot.set(g, nextSlot++);
      }
    }
    for (const ck of colKeys) {
      cols[ck].sort((a, b) => {
        const ga = nodes[a].group, gb = nodes[b].group;
        const sa = ga ? groupSlot.get(ga) : Number.MAX_SAFE_INTEGER;
        const sb = gb ? groupSlot.get(gb) : Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return a.localeCompare(b);
      });
    }

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
      nodeIndex.set(k, { g: null, edgesFrom: [], edgesTo: [], groupName: wf.nodes[k].group || null });
    }

    // Phase 5.7.6 — group hulls. Group nodes by their `.group`
    // property, draw a translucent rounded rect behind each group's
    // bounding box + a label at top-left. Hulls sit between the
    // background grid and the edges so edges remain readable.
    const groups = new Map();
    for (const [k, n] of Object.entries(wf.nodes)) {
      if (!n.group) continue;
      if (!groups.has(n.group)) groups.set(n.group, []);
      groups.get(n.group).push(k);
    }
    groupHulls.clear();
    const GROUP_COLORS = [
      '#f5b400', '#6c9af0', '#f87171', '#a5d6a7',
      '#b39ddb', '#f48fb1', '#90caf9', '#ffb74d',
    ];
    let groupIdx = 0;
    for (const [name, members] of groups) {
      const color = GROUP_COLORS[groupIdx % GROUP_COLORS.length];
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'group-hull');
      rect.setAttribute('rx', 8);
      rect.setAttribute('fill', color);
      rect.setAttribute('fill-opacity', '0.07');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-opacity', '0.40');
      rect.setAttribute('stroke-dasharray', '4 3');
      $svg.appendChild(rect);
      const lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('class', 'group-label');
      lbl.setAttribute('fill', color);
      lbl.textContent = name;
      $svg.appendChild(lbl);
      groupHulls.set(name, { rect, lbl, members });
      computeGroupHull(name);
      groupIdx++;
    }

    // Phase 5.7 polish — map sets onto the role that executes them
    // so the SVG nodes can display them (state mutations were
    // otherwise invisible above the routing topology).
    const setsByRole = (wf.tree && typeof wf.tree === 'object')
      ? setsPerRole(wf)
      : {};

    // Phase 5.5f — collect the edge list. v2 → derived from tree
     // (so if/for/while routes show up), v1 → per-node next[].
    let edgeList = [];
    if (wf.tree && typeof wf.tree === 'object') {
      edgeList = deriveEdgesFromTree(wf);
    } else {
      for (const [from, n] of Object.entries(wf.nodes)) {
        for (const to of (n.next || [])) {
          if (wf.nodes[to]) edgeList.push({ from, to, kind: 'flow', label: '' });
        }
      }
    }

    // Edges first, so nodes draw on top.
    for (const e of edgeList) {
      const a = wf._layout[e.from];
      const b = wf._layout[e.to];
      if (!a || !b) continue;
      const isSelfLoop = (e.from === e.to);
      const line = document.createElementNS(SVG_NS, isSelfLoop ? 'path' : 'line');
      const cssClass = 'edge edge-' + (e.kind || 'flow');
      line.setAttribute('class', cssClass);
      if (isSelfLoop) {
        // Small arc above the node : start at top-right, sweep up
        // and around, land on top-left with an arrow.
        const ax = a.x + NODE_W / 4;
        const ay = a.y - NODE_H / 2;
        const bx = a.x - NODE_W / 4;
        const by = a.y - NODE_H / 2;
        const c = `M ${ax} ${ay} C ${ax + 30} ${ay - 50}, ${bx - 30} ${by - 50}, ${bx} ${by}`;
        line.setAttribute('d', c);
        line.setAttribute('fill', 'none');
      } else {
        line.setAttribute('x1', a.x + NODE_W / 2);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x - NODE_W / 2);
        line.setAttribute('y2', b.y);
      }
      line.dataset.from = e.from;
      line.dataset.to = e.to;
      $svg.appendChild(line);
      nodeIndex.get(e.from).edgesFrom.push(line);
      if (nodeIndex.get(e.to)) nodeIndex.get(e.to).edgesTo.push(line);

      // Label : draw a text element at the midpoint when the edge
      // carries routing context (if branch / for / while etc).
      if (e.label) {
        const mx = isSelfLoop
          ? a.x
          : (a.x + NODE_W / 2 + b.x - NODE_W / 2) / 2;
        const my = isSelfLoop
          ? a.y - NODE_H / 2 - 30
          : (a.y + b.y) / 2 - 4;
        const lbl = document.createElementNS(SVG_NS, 'text');
        lbl.setAttribute('class', 'edge-label edge-label-' + (e.kind || 'flow'));
        lbl.setAttribute('x', mx);
        lbl.setAttribute('y', my);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.textContent = e.label;
        $svg.appendChild(lbl);
        // Phase 5.7.5 — keep label glued to its line. moveNode
        // walks edgesFrom/edgesTo and we need to update the label
        // alongside the geometry, so we store it on the line.
        line._label = lbl;
        line._isSelfLoop = isSelfLoop;
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

      // Phase 5.7 polish — render sets owned by this role under
      // the host/port line so they're visible in the DAG (the
      // tree has them but the canvas was silent about state
      // mutations).
      const setsHere = setsByRole[k] || [];
      if (setsHere.length > 0) {
        const setsLabel = document.createElementNS(SVG_NS, 'text');
        setsLabel.setAttribute('class', 'node-sets');
        setsLabel.setAttribute('y', 28);
        const shown = setsHere.slice(0, 2)
          .map(s => '✎ ' + (s.path || 'state.?'))
          .join('  ');
        const extra = setsHere.length > 2 ? `  +${setsHere.length - 2}` : '';
        setsLabel.textContent = shown + extra;
        g.appendChild(setsLabel);
      }

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
      if (breakpoints.has(k)) {
        g.classList.add('has-bp');
        const def = breakpoints.get(k);
        if (def && def.when) g.classList.add('has-bp-cond');
      }

      g.addEventListener('mousedown', e => onNodeMouseDown(e, k));
      g.addEventListener('contextmenu', e => {
        e.preventDefault();
        // shift+right-click → edit condition (set / change / clear)
        // plain right-click  → toggle on/off
        toggleBreakpoint(k, { editCondition: e.shiftKey });
      });
      $svg.appendChild(g);
      const idx = nodeIndex.get(k);
      idx.g = g;
      idx.badge = badgeText;
      idx.badgeG = badgeG;
    }

    refreshRaw();
    syncInspector();
    // If the inject panel is open, repopulate the target/topic
    // selects with whatever nodes exist now (might have been
    // renamed / added / deleted while editing).
    if (typeof refreshInjectTargets === 'function'
        && $injectPanel && !$injectPanel.hidden) {
      refreshInjectTargets();
    }
    renderTree();
  }

  // ── workflow tree view (Phase 5.x) ─────────────────────────────
  //
  // Renders wf.tree as a nested outline. Each step prints its type
  // and the relevant fields :
  //   call     → role name
  //   fan_out  → list of roles
  //   sequence → header + recursive children
  //   if       → branches, each a "when <op> <var> <value>" line
  //              followed by its `then` (recursive) and the else branch
  //   set      → `state.X = <expr summary>`
  //   for      → "for <var> in [<items>] do …"
  //   while    → "while <cond> (maxIter=N) do …"
  //   end      → terminal marker
  // Read-only for now ; editing controls land in Phase 5.5.
  function renderTree() {
    const $treeView = document.getElementById('tree-view');
    if (!$treeView) return;
    const $empty   = document.getElementById('tree-empty');
    const $outline = document.getElementById('tree-outline');
    const $tag     = document.getElementById('tree-schema-tag');
    if (!$empty || !$outline) return;

    if ($tag) {
      $tag.textContent = (wf && wf.schema) ? wf.schema : '';
    }
    // Show the Migrate button only when the loaded wf looks v1 :
    // no `schema`, no `tree`, but nodes exist with `next:` arrays.
    const $migrate = document.getElementById('tree-migrate');
    if ($migrate) {
      const hasV1Next = wf && wf.nodes && Object.values(wf.nodes).some(n => Array.isArray(n.next));
      $migrate.hidden = !!wf && (!!wf.schema || !!wf.tree || !hasV1Next);
    }

    if (!wf || !wf.tree || typeof wf.tree !== 'object') {
      $empty.hidden = false;
      $outline.hidden = true;
      $outline.innerHTML = '';
      return;
    }

    $empty.hidden = true;
    $outline.hidden = false;
    $outline.innerHTML = '';
    $outline.appendChild(renderTreeNode(wf.tree));
    // Re-apply selection styling + toolbar state if we still have
    // a valid index after the re-render.
    if (typeof setSelectedStep === 'function') {
      const steps = (wf.tree && wf.tree.type === 'sequence'
                     && Array.isArray(wf.tree.steps)) ? wf.tree.steps : [];
      if (selectedStepIdx >= steps.length) selectedStepIdx = -1;
      setSelectedStep(selectedStepIdx);
    }
  }

  function summarizeExpr(expr) {
    if (expr === null || expr === undefined) return '<i>?</i>';
    if (typeof expr !== 'object') return JSON.stringify(expr);
    if ('const' in expr) {
      return JSON.stringify(expr.const);
    }
    if ('var' in expr) {
      return `<code>${escapeHtml(expr.var)}</code>`;
    }
    if ('op' in expr && 'left' in expr && 'right' in expr) {
      return `${summarizeExpr(expr.left)} <b>${escapeHtml(expr.op)}</b> ${summarizeExpr(expr.right)}`;
    }
    return `<i>${escapeHtml(JSON.stringify(expr).slice(0, 40))}</i>`;
  }

  function summarizeCond(branch) {
    // Phase 5.4.1 — branch can carry a `cond` field with a composite
    // expression {op:"and|or|not",…}, or legacy flat fields
    // (op + var + value) at top of the branch object. Missing both
    // = else.
    if (!branch) return '<b>else</b>';
    if (branch.cond && typeof branch.cond === 'object') {
      return summarizeCondExpr(branch.cond);
    }
    if (branch.op === undefined) return '<b>else</b>';
    return summarizeCondLeaf(branch);
  }

  function summarizeCondLeaf(c) {
    const v = c.value;
    const vStr = (typeof v === 'string')
      ? JSON.stringify(v)
      : (v === null || v === undefined ? '?' : String(v));
    return `<code>${escapeHtml(c.var || '?')}</code> <b>${escapeHtml(c.op)}</b> ${escapeHtml(vStr)}`;
  }

  function summarizeCondExpr(c) {
    if (!c || typeof c !== 'object') return '<i>?</i>';
    const op = c.op;
    if (op === 'and' || op === 'or') {
      const args = Array.isArray(c.args) ? c.args : [];
      const joined = args.map(summarizeCondExpr).join(` <b>${op.toUpperCase()}</b> `);
      return args.length > 1 ? `(${joined})` : joined;
    }
    if (op === 'not') {
      return `<b>NOT</b> ${summarizeCondExpr(c.arg)}`;
    }
    // Leaf — same shape as a branch.
    return summarizeCondLeaf(c);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Phase 5.7.6 — group hull elements indexed by group name.
  // Populated by render() ; live-updated by moveNode so the hull
  // tracks a node being dragged in real time.
  const groupHulls = new Map();
  const GROUP_PAD = 16;

  function computeGroupHull(name) {
    const g = groupHulls.get(name);
    if (!g) return;
    const xs = []; const ys = [];
    for (const m of g.members) {
      const p = wf && wf._layout && wf._layout[m];
      if (!p) continue;
      xs.push(p.x); ys.push(p.y);
    }
    if (!xs.length) return;
    const minX = Math.min(...xs) - NODE_W / 2 - GROUP_PAD;
    const maxX = Math.max(...xs) + NODE_W / 2 + GROUP_PAD;
    const minY = Math.min(...ys) - NODE_H / 2 - GROUP_PAD - 12;
    const maxY = Math.max(...ys) + NODE_H / 2 + GROUP_PAD;
    g.rect.setAttribute('x', minX);
    g.rect.setAttribute('y', minY);
    g.rect.setAttribute('width', maxX - minX);
    g.rect.setAttribute('height', maxY - minY);
    g.lbl.setAttribute('x', minX + 8);
    g.lbl.setAttribute('y', minY + 14);
  }

  // Phase 5.7.6 — collapsible blocks for scalability. Step objects
  // in this set render their body hidden ; click on the ▶/▼ toggle
  // adds/removes from the set + flips the .collapsed class. WeakSet
  // because step objects are mutated, not replaced, between renders
  // — collapse state survives until a wf reload.
  const collapsedSteps = new WeakSet();

  function addCollapseToggle(block, head, step, bodyClassName) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'block-collapse';
    const initial = collapsedSteps.has(step);
    toggle.textContent = initial ? '▶' : '▼';
    toggle.title = 'Collapse / expand';
    if (initial) block.classList.add('collapsed');
    toggle.addEventListener('click', ev => {
      ev.stopPropagation();
      const isCollapsed = block.classList.toggle('collapsed');
      if (isCollapsed) collapsedSteps.add(step);
      else collapsedSteps.delete(step);
      toggle.textContent = isCollapsed ? '▶' : '▼';
    });
    // Insert as the first child of head so the arrow sits before
    // the keyword.
    head.insertBefore(toggle, head.firstChild);
  }

  // Phase 5.7 — WYSIWYG block renderer.
  //
  // Replaces the textual outline + JSON step editor with inline
  // form widgets per step type. Each input mutates `wf` in place ;
  // text edits are live (no re-render so focus is preserved), while
  // structural changes (add/delete branch, change step type, etc)
  // call render() + markDirty().

  // Live update of a text field — no re-render, no focus loss.
  function liveBind(input, getter, setter) {
    input.value = getter();
    input.addEventListener('input', () => {
      setter(input.value);
      markDirty();
      // Status only — DAG topology may shift but we skip the
      // structural re-render to keep the caret position.
    });
    input.addEventListener('change', () => {
      // On commit (blur, Enter): full re-render so the DAG canvas
      // reflects renamed targets etc.
      setter(input.value);
      markDirty();
      render();
    });
  }

  function nodeOptionsHtml(selected, includeEmpty) {
    const keys = nodeKeys();
    let html = includeEmpty ? '<option value=""></option>' : '';
    for (const k of keys) {
      const sel = k === selected ? ' selected' : '';
      html += `<option value="${escapeAttr(k)}"${sel}>${escapeHtml(k)}</option>`;
    }
    // If `selected` isn't in the current node list, still show it
    // so we don't silently lose the reference.
    if (selected && keys.indexOf(selected) < 0) {
      html += `<option value="${escapeAttr(selected)}" selected>${escapeHtml(selected)} (unknown)</option>`;
    }
    return html;
  }

  function makeDeleteBtn(onClick, label) {
    const b = document.createElement('button');
    b.className = 'block-del';
    b.type = 'button';
    b.innerHTML = label || '✕';
    b.title = 'Delete';
    b.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
    return b;
  }

  function makeAddBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'block-add';
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
    return b;
  }

  // Phase 5.7.1 — recursive cond builder.
  // Leaf : 3 inline inputs (var | op | value) + wrap-with-AND/OR/NOT.
  // Composite : box labelled with op (AND / OR / NOT), each arg
  // is itself a buildCondEditor(args, i) recursion, plus a
  // "+ clause" button. Collapsing a composite back to a leaf is
  // a "↺ leaf" button.
  function buildCondEditor(parent, key) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cond-editor';
    let c = parent[key];

    // ── AND / OR composite ──
    if (c && (c.op === 'and' || c.op === 'or')) {
      wrapper.classList.add('cond-composite');
      const box = document.createElement('div');
      box.className = 'cond-group cond-group-' + c.op;

      const head = document.createElement('div');
      head.className = 'cond-group-head';
      // op switcher (AND ↔ OR)
      const opSel = document.createElement('select');
      opSel.className = 'cond-group-op';
      ['and', 'or'].forEach(op => {
        const o = document.createElement('option');
        o.value = op; o.textContent = op.toUpperCase();
        if (c.op === op) o.selected = true;
        opSel.appendChild(o);
      });
      opSel.addEventListener('change', () => {
        c.op = opSel.value;
        box.className = 'cond-group cond-group-' + c.op;
        markDirty();
      });
      head.appendChild(opSel);

      // Wrap-with-NOT
      const notBtn = document.createElement('button');
      notBtn.type = 'button';
      notBtn.className = 'block-add';
      notBtn.textContent = '! NOT';
      notBtn.title = 'Wrap this whole group in NOT';
      notBtn.addEventListener('click', () => {
        parent[key] = { op: 'not', arg: c };
        markDirty(); render();
      });
      head.appendChild(notBtn);

      // Collapse to leaf : take the first arg (if any) else default.
      const toLeaf = document.createElement('button');
      toLeaf.type = 'button';
      toLeaf.className = 'block-add';
      toLeaf.textContent = '↺ leaf';
      toLeaf.addEventListener('click', () => {
        const first = Array.isArray(c.args) && c.args[0]
          ? c.args[0]
          : { op: '==', var: 'data.X', value: '' };
        parent[key] = first;
        markDirty(); render();
      });
      head.appendChild(toLeaf);

      box.appendChild(head);

      if (!Array.isArray(c.args)) c.args = [];
      c.args.forEach((arg, i) => {
        const argRow = document.createElement('div');
        argRow.className = 'cond-arg';
        argRow.appendChild(buildCondEditor(c.args, i));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'block-del';
        del.innerHTML = '✕';
        del.title = 'Delete this clause';
        del.addEventListener('click', () => {
          c.args.splice(i, 1);
          // If only one clause remains, collapse the wrapper.
          if (c.args.length === 1) parent[key] = c.args[0];
          // If zero, collapse to a default leaf.
          else if (c.args.length === 0) {
            parent[key] = { op: '==', var: 'data.X', value: '' };
          }
          markDirty(); render();
        });
        argRow.appendChild(del);
        box.appendChild(argRow);
      });

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'block-add';
      addBtn.textContent = '+ clause';
      addBtn.addEventListener('click', () => {
        c.args.push({ op: '==', var: 'data.X', value: '' });
        markDirty(); render();
      });
      box.appendChild(addBtn);

      wrapper.appendChild(box);
      return wrapper;
    }

    // ── NOT composite ──
    if (c && c.op === 'not') {
      wrapper.classList.add('cond-composite');
      const box = document.createElement('div');
      box.className = 'cond-group cond-group-not';

      const head = document.createElement('div');
      head.className = 'cond-group-head';
      const lbl = document.createElement('span');
      lbl.className = 'cond-group-op';
      lbl.textContent = 'NOT';
      head.appendChild(lbl);

      const toLeaf = document.createElement('button');
      toLeaf.type = 'button';
      toLeaf.className = 'block-add';
      toLeaf.textContent = '↺ leaf';
      toLeaf.addEventListener('click', () => {
        parent[key] = c.arg || { op: '==', var: 'data.X', value: '' };
        markDirty(); render();
      });
      head.appendChild(toLeaf);

      box.appendChild(head);

      if (!c.arg) c.arg = { op: '==', var: 'data.X', value: '' };
      const argRow = document.createElement('div');
      argRow.className = 'cond-arg';
      argRow.appendChild(buildCondEditor(c, 'arg'));
      box.appendChild(argRow);

      wrapper.appendChild(box);
      return wrapper;
    }

    // ── Leaf : var | op | value (or values chips for in/not_in) ──
    const leaf = (c && typeof c === 'object') ? c : { op: '==', var: '', value: '' };
    parent[key] = leaf;
    const isMembership = (leaf.op === 'in' || leaf.op === 'not_in');

    const varInput = document.createElement('input');
    varInput.type = 'text';
    varInput.className = 'cond-var';
    varInput.placeholder = 'data.X or state.X';
    liveBind(varInput, () => leaf.var || '', v => leaf.var = v);

    const opSelect = document.createElement('select');
    opSelect.className = 'cond-op';
    [
      ['==', '=='],
      ['!=', '≠'],
      ['<',  '<'],
      ['>',  '>'],
      ['<=', '≤'],
      ['>=', '≥'],
      ['in', 'in'],
      ['not_in', 'not in'],
    ].forEach(([v, lbl]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = lbl;
      if ((leaf.op || '==') === v) o.selected = true;
      opSelect.appendChild(o);
    });
    opSelect.addEventListener('change', () => {
      const prev = leaf.op;
      leaf.op = opSelect.value;
      const becomesMembership = (leaf.op === 'in' || leaf.op === 'not_in');
      const wasMembership = (prev === 'in' || prev === 'not_in');
      if (becomesMembership && !wasMembership) {
        // Move scalar value into values list (1-element if defined).
        leaf.values = (leaf.value !== undefined && leaf.value !== '')
          ? [leaf.value] : [];
        delete leaf.value;
      } else if (!becomesMembership && wasMembership) {
        // Collapse values back to scalar.
        leaf.value = (leaf.values && leaf.values[0] !== undefined) ? leaf.values[0] : '';
        delete leaf.values;
      }
      markDirty();
      render();
    });

    function valToStr(v) {
      if (v === true) return 'true';
      if (v === false) return 'false';
      if (v === null) return 'null';
      if (typeof v === 'string') return v;
      return String(v);
    }
    function strToVal(s) {
      if (s === 'true') return true;
      if (s === 'false') return false;
      if (s === 'null') return null;
      const n = Number(s);
      if (s !== '' && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
      return s;
    }

    let valWidget;
    if (isMembership) {
      // chip list for `values`
      valWidget = document.createElement('span');
      valWidget.className = 'cond-val-chips chips';
      if (!Array.isArray(leaf.values)) leaf.values = [];
      leaf.values.forEach((item, i) => {
        const c = document.createElement('span');
        c.className = 'chip chip-lit';
        c.textContent = valToStr(item);
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'chip-x'; x.textContent = '×';
        x.addEventListener('click', () => {
          leaf.values.splice(i, 1);
          markDirty(); render();
        });
        c.appendChild(x);
        valWidget.appendChild(c);
      });
      const adder = document.createElement('input');
      adder.type = 'text';
      adder.className = 'chip-add chip-add-text';
      adder.placeholder = '+ value';
      adder.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const raw = adder.value.trim();
        if (!raw) return;
        leaf.values.push(strToVal(raw));
        markDirty(); render();
      });
      valWidget.appendChild(adder);
    } else {
      valWidget = document.createElement('input');
      valWidget.type = 'text';
      valWidget.className = 'cond-val';
      valWidget.placeholder = 'value';
      valWidget.value = valToStr(leaf.value);
      valWidget.addEventListener('input', () => {
        leaf.value = strToVal(valWidget.value);
        markDirty();
      });
    }

    // Wrap buttons : AND / OR / NOT.
    const andBtn = document.createElement('button');
    andBtn.type = 'button';
    andBtn.className = 'block-add';
    andBtn.textContent = '+ AND';
    andBtn.title = 'Combine this with another condition (all must match)';
    andBtn.addEventListener('click', () => {
      parent[key] = { op: 'and', args: [Object.assign({}, leaf), { op: '==', var: 'data.X', value: '' }] };
      markDirty(); render();
    });

    const orBtn = document.createElement('button');
    orBtn.type = 'button';
    orBtn.className = 'block-add';
    orBtn.textContent = '+ OR';
    orBtn.title = 'Combine this with another condition (any can match)';
    orBtn.addEventListener('click', () => {
      parent[key] = { op: 'or', args: [Object.assign({}, leaf), { op: '==', var: 'data.X', value: '' }] };
      markDirty(); render();
    });

    const notBtn = document.createElement('button');
    notBtn.type = 'button';
    notBtn.className = 'block-add';
    notBtn.textContent = '! NOT';
    notBtn.title = 'Negate this condition';
    notBtn.addEventListener('click', () => {
      parent[key] = { op: 'not', arg: Object.assign({}, leaf) };
      markDirty(); render();
    });

    wrapper.append(varInput, opSelect, valWidget, andBtn, orBtn, notBtn);
    return wrapper;
  }

  // === per-step block builders ==============================
  function buildCall(step, parentRef, parentKey, deletable) {
    const block = document.createElement('div');
    block.className = 'block block-call';
    const head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML = '<span class="block-kw">call</span> →';

    const sel = document.createElement('select');
    sel.className = 'role-select';
    sel.innerHTML = nodeOptionsHtml(step.node, false);
    sel.addEventListener('change', () => {
      step.node = sel.value;
      markDirty();
      render();
    });
    head.appendChild(sel);

    if (deletable) head.appendChild(makeDeleteBtn(deletable));
    block.appendChild(head);
    return block;
  }

  function buildFanOut(step, deletable) {
    const block = document.createElement('div');
    block.className = 'block block-fan-out';
    const head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML = '<span class="block-kw">fan_out</span> →';

    const chips = document.createElement('div');
    chips.className = 'chips';
    const nodes = Array.isArray(step.nodes) ? step.nodes : (step.nodes = []);
    nodes.forEach((n, i) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = n;
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'chip-x'; x.textContent = '×';
      x.title = 'Remove';
      x.addEventListener('click', ev => {
        ev.stopPropagation();
        nodes.splice(i, 1);
        markDirty(); render();
      });
      c.appendChild(x);
      chips.appendChild(c);
    });
    const adder = document.createElement('select');
    adder.className = 'chip-add';
    adder.innerHTML = '<option value="">+ add target…</option>' + nodeOptionsHtml('', false);
    adder.addEventListener('change', () => {
      const v = adder.value;
      if (!v) return;
      if (nodes.indexOf(v) < 0) nodes.push(v);
      markDirty(); render();
    });
    chips.appendChild(adder);
    head.appendChild(chips);

    if (deletable) head.appendChild(makeDeleteBtn(deletable));
    block.appendChild(head);
    return block;
  }

  // Phase 5.7.2 — recursive expression builder for set.value.
  //
  // Same shape as the runtime Expr evaluator (Phase 5.3.1) :
  //   {const: <literal>}        — number / string / true / false / null
  //   {var:   "data.X|state.X"}  — variable reference
  //   {op:"+|-|*|/", left:Expr, right:Expr}   — arithmetic
  //
  // The root <select> picks the form ; switching wipes irrelevant
  // fields and inserts defaults for the new shape.
  function buildExprEditor(parent, key) {
    const wrapper = document.createElement('span');
    wrapper.className = 'expr-editor';
    let e = parent[key];
    if (e === undefined || e === null) e = parent[key] = { const: 0 };
    if (typeof e !== 'object') e = parent[key] = { const: e };

    // Detect form.
    let form;
    if (e.op === '+' || e.op === '-' || e.op === '*' || e.op === '/') form = e.op;
    else if ('var' in e) form = 'var';
    else form = 'const';

    // Form selector.
    const sel = document.createElement('select');
    sel.className = 'expr-form';
    [
      ['const', 'const'],
      ['var',   'var'],
      ['+',     '+'],
      ['-',     '−'],
      ['*',     '×'],
      ['/',     '÷'],
    ].forEach(([val, lbl]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = lbl;
      if (val === form) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      const next = sel.value;
      if (next === 'const') parent[key] = { const: 0 };
      else if (next === 'var') parent[key] = { var: 'state.X' };
      else parent[key] = { op: next, left: { var: 'state.X' }, right: { const: 1 } };
      markDirty(); render();
    });
    wrapper.appendChild(sel);

    if (form === 'const') {
      const val = e.const;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'expr-const-val';
      inp.placeholder = 'number / string / true / false';
      function valToStr(v) {
        if (v === true) return 'true';
        if (v === false) return 'false';
        if (v === null) return 'null';
        if (typeof v === 'string') return v;
        return String(v);
      }
      function strToVal(s) {
        if (s === 'true') return true;
        if (s === 'false') return false;
        if (s === 'null') return null;
        const n = Number(s);
        if (s !== '' && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
        return s;
      }
      inp.value = valToStr(val);
      inp.addEventListener('input', () => {
        e.const = strToVal(inp.value);
        markDirty();
      });
      wrapper.appendChild(inp);
    } else if (form === 'var') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'expr-var';
      inp.placeholder = 'data.X or state.X';
      liveBind(inp, () => e.var || '', v => e.var = v);
      wrapper.appendChild(inp);
    } else {
      // Binary op : left + right are themselves expressions.
      const group = document.createElement('span');
      group.className = 'expr-binop';
      if (!e.left)  e.left  = { var: 'state.X' };
      if (!e.right) e.right = { const: 1 };
      group.appendChild(buildExprEditor(e, 'left'));
      const opLbl = document.createElement('span');
      opLbl.className = 'expr-op-glyph';
      opLbl.textContent = ({ '+':'+', '-':'−', '*':'×', '/':'÷' })[form];
      group.appendChild(opLbl);
      group.appendChild(buildExprEditor(e, 'right'));
      wrapper.appendChild(group);
    }

    return wrapper;
  }

  function buildSet(step, deletable) {
    const block = document.createElement('div');
    block.className = 'block block-set';
    const head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML = '<span class="block-kw">set</span>';

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = 'state.X';
    pathInput.className = 'set-path';
    liveBind(pathInput, () => step.path || '', v => step.path = v);
    head.appendChild(pathInput);

    const eq = document.createElement('span');
    eq.textContent = '=';
    eq.className = 'block-eq';
    head.appendChild(eq);

    // Phase 5.7.2 — recursive expr builder (const / var / arithm)
    // replaces the JSON textarea. Operator picks the form via a
    // dropdown ; arithmetic binds two nested expressions.
    if (step.value === undefined) step.value = { const: 0 };
    head.appendChild(buildExprEditor(step, 'value'));

    if (deletable) head.appendChild(makeDeleteBtn(deletable));
    block.appendChild(head);
    return block;
  }

  function buildIf(step, deletable) {
    const block = document.createElement('div');
    block.className = 'block block-if';
    const head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML = '<span class="block-kw">if</span>';
    if (deletable) head.appendChild(makeDeleteBtn(deletable));
    block.appendChild(head);
    addCollapseToggle(block, head, step);

    const body = document.createElement('div');
    body.className = 'block-body';
    if (!Array.isArray(step.branches)) step.branches = [];
    const branches = step.branches;

    branches.forEach((br, i) => {
      const branchDiv = document.createElement('div');
      branchDiv.className = 'branch';

      const branchHead = document.createElement('div');
      branchHead.className = 'branch-head';

      const hasCond = br && (br.cond !== undefined || br.op !== undefined);
      const label = !hasCond ? 'else' : (i === 0 ? 'when' : 'elseif');
      const lblSpan = document.createElement('span');
      lblSpan.className = 'branch-label';
      lblSpan.textContent = label;
      branchHead.appendChild(lblSpan);

      if (label !== 'else') {
        // Migrate legacy flat {op,var,value} → branch.cond shape.
        if (!br.cond && br.op !== undefined) {
          br.cond = { op: br.op, var: br.var, value: br.value };
          delete br.op; delete br.var; delete br.value;
        }
        branchHead.appendChild(buildCondEditor(br, 'cond'));
      }

      // Delete branch button (always, since at least the else can
      // stay alone but we let user remove anything).
      branchHead.appendChild(makeDeleteBtn(() => {
        branches.splice(i, 1);
        markDirty(); render();
      }, '✕ branch'));
      branchDiv.appendChild(branchHead);

      // The "then" action.
      const thenWrap = document.createElement('div');
      thenWrap.className = 'branch-then';
      if (!br.then) br.then = { type: 'fan_out', nodes: [] };
      thenWrap.appendChild(buildAction(br.then, br, 'then'));
      branchDiv.appendChild(thenWrap);

      body.appendChild(branchDiv);
    });

    // Add-branch buttons.
    const adders = document.createElement('div');
    adders.className = 'branch-adders';
    adders.appendChild(makeAddBtn('+ elseif', () => {
      // Insert before the else branch if one exists.
      const elseIdx = branches.findIndex(b => !b || (b.cond === undefined && b.op === undefined));
      const newBranch = { cond: { op: '==', var: 'data.X', value: '' }, then: { type: 'fan_out', nodes: [] } };
      if (elseIdx >= 0) branches.splice(elseIdx, 0, newBranch);
      else branches.push(newBranch);
      markDirty(); render();
    }));
    const hasElse = branches.some(b => !b || (b.cond === undefined && b.op === undefined));
    if (!hasElse) {
      adders.appendChild(makeAddBtn('+ else', () => {
        branches.push({ then: { type: 'fan_out', nodes: [] } });
        markDirty(); render();
      }));
    }
    body.appendChild(adders);

    block.appendChild(body);
    return block;
  }

  function buildFor(step, deletable) {
    const block = document.createElement('div');
    block.className = 'block block-for';
    const head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML = '<span class="block-kw">for</span>';
    // Toggle added AFTER head fills (call signature differs from
    // buildIf since for's head is assembled inline below).

    const varInput = document.createElement('input');
    varInput.type = 'text';
    varInput.className = 'for-var';
    varInput.placeholder = 'item';
    liveBind(varInput, () => step.var || 'item', v => step.var = v);
    head.appendChild(varInput);

    const inLabel = document.createElement('span');
    inLabel.textContent = 'in';
    inLabel.className = 'block-kw-sub';
    head.appendChild(inLabel);

    // Items : chips of literal values.
    const itemsBox = document.createElement('div');
    itemsBox.className = 'chips';
    if (!Array.isArray(step.in)) step.in = [];
    step.in.forEach((item, i) => {
      const c = document.createElement('span');
      c.className = 'chip chip-lit';
      c.textContent = JSON.stringify(item);
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'chip-x'; x.textContent = '×';
      x.addEventListener('click', () => {
        step.in.splice(i, 1);
        markDirty(); render();
      });
      c.appendChild(x);
      itemsBox.appendChild(c);
    });
    const itemAdd = document.createElement('input');
    itemAdd.type = 'text';
    itemAdd.className = 'chip-add chip-lit-add';
    itemAdd.placeholder = '+ item (Enter)';
    itemAdd.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const raw = itemAdd.value.trim();
      if (!raw) return;
      let v;
      try { v = JSON.parse(raw); } catch { v = raw; }
      step.in.push(v);
      itemAdd.value = '';
      markDirty(); render();
    });
    itemsBox.appendChild(itemAdd);
    head.appendChild(itemsBox);

    if (deletable) head.appendChild(makeDeleteBtn(deletable));
    block.appendChild(head);
    addCollapseToggle(block, head, step);

    // body : the do action.
    const body = document.createElement('div');
    body.className = 'block-body';
    const doLabel = document.createElement('span');
    doLabel.className = 'block-kw-sub';
    doLabel.textContent = 'do';
    body.appendChild(doLabel);
    if (!step.do) step.do = { type: 'call', node: '' };
    body.appendChild(buildAction(step.do, step, 'do'));
    block.appendChild(body);

    return block;
  }

  function buildWhile(step, deletable) {
    const block = document.createElement('div');
    block.className = 'block block-while';
    const head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML = '<span class="block-kw">while</span>';

    if (!step.cond || typeof step.cond !== 'object') {
      step.cond = { op: '<', var: 'state.iter', value: 3 };
    }
    head.appendChild(buildCondEditor(step, 'cond'));

    const maxLabel = document.createElement('span');
    maxLabel.className = 'block-kw-sub';
    maxLabel.textContent = 'maxIter';
    head.appendChild(maxLabel);
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.className = 'while-max';
    maxInput.min = '1';
    maxInput.value = String(step.maxIter || 10);
    maxInput.addEventListener('input', () => {
      const v = parseInt(maxInput.value, 10);
      if (!Number.isNaN(v) && v > 0) { step.maxIter = v; markDirty(); }
    });
    head.appendChild(maxInput);

    if (deletable) head.appendChild(makeDeleteBtn(deletable));
    block.appendChild(head);
    return block;
  }

  // Action dispatcher : picks the right block builder, plus a
  // "change type" dropdown for swapping action kinds.
  function buildAction(action, parentRef, parentKey) {
    const t = (action && action.type) || 'call';
    const onDelete = (parentRef && parentKey)
      ? () => {
          // For an action embedded inside another (if-branch then,
          // for.do): replace by a placeholder so the parent still
          // has shape.
          parentRef[parentKey] = { type: 'call', node: '' };
          markDirty(); render();
        }
      : null;
    if (t === 'call')     return buildCall(action, parentRef, parentKey, onDelete);
    if (t === 'fan_out')  return buildFanOut(action, onDelete);
    if (t === 'set')      return buildSet(action, onDelete);
    if (t === 'if')       return buildIf(action, onDelete);
    if (t === 'for')      return buildFor(action, onDelete);
    if (t === 'while')    return buildWhile(action, onDelete);
    if (t === 'sequence') return buildSequence(action, false);
    if (t === 'end') {
      const block = document.createElement('div');
      block.className = 'block block-end';
      block.innerHTML = '<span class="block-kw">end</span>';
      if (onDelete) block.appendChild(makeDeleteBtn(onDelete));
      return block;
    }
    const block = document.createElement('div');
    block.className = 'block block-unknown';
    block.innerHTML = `<span class="tree-unknown">unknown: ${escapeHtml(t)}</span>`;
    return block;
  }

  function buildSequence(step, isRoot) {
    const block = document.createElement('div');
    block.className = 'block block-seq' + (isRoot ? ' block-seq-root' : '');
    if (!Array.isArray(step.steps)) step.steps = [];
    const steps = step.steps;

    steps.forEach((s, i) => {
      const slot = document.createElement('div');
      slot.className = 'seq-step';
      slot.setAttribute('data-step-idx', String(i));

      // Phase 5.7.4 — drag handle on the left of the controls.
      // Native HTML5 DnD : the handle owns the draggable=true
      // attribute, so the user only initiates a drag when grabbing
      // the handle (text inputs etc inside the step stay clickable).
      const handle = document.createElement('span');
      handle.className = 'seq-drag-handle';
      handle.innerHTML = '⋮⋮';
      handle.title = 'Drag to reorder';
      handle.draggable = true;
      handle.addEventListener('dragstart', ev => {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(i));
        slot.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        slot.classList.remove('dragging');
        block.querySelectorAll('.seq-step.drop-above, .seq-step.drop-below')
          .forEach(el => el.classList.remove('drop-above', 'drop-below'));
      });

      slot.addEventListener('dragover', ev => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        const rect = slot.getBoundingClientRect();
        const above = ev.clientY < rect.top + rect.height / 2;
        slot.classList.toggle('drop-above', above);
        slot.classList.toggle('drop-below', !above);
      });
      slot.addEventListener('dragleave', () => {
        slot.classList.remove('drop-above', 'drop-below');
      });
      slot.addEventListener('drop', ev => {
        ev.preventDefault();
        const srcStr = ev.dataTransfer.getData('text/plain');
        const src = parseInt(srcStr, 10);
        if (Number.isNaN(src) || src === i) {
          slot.classList.remove('drop-above', 'drop-below');
          return;
        }
        const rect = slot.getBoundingClientRect();
        const above = ev.clientY < rect.top + rect.height / 2;
        // Compute the post-removal insertion index.
        let dst = above ? i : i + 1;
        const moved = steps[src];
        steps.splice(src, 1);
        if (src < dst) dst -= 1;
        steps.splice(dst, 0, moved);
        if (isRoot && selectedStepIdx === src) selectedStepIdx = dst;
        markDirty();
        render();
      });

      const child = buildAction(s, null, null);
      // Phase 5.7.8 — place the drag handle + delete button INSIDE
      // the block's head bar so they live on the colored band, not
      // floating in the gutter outside.
      const delBtn = makeDeleteBtn(() => {
        steps.splice(i, 1);
        if (isRoot && selectedStepIdx === i) selectedStepIdx = -1;
        markDirty(); render();
      }, '✕');
      const head = child.querySelector ? child.querySelector('.block-head') : null;
      if (head) {
        head.appendChild(handle);
        head.appendChild(delBtn);
      } else {
        // No head (e.g. unknown step) — append at the end of the block.
        child.appendChild(handle);
        child.appendChild(delBtn);
      }
      slot.appendChild(child);

      if (isRoot) {
        slot.addEventListener('click', ev => {
          ev.stopPropagation();
          setSelectedStep(i);
        });
      }
      block.appendChild(slot);
    });

    // Phase 5.7.11 — context-aware insert. When a step is selected
    // (only meaningful for the root sequence), the adder inserts
    // immediately AFTER it and re-selects the new step so the
    // operator can chain inserts naturally. No selection → append
    // at the end (the original behavior).
    function insertStep(tmpl) {
      const isRootSel = isRoot && selectedStepIdx >= 0 && selectedStepIdx < steps.length;
      const at = isRootSel ? selectedStepIdx + 1 : steps.length;
      steps.splice(at, 0, tmpl);
      if (isRootSel) selectedStepIdx = at;
      markDirty(); render();
    }
    function makeAddersBar() {
      const bar = document.createElement('div');
      bar.className = 'seq-adders';
      bar.appendChild(makeAddBtn('+ call', () => insertStep({ type: 'call', node: '' })));
      bar.appendChild(makeAddBtn('+ fan_out', () => insertStep({ type: 'fan_out', nodes: [] })));
      bar.appendChild(makeAddBtn('+ if', () => insertStep({
        type: 'if',
        branches: [
          { cond: { op: '==', var: 'data.kind', value: 'vip' }, then: { type: 'fan_out', nodes: [] } },
          { then: { type: 'fan_out', nodes: [] } }
        ]
      })));
      bar.appendChild(makeAddBtn('+ set', () => insertStep({
        type: 'set', path: 'state.example', value: { const: 0 } })));
      bar.appendChild(makeAddBtn('+ for', () => insertStep({
        type: 'for', var: 'item', in: [], do: { type: 'call', node: '' } })));
      bar.appendChild(makeAddBtn('+ while', () => insertStep({
        type: 'while', cond: { op: '<', var: 'state.iter', value: 3 }, maxIter: 10 })));
      return bar;
    }

    // Phase 5.7.12 — adders inside the sequence only for NESTED
    // sequences (inside if.then or for.do). The root sequence
    // is served by the unified tree-head toolbar (which knows
    // about selection) ; duplicating it inside the block was
    // visual noise.
    if (!isRoot) {
      block.insertBefore(makeAddersBar(), block.firstChild);
      block.appendChild(makeAddersBar());
    }

    return block;
  }

  // Top-level wrapper that the outline renderer calls.
  function renderTreeNode(step) {
    // Wrap into <li> so the old DOM structure still holds where
    // callers expect (the <ol> outline) — but the content is now
    // the block tree.
    const li = document.createElement('li');
    li.className = 'tree-node';
    if (!step || typeof step !== 'object') {
      li.innerHTML = '<span class="tree-unknown">(invalid step)</span>';
      return li;
    }
    if (step.type === 'sequence') {
      li.appendChild(buildSequence(step, true));
    } else {
      li.appendChild(buildAction(step, null, null));
    }
    return li;
  }

  function refreshRaw() {
    // Show v2 workflows in their array-of-nodes form so what the
    // user sees in Raw JSON matches what gets written to disk.
    let view = wf;
    if (isV2Schema(wf) && wf && wf.nodes && !Array.isArray(wf.nodes)) {
      view = Object.assign({}, wf);
      view.nodes = nodesObjectToArray(wf.nodes);
    }
    $src.value = JSON.stringify(view, null, 2);
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
      updateEdgeLabel(line);
    }
    for (const line of entry.edgesTo) {
      line.setAttribute('x2', x - NODE_W / 2);
      line.setAttribute('y2', y);
      updateEdgeLabel(line);
    }
    // Phase 5.7.6 — group hull follows the dragged node.
    if (entry.groupName) computeGroupHull(entry.groupName);
  }

  // Phase 5.7.5 — reposition the label attached to a <line> /
  // <path> edge after a node has been dragged. The label always
  // sits at the line midpoint (regular edge) or above the source
  // (self-loop), so we recompute from the current SVG coords.
  function updateEdgeLabel(line) {
    const lbl = line._label;
    if (!lbl) return;
    if (line._isSelfLoop) {
      const from = line.dataset.from;
      const a = wf._layout[from];
      if (!a) return;
      lbl.setAttribute('x', a.x);
      lbl.setAttribute('y', a.y - NODE_H / 2 - 30);
    } else {
      const x1 = Number(line.getAttribute('x1'));
      const y1 = Number(line.getAttribute('y1'));
      const x2 = Number(line.getAttribute('x2'));
      const y2 = Number(line.getAttribute('y2'));
      lbl.setAttribute('x', (x1 + x2) / 2);
      lbl.setAttribute('y', (y1 + y2) / 2 - 4);
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

  // Phase 5.7.3 — chip-list editor inside the inspector. Replaces
  // comma-separated text inputs. Each chip is removable ; an inline
  // <input> at the end accepts a new value on Enter and appends.
  function renderChipsInto(container, getList, setList) {
    container.innerHTML = '';
    const list = getList() || [];
    list.forEach((item, i) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = item;
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'chip-x'; x.textContent = '×';
      x.addEventListener('click', ev => {
        ev.stopPropagation();
        const next = list.slice(); next.splice(i, 1);
        setList(next);
        renderChipsInto(container, getList, setList);
      });
      c.appendChild(x);
      container.appendChild(c);
    });
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'chip-add chip-add-text';
    inp.placeholder = container.dataset.placeholder || '+ item';
    inp.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const v = inp.value.trim();
      if (!v) return;
      const cur = getList() || [];
      if (cur.indexOf(v) >= 0) { inp.value = ''; return; }
      setList(cur.concat([v]));
      renderChipsInto(container, getList, setList);
    });
    container.appendChild(inp);
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
    if ($fGroup) $fGroup.value = n.group || '';
    renderChipsInto($fCons,  () => n.consumes || [],
                              vs => setOrDeleteArray(n, 'consumes', vs));
    renderChipsInto($fEmits, () => n.emits || [],
                              vs => setOrDeleteArray(n, 'emits', vs));
    // `next` is v1-only — v2 workflows store routing in `tree`.
    const $nextRow = document.getElementById('f-next-row');
    const isV2 = isV2Schema(wf) || (wf && wf.tree);
    if ($nextRow) $nextRow.style.display = isV2 ? 'none' : '';
    if (!isV2) {
      renderChipsInto($fNext, () => n.next || [],
                              vs => setOrDeleteArray(n, 'next', vs));
    }
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
    if ($fGroup) {
      const grp = $fGroup.value.trim();
      if (grp) n.group = grp; else delete n.group;
    }
    // Phase 5.7.3 — consumes / emits / next are edited via the
    // chip widgets, which mutate wf.nodes directly on each
    // add/remove. Nothing left to collect from form inputs.

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

  // ── schema v1↔v2 nodes normalization ────────────────────────
  //
  // v1 : "nodes": { "<label>": {host, port, …} }      object
  // v2 : "nodes": [ {id, label, host, port, …}, … ]   array
  //
  // The in-memory model stays in v1 shape (object keyed by label)
  // so all the existing render / addNode / inspector code keeps
  // working. We convert at the load/save boundaries based on the
  // top-level `schema` field (v2 if it starts with "workflow-tree/").
  function isV2Schema(w) {
    return w && typeof w.schema === 'string'
        && w.schema.indexOf('workflow-tree/') === 0;
  }
  function nodesArrayToObject(arr) {
    const out = {};
    arr.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const key = entry.label || entry.id;
      if (!key) return;
      const copy = Object.assign({}, entry);
      delete copy.label;
      out[key] = copy;
    });
    return out;
  }
  function nodesObjectToArray(obj) {
    return Object.keys(obj).map(k => {
      const copy = Object.assign({}, obj[k]);
      const out = { label: k };
      if (copy.id) { out.id = copy.id; delete copy.id; }
      else { out.id = 'n-' + k; }
      return Object.assign(out, copy);
    });
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
      // v2 arrives as an array — flatten into the object form
      // the rest of the manager expects.
      if (Array.isArray(wf.nodes)) {
        wf.nodes = nodesArrayToObject(wf.nodes);
      }
      selected = null;
      $delete.disabled = true;
      markClean();
      // Phase 5.7.14 — fresh load resets the undo / redo stacks.
      // Initial wf is the bottom of the history (undo target floor).
      history = [JSON.stringify(wf)];
      future = [];
      render();
      updateUndoRedoButtons();
      const n = Object.keys(wf.nodes).length;
      setStatus(`loaded · ${n} node${n === 1 ? '' : 's'}`, 'ok');
    } catch (e) {
      setStatus('load error: ' + e.message, 'error');
    }
  }

  async function save() {
    setStatus('saving…');
    try {
      // For v2 workflows, restore the array shape on the way out
      // so the runtime side sees a valid v2 file.
      const out = Object.assign({}, wf);
      if (isV2Schema(wf) && wf.nodes && !Array.isArray(wf.nodes)) {
        out.nodes = nodesObjectToArray(wf.nodes);
      }
      const body = JSON.stringify(out, null, 2);
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
  // Phase 5.7.14 — Undo / Redo toolbar buttons.
  const $undo = document.getElementById('undo');
  const $redo = document.getElementById('redo');
  if ($undo) $undo.addEventListener('click', undo);
  if ($redo) $redo.addEventListener('click', redo);
  $add.addEventListener('click', addNode);

  // Phase 5.7 polish — Re-layout : wipe the sticky _layout so
  // ensureLayout() picks fresh positions from the current
  // topology (edges derived from the tree).
  const $relayout = document.getElementById('dag-relayout');
  if ($relayout) {
    $relayout.addEventListener('click', () => {
      if (wf && wf._layout) wf._layout = {};
      markDirty();
      render();
      setStatus('layout recomputed — click Save to persist positions', 'ok');
    });
  }
  $delete.addEventListener('click', deleteSelected);
  $apply.addEventListener('click', applyForm);

  // Phase 5.5c — selection + reorder/delete for top-level sequence
  // steps. Nested edits (branches inside an `if`, body of `for`,
  // etc) still go through Raw JSON for now.
  let selectedStepIdx = -1;

  function setSelectedStep(idx) {
    selectedStepIdx = idx;
    const $up   = document.getElementById('tree-up');
    const $down = document.getElementById('tree-down');
    const $del  = document.getElementById('tree-delete');
    const steps = (wf && wf.tree && wf.tree.type === 'sequence'
                   && Array.isArray(wf.tree.steps)) ? wf.tree.steps : [];
    const valid = idx >= 0 && idx < steps.length;
    if ($up)   $up.disabled   = !valid || idx === 0;
    if ($down) $down.disabled = !valid || idx >= steps.length - 1;
    if ($del)  $del.disabled  = !valid;
    // Visually mark the selected sequence step. The block renderer
    // (Phase 5.7) stamps data-step-idx on .seq-step divs.
    const out = document.getElementById('tree-outline');
    if (out) {
      out.querySelectorAll('.seq-step.selected').forEach(el => el.classList.remove('selected'));
      if (valid) {
        const el = out.querySelector(`.seq-step[data-step-idx="${idx}"]`);
        if (el) el.classList.add('selected');
      }
    }
    // Step editor panel — show the JSON of the selected step so the
    // user can tweak fields without scrolling through the whole
    // workflow's Raw JSON.
    const $editPanel  = document.getElementById('tree-step-edit');
    const $editSrc    = document.getElementById('tree-step-src');
    const $editLabel  = document.getElementById('tree-step-label');
    const $editStatus = document.getElementById('tree-step-status');
    if ($editPanel && $editSrc) {
      if (valid) {
        const step = steps[idx];
        $editPanel.hidden = false;
        $editPanel.open = true;
        if ($editLabel) {
          $editLabel.textContent = `${step.type || '?'} @ index ${idx}`;
        }
        $editSrc.value = JSON.stringify(step, null, 2);
        if ($editStatus) { $editStatus.textContent = ''; $editStatus.className = 'hint'; }
      } else {
        $editPanel.hidden = true;
        if ($editLabel) $editLabel.textContent = 'none';
        $editSrc.value = '';
      }
    }
  }

  function applyStepEdit() {
    if (selectedStepIdx < 0) return;
    if (!wf || !wf.tree || wf.tree.type !== 'sequence') return;
    const $editSrc    = document.getElementById('tree-step-src');
    const $editStatus = document.getElementById('tree-step-status');
    if (!$editSrc) return;
    try {
      const parsed = JSON.parse($editSrc.value);
      if (!parsed || typeof parsed !== 'object' || !parsed.type) {
        if ($editStatus) {
          $editStatus.textContent = 'step needs an object with a "type" field';
          $editStatus.className = 'hint error';
        }
        return;
      }
      wf.tree.steps[selectedStepIdx] = parsed;
      render();
      markDirty();
      // Re-apply selection so the panel stays open with the new
      // (now-canonical) JSON shown.
      setSelectedStep(selectedStepIdx);
      if ($editStatus) {
        $editStatus.textContent = 'step updated — click Save to persist';
        $editStatus.className = 'hint ok';
      }
    } catch (e) {
      if ($editStatus) {
        $editStatus.textContent = 'parse error: ' + e.message;
        $editStatus.className = 'hint error';
      }
    }
  }

  const $treeStepApply = document.getElementById('tree-step-apply');
  if ($treeStepApply) $treeStepApply.addEventListener('click', applyStepEdit);

  // Phase 5.5e polish — Validate. Walk the tree, collect every
  // referenced node name, flag those that don't exist in wf.nodes.
  // Also flag empty fan_outs (would silently route nowhere) and
  // ifs whose last branch isn't an else (messages can fall off).
  function collectIssues() {
    const issues = [];
    const keys = nodeKeys();
    if (!wf) { issues.push('no workflow loaded'); return issues; }
    if (keys.length === 0) issues.push('no nodes defined');
    if (!wf.tree) { issues.push('no tree (workflow has no behavior)'); return issues; }

    function checkRoleRef(role, path) {
      if (!role) issues.push(`${path}: empty node reference`);
      else if (keys.indexOf(role) < 0) issues.push(`${path}: node "${role}" not in wf.nodes`);
    }

    function walk(step, path) {
      if (!step || typeof step !== 'object') return;
      const t = step.type;
      if (t === 'sequence') {
        const steps = Array.isArray(step.steps) ? step.steps : [];
        steps.forEach((s, i) => walk(s, `${path}.steps[${i}]`));
      } else if (t === 'call') {
        checkRoleRef(step.node, path);
      } else if (t === 'fan_out') {
        const nodes = Array.isArray(step.nodes) ? step.nodes : [];
        if (nodes.length === 0) issues.push(`${path}: fan_out has no targets`);
        nodes.forEach((r, i) => checkRoleRef(r, `${path}.nodes[${i}]`));
      } else if (t === 'if') {
        const branches = Array.isArray(step.branches) ? step.branches : [];
        if (branches.length === 0) issues.push(`${path}: if has no branches`);
        const last = branches[branches.length - 1];
        if (last && (last.cond !== undefined || last.op !== undefined)) {
          issues.push(`${path}: last branch has a cond — messages that don't match any branch are dropped. Add an else.`);
        }
        branches.forEach((b, i) => {
          if (b && b.then) walk(b.then, `${path}.branches[${i}].then`);
        });
      } else if (t === 'set') {
        if (!step.path || typeof step.path !== 'string') {
          issues.push(`${path}: set step missing path`);
        }
      } else if (t === 'for') {
        if (!Array.isArray(step.in) || step.in.length === 0) {
          issues.push(`${path}: for has empty items list`);
        }
        if (step.do) walk(step.do, `${path}.do`);
      } else if (t === 'while') {
        if (!step.cond || typeof step.cond !== 'object') {
          issues.push(`${path}: while has no cond — would loop forever (capped by maxIter)`);
        }
      } else if (t !== 'end' && t !== undefined) {
        issues.push(`${path}: unknown step type "${t}"`);
      }
    }
    walk(wf.tree, 'tree');
    return issues;
  }

  function validateWorkflow() {
    const issues = collectIssues();
    if (issues.length === 0) {
      setStatus('✓ workflow validates — no issues found', 'ok');
    } else {
      const lines = issues.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
      setStatus(`✗ ${issues.length} issue(s) — see console`, 'error');
      // Also log to console so the user can copy/paste.
      console.warn('Workflow validation issues:\n' + lines);
    }
  }

  const $treeValidate = document.getElementById('tree-validate');
  if ($treeValidate) $treeValidate.addEventListener('click', validateWorkflow);

  // Phase 5.6 — migrate v1 → v2.
  //
  // v1 : `nodes: {role: {next: [...]}}` flat DAG.
  // v2 : `nodes: [array]` + `tree: {type:"sequence", steps:[...]}`.
  //
  // Scope : handles the common case of a single root + linear
  // chain + optional terminal fan_out. Diamonds and multi-root
  // DAGs need manual editing — we surface the limit clearly.
  function migrateV1toV2() {
    if (!wf || !wf.nodes) {
      setStatus('migrate : no workflow loaded', 'error');
      return;
    }
    if (wf.schema || wf.tree) {
      setStatus('already v2 (has schema or tree) — nothing to migrate', 'error');
      return;
    }

    const keys = Object.keys(wf.nodes);
    if (keys.length === 0) {
      setStatus('migrate : no nodes', 'error');
      return;
    }

    // Find roots — nodes with no incoming `next` edges.
    const incoming = {};
    keys.forEach(k => incoming[k] = 0);
    for (const k of keys) {
      for (const tgt of (wf.nodes[k].next || [])) {
        if (incoming[tgt] !== undefined) incoming[tgt]++;
      }
    }
    const roots = keys.filter(k => incoming[k] === 0);
    if (roots.length === 0) {
      setStatus('migrate : no root (cyclic next:) — fix the DAG first', 'error');
      return;
    }
    if (roots.length > 1) {
      setStatus(`migrate : multiple roots [${roots.join(', ')}] — only single-root chains are auto-migrated. Edit Raw JSON for diamonds.`, 'error');
      return;
    }
    const root = roots[0];

    // Walk : root → chain → terminal fan_out.
    const steps = [];
    let cur = root;
    const visited = new Set();
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      steps.push({ type: 'call', node: cur });
      const next = wf.nodes[cur].next || [];
      if (next.length === 0) { cur = null; break; }
      if (next.length === 1) {
        cur = next[0];
        continue;
      }
      // multi-target → terminal fan_out
      steps.push({ type: 'fan_out', nodes: next.slice() });
      cur = null;
    }

    // Flip the schema + drop the per-node next.
    wf.schema = 'workflow-tree/v1';
    wf.tree = { type: 'sequence', steps };
    for (const k of keys) {
      delete wf.nodes[k].next;
    }

    setSelectedStep(-1);
    render();
    markDirty();
    setStatus(`migrated → v2 (${steps.length} step${steps.length === 1 ? '' : 's'}, root=${root}) — review + Save`, 'ok');
  }

  const $treeMigrate = document.getElementById('tree-migrate');
  if ($treeMigrate) $treeMigrate.addEventListener('click', migrateV1toV2);

  function moveStep(delta) {
    if (selectedStepIdx < 0) return;
    if (!wf || !wf.tree || wf.tree.type !== 'sequence') return;
    const steps = wf.tree.steps;
    const j = selectedStepIdx + delta;
    if (j < 0 || j >= steps.length) return;
    const tmp = steps[selectedStepIdx];
    steps[selectedStepIdx] = steps[j];
    steps[j] = tmp;
    selectedStepIdx = j;
    render();
    markDirty();
    setSelectedStep(selectedStepIdx);
  }

  function deleteStep() {
    if (selectedStepIdx < 0) return;
    if (!wf || !wf.tree || wf.tree.type !== 'sequence') return;
    wf.tree.steps.splice(selectedStepIdx, 1);
    selectedStepIdx = -1;
    render();
    markDirty();
    setSelectedStep(-1);
  }

  const $treeUp   = document.getElementById('tree-up');
  const $treeDown = document.getElementById('tree-down');
  const $treeDel  = document.getElementById('tree-delete');
  if ($treeUp)   $treeUp.addEventListener('click',   () => moveStep(-1));
  if ($treeDown) $treeDown.addEventListener('click', () => moveStep(+1));
  if ($treeDel)  $treeDel.addEventListener('click',  () => deleteStep());

  // Phase 5.5b — toolbar buttons append a template step at the end
  // of the top-level sequence. User edits values via Raw JSON or
  // (future) inline forms.
  function ensureSequence() {
    if (!wf || typeof wf !== 'object') {
      $rawStatus && ($rawStatus.textContent = 'no workflow loaded');
      return null;
    }
    if (!wf.tree || typeof wf.tree !== 'object') {
      wf.tree = { type: 'sequence', steps: [] };
    }
    if (wf.tree.type !== 'sequence') {
      // Wrap a non-sequence root in a fresh sequence so we have a
      // place to append. Conservative — the original root becomes
      // the first step.
      wf.tree = { type: 'sequence', steps: [wf.tree] };
    }
    if (!Array.isArray(wf.tree.steps)) wf.tree.steps = [];
    return wf.tree.steps;
  }

  function appendStep(step, label) {
    const steps = ensureSequence();
    if (!steps) return;
    steps.push(step);
    render();
    markDirty();
    if ($rawStatus) {
      $rawStatus.textContent = `+ ${label} appended — edit Raw JSON to fill in details, then Save`;
      $rawStatus.className = 'hint ok';
    }
  }

  // Phase 5.7.12 — tree-head toolbar is the single source of
  // truth for adding root-sequence steps. Templates default to
  // EMPTY targets to avoid phantom-edge floods in the DAG ;
  // operator picks the role from the dropdown after.
  function nodeKeys() {
    return (wf && wf.nodes) ? Object.keys(wf.nodes) : [];
  }
  function insertRootStep(tmpl, label) {
    const steps = ensureSequence();
    if (!steps) return;
    const sel = (selectedStepIdx >= 0 && selectedStepIdx < steps.length)
      ? selectedStepIdx + 1
      : steps.length;
    steps.splice(sel, 0, tmpl);
    selectedStepIdx = sel;
    render();
    markDirty();
    setSelectedStep(sel);
    if ($rawStatus) {
      $rawStatus.textContent = `+ ${label} inserted at index ${sel} — click Save to persist`;
      $rawStatus.className = 'hint ok';
    }
  }

  const treeAddSpecs = [
    ['tree-add-call',    'call',    () => ({ type: 'call', node: '' })],
    ['tree-add-fan_out', 'fan_out', () => ({ type: 'fan_out', nodes: [] })],
    ['tree-add-if',      'if',      () => ({
      type: 'if',
      branches: [
        { cond: { op: '==', var: 'data.kind', value: 'vip' },
          then: { type: 'fan_out', nodes: [] } },
        { then: { type: 'fan_out', nodes: [] } }
      ]
    })],
    ['tree-add-set',     'set',     () => ({
      type: 'set', path: 'state.example', value: { const: 0 } })],
    ['tree-add-for',     'for',     () => ({
      type: 'for', var: 'item', in: [], do: { type: 'call', node: '' } })],
    ['tree-add-while',   'while',   () => ({
      type: 'while', cond: { op: '<', var: 'state.iter', value: 3 }, maxIter: 10 })],
  ];
  for (const [id, lbl, mkTmpl] of treeAddSpecs) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => insertRootStep(mkTmpl(), lbl));
  }

  // Phase 5.5a — Raw JSON edit + Apply. Smallest useful editing
  // path until the visual tree editor lands. Parse the textarea
  // into the in-memory wf, then re-render (DAG + tree).
  const $applyRaw  = document.getElementById('apply-raw');
  const $rawStatus = document.getElementById('raw-status');
  if ($applyRaw) {
    $applyRaw.addEventListener('click', () => {
      try {
        const parsed = JSON.parse($src.value);
        if (!parsed || typeof parsed !== 'object') {
          $rawStatus.textContent = 'not an object';
          $rawStatus.className = 'hint error';
          return;
        }
        // Preserve _layout if not present in pasted JSON.
        if (!parsed._layout && wf && wf._layout) parsed._layout = wf._layout;
        // Normalize v2 nodes array → object so the rest of the
        // manager works on either schema.
        if (Array.isArray(parsed.nodes)) {
          parsed.nodes = nodesArrayToObject(parsed.nodes);
        }
        if (!parsed.nodes) parsed.nodes = {};
        wf = parsed;
        render();
        markDirty();
        $rawStatus.textContent = 'tree updated — click Save to persist';
        $rawStatus.className = 'hint ok';
      } catch (e) {
        $rawStatus.textContent = 'parse error: ' + e.message;
        $rawStatus.className = 'hint error';
      }
    });
  }

  // Empty SVG click → deselect + start pan.
  // Phase 5.7.10 — zoom + pan via mouse wheel + drag-on-background.
  let viewBox = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  function applyViewBox() {
    $svg.setAttribute('viewBox',
      `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  }
  let pan = null;
  $svg.addEventListener('mousedown', e => {
    if (e.target === $svg || e.target.classList.contains('canvas-bg')) {
      select(null);
      // Phase 5.7.13 — clicking the canvas background also exits
      // focus mode (visual signal : "I'm done tracing this flow").
      if (document.body.classList.contains('focus-active')) {
        clearFocus();
      }
      // Start pan on background drag.
      pan = { startX: e.clientX, startY: e.clientY,
              vbX: viewBox.x, vbY: viewBox.y };
      $svg.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', e => {
    if (!pan) return;
    const rect = $svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    viewBox.x = pan.vbX - (e.clientX - pan.startX) * scaleX;
    viewBox.y = pan.vbY - (e.clientY - pan.startY) * scaleY;
    applyViewBox();
  });
  window.addEventListener('mouseup', () => {
    if (pan) { pan = null; $svg.style.cursor = ''; }
  });
  $svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = $svg.getBoundingClientRect();
    // Cursor position in viewBox coords (anchor for zoom).
    const cx = viewBox.x + (e.clientX - rect.left) * (viewBox.w / rect.width);
    const cy = viewBox.y + (e.clientY - rect.top) * (viewBox.h / rect.height);
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const nw = Math.max(200, Math.min(8000, viewBox.w * factor));
    const nh = Math.max(150, Math.min(4500, viewBox.h * factor));
    // Keep cursor anchor stationary in world coords.
    viewBox.x = cx - (cx - viewBox.x) * (nw / viewBox.w);
    viewBox.y = cy - (cy - viewBox.y) * (nh / viewBox.h);
    viewBox.w = nw;
    viewBox.h = nh;
    applyViewBox();
  }, { passive: false });
  function resetView() {
    viewBox = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
    applyViewBox();
  }
  const $resetView = document.getElementById('dag-reset-view');
  if ($resetView) $resetView.addEventListener('click', resetView);

  // Phase 5.7.13 — Focus mode. Compute upstream + downstream
  // reachable set from `selected`, dim the rest. Esc / click on
  // canvas-bg exits.
  function computeReachable(role) {
    if (!role || !wf) return new Set();
    const edges = (wf.tree && typeof wf.tree === 'object')
      ? deriveEdgesFromTree(wf)
      : (() => {
          const out = [];
          for (const [from, n] of Object.entries(wf.nodes || {})) {
            for (const to of (n.next || [])) {
              if (wf.nodes[to]) out.push({ from, to });
            }
          }
          return out;
        })();
    const fwd = new Map(); const rev = new Map();
    for (const e of edges) {
      (fwd.get(e.from) || fwd.set(e.from, new Set()).get(e.from)).add(e.to);
      (rev.get(e.to)   || rev.set(e.to, new Set()).get(e.to)).add(e.from);
    }
    const reach = new Set([role]);
    function walk(map, start) {
      const q = [start];
      while (q.length) {
        const k = q.shift();
        const nbrs = map.get(k);
        if (!nbrs) continue;
        for (const n of nbrs) {
          if (reach.has(n)) continue;
          reach.add(n);
          q.push(n);
        }
      }
    }
    walk(fwd, role);
    walk(rev, role);
    return reach;
  }

  function applyFocus(role) {
    const reach = computeReachable(role);
    document.body.classList.add('focus-active');
    for (const [k, entry] of nodeIndex.entries()) {
      if (!entry || !entry.g) continue;
      entry.g.classList.toggle('dimmed', !reach.has(k));
    }
    // Edges : dim if either endpoint is out of the reachable set.
    for (const line of $svg.querySelectorAll('.edge')) {
      const from = line.dataset.from, to = line.dataset.to;
      const dim = !(reach.has(from) && reach.has(to));
      line.classList.toggle('dimmed', dim);
    }
    for (const lbl of $svg.querySelectorAll('.edge-label')) {
      // Edge labels don't carry data-from/to — we just dim along
      // with their parent line via CSS sibling logic (handled below).
      lbl.classList.toggle('dimmed', false);
    }
    setStatus(`focus → ${role} (${reach.size} reachable). Esc to exit.`, 'ok');
  }

  function clearFocus() {
    document.body.classList.remove('focus-active');
    for (const [, entry] of nodeIndex.entries()) {
      if (entry && entry.g) entry.g.classList.remove('dimmed');
    }
    for (const line of $svg.querySelectorAll('.edge.dimmed')) {
      line.classList.remove('dimmed');
    }
  }

  const $focus = document.getElementById('dag-focus');
  if ($focus) {
    $focus.addEventListener('click', () => {
      if (!selected) {
        setStatus('focus : select a node first', 'error');
        return;
      }
      applyFocus(selected);
    });
  }
  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && document.body.classList.contains('focus-active')) {
      clearFocus();
      return;
    }
    // Phase 5.7.14 — Ctrl+Z = undo, Ctrl+Y or Ctrl+Shift+Z = redo.
    // Ignore when focus is in a text field — there the browser's
    // native undo on the input is more useful.
    const inText = ev.target && (
      ev.target.tagName === 'INPUT' ||
      ev.target.tagName === 'TEXTAREA' ||
      ev.target.tagName === 'SELECT'
    );
    if (inText) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' ||
                (ev.shiftKey && ev.key.toLowerCase() === 'z'))) {
      ev.preventDefault();
      redo();
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
        // Phase 5.5g — for v2 workflows the routing lives in the
        // tree, not in node.next ; we look up outgoing edges via
        // the SVG dataset (already wired by render()) instead of
        // re-reading the workflow.
        for (const r of newRecords) {
          flashNode(r.role);
          const rec = r.record || {};
          if (rec.topicOut) flashEdgesFrom(r.role);
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

  // Phase 5.5g — flash every outgoing edge from a role. Used when
  // a record arrives and we don't know the specific target yet
  // (v2 trees have many possible exits — cond branches, fan_out
  // splits — so we just light up all of them when this role
  // forwards).
  function flashEdgesFrom(role) {
    const e = nodeIndex.get(role);
    if (!e) return;
    for (const line of e.edgesFrom) restartFlash(line, 'flash', 1400);
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
  const $dbgMutToggle = document.getElementById('dbg-mutate-toggle');
  const $dbgMutPanel  = document.getElementById('dbg-mutate-panel');
  const $dbgMutData   = document.getElementById('dbg-mutate-data');
  const $dbgMutApplyContinue = document.getElementById('dbg-mutate-apply-continue');
  const $dbgMutApplyStep     = document.getElementById('dbg-mutate-apply-step');
  const $bpSummary    = document.getElementById('bp-summary');
  const $bpList       = document.getElementById('bp-list');
  const $bpCopy       = document.getElementById('bp-copy');
  const $bpClear      = document.getElementById('bp-clear');
  let dbgPollTimer = null;
  let dbgActive = null;  // { session, role } of the currently shown pause
  let dbgPausedRole = null;  // role with the .paused class on DAG, for cleanup
  let lastPauseEnvelope = null;  // for MUTATE prefill (Phase 4.5.7)
  // Client-side breakpoints — set via right-click on a DAG node,
  // persisted in localStorage. Each bp can optionally carry a
  // condition (Phase 4.5.6) :
  //   { role: "xformer", when: "data.amount > 1000" }
  // shift+right-click on a node prompts for the condition. The
  // condition is evaluated client-side when a DEBUG_PAUSE arrives
  // — if false, we silently auto-CONTINUE so the user only sees
  // the pauses that genuinely matter.
  //
  // Stored shape : Map<role, {when?: string}>.
  const BP_STORAGE_KEY = 'pollen-manager:bp';
  let breakpoints = new Map();
  try {
    const stored = localStorage.getItem(BP_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        // Legacy format : plain array of role names (Phase 4.5.3.2).
        for (const r of parsed) breakpoints.set(r, {});
      } else if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          breakpoints.set(k, v || {});
        }
      }
    }
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

  // ── Conditional breakpoint evaluator (Phase 4.5.6, extended in
  // 4.5.8 with compound + membership ops to mirror the workflow
  // `if` cond_eval syntax — same mental model both places).
  //
  // Grammar (recursive descent):
  //   expr   := or
  //   or     := and ('or'  and)*
  //   and    := not ('and' not)*
  //   not    := 'not' not | atom
  //   atom   := '(' expr ')' | leaf
  //   leaf   := path OP value
  //           | path 'in'     '[' value (',' value)* ']'
  //           | path 'not_in' '[' value (',' value)* ']'
  //   path   := IDENT ('.' IDENT)*
  //   OP     := '==' | '!=' | '<' | '>' | '<=' | '>='
  //   value  := NUM | STR | 'true' | 'false' | 'null'
  //
  // Path roots :
  //   data.X         → envelope.data.X (most common)
  //   msg.X / envelope.X → envelope.X
  //   bare X         → envelope.data.X (shorthand)
  //
  // Eval failures (parse error / type mismatch) → TRUE (better to
  // over-pause than to silently skip a pause the operator wanted).
  function tokenizeCond(s) {
    const toks = []; let i = 0;
    const len = s.length;
    while (i < len) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',') {
        toks.push({ k: c, v: c }); i++; continue;
      }
      if (c === '"' || c === "'") {
        const q = c; let j = i + 1; let out = '';
        while (j < len && s[j] !== q) {
          if (s[j] === '\\' && j + 1 < len) { out += s[j + 1]; j += 2; }
          else { out += s[j]; j++; }
        }
        if (j >= len) throw new Error('unterminated string');
        toks.push({ k: 'str', v: out }); i = j + 1; continue;
      }
      const op2 = s.slice(i, i + 2);
      if (op2 === '==' || op2 === '!=' || op2 === '<=' || op2 === '>=') {
        toks.push({ k: 'op', v: op2 }); i += 2; continue;
      }
      if (c === '<' || c === '>') {
        toks.push({ k: 'op', v: c }); i++; continue;
      }
      if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
        const m = s.slice(i).match(/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/);
        if (m && m[0].length > 0 && /\d/.test(m[0])) {
          toks.push({ k: 'num', v: parseFloat(m[0]) });
          i += m[0].length;
          continue;
        }
      }
      if (/[a-zA-Z_]/.test(c)) {
        const m = s.slice(i).match(/^[a-zA-Z_][a-zA-Z_0-9.]*/);
        const w = m[0];
        if (w === 'and' || w === 'or' || w === 'not' || w === 'in' || w === 'not_in') {
          toks.push({ k: 'kw', v: w });
        } else if (w === 'true' || w === 'false') {
          toks.push({ k: 'bool', v: w === 'true' });
        } else if (w === 'null') {
          toks.push({ k: 'null', v: null });
        } else {
          toks.push({ k: 'path', v: w });
        }
        i += w.length;
        continue;
      }
      throw new Error('unexpected character: ' + JSON.stringify(c));
    }
    return toks;
  }

  function parseCond(toks) {
    let i = 0;
    const peek = () => toks[i];
    const eat = (k, v) => {
      const t = toks[i];
      if (!t || t.k !== k || (v !== undefined && t.v !== v)) {
        throw new Error('expected ' + k + (v ? ' ' + v : '')
                        + ' got ' + JSON.stringify(t));
      }
      i++; return t;
    };
    const parseValue = () => {
      const t = peek();
      if (!t) throw new Error('expected value');
      if (t.k === 'num' || t.k === 'str' || t.k === 'bool' || t.k === 'null') {
        i++; return t.v;
      }
      throw new Error('expected value, got ' + JSON.stringify(t));
    };
    const parseLeaf = () => {
      const path = eat('path').v;
      const t = peek();
      if (t && t.k === 'kw' && (t.v === 'in' || t.v === 'not_in')) {
        const kw = eat('kw').v;
        eat('[');
        const values = [];
        if (peek() && peek().k !== ']') {
          values.push(parseValue());
          while (peek() && peek().k === ',') { eat(','); values.push(parseValue()); }
        }
        eat(']');
        return { kind: kw, path, values };
      }
      // Bare path → truthy check (handles `not data.processed` and
      // raw `data.urgent` cases). Recognised when the next token is
      // not a comparison op : end-of-input, a closing paren, a
      // boolean keyword (and / or), or a list-context comma.
      if (!t || t.k === ')' || t.k === ']' || t.k === ','
          || (t.k === 'kw' && (t.v === 'and' || t.v === 'or'))) {
        return { kind: 'truthy', path };
      }
      const op = eat('op').v;
      const rhs = parseValue();
      return { kind: 'cmp', path, op, rhs };
    };
    const parseAtom = () => {
      if (peek() && peek().k === '(') {
        eat('('); const e = parseExpr(); eat(')'); return e;
      }
      return parseLeaf();
    };
    const parseNot = () => {
      if (peek() && peek().k === 'kw' && peek().v === 'not') {
        eat('kw', 'not');
        return { kind: 'not', a: parseNot() };
      }
      return parseAtom();
    };
    const parseAnd = () => {
      let lhs = parseNot();
      while (peek() && peek().k === 'kw' && peek().v === 'and') {
        eat('kw', 'and');
        lhs = { kind: 'and', a: lhs, b: parseNot() };
      }
      return lhs;
    };
    const parseExpr = () => {
      let lhs = parseAnd();
      while (peek() && peek().k === 'kw' && peek().v === 'or') {
        eat('kw', 'or');
        lhs = { kind: 'or', a: lhs, b: parseAnd() };
      }
      return lhs;
    };
    const ast = parseExpr();
    if (i !== toks.length) {
      throw new Error('trailing tokens: ' + JSON.stringify(toks.slice(i)));
    }
    return ast;
  }

  function resolveCondPath(path, envelope) {
    const segs = path.split('.');
    let v;
    if (segs[0] === 'data') v = envelope.data;
    else if (segs[0] === 'msg' || segs[0] === 'envelope') v = envelope;
    else v = envelope.data;
    const start = (segs[0] === 'data' || segs[0] === 'msg' || segs[0] === 'envelope') ? 1 : 0;
    for (let k = start; k < segs.length; k++) {
      if (v == null) return undefined;
      v = v[segs[k]];
    }
    return v;
  }

  function evalCondAst(ast, env) {
    switch (ast.kind) {
      case 'and': return evalCondAst(ast.a, env) && evalCondAst(ast.b, env);
      case 'or':  return evalCondAst(ast.a, env) || evalCondAst(ast.b, env);
      case 'not': return !evalCondAst(ast.a, env);
      case 'truthy': return !!resolveCondPath(ast.path, env);
      case 'cmp': {
        const lhs = resolveCondPath(ast.path, env);
        if (lhs === undefined) return false;  // missing field → no pause
        const rhs = ast.rhs;
        switch (ast.op) {
          case '==': return lhs === rhs;
          case '!=': return lhs !== rhs;
          case '<':  return lhs <  rhs;
          case '>':  return lhs >  rhs;
          case '<=': return lhs <= rhs;
          case '>=': return lhs >= rhs;
        }
        return false;
      }
      case 'in':     {
        const lhs = resolveCondPath(ast.path, env);
        return ast.values.includes(lhs);
      }
      case 'not_in': {
        const lhs = resolveCondPath(ast.path, env);
        return !ast.values.includes(lhs);
      }
    }
    return false;
  }

  // Exported for tests + the modal's live-preview (window-scoped
  // so the page console can poke at it during debugging).
  window.__pollenBpCond = {
    tokenize: tokenizeCond, parse: parseCond,
    evalAst: evalCondAst, resolve: resolveCondPath,
  };

  function evalCondition(exprStr, envelope) {
    if (!exprStr) return true;
    try {
      return evalCondAst(parseCond(tokenizeCond(exprStr)), envelope);
    } catch (e) {
      console.warn('breakpoint cond parse error:', e.message, 'expr:', exprStr);
      return true;  // fail-safe — pause
    }
  }

  // Fire-and-forget DEBUG_CONTINUE for a pause whose condition
  // evaluated false. The pause is silently resolved before the
  // UI ever shows it.
  function autoContinue(session, role) {
    fetch('/api/debug/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, role, cmd: 'DEBUG_CONTINUE' }),
    }).catch(() => { /* silent */ });
  }

  async function pollDebug() {
    try {
      const r = await fetch('/api/debug/pauses');
      if (!r.ok) return;
      const rawList = await r.json();

      // Filter out pauses whose condition evaluates to false —
      // for each, fire a DEBUG_CONTINUE in the background so the
      // Pollen node moves on. Keeps the bar reserved for pauses
      // the operator actually wants to see.
      const list = [];
      for (const p of rawList) {
        const bps = p.raw && p.raw.envelope && p.raw.envelope.debug
                  && p.raw.envelope.debug.breakpoints;
        let cond = null;
        if (Array.isArray(bps)) {
          const match = bps.find(b => b && b.role === p.role);
          if (match && match.when) cond = match.when;
        }
        if (cond && !evalCondition(cond, p.raw.envelope)) {
          autoContinue(p.session, p.role);
          continue;
        }
        list.push(p);
      }

      if (!list.length) {
        if (dbgActive) {
          dbgActive = null;
          $dbgBar.hidden = true;
          $dbgMutPanel.hidden = true;
          lastPauseEnvelope = null;
          clearPausedHighlight();
        }
        return;
      }
      const p = list[0];
      const env = p.raw && p.raw.envelope || {};
      const mid = env.messageId ? env.messageId.slice(0, 8) : '?';
      const topicIn = (env.topic && env.topic.uuid) || '?';
      const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
      const bps = (env.debug && env.debug.breakpoints) || [];
      const myBp = bps.find(b => b && b.role === p.role);
      const condTag = myBp && myBp.when ? ` · cond[${myBp.when}]` : '';
      $dbgInfo.textContent = `${p.role} · session ${p.session} · mid ${mid} · topic ${topicIn}${condTag}${more}`;
      $dbgBar.hidden = false;
      // New pause → close any open mutate panel from a previous one,
      // stash the envelope for the Edit button to prefill.
      const isNewPause = !dbgActive
        || dbgActive.session !== p.session
        || dbgActive.role !== p.role;
      if (isNewPause) $dbgMutPanel.hidden = true;
      lastPauseEnvelope = env;
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

  // ── MUTATE (Phase 4.5.7) ──
  // The "✎ Edit" button toggles a panel under the bar with the
  // current msg.data prefilled into a textarea. Two apply
  // buttons : "Apply & Continue" (mutate + run to next bp / end)
  // and "Apply & Step" (mutate + pause at next hop).
  $dbgMutToggle.addEventListener('click', () => {
    const wasHidden = $dbgMutPanel.hidden;
    $dbgMutPanel.hidden = !wasHidden;
    if (wasHidden && dbgActive) {
      // Prefill the textarea with the current envelope.data on open.
      const cur = lastPauseEnvelope && lastPauseEnvelope.data;
      $dbgMutData.value = JSON.stringify(cur ?? null, null, 2);
      $dbgMutData.focus();
    }
  });
  async function sendMutate(then) {
    if (!dbgActive) return;
    let parsed;
    try { parsed = JSON.parse($dbgMutData.value); }
    catch (e) { setStatus('mutate: data is not JSON: ' + e.message, 'error'); return; }
    const { session, role } = dbgActive;
    setStatus('mutating…');
    try {
      const r = await fetch('/api/debug/cmd', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, role, cmd: 'DEBUG_MUTATE', data: parsed, then }),
      });
      const reply = await r.json();
      if (!r.ok) {
        setStatus(`mutate failed: ${reply.error || r.status}`, 'error');
        return;
      }
      setStatus(`mutate → ${then} (${role})`, 'ok');
      dbgActive = null;
      $dbgBar.hidden = true;
      $dbgMutPanel.hidden = true;
      clearPausedHighlight();
      pollDebug();
    } catch (e) {
      setStatus('mutate error: ' + e.message, 'error');
    }
  }
  $dbgMutApplyContinue.addEventListener('click', () => sendMutate('continue'));
  $dbgMutApplyStep    .addEventListener('click', () => sendMutate('step_over'));

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
  // ── Conditional breakpoint modal (Phase 4.5.8) ──
  // Opens on shift+right-click ; lets the operator write a cond
  // expression with live validation + inline help. Gracefully
  // degrades to a prompt() if the modal markup isn't present in
  // the page yet (e.g. server binary built before this phase).
  const $bpCondModal   = document.getElementById('bp-cond-modal');
  let   bpCondModalReady = false;
  let   $bpCondRole, $bpCondInput, $bpCondStatus, $bpCondApply,
        $bpCondCancel, $bpCondClose, $bpCondRemove, $bpCondBackdrop;
  let   bpCondTargetRole = null;

  function openBpCondModal(name) {
    if (!bpCondModalReady) { openBpCondPromptFallback(name); return; }
    bpCondTargetRole = name;
    const existing = breakpoints.get(name);
    const cur = (existing && existing.when) || '';
    $bpCondRole.textContent = '@' + name;
    $bpCondInput.value = cur;
    $bpCondRemove.hidden = !cur;
    validateBpCond();
    $bpCondModal.hidden = false;
    setTimeout(() => { $bpCondInput.focus(); $bpCondInput.select(); }, 0);
  }

  function openBpCondPromptFallback(name) {
    const existing = breakpoints.get(name);
    const cur = (existing && existing.when) || '';
    const next = prompt(
      `Condition for breakpoint @${name} (leave empty = always pause)\n\n` +
      `Examples :\n` +
      `  data.amount > 1000\n` +
      `  data.user.tier == "vip"\n` +
      `  data.amount > 1000 and data.user.tier == "vip"\n` +
      `  not data.processed\n` +
      `  data.tier in ["vip","gold"]`,
      cur
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === '' && !existing) return;
    breakpoints.set(name, trimmed ? { when: trimmed } : {});
    persistBpUiChange(name);
  }

  function closeBpCondModal() {
    if (!bpCondModalReady) return;
    $bpCondModal.hidden = true;
    bpCondTargetRole = null;
  }

  function validateBpCond() {
    const expr = $bpCondInput.value.trim();
    if (!expr) {
      $bpCondStatus.textContent = 'Empty — breakpoint will pause unconditionally.';
      $bpCondStatus.className = 'bp-cond-status';
      return true;
    }
    try {
      window.__pollenBpCond.parse(window.__pollenBpCond.tokenize(expr));
      $bpCondStatus.textContent = '✓ Syntax OK';
      $bpCondStatus.className = 'bp-cond-status ok';
      return true;
    } catch (e) {
      $bpCondStatus.textContent = '⚠ ' + e.message;
      $bpCondStatus.className = 'bp-cond-status error';
      return false;  // applies anyway — runtime fail-safe pauses
    }
  }

  function applyBpCond() {
    if (!bpCondTargetRole) return;
    const expr = $bpCondInput.value.trim();
    const name = bpCondTargetRole;
    if (expr) {
      breakpoints.set(name, { when: expr });
    } else {
      const existing = breakpoints.get(name);
      if (existing) breakpoints.set(name, {});
      else { closeBpCondModal(); return; }
    }
    closeBpCondModal();
    persistBpUiChange(name);
  }

  function removeBpCond() {
    if (!bpCondTargetRole) return;
    const name = bpCondTargetRole;
    if (breakpoints.has(name)) breakpoints.set(name, {});
    closeBpCondModal();
    persistBpUiChange(name);
  }

  // Common tail after toggle / cond edit — save + refresh DAG class
  // markers + inject hint. Factored so the modal path matches the
  // plain-toggle path.
  function persistBpUiChange(name) {
    saveBreakpoints();
    syncBpSummary();
    const e = nodeIndex.get(name);
    if (e && e.g) {
      e.g.classList.toggle('has-bp', breakpoints.has(name));
      const has = breakpoints.has(name);
      const cond = has && breakpoints.get(name).when;
      e.g.classList.toggle('has-bp-cond', !!cond);
    }
    if (typeof refreshInjectHint === 'function'
        && $injectPanel && !$injectPanel.hidden) {
      refreshInjectHint();
    }
  }

  if ($bpCondModal) {
    $bpCondRole     = document.getElementById('bp-cond-role');
    $bpCondInput    = document.getElementById('bp-cond-input');
    $bpCondStatus   = document.getElementById('bp-cond-status');
    $bpCondApply    = document.getElementById('bp-cond-apply');
    $bpCondCancel   = document.getElementById('bp-cond-cancel');
    $bpCondClose    = document.getElementById('bp-cond-close');
    $bpCondRemove   = document.getElementById('bp-cond-remove');
    $bpCondBackdrop = $bpCondModal.querySelector('.bp-cond-backdrop');
    bpCondModalReady = !!($bpCondRole && $bpCondInput && $bpCondStatus
                          && $bpCondApply && $bpCondCancel
                          && $bpCondClose && $bpCondBackdrop);
    if (bpCondModalReady) {
      $bpCondInput.addEventListener('input', validateBpCond);
      $bpCondApply.addEventListener('click', applyBpCond);
      $bpCondCancel.addEventListener('click', closeBpCondModal);
      $bpCondClose.addEventListener('click', closeBpCondModal);
      $bpCondBackdrop.addEventListener('click', closeBpCondModal);
      if ($bpCondRemove) $bpCondRemove.addEventListener('click', removeBpCond);
      $bpCondInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault(); applyBpCond();
        } else if (e.key === 'Escape') {
          e.preventDefault(); closeBpCondModal();
        }
      });
      document.addEventListener('keydown', e => {
        if (!$bpCondModal.hidden && e.key === 'Escape') {
          e.preventDefault(); closeBpCondModal();
        }
      });
    }
  }

  function toggleBreakpoint(name, opts) {
    // opts.editCondition = true → open the cond modal (or the
    // prompt fallback if the modal markup isn't compiled in yet).
    if (opts && opts.editCondition) {
      openBpCondModal(name);
      return;
    }
    if (breakpoints.has(name)) breakpoints.delete(name);
    else breakpoints.set(name, {});
    saveBreakpoints();
    syncBpSummary();
    const e = nodeIndex.get(name);
    if (e && e.g) {
      e.g.classList.toggle('has-bp', breakpoints.has(name));
      const has = breakpoints.has(name);
      const cond = has && breakpoints.get(name).when;
      e.g.classList.toggle('has-bp-cond', !!cond);
    }
    // Refresh the inject hint if the panel is open. The function
    // is defined later in this IIFE but hoisted (function decl)
    // so we can call it from here.
    if (typeof refreshInjectHint === 'function'
        && $injectPanel && !$injectPanel.hidden) {
      refreshInjectHint();
    }
  }

  function saveBreakpoints() {
    try {
      const obj = Object.fromEntries(breakpoints);
      localStorage.setItem(BP_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore quota errors */ }
  }

  // Comma-joined list of bp roles (used by the [⎘] copy button
  // to assemble the --debug-bp CLI arg). Conditions aren't
  // included since the CLI doesn't yet support them — they only
  // work via the UI inject path (Phase 4.5.6).
  function bpCsv() {
    return [...breakpoints.keys()].join(',');
  }

  // Build the list of bp objects to send via the inject envelope.
  function bpList() {
    const out = [];
    for (const [role, def] of breakpoints) {
      const item = { role };
      if (def && def.when) item.when = def.when;
      out.push(item);
    }
    return out;
  }

  function syncBpSummary() {
    if (breakpoints.size === 0) {
      $bpSummary.hidden = true;
      return;
    }
    $bpSummary.hidden = false;
    const labels = [...breakpoints].map(([role, def]) =>
      def && def.when ? `${role}[${def.when}]` : role);
    $bpList.textContent = labels.join(' ');
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
    if ($injectPanel && !$injectPanel.hidden) refreshInjectHint();
  });

  // Initial sync (in case breakpoints came from localStorage).
  syncBpSummary();

  // ── Inject debug message (Phase 4.5.5) ─────────────────────
  const $injectPanel    = document.getElementById('inject-panel');
  const $injectTarget   = document.getElementById('inject-target');
  const $injectTopic    = document.getElementById('inject-topic');
  const $injectData     = document.getElementById('inject-data');
  const $injectHint     = document.getElementById('inject-mode-hint');
  const $injectSend     = document.getElementById('inject-send');

  function refreshInjectTargets() {
    // Populate target select from wf.nodes that have consumes.
    // (A producer with no consumes can't ACK an incoming message,
    // so it's not a meaningful target. xformer/sink/audit/alerts
    // are the typical candidates.)
    const prev = $injectTarget.value;
    $injectTarget.innerHTML = '';
    if (!wf || !wf.nodes) return;
    for (const [name, n] of Object.entries(wf.nodes)) {
      if (!Array.isArray(n.consumes) || n.consumes.length === 0) continue;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name}  (${n.host || '?'}:${n.port || '?'})`;
      $injectTarget.appendChild(opt);
    }
    if (prev && [...$injectTarget.options].some(o => o.value === prev)) {
      $injectTarget.value = prev;
    }
    refreshInjectTopics();
  }

  function refreshInjectTopics() {
    const target = $injectTarget.value;
    const node = wf && wf.nodes && wf.nodes[target];
    $injectTopic.innerHTML = '';
    if (!node || !Array.isArray(node.consumes)) return;
    for (const t of node.consumes) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      $injectTopic.appendChild(opt);
    }
  }

  function refreshInjectHint() {
    const n = breakpoints.size;
    if (n === 0) {
      $injectHint.textContent = 'No breakpoints set → mode=step (pause at every hop).';
      $injectHint.dataset.kind = 'step';
    } else {
      $injectHint.textContent = `${n} breakpoint(s) → mode=breakpoint (pause only at: ${bpCsv()}).`;
      $injectHint.dataset.kind = 'bp';
    }
  }

  $injectTarget.addEventListener('change', refreshInjectTopics);

  $injectSend.addEventListener('click', async () => {
    const target = $injectTarget.value;
    const topic = $injectTopic.value;
    const node = wf && wf.nodes && wf.nodes[target];
    if (!node) { setStatus('inject: no target selected', 'error'); return; }
    if (!topic) { setStatus('inject: no topic selected', 'error'); return; }
    let data;
    try { data = JSON.parse($injectData.value); }
    catch (e) { setStatus('inject: data is not JSON: ' + e.message, 'error'); return; }
    setStatus('injecting…');
    try {
      const r = await fetch('/api/inject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: node.host || '127.0.0.1',
          port: node.port || 7902,
          topic,
          version: 1,
          data,
          breakpoints: bpList(),
        }),
      });
      const reply = await r.json();
      if (!r.ok) {
        setStatus(`inject failed: ${reply.error || r.status}`, 'error');
        return;
      }
      setStatus(`injected → ${target} · mode=${reply.mode} · mid ${reply.messageId.slice(0,8)}`, 'ok');
    } catch (e) {
      setStatus('inject error: ' + e.message, 'error');
    }
  });

  // The inject panel mirrors the debug-toggle state.
  function syncInjectPanel() {
    if ($dbgToggle.checked) {
      $injectPanel.hidden = false;
      refreshInjectTargets();
      refreshInjectHint();
    } else {
      $injectPanel.hidden = true;
    }
  }
  $dbgToggle.addEventListener('change', syncInjectPanel);

  // Whenever the workflow gets reloaded or saved, the target /
  // topic lists need to refresh too. Hook into pollLive's
  // refresh + the load/save paths via a small observer.
  // (Simplest : refresh on every change of wf.nodes from
  // outside ; toggleBreakpoint and bpClear call refreshInjectHint
  // directly inline since they're already in this scope.)

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
