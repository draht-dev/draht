---
title: "Polyphase — see what every agent is doing"
description: "Draht's latest work on main adds live agent oversight, scriptable workflows, and saved commands for repeatable multi-agent tasks."
date: "2026-10-12"
author: "Oskar Freye"
tags: ["update", "agents", "workflow", "polyphase"]
---

When a coding agent delegates work, you need to know what its children are doing. Which model is reviewing the change? Is the investigator still running, waiting for a slot, or blocked on a tool call? What did the failed agent actually return?

**Polyphase** adds that view to draht. It also adds a workflow tool for coordinating agents in JavaScript and saved workflows you can run as commands. These changes are on main and shipped in **v2026.10.8-1**, as recorded in the [coding-agent changelog](https://github.com/draht-dev/draht/blob/main/packages/coding-agent/CHANGELOG.md).

## Follow the work while it runs

Subagent and workflow calls now show a line for each agent in the terminal transcript: its model, state, and current activity. Expand the tool block to see task text, tool-call counts, and the live transcript tail. Chains show which step is running and which steps are waiting; workflows group agents under their phases.

A dock above the editor summarizes active runs, queued agents, failures, and cost. Open the inspector with `alt+a` to follow an individual agent's thinking, text, and tool calls. On wider terminals, the agent list and selected transcript appear side by side. The bindings are configurable.

You can cancel one agent or the entire run from the inspector. Cancellation takes two presses of the same key, so a single stray keystroke does not stop the work.

## Describe a workflow, then inspect its execution

Include `polyphase` in a normal prompt to enable the workflow tool for that turn:

```text
polyphase: investigate the checkout flow, review error handling and
idempotency in parallel, then synthesize the findings. Do not edit files.
```

Draht gives the model the workflow authoring guide. The model can then write a JavaScript script that declares phases and starts agents through `agent()`.

The script controls the order of work. `parallel()` waits for a group of tasks before advancing. `pipeline()` lets each item move through its stages without waiting for every other item at a barrier. `phase()` groups work in the live view, and `log()` adds a visible progress line.

The orchestration script has no filesystem or network access of its own. The agents it starts do the work. An `agent()` call can request schema-validated output, making the next step consume a checked object instead of trying to interpret free text. Failed, cancelled, or invalid structured results return `null`; scripts must handle that case explicitly.

## Save the procedure as a command

Once a workflow is useful, save it as a `.js` file. User workflows live in `~/.draht/agent/workflows`; project workflows live in `.draht/workflows` and require project trust.

A saved workflow named `review-checkout.js` can run with:

```text
/review-checkout inspect retries and duplicate payment requests
```

Or invoke it explicitly:

```text
/workflow review-checkout inspect retries and duplicate payment requests
```

The explicit form also works when the name collides with an existing command. `/workflows` opens the runs view in the TUI and lists workflows as plain text outside it.

Saved commands run the existing script directly. Their result is appended to the conversation without automatically starting another model turn. The next time you prompt the model, it can use that result.

## Models, limits, and results stay visible

Agents without a model override now inherit the parent session's model and thinking level. A call, workflow phase, or agent definition can choose a different model. That makes model selection explicit at the point where the work needs it.

Subagent calls, workflows, and duet triage share a session-wide child concurrency limit. Workflow runs can also have token budgets and deadlines. Token budgets can overshoot by an in-flight response per active agent; they are a bound on execution, not an exact spending cutoff.

Results returned to the parent model are bounded. Parallel results preserve each agent's head and tail, including its `STATUS:` line, and failures include a stderr tail. Tool-driven agent usage counts toward session cost. Saved command runs show their own usage in the dock, inspector, and result message; those totals are not added to the session footer.

Final summaries persist with the session. Live transcripts remain in memory while a run is available; resuming a session restores the saved summary rather than a full recording of every child's live stream.

## Blocked work is reported

Workflow runs pass through draht's permission gate. Child agents cannot display their own approval prompts, so tool calls that require approval are blocked and reported in the live view and final result. Configure explicit permission rules before a run when its agents need those tools.

Nesting is bounded by `polyphase.maxDepth`. Child agents cannot start workflows or duet triage batches. The update also fixes dropped streaming text and thinking, split UTF-8 output, queued agents starting after an abort, and child processes surviving an emergency exit.

Polyphase makes delegation inspectable: follow an agent, see its model and activity, read its failure, and reuse a procedure once you have checked how it behaves. The [polyphase guide](https://github.com/draht-dev/draht/blob/main/packages/coding-agent/docs/polyphase.md) documents the script API, settings, permissions, and behavior outside the terminal UI.
