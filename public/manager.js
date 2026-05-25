// Pollen Manager — client logic.
//
// Phase 4.0 MVP: fetch workflow.json, render a read-only DAG into
// the SVG, populate the textarea. On Save, PUT the textarea body
// back to /api/workflow and re-render. The actual drag-and-drop
// (Phase 4.1) will replace the layout() function with positions
// the user moved + persist them in workflow.json under a
// `_layout` sidecar key.

(() => {
  const $src = document.getElementById('src');
  const $svg = document.getElementById('dag');
  const $status = document.getElementById('status');
  const $save = document.getElementById('save');

  function setStatus(msg, kind) {
    $status.textContent = msg;
    $status.className = kind || '';
  }

  async function load() {
    setStatus('loading…');
    try {
      const r = await fetch('/api/workflow');
      const txt = await r.text();
      if (!r.ok) {
        setStatus('GET /api/workflow → ' + r.status, 'error');
        $src.value = txt;
        return;
      }
      $src.value = txt;
      render(JSON.parse(txt));
      setStatus('loaded · ' + txt.length + ' bytes', 'ok');
    } catch (e) {
      setStatus('load failed: ' + e.message, 'error');
    }
  }

  async function save() {
    setStatus('saving…');
    try {
      JSON.parse($src.value);
    } catch (e) {
      setStatus('JSON syntax error: ' + e.message, 'error');
      return;
    }
    try {
      const r = await fetch('/api/workflow', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: $src.value,
      });
      const reply = await r.json();
      if (!r.ok) {
        setStatus('PUT failed: ' + (reply.error || r.status), 'error');
        return;
      }
      setStatus('saved → ' + reply.path + ' (' + reply.bytes + ' bytes ; nodes reload within ~2s)', 'ok');
      render(JSON.parse($src.value));
    } catch (e) {
      setStatus('save failed: ' + e.message, 'error');
    }
  }

  // Trivial column layout: producers (no consumes) on the left,
  // sinks (no emits) on the right, everything else in the middle
  // ranked by edge depth. Good enough for read-only viewing in
  // 4.0; 4.1 swaps in user-controlled positions.
  function layout(wf) {
    const nodes = wf.nodes || {};
    const keys = Object.keys(nodes);
    if (!keys.length) return { positions: {}, edges: [] };

    // Build forward edges (next).
    const edges = [];
    for (const k of keys) {
      const n = nodes[k] || {};
      for (const tgt of (n.next || [])) {
        if (nodes[tgt]) edges.push({ from: k, to: tgt });
      }
    }

    // Rank by longest path from any root.
    const indeg = Object.fromEntries(keys.map(k => [k, 0]));
    for (const e of edges) indeg[e.to]++;
    const rank = {};
    const queue = keys.filter(k => indeg[k] === 0);
    queue.forEach(k => rank[k] = 0);
    while (queue.length) {
      const k = queue.shift();
      for (const e of edges) {
        if (e.from === k) {
          const next = Math.max(rank[e.to] || 0, (rank[k] || 0) + 1);
          if (next !== rank[e.to]) {
            rank[e.to] = next;
            queue.push(e.to);
          }
        }
      }
    }
    keys.forEach(k => { if (rank[k] === undefined) rank[k] = 0; });

    // Column layout.
    const cols = {};
    for (const k of keys) {
      const r = rank[k];
      cols[r] = cols[r] || [];
      cols[r].push(k);
    }
    const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);
    const W = 800, H = 360, padX = 80, padY = 50;
    const stepX = colKeys.length > 1 ? (W - 2 * padX) / (colKeys.length - 1) : 0;
    const positions = {};
    for (let ci = 0; ci < colKeys.length; ci++) {
      const col = cols[colKeys[ci]];
      const stepY = col.length > 1 ? (H - 2 * padY) / (col.length - 1) : 0;
      for (let i = 0; i < col.length; i++) {
        positions[col[i]] = {
          x: padX + ci * stepX,
          y: col.length === 1 ? H / 2 : padY + i * stepY,
        };
      }
    }
    return { positions, edges };
  }

  function render(wf) {
    const { positions, edges } = layout(wf);
    const parts = [];
    parts.push(
      '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
      'markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="#888"/></marker></defs>'
    );
    for (const e of edges) {
      const a = positions[e.from], b = positions[e.to];
      if (!a || !b) continue;
      parts.push(
        `<line class="edge" x1="${a.x + 50}" y1="${a.y}" x2="${b.x - 50}" y2="${b.y}"/>`
      );
    }
    const nodes = wf.nodes || {};
    for (const [k, p] of Object.entries(positions)) {
      const n = nodes[k] || {};
      const port = n.port || '?';
      parts.push(
        `<rect class="node-rect" x="${p.x - 50}" y="${p.y - 22}" width="100" height="44" rx="6"/>`,
        `<text class="node-label" x="${p.x}" y="${p.y - 2}">${escapeXml(k)}</text>`,
        `<text class="node-meta"  x="${p.x}" y="${p.y + 14}">:${port}</text>`,
      );
    }
    $svg.innerHTML = parts.join('');
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&"]/g, c => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
    ));
  }

  $save.addEventListener('click', save);
  load();
})();
