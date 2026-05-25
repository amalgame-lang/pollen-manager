# Pollen Manager

> Phase 4.0 scaffold (v0.1.0-dev) — Mosaic web app for the
> [Pollen](https://github.com/amalgame-lang/pollen) P2P message bus.

Pollen Manager is the WYSIWYG **workflow.json designer** + live
**executions dashboard** for a Pollen network. It is a Mosaic
application that reads/writes the `workflow.json` file Pollen
nodes self-identify against (Pollen Phase 3.0+) and surfaces the
`sharedDir/executions/` records each node writes (Pollen Phase
3.5+).

It is **not** a control plane: Pollen stays choreography-based
(every node knows its part). The manager just edits the
choreography sheet and visualises live runs.

## Running locally

```sh
amc package add web net-http tls crypto    # one-shot install
WORKFLOW_PATH=/tmp/pollen-wf.json SHARED_DIR=/tmp/pollen-shared mosaic dev
```

Open <http://localhost:3000>. With `mosaic dev`, every edit under
`app/` and `server.am` triggers a rebuild + live-reload.

> **⚠ Build blocker (2026-05-25):** the scaffold currently fails
> to link because `amc package add` + `mosaic build` only compile
> each package's `facade.am` into its `.a` archive, missing the
> classes defined in sibling `sources = [...]` files
> (`WebApp`, `Static`, `Session` in amalgame-web, etc.). Tracked
> upstream; the `mosaic-fs-demo` example hits the same wall in
> a fresh build. Resolution path: have the package builder
> compile every file listed in `sources` together, not just
> `facade.am`. Once that lands, Pollen Manager builds clean
> and we can iterate on the editor.

## MVP surface (Phase 4.0)

| Route | Verb | Purpose |
|---|---|---|
| `/` | GET | Landing page: read-only SVG render of the DAG + JSON textarea editor. |
| `/api/workflow` | GET | Returns the current `workflow.json` body verbatim. |
| `/api/workflow` | PUT | Validates JSON syntax, writes to `$WORKFLOW_PATH`. Pollen nodes' Phase 3.3 watcher picks the change up within ~2 s. |
| `/api/executions` | GET | Lists `$SHARED_DIR/executions/<mid>-<role>.json` as `[{file, messageId, role}]`. |

The DAG render uses a trivial column layout (producers left,
sinks right) — fine for read-only viewing. **Drag-and-drop node
positioning is Phase 4.1.**

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WORKFLOW_PATH` | `/tmp/pollen-wf.json` | The workflow.json the manager reads/writes. Should match what every Pollen node passes via `--workflow`. |
| `SHARED_DIR` | `/tmp/pollen-shared` | The directory every Pollen node points to via `--shared-dir`. The manager looks under `<dir>/executions/` for live records. |

## Phase 4 roadmap

| Phase | Scope |
|---|---|
| **4.0** ✅ | API endpoints + SVG render + JSON textarea editor (this scaffold). |
| 4.1 | SVG-based drag-and-drop WYSIWYG: move nodes, draw edges to set `next`, edit a side panel for `consumes`/`emits`. Persist user-controlled positions in a sidecar `_layout` key inside workflow.json (Pollen ignores it). |
| 4.2 | Live executions dashboard: poll `/api/executions`, overlay each record's status onto the DAG, drill-down on a record to read its JSON. |
| 4.3 | SYNC broadcast on save: today we trust the Phase 3.3 mtime watcher (≤2 s lag). 4.3 sends an explicit SYNC TCP packet to each node listed in the workflow so the reload is instant. |
| 4.4 | Manual intervention: force-ACK, replay, cancel an in-flight chain. Requires a new pollen-node-tcp endpoint to receive the commands — coordinate with Pollen Phase 3.x+. |

## Project layout

```
pollen-manager/
├── amalgame.toml         # web + net-http + tls + crypto
├── server.am             # WebApp.Serve(3000)
├── app/
│   ├── index.am          # GET /  → editor page
│   └── api/
│       ├── info.am       # GET /api/info     (build sanity)
│       ├── workflow.am   # GET, PUT /api/workflow
│       └── executions.am # GET /api/executions
├── public/
│   ├── style.css         # pollen yellow theme
│   └── manager.js        # editor + DAG renderer (vanilla JS)
└── README.md
```

## License

Apache 2.0.
