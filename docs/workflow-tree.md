# Workflow tree (v2)

`workflow.json` describes the mesh : the **nodes** (roles + where
they listen) and the **tree** (the control flow that routes a message
from role to role). Pollen Manager's Edit mode authors this file ;
nodes load it and route accordingly.

## Top-level shape

```json
{
  "schema": "workflow-tree/v1",
  "name":   "my-workflow",
  "version": 1,
  "nodes": {
    "<role>": { "host": "127.0.0.1", "port": 8000,
                "consumes": ["topic.in"], "emits": ["topic.out"],
                "group": "optional-ui-group" }
  },
  "tree": { "type": "sequence", "steps": [ ... ] },
  "_layout": { "<role>": { "x": 120, "y": 90 } }
}
```

- **nodes** can be an object keyed by role id **or** an array of
  `{ "id":…, "label":…, … }` entries (the form the manager's Save
  writes). The reference node + the manager both accept either ;
  in the array form the role is the `label` (falling back to `id`).
  Each node declares the topics it `consumes` and the topic it
  `emits` (first entry is the forward topic).
- **tree** is the routing program. **_layout** is cosmetic (DAG
  positions), ignored by the runtime.

## Step types

| Step | Shape | Routing |
|------|-------|---------|
| `call` | `{ "type":"call", "node":"<role>" }` | forward to one role |
| `fan_out` | `{ "type":"fan_out", "nodes":["a","b"] }` | forward to several |
| `if` | `{ "type":"if", "branches":[ {cond, then}, {then} ] }` | first matching branch wins ; last branch with no `cond` is the else |
| `set` | `{ "type":"set", "path":"state.x", "value":<expr> }` | mutate per-execution state before routing |
| `for` | `{ "type":"for", "var":"item", "in":[...], "do":<step> }` | fan out one message per item, with `state.<var>` set |
| `while` | `{ "type":"while", "cond":<expr>, "maxIter":N }` | self-loop until cond false or maxIter |
| `sequence` | `{ "type":"sequence", "steps":[...] }` | run steps in order |

### Conditions (`cond`)

Same grammar as the breakpoint DSL, but as JSON :

```json
{ "op": ">", "var": "data.amount", "value": 1000 }
{ "op": "and", "args": [ {...}, {...} ] }
{ "op": "not", "arg": {...} }
{ "op": "in", "var": "data.tier", "values": ["vip","gold"] }
```

Leaf ops : `==` `!=` `<` `>` `<=` `>=`. Composite : `and` `or` `not`.
Membership : `in` `not_in`. Paths : `data.X` (the payload) or
`state.X` (the per-execution state file).

### Expressions (`set` values)

```json
{ "const": 7 }
{ "var": "data.qty" }
{ "op": "+", "left": {"var":"state.count"}, "right": {"const":1} }
```

Arithmetic ops `+ - * /` over numbers. A missing `var` reads as 0
(so a counter increment from absent → 1 works).

## Example

```json
{
  "schema": "workflow-tree/v1",
  "name": "orders",
  "version": 1,
  "nodes": {
    "ingest":   { "host":"127.0.0.1","port":8000,"consumes":["order.in"],"emits":["order.routed"] },
    "vip":      { "host":"127.0.0.1","port":8002,"consumes":["order.routed"] },
    "standard": { "host":"127.0.0.1","port":8003,"consumes":["order.routed"] }
  },
  "tree": { "type":"sequence", "steps":[
    { "type":"call", "node":"ingest" },
    { "type":"if", "branches":[
        { "cond":{"op":">","var":"data.amount","value":1000},
          "then":{"type":"call","node":"vip"} },
        { "then":{"type":"call","node":"standard"} }
    ] }
  ] }
}
```

`amount=1500 → vip`, `amount=50 → standard`.

## Reference-node caveats (M3.x)

The package reference node (`examples/pollen-node.am`) currently
walks the **top-level sequence** and resolves `if` / `for` / `while`
branch targets one level deep (the `then` / `do` must be a `call` /
`fan_out`, or a sequence whose first dispatchable step is). Deeply
nested trees (an `if` inside a `for` inside an `if` …) are not yet
fully resolved — that's a planned extension. The legacy
`pollen-node-tcp` binary handled more nesting but mis-evaluated
`if` conditions (always took branch 0) ; the package fixes the
evaluation.
