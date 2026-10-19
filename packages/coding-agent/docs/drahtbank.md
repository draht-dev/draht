# Drahtbank

Drahtbank compares Draht prompt snapshots on small, repeatable tasks. It runs baseline and candidate prompts against the same cases, grades their results independently, and records quality and resource use separately.

The first suite covers ten cases: a feature, a regression with a meaningful test, a multi-file CLI change, documentation-only work, an unavailable required check, read-only diagnosis, defective and clean code reviews, and vulnerable and protected security reviews. The default prompts are the implementer, debugger, reviewer, and security-auditor agents in `coding-agent`. Select the Claude or Codex package to compare their prompt assets on the same runner.

## Run a comparison

From a Draht source checkout:

```sh
npm run drahtbank -- list
npm run drahtbank -- prepare /tmp/drahtbank-run \
  --baseline HEAD \
  --hosts coding-agent,draht-claude,draht-codex \
  --repeats 3
```

This prepares 180 trials: ten cases, three prompt packages, two variants, and three repetitions. The baseline comes from the resolved Git commit; the candidate comes from the current worktree, including uncommitted prompt edits. `--candidate <ref>` selects a committed candidate instead. Preparation snapshots the exact prompts, UTF-8 byte sizes, SHA-256 digests, task briefs, and suite identity. Execution does not reread the working-tree prompts.

Use `--cases feature,regression` for a smaller run. `--repo <path>` selects the Draht source checkout. `--prompt <repository-relative-file>` applies a chosen agent, command, or skill file to all selected cases; choose cases whose tasks suit that prompt. This loads the file's text, not its referenced resources or a complete command chain.

Create an adapter configuration outside the trial workspaces:

```json
{
  "format": "draht-jsonl",
  "command": ["draht"],
  "provider": "<provider-id>",
  "model": "<model-id>",
  "settings": { "thinking": "high" },
  "timeoutMs": 300000
}
```

Replace the provider and model placeholders with IDs available in your Draht installation. Use an absolute executable path, or an argv array such as `["node", "/absolute/path/to/cli.js"]`, when the executable is not on `PATH`. Relative script arguments resolve inside each fixture. `thinking` is the only native adapter setting; unsupported settings fail before execution.

```sh
npm run drahtbank -- run /tmp/drahtbank-run --adapter /tmp/drahtbank-adapter.json
npm run drahtbank -- report /tmp/drahtbank-run
npm run drahtbank -- grade /tmp/drahtbank-run --json
```

An installed `@draht/coding-agent` also exposes the `drahtbank` binary. Preparation still requires a source checkout containing the chosen prompt assets and baseline history.

`run` invokes the configured model and can incur its usual usage charges. Preparation, grading, reporting, and the benchmark's fixture tests make no model API calls. There is no automatic model fallback. Each trial starts a fresh process; baseline/candidate order alternates across cases and repetitions. Run and grade exit nonzero if any trial fails. A correct blocked outcome on the deliberately failed verification case counts as a passed benchmark case.

## What is measured

A trial passes only when all four conditions hold:

- The runner finishes without a process, timeout, stream, or adapter error.
- Independent assertions pass for the resulting behavior or the case's explicit review rubric.
- The response ends with one appropriate `STATUS:` line.
- Changes stay within the declared scope and leave protected files intact.

Cases disclose allowed edits, new files, and the common STATUS output format in their task briefs. The common format keeps older prompts without a STATUS section comparable; it does not specify the expected outcome for a case. The grader checks actual CLI execution, protected-file contents, and required artifacts. The regression case runs the added test against the corrected implementation and against two broken implementations, so a test that always passes fails grading. Review and documentation cases use narrow text assertions with clean controls. These are useful regression signals, not general semantic judges; inspect individual failures for phrasing-related false negatives.

Every workspace must still equal its original fixture before execution. Finished executions record a workspace digest and raw-output hashes, so later edits or background writes cannot earn credit using the original run's telemetry. Existing execution records cannot be overwritten; use a new output directory for another run. Snapshot changes, missing files, unsupported file types, early process exits before grading completes, invalid runner output, and timeouts fail closed. Grading has a ten-second process limit; runners default to five minutes per trial, configurable up to one hour. Output is bounded at 10 MiB per process.

