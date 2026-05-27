# Conditional breakpoints

The DAG view's breakpoints can be unconditional ("pause every time this
node sees a message") or **conditional** ("pause only when this
expression is true on the message envelope"). Conditional pauses are
the equivalent of Visual Studio's *Hit Count* / *Conditional Expression*
on a breakpoint — useful when a workflow runs millions of messages and
you only care about a handful.

## Setting a condition

1. Right-click the DAG node to toggle the breakpoint on (no
   condition). A red "BP:" summary chip appears in the toolbar
   for each role with a breakpoint set.
2. **Click the chip** in the BP summary bar to open the
   *Breakpoint condition* modal for that role. Universal across
   browsers — no modifier-key juggling needed. Chips without a
   condition are red ; chips with a condition turn blue and
   show the condition text inline.
3. Type an expression, press *Apply* (or `Ctrl+Enter`). The
   status line below the textarea validates syntax live.
4. Press *Cancel* / `Esc` to leave the existing condition
   untouched. Press *Remove condition* to keep the breakpoint
   but drop its condition (back to "always pause").

*Power-user shortcut* : `Alt+RightClick` on a node opens the
modal directly (skips the click-the-chip step). Works on
Chromium ; Firefox routes shift+right-click to the native menu,
but alt+right-click usually passes through. The click-the-chip
flow is the reliable cross-browser path.

The condition is stored client-side in `localStorage`, replayed
into the next `--debug-bp` argument the *Inject* panel emits.

## How evaluation flows

The pollen binary itself does **not** evaluate the condition — it
sends the pause notification with the full envelope to the manager's
`:3001` debug bridge. The manager polls `/api/debug/pauses` once per
tick ; for each pause it reads `envelope.debug.breakpoints[i].when`,
evaluates it in JavaScript, and either :

- shows the pause in the UI (condition was `true` or absent), or
- silently fires `DEBUG_CONTINUE` for that pause (condition was
  `false` — the pollen node moves on without the operator noticing).

Conditions therefore add zero binary-side overhead — the cost is one
JS expression evaluation per pause arrival in the manager.

## DSL grammar

```text
expr   := or
or     := and ('or'  and)*
and    := not ('and' not)*
not    := 'not' not | atom
atom   := '(' expr ')' | leaf
leaf   := path OP value
        | path 'in'     '[' value (',' value)* ']'
        | path 'not_in' '[' value (',' value)* ']'
        | path                                        // truthy check
path   := IDENT ('.' IDENT)*
OP     := '==' | '!=' | '<' | '>' | '<=' | '>='
value  := NUM | STR | 'true' | 'false' | 'null'
```

Keywords are lowercase. Strings can use `"` or `'`. Whitespace is
flexible.

## Path roots

| Form          | Resolves to                       |
|---------------|-----------------------------------|
| `data.X`      | `envelope.data.X` (the payload)   |
| `msg.X`       | `envelope.X` (any envelope field) |
| `envelope.X`  | `envelope.X` (alias of `msg.X`)   |
| Bare `X`      | `envelope.data.X` (shorthand)     |

So `messageId`, `topic.uuid`, `topic.version`, `rootMessageId`,
`parentMessageId`, `timestamp` are all reachable through `msg.` /
`envelope.`. `data.` is the standard prefix for the user-supplied
payload.

## Examples

```text
# Pause only on large amounts
data.amount > 1000

# Pause on VIP customers
data.user.tier == "vip"

# Pause when both conditions hold
data.amount > 1000 and data.user.tier == "vip"

# Pause on either of two markers
data.urgent == true or data.amount > 5000

# Pause unless already processed (bare path = JS truthy check)
not data.processed

# Pause only when a flag is set (truthy)
data.urgent

# Pause on a set of values
data.user.tier in ["vip","gold","platinum"]

# Pause on anything except the happy path
data.status not_in ["ok","success"]

# Parenthesised groups
(data.a == 1 or data.a == 2) and data.b > 0

# Envelope-side fields (not payload)
msg.topic.version >= 2
envelope.topic.uuid == "user.signup.completed"
```

## Semantics

| Situation                  | Result        |
|----------------------------|---------------|
| Empty expression           | Always pause  |
| Parse error                | Pause (fail-safe — better to over-pause than miss) |
| Path resolves to undefined | `false` (no pause) — missing fields don't trip the breakpoint |
| Type mismatch (`"abc" > 1`)| JS comparison falls through ; usually evaluates `false` |
| `null` value vs `null`     | `==` returns `true` only for explicit `null === null` |

## Operators

| Op       | Meaning                            | Works on        |
|----------|------------------------------------|-----------------|
| `==`     | Strict equality (JS `===`)         | Any             |
| `!=`     | Strict inequality                  | Any             |
| `<` `<=` | Less-than (numeric or lexicographic) | Numbers, strings |
| `>` `>=` | Greater-than                       | Numbers, strings |
| `and`    | Short-circuit logical AND          | Booleans        |
| `or`     | Short-circuit logical OR           | Booleans        |
| `not`    | Logical negation                   | Booleans        |
| `in`     | Membership in a literal list       | Any vs list     |
| `not_in` | Negated membership                 | Any vs list     |

## Limits today

- **No `state.X` access.** The evaluator only sees the envelope as
  received by the manager — it does not consult
  `sharedDir/state/<rootMid>.json`. Add the state file value to your
  envelope's `data` if you need to branch on it (a `set` step in the
  workflow can copy state → data before reaching the breakpoint).
- **No arithmetic** in the cond (`>=` against a literal, not
  `data.amount * 2 > 1000`). Add a `set` step upstream to compute
  the value into `data.X` and condition on `data.X`.
- **No regex / startsWith / contains** for strings. Use `in [...]`
  for finite sets, or pre-compute a boolean in a `set` step.

## Keyboard shortcuts

| Shortcut       | Action                            |
|----------------|-----------------------------------|
| Click the BP chip          | **Open the cond modal (universal)** |
| RightClick on node         | Toggle BP (no condition) |
| Alt+RightClick on node     | Open the cond modal (browser-dependent shortcut) |
| `Ctrl+Enter` (in textarea) | Apply                  |
| `Esc`          | Cancel                            |

## Relationship to the workflow `if` evaluator

The DSL is a **deliberate subset** of the workflow-tree `if`
condition language (`Pollen.EvalCond` in the `amalgame-pollen`
package). Same operators, same membership ops, same compound
keywords. Two differences :

- The workflow form is JSON
  (`{"op":">","var":"data.amount","value":1000}`).
  Breakpoint conditions are text — easier to type in a UI textarea.
- The workflow form evaluates server-side against the live envelope
  **plus** the state file (`state.X` paths supported).
  Breakpoint conditions evaluate client-side against the envelope
  alone.

If a breakpoint condition you've written turns out to be more useful
as a permanent workflow branch, copy it into an `if` step — the
operator-facing semantics match.
