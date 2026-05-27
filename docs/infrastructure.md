# Infrastructure & discovery

The Infra view answers two questions about the mesh :

1. **What *should* exist** — the servers + actions you *declare* in
   `infrastructure.json` (the declarative half).
2. **What *is alive* right now** — the nodes that have *advertised*
   themselves under `<sharedDir>/capabilities/` (the auto-discovery
   half).

The panel shows both side by side : *"N declared, M alive"*. This is
the operator-facing slice of the capability / load-balancing design
(Pollen Phase 6).

## Why two halves

`workflow.json` is **zero-coupling to infra** : its tree names
*actions* (or roles), never machines. The binding *action → which
machine runs it* is resolved at runtime against the live registry.
That keeps the workflow portable while the infra underneath scales,
moves, or fails over.

- The **declarative** manifest is the spec : it's what you intend to
  run, with the adapter details (how each action actually executes).
- **Auto-discovery** is the truth : each node rewrites its capability
  file every few seconds with its load + heartbeat ; a file not
  refreshed within ~15s marks that node dead.

## `infrastructure.json`

Sits next to `workflow.json` (override with `INFRA_PATH`). Schema :

```json
{
  "servers": {
    "worker-1": {
      "host": "10.0.0.10",
      "port": 7902,
      "actions": ["transcode-video", "transcribe-audio"],
      "capacity": 4
    },
    "api-gw": {
      "host": "10.0.0.20",
      "actions": ["fetch-user", "send-slack"]
    }
  },
  "actions": {
    "transcode-video": {
      "type": "bash",
      "cmd": "ffmpeg -i {input} -c:v libx264 {output}",
      "timeout_s": 300
    },
    "fetch-user": {
      "type": "http",
      "method": "GET",
      "url": "https://api.acme.com/users/{id}",
      "headers": { "Authorization": "Bearer ${env.TOKEN}" }
    },
    "send-slack": {
      "type": "http", "method": "POST",
      "url": "https://hooks.slack.com/...",
      "body_template": "..."
    }
  }
}
```

### Action adapter types (planned)

| `type` | Fields | What it does |
|--------|--------|--------------|
| `http` | method, url, headers, body_template | REST/HTTP call |
| `bash` | cmd, timeout_s | shell exec with stdin/stdout/stderr capture |
| `tcp`  | host, port, send_template | raw TCP send/recv |
| `db_query` | dsn, sql | SQL query |
| `file_write` / `file_read` | path | filesystem |
| `mail` | smtp config | send email |

`{placeholders}` interpolate from the message (`{input}` ←
`msg.data.input`), `${env.X}` from the node's environment.

## Capability files (auto-discovery)

Each node writes `<sharedDir>/capabilities/<instanceId>.json` every
~5s :

```json
{
  "instanceId": "<uuid>",
  "host": "192.168.1.10", "port": 7902, "label": "worker-3",
  "actions": ["encode-video", "decode-video"],
  "load": { "encode-video": { "inFlight": 3, "lastMinuteMsgs": 124, "p99Ms": 230 } },
  "system": { "cpuPct": 42.1, "memPct": 18.3, "uptimeS": 86400 },
  "heartbeat": 1779716180474,
  "version": "v0.2.0-dev"
}
```

The manager's `/api/capabilities` lists these with a server-side
`now` so the UI can flag staleness without clock skew.

## Load balancing + failover (Phase 6, runtime side)

Once nodes advertise, the runtime resolves `action → instance` by
**power-of-two-choices** : pick 2 candidates at random, send to the
one with fewer `inFlight`. Failure detection is belt-and-braces :
heartbeat staleness (15s) + reactive TCP failover (retry the 2nd
candidate on connect/ACK failure). This is **emergent** LB + HA — no
config, just the discovery mechanic + a sharedDir.

## Status

- **Manager side** : declares + visualises. Editing
  `infrastructure.json` + the live discovery overview both work.
- **Node side — capability writer** : ✅ shipped in
  `amalgame-pollen` v0.1.13. `Pollen.StartCapabilityWriter(label,
  host, port)` spawns a thread that rewrites the node's capability
  file every 5s ; `examples/pollen-node` calls it when a shared dir
  is set, so a package-driven mesh self-advertises and the *alive*
  column populates with green/stale badges.
- **Node side — LB resolver + failover** : Phase 6.3+ (power-of-two
  choices on `inFlight`, TCP failover). Not yet built — routing
  still targets explicit roles, not abstract actions.
