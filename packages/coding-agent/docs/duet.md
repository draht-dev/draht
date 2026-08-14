# Duet mode

Duet mode lets multiple authenticated models collaborate in one Draht session. Configuration and turn position are stored in the session, so `/resume`, `/tree`, and compaction continue to work normally.

## Configure

Pass two to eight comma-separated models. Optional role names use `role=model`; optional thinking levels use `model:level`.

```text
/duet turns implementer=openai-codex/gpt-5.5:high,reviewer=anthropic/claude-opus-4-8:high
/duet triage lead=openai-codex/gpt-5.5:high,reviewer=anthropic/claude-opus-4-8,tester=google/gemini-3.1-pro-preview
/duet status
/duet off
```

With no model list, `/duet turns` and `/duet triage` use the models configured by `/scoped-models` or `--models`. At least two scoped models are required.

Duet can also start from CLI flags:

```bash
draht \
  --duet "lead=openai-codex/gpt-5.5,reviewer=anthropic/claude-opus-4-8" \
  --duet-strategy triage
```

## Strategies

### Turn taking

`turns` rotates the active model before each new, idle user prompt. Every model receives the same persisted conversation, tool results, session tree, and working directory. Steering and follow-up messages queued during an active response stay with that response's model; rotation happens on the next prompt submitted while idle.

### Triage

`triage` makes the first participant the lead. For non-trivial requests, the lead can call `duet_delegate` to assign independent investigations to the remaining model roles concurrently. Results return as one tool result in the shared conversation, then the lead synthesizes them and performs the implementation.

Triage teammates intentionally receive only `read`, `grep`, `find`, and `ls`, and user/project extensions are disabled in their child processes. They cannot modify the shared working tree. This avoids concurrent edits and leaves one model accountable for integration. Use the existing `subagent` tool with worktree isolation when autonomous writing agents are required.

Teammates can read project content and send it to their configured providers. Choose participant providers according to the project's data policy, and do not expose secrets through project files or symlinks.

## Cost and authentication

Every participant must already be authenticated. Parallel triage assignments make concurrent provider requests and are billed independently. By default, each delegation batch requires approval through Draht's permission gate; explicit permission rules can change that behavior. Draht limits triage to one delegation batch per user prompt and records nested teammate usage in session totals. The lead is instructed to skip delegation when it would only add latency or cost.
