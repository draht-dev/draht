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

Replace the provider and model placeholders with IDs available in your Draht installation. Use an absolute executable path, or an argv array such as `["node", "/absolute/path/to/cli.js"]`, when the executable is not on `PATH`. Relative script arguments resolve inside each fixture. `thinking` is the only native adapter setting; unsupported settings fail before execution. The native runtime must expose Drahtbank's tool-operations compatibility marker, covering confined grep execution and read-path resolution; the shipped extension rejects older runtimes at startup.

Execution and acceptance grading now require Linux user, mount, PID, network and IPC namespaces, plus the local `unshare`, `mount`, `chroot`, `setpriv`, `bash`, Node, ripgrep and fd executables. A real filesystem preflight runs before the adapter starts. Missing tools or unavailable confinement stop execution; there is no unconfined fallback. Fixtures must use fresh files: hardlinked inputs and preexisting sockets or devices are rejected. Preparation and report inspection remain available without these prerequisites.

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

Every workspace must still equal its original fixture before execution. Finished executions record a workspace digest and raw-output hashes, so later edits or background writes cannot earn credit using the original run's telemetry. Existing execution records cannot be overwritten; use a new output directory for another run. Snapshot changes, missing files, unsupported file types, early process exits before grading completes, invalid runner output, and timeouts fail closed. Grading has a ten-second process limit; runners default to five minutes per trial, configurable up to one hour. Runner and command output are bounded at 10 MiB; the private filesystem transport allows the additional base64 encoding overhead.

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

This benchmarks supplied prompt text on one selected runner. It does not validate installed Claude/Codex skill activation, plugin hooks, delegation chains, or provider parity. The native adapter disables context-file, skill, prompt-template, and extension discovery and disables builtin tools. It explicitly loads only Drahtbank's tool extension, which registers the same seven native tool definitions with confined operations. Global native configuration and the host's base system prompt can still affect both variants; use a controlled installation and record its CLI version and configuration with published results. Authentication remains the runner's responsibility.

Runner processes clear inherited Git repository-path overrides and Git configuration injection variables, then set `GIT_CEILING_DIRECTORIES` to the fixture's physical parent. Git stops before entering that parent; a ceiling equal to the initial working directory would be ignored. Execution evidence records this policy without saving inherited environment values. Generic runner commands still use the current user's permissions and must provide their own tool isolation.

Native tool operations execute in a fresh filesystem root containing the fixture at its original absolute path, declared readonly runtime directories, and minimal device files. The fixture is the only writable data directory. Host home, temporary directories, credentials, bank manifests, control files, other trials, host processes and host Unix sockets are not mounted. Child commands receive a fixed environment, empty network and IPC namespaces, no capabilities, and `no_new_privs`. Symlink targets outside this root cannot expose or modify host files. Every worker gets its own PID namespace; its descendants die with its namespace leader. Shell commands can read the declared runtime files. Direct filesystem operations require fixture paths, except for reading explicitly retained shell-output captures. This minimal runtime has no `/dev/fd`, so shell process substitution is unavailable.

The provider process remains outside this boundary so authentication and inference can work. Its trusted implementation, extension loading and output capture are part of the harness, not model tools. Truncated shell output is copied into a harness-owned readonly mount at `/.drahtbank/artifacts`; returned paths point there so the native read tool can retrieve the full capture without exposing host temporary files. Native grades require an isolation readiness event before agent execution, including the runtime compatibility marker and worker digest. This records the trusted extension's startup checks, not independent attestation of an arbitrary adapter executable. The independent acceptance process uses the same confinement because importing model-produced code can itself execute filesystem operations. Temporary grader files use the fixture and must be removed before the final snapshot check.

This enforces the filesystem and process boundary, not per-file task permissions inside the fixture. Final-file checks and trace review still detect protected-file changes and unauthorized new files; temporary in-fixture changes can require audit. CPU, memory and disk quotas are not implemented. The outer provider process retains the existing timeout and output bounds. Unsupported operating systems fail closed for execution and acceptance grading.

Use repeated paired runs with fixed model/settings and inspect both quality and resource use. External model nondeterminism, shared machine load, and provider cache state are not controlled. A smaller prompt or a few passing fixtures does not establish improved model quality, statistically meaningful equivalence, or lower latency. The earlier five-case pilot remains separate historical evidence in `docs/frontier-prompt-evaluation.json`; it is not imported as a Drahtbank run.

## Suite 2: multiple variants and separate outcomes

Suite 1 remains available with its original case digest. Suite 2 adds ten screening cases and six separate holdout cases. Its digest includes the case definitions, response grader, bank implementation, adapter parser, isolation helper, worker and tool extension. Prepare a fresh bank after changing those sources. Keep the matching original runner and grader when reproducing earlier results: confinement changes the execution environment even when a case's task is unchanged.

Create a variants JSON file outside the fixtures:

```json
[
  { "id": "verbose", "ref": "<original-commit>" },
  { "id": "pruning", "ref": "<pruning-commit>" },
  { "id": "frontier", "ref": "<frontier-commit>" },
  { "id": "hybrid", "ref": null }
]
```

References resolve to commits at preparation; `null` snapshots the current worktree. Each trial records its prompt source, bytes, and hash. Variant order rotates across cases and repetitions; `--order-offset` rotates the starting position across model banks. Four repetitions balance each position for a four-variant case.

```sh
npm run drahtbank -- list --suite 2 --json
npm run drahtbank -- prepare /tmp/drahtbank-screen \
  --suite 2 --split screen --variants /tmp/variants.json \
  --hosts coding-agent --repeats 1
npm run drahtbank -- run /tmp/drahtbank-screen --adapter /tmp/go-adapter.json
```

The existing native adapter accepts `provider: "opencode-go"` and any registered model ID. Check access, tool calling, and supported thinking settings before a broad run. Use the same runtime and permissions across variants. Provider or quota failures are execution outcomes, not evidence of poor prompt quality; retain them and never silently switch models.

Suite 2 reports these axes independently:

- Behavioral acceptance from executable assertions. It is unknown when scope violations or unavailable isolation prevent the grader from running. Isolation startup failures are infrastructure errors, not invented scope violations. For read-only cases, these assertions also check that the original fixture remains intact; they do not establish a correct diagnosis or review by themselves.
- Actual verification from the latest completed recognized invocation of each required command, using native tool-start/tool-end records, exit codes and outputs after the final observed direct edit. Literal quoting, escaping and whitespace, equivalent script paths within the fixture, and a literal `cd <workspace> && <check>` prefix are supported. Environment expansion, pipelines, redirects, arbitrary wrappers, extra commands and exit-masking chains remain unverified. An earlier success cannot hide a later failure or missing output. Overlapping attempts of the same command require audit; denied commands do not count as execution. Final prose does not prove execution. Generic adapters have unknown verification evidence.
- Output format, terminal-marker syntax, and case-specific status outcomes. `DONE` means a requested read-only review or diagnosis is complete with required evidence, including when it finds defects. `DONE_WITH_CONCERNS` permits nonblocking concerns or optional verification gaps. An observed failed required check requires `BLOCKED` until a later successful recognized rerun after the final edit; editing alone does not resolve the failure. Triage retains its separate marker contract.
- Structured verdicts, observable facts, and valid source citations. The response instructions define conditional mappings: reviews use `findings` or `clear`, diagnoses use `diagnosis`, and triage uses its specified classification mapping. These replace keyword searches in prose without disclosing which review outcome is correct. Supplied probes and explicitly supplied classifications measure fixture compliance, not autonomous discovery. Explanations and additional claims still need blinded semantic review.
- Final-file scope and observed direct write/edit violations. Opaque shell effects inside the fixture can still require audit. Native filesystem confinement prevents outside operations rather than inferring their absence from final files. Generic runner tools have no such guarantee.

Strict pass combines these checks for regression use. Use the separate axes when interpreting model quality. The unavailable-check case explicitly asks every variant to preserve completed work and report verification as blocked, so it no longer silently grades one branch's rollback policy against another.

The UTF-8 case explicitly requires preserving a leading U+FEFF, matching the original Buffer decoding behavior. Both its public check and independent assertions cover a byte-order mark split across chunks. Earlier frozen Suite 2 runs did not include this compatibility requirement: any later BOM probe is supplementary evidence, not a correction to their raw score.

These clarified verdict/status contracts, latest-check handling, and BOM assertions change the suite hash. Retain the matching source and original grades for earlier runs; prepare a new bank for this revision. The triage terminal parser rejects trailing content and competing markers, but does not inspect the preceding prose for tracker links or unsupported posting claims. Those claims remain part of semantic audit, not a demonstrated posting safeguard.

The advisor and triage cases load their corresponding skill/command text. The native advisor case uses canonical `skills/model-tiering/SKILL.md`, which is not shipped as a native package skill; its trial is labeled `canonical-skill`. This is a text comparison, not evidence of native activation. Shorter discovery descriptions are measured separately; their activation behavior is not exercised with discovery disabled.

Freeze prompt variants and both case splits before screening. Use `--split holdout` for subsequent repetitions, and retain weaker models as well as stronger ones. A case is held out from model-driven tuning, not hidden from the repository. Do not tune prompts after seeing holdout results and report the same cases as unseen evidence.

Configured completion checks have a separate offline runtime evaluation in `eval/drahtbank/runtime-checks.mjs`. It replays existing native faux-provider lifecycle tests, the shared configured-check runner tests, and both plugin Stop script tests, recording raw output, named proofs, source hashes and runtime identity. It measures enforcement behavior independently from paid model trials; installed host hook delivery and live-model repair ability remain outside that lane.