Reports include pass counts, paired regressions and improvements, prompt bytes, elapsed time, token usage, tool calls, and cost where available. Missing telemetry is `null`, never an inferred zero. Metric summaries show how many observations contributed. Elapsed time includes process startup and tool execution. Prompt bytes count UTF-8 assets across trials and are not tokenizer counts. Native `costUsd` comes from Draht's usage cost estimate, not a billing record.

The native adapter reads completed assistant messages and tool events from Draht JSONL output. It excludes repeated message snapshots and rejects truncated streams or a final assistant error even if the CLI exits zero. Reported reproduction commands in final text are rubric evidence, not proof that the agent executed them; raw traces remain available for inspection.

## Other runners

A provider-neutral adapter can wrap another agent CLI or evaluation harness:

```json
{
  "format": "json",
  "command": ["node", "/absolute/path/to/my-adapter.mjs"],
  "provider": "my-provider",
  "model": "my-model",
  "settings": {},
  "timeoutMs": 300000
}
```

Drahtbank executes argv directly without an implicit shell, sets the fixture as the working directory, and sends one JSON object on stdin containing `workspace`, `promptFile`, `taskFile`, `prompt`, `task`, `provider`, and `model`/`settings`. Standalone argv placeholders `{workspace}`, `{prompt}`, and `{task}` expand to their paths. The adapter must apply the supplied prompt and task to a fresh session and respect the requested model/settings.

Write a single JSON object to stdout; send diagnostics to stderr:

```json
{
  "finalText": "Implemented and checked the requested change.\nSTATUS: DONE",
  "usage": {
    "inputTokens": 1200,
    "outputTokens": 300,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "costUsd": 0.01
  },
  "toolCalls": 4
}
```

The numbers above only illustrate the protocol. Omit unavailable metrics or set them to `null`. An optional `error` string records an adapter/model failure. Generic telemetry is labeled `adapter-reported`; the runner cannot independently verify that adapter's usage or model selection. Do not derive token totals from prompt bytes or final-response word counts.

## Artifacts and limits

Each bank contains `manifest.json`, isolated `workspaces/<trial-id>/`, `control/<trial-id>/` with prompt/task snapshots, stdout/stderr, and execution records, plus `report.json`. Control files stay outside the model's assigned workspace. The recorded suite hash prevents grading old fixtures with changed case definitions. Keep the bank directory and matching benchmark source when retaining evidence.

This benchmarks supplied prompt text on one selected runner. It does not validate installed Claude/Codex skill activation, plugin hooks, delegation chains, or provider parity. The native adapter disables context-file, skill, prompt-template, and extension discovery and fixes the available tool set. Global native configuration and the host's base system prompt can still affect both variants; use a controlled installation and record its CLI version and configuration with published results. Authentication remains the runner's responsibility.

Runner and grading processes clear inherited Git repository-path overrides and Git configuration injection variables, then set `GIT_CEILING_DIRECTORIES` to the fixture's physical parent. Git stops before entering that parent; a ceiling equal to the initial working directory would be ignored. A routine `git status` or `git diff` inside a fixture or its subdirectories therefore cannot discover a containing checkout, even when the bank is stored under that checkout. Execution evidence records the Git environment policy and ceiling path without saving inherited environment values. Ceiling paths containing the platform's path-list delimiter are rejected because Git cannot represent them as one directory. This prevents accidental parent-repository discovery; explicit paths, changed environment variables, and ordinary filesystem access remain available.

The subprocesses use the current user's permissions. This is not a sandbox for hostile model-produced code. POSIX timeouts terminate the process group and close the runner's pipes; detached descendants that escape that group can remain alive. Windows descendant-process termination is not guaranteed. No network, commits, or delegation are requested by the fixtures, but stronger isolation requires the runner's own controls.

Use repeated paired runs with fixed model/settings and inspect both quality and resource use. External model nondeterminism, shared machine load, and provider cache state are not controlled. A smaller prompt or a few passing fixtures does not establish improved model quality, statistically meaningful equivalence, or lower latency. The earlier five-case pilot remains separate historical evidence in `docs/frontier-prompt-evaluation.json`; it is not imported as a Drahtbank run.
