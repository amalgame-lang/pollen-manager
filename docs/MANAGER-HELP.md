# Pollen Manager — overview

Pollen Manager is the operator console for a [Pollen](https://github.com/amalgame-lang/pollen)
workflow mesh. It edits the `workflow.json` your nodes run, injects
messages, steps through executions with breakpoints, and shows what
the mesh is doing live.

It is a single self-contained binary (a Mosaic web app) — no
database, no external services. State lives in the `sharedDir` your
nodes write to.

## The two modes

The header toggles between two workspaces :

- **Edit** — author the workflow : the DAG canvas, the tree outline
  (`if` / `for` / `while` / `set` / `call` / `fan_out`), the node
  inspector, and Save / Reload.
- **Watch** — observe + drive a running mesh : Live executions, the
  debug pause bar (step / continue / mutate / cancel), and the
  Inject panel.

## Header controls

| Control | What it does |
|---------|--------------|
| Edit / Watch | switch workspace |
| ⏸ Debug | start/stop polling the `:3001` debug bridge for paused nodes |
| BP: chips | breakpoints you've set ; click a chip to add/edit a condition (see [Conditional breakpoints](conditional-breakpoints.md)) |
| ⚙ Settings | view the manager's runtime config |
| 🗺 Infra | declared servers + actions and live node discovery |
| ? Help | this help |

## Typical loops

**Author a workflow** — Edit mode → add nodes on the DAG → wire the
tree (`+ call`, `+ if`, `+ for`, …) → Validate → Save. The file is
written to `WORKFLOW_PATH` ; nodes hot-reload it within ~2s.

**Drive a run** — start your nodes (each `--workflow <path>
--node-name <role> --shared-dir <dir>`), turn on ⏸ Debug, set a
breakpoint or a condition on a node, then Inject a message. The
matching node pauses ; step / continue / edit the payload from the
debug bar.

**Watch live** — the Live executions panel reads the
`executions/<mid>-<role>.json` records each node writes per hop and
reconstructs the chain by `parentMessageId`.

## Configuration

All settings come from environment variables read at launch (see the
⚙ Settings panel for the live values) :

| Env | Default | Purpose |
|-----|---------|---------|
| `WORKFLOW_PATH` | `/tmp/pollen-demo.json` | the workflow the manager edits + serves |
| `SHARED_DIR` | `/tmp/pollen-shared` | where nodes write `executions/`, `state/`, `capabilities/` |
| `DEBUG_MANAGER` | `127.0.0.1:3001` | host:port paused nodes phone home to |
| `EXEC_RETENTION_MIN` | `60` | minutes before Cleanup purges execution records |

## Related docs

- [Conditional breakpoints](conditional-breakpoints.md) — pause only
  when an expression on the message is true.
- [Workflow tree (v2)](workflow-tree.md) — the `workflow.json` schema
  the Edit mode authors.
- [Infrastructure & discovery](infrastructure.md) — declare servers +
  actions, and see which nodes are alive.

## Powered by the package

Under the hood the manager talks to nodes built on the
[`amalgame-pollen`](https://github.com/amalgame-lang/amalgame-pollen)
package : `Pollen.PublishDebug` builds the inject envelope, and nodes
run the same workflow-tree engine (`if` / `set` / `for` / `while`) the
Edit mode authors.
