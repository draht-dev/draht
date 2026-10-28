---
name: judge
description: The judge queue — a human-judgment TUI that reviews the gates an agent writes, replaying each new test to show whether it can actually fail before the implementation is written. Use when the user asks to open, start, or check judge, asks why an edit was held or denied, asks how good the project's tests are as gates, or when a "[judge]" feedback block appears in context.
---

# judge

`judge` reviews **gates**: the tests a session writes to constrain itself. A test the agent wrote is a claim, not evidence — the same process that can get the code wrong wrote the check that is supposed to catch it. This queue turns the claim into evidence wherever a machine can, and puts one question to the human: is this the right thing to gate, and is the bar high enough.

It cannot run inside an agent session — it needs its own terminal pane.

## When the user asks to open it

Run this immediately (no confirmation) and report the one-line result:

    judge open

That pops a new cmux split to the right with the TUI running. If it prints that cmux is not found, tell the user to run `judge` in any other terminal pane. If it says "already running", say so.

If `judge` is not on PATH, the same binary ships with this plugin at `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/judge` — run it by path, and tell the user the plugin installer can link it onto PATH for them.

Other commands: `judge list` (the open queue), `judge gates` (the ledger: every judged gate, its mutation kill rate, the recurring smells), `judge clear` (expire every open card).

## What a gate card is

Two stages, because the two questions can only be answered at different moments.

**RED** — a test was written and the session is now reaching for the implementation. The test is replayed against the code as it stands, in a throwaway worktree, and the result is on the card:

- *fails on an assertion* — a real red. The test knows what wrong behaviour looks like.
- *fails on an import or compile error* — a weak red. It proves a module is missing, not that behaviour is checked.
- *PASSES without the implementation* — not a gate at all. This one is denied without asking anyone: a test that already passes cannot fail when the implementation about to be written is wrong, whatever it turns out to be.

A test written for behaviour that already exists is a different case, and is not treated as a lie: with no implementation coming, passing is the expected result, so it is carded as *already-green* at the end of the turn and nothing is held.

**GREEN** — the implementation landed and the test passes. Single-token mutations are applied to the source lines the change touched (comparisons flipped, boolean operators swapped, literals bumped) and the test is re-run against each. A mutation the test does not notice is a survivor, and a gate whose survivors outnumber its kills does not bite. Mutants that fail to compile are discarded rather than counted as caught.

Both stages also carry static smells that no run can excuse: assertions only about mocks being called, a snapshot as the sole assertion, no assertion at all, a tautology, a skipped or `.only` test, reaching into private internals, an empty catch swallowing the failure.

## What a verdict does

A gate is held while it is judged, so:

- **real gate →** the edit proceeds; the gate is recorded for the mutation pass once the implementation lands.
- **weak gate ←** the edit is denied and the session receives the evidence plus the reviewer's comment. Address it by strengthening the test — assert the behaviour that would actually break — and do not write the implementation until the gate would catch a wrong one. If the reject carried no comment, work out from the evidence why the gate is too weak and say what you think was wrong before changing it.

When you see a `[judge]` block, that is the human's verdict on the gate you just wrote. It comes before everything else you were doing.

## What stays out of the way

Nothing is gated unless the TUI is running: with judge closed, edits proceed and the host's own permission dialog behaves exactly as it did before. Permission prompts and finished turns still queue as their own card kinds. A repo with no runnable test command, no git, or a suite that will not start produces a card with less evidence on it — never a blocked session.

Per-repo settings live under `"gates"` in `.planning/config.json`: `enabled`, `testCommand` (with `{file}` substituted), `timeout`, `mutants`, `budget`. `JUDGE_GATES=0` in the environment turns the whole thing off.

## State

Everything lives under the host config dir, in `$CLAUDE_CONFIG_DIR/judge`: `cards` for the queue, `inbox/<session>` for undelivered feedback, `sessions` for which tests are still unjudged, `gates.jsonl` for the ledger, and `heartbeat`, touched once a second while the TUI runs. The draht status line reads the same directory to show its `⚖ N` segment.
