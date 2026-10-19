# Concise prompts with deterministic verification

Ordinary work and `/quick` proceed directly: inspect the task, implement it, and verify the result. GSD remains an explicitly selected workflow. Brainstorming no longer requires approval rounds, planning files, or a GSD handoff. Debugging permits source investigation and provisional hypotheses before reproduction; confirmed diagnoses still require evidence. Fixed hypothesis counts, ritual self-checks, repeated discipline, and textbook material have been removed or shortened.

All native agents now carry a STATUS contract, so removing repeated caller prose does not leave smaller models without a completion contract. Scope limits, evidence before completion, bounded corrections, and `red:`/`green:`/`refactor:` commit conventions remain. Commits require authorization. Explicit phase workflows retain their review sequence; ordinary work selects reviews according to risk. Orchestration accepts auditable results for unchanged inputs instead of rerunning every check through every role.

This follows [ADR 0001](adr/0001-three-tier-logic-placement.md): enforce correctness in code and use prompts for task context and judgment. [OpenAI's reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning-best-practices) and [Anthropic's Opus guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) motivate concise instructions; they do not establish a performance improvement for this repository.

## Project checks

Create `.draht/checks.json` at the project root. The same runner ships in all three packages:

```json
{
  "checks": [
    {
      "name": "acceptance",
      "command": ["node", "scripts/check.mjs"],
      "inputs": ["src", "scripts/check.mjs", "package.json"],
      "timeoutMs": 30000
    }
  ]
}
```

`command` is an argv array, executed without an implicit shell. `cwd` defaults to the configuration's project root. `inputs` contains literal project-relative files or directories, without globs; omit it to cover the project. Include check scripts, configuration, lockfiles, and other dependencies needed to invalidate evidence. `timeoutMs` defaults to 30 seconds, with a 150-second total runner budget. `enabled: false` disables configured verification and the plugin fallback.

A successful result is cached against scoped file contents, file modes, command/configuration, and runtime identity. Relevant uncommitted or committed edits invalidate it. A commit containing unchanged content does not invalidate otherwise valid evidence. Failures never count as cached passes. A formatter or concurrent edit detected during a cached check scope invalidates that result. Configuration changes during verification always fail the run. Cache files live in the worktree's Git directory, outside the checked inputs.

Set `cache: false` for environment variables, services, ignored dependency directories, or other state outside the declared inputs. An explicitly listed ignored file is fingerprinted, but ignored directory contents are not discovered. No-Git projects, symlinks, and submodules run uncached. These uncached cases do not provide content-change detection during the command itself. `--force` reruns checks even when cached evidence exists.

Run manually with:

```sh
node <coding-agent-package>/hooks/checks/checks-runtime.cjs --cwd <project> --force
node <plugin-root>/scripts/checks-runtime.cjs --cwd <project> --force
```

Configured checks are authoritative, including any explicitly configured tests. Legacy `--no-tests` suppresses inferred full-suite checks; it does not disable commands in `.draht/checks.json`. Standalone quality gates retain their full optional diagnostics; `--checks-only` excludes GSD/source heuristics. Standalone native strictness now matches the plugins. Existing post-task strict/advisory behavior remains, and failed checks are logged as failures even in advisory mode.

## Completion behavior

- **Native:** trusted projects run configured checks after other settlement handlers and before session settlement. A failure returns diagnostics to the model for at most three repair attempts. Exhaustion leaves a visible unverified result and aborts further repair. Cancellation stops the check runner; POSIX cancellation kills its process group. Unconfigured and untrusted projects execute no automatic project commands.
- **Plugins:** Stop runs configured checks regardless of file language, Git dirtiness, or planning state. A repeated Stop does not bypass a failed check. Without configuration, the existing fallback checks uncommitted JavaScript/TypeScript with applicable type/lint commands. It recognizes package lint scripts and `biome.json`/`biome.jsonc`; it does not infer a full test suite. Legacy `hooks.stopGate: false` and advisory mode apply only to this unconfigured fallback.

Configured checks reject nonzero exits, signals, timeouts, launch errors, invalid configuration, and unknown outcomes. Git status errors still skip the unconfigured plugin fallback; committed-only and non-JavaScript coverage requires explicit configuration. Host hook delivery and native project trust remain prerequisites. Native failure is recorded as a visible `project-checks` message; the public `agent_settled` event itself has no typed verification outcome. Changes made after settlement, including background writes, are outside that verification boundary.

Individual configured-command timeouts kill the direct process. A command that launches descendants may need its own cleanup; plugin hooks are not process supervisors. Windows process-tree cancellation has not been validated.

## Git safeguards and installation

The native shell-tool hook and both plugin PreToolUse hooks share a dependency-free Git policy. It rejects literal forced pushes, forced refspecs, unsafe force-with-lease forms, hook bypass flags, and command-local hook disabling. The explicit create-if-absent ref lease used by saga locking remains allowed. This is a guard against recognized shell commands, not a security sandbox: dynamically generated commands, scripts, aliases, and arbitrary interpreter programs require the host's permission controls.

Canonical explicit-only skills carry both `disable-model-invocation: true` and `agents/openai.yaml` with `allow_implicit_invocation: false`. Native and Claude use the frontmatter; Codex uses its [documented policy](https://learn.chatgpt.com/docs/build-skills). Generated Claude command artifacts receive the flag as well, using [Claude's invocation control](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill). The generator rejects mismatched controls. Other hosts may ignore these extensions. The optional legacy project extension's `/quick` handler now also executes directly without forced delegation or commits.

Plugin planning-context injection defaults to silent, even when planning files exist. `hooks.planningContext: true` in `.planning/config.json` opts in. The per-prompt reminder is capped at 196 Unicode characters. Explicit GSD commands can read their own state independently of this injection or the check configuration.

Runtime mirrors, generated skills, hook registrations, portable activation policies, and dual-channel native skill copies have deterministic drift checks. Nonexistent research/milestone commands, full-map loading instructions, debugger scope conflicts, review-status contradictions, and outdated fixed model-tiering claims were corrected in the same worktree.

## Measurements and pilot

The reusable [Drahtbank benchmark](../packages/coding-agent/docs/drahtbank.md) now provides versioned cases, repeated paired runs, runner adapters, usage recording, and deterministic grading. The pilot below remains the original, separately recorded experiment.

Against `8705c2adc`, the tracked Markdown prompt assets shrink by 36% in coding-agent, 32% in draht-claude, and 30% in draht-codex. The canonical catalog shrinks by 32%. These are UTF-8 asset bytes across separate contexts, not tokenizer counts or an estimate of every session's input. Reproduce with `node scripts/measure-frontier-prompts.mjs 8705c2adc`.

Selected canonical assets:

| Asset | Before | After | Reduction |
|---|---:|---:|---:|
| Brainstorming | 8,816 bytes | 1,826 bytes | 79% |
| Debugging workflow | 10,986 bytes | 2,828 bytes | 74% |
| `/fix` | 12,557 bytes | 3,158 bytes | 75% |
| `/why` | 10,414 bytes | 3,013 bytes | 71% |
| Native implementer | 2,679 bytes | 1,563 bytes | 42% |

A paired pilot compared the baseline and final native implementer prompts on five isolated tasks: a small feature, a regression fix, a multi-file CLI change, docs-only work, and a deliberately failed required check. Fresh GPT-6 Astra agents used inherited ultra reasoning, the same tool surface, and identical caller constraints. Both variants passed all five independent acceptance checks. Both correctly recorded the known failed verification as blocked. The required check files remained unchanged; docs-only runs preserved runtime code.

The pilot uses one run per case and variant. It tests an implementer role, not the full `/quick` or GSD command chain. Caller instructions explicitly required truthful check reporting, so the blocked-case result does not isolate the prompt's effect. Actual model token use, tool-call totals, cost, and controlled latency were not collected. These results show no regression in this small fixture set; they establish neither a quality gain nor a statistically meaningful equivalence. Hook regressions separately prove the deterministic enforcement behavior.

Reproduce the fixtures with `node packages/coding-agent/eval/frontier-prompts.mjs prepare <new-output-directory> 8705c2adc`, give each `brief.md` to a fresh agent with fixed settings, then run the script's `grade` command on that directory. Grading executes acceptance assertions separately and detects check tampering. Model-provided check reports are compared with expected outcomes, not treated as invocation telemetry. Recorded results are in [frontier-prompt-evaluation.json](frontier-prompt-evaluation.json).

## Repeated two-model comparison

On 2026-10-18, Drahtbank ran 360 primary trials: ten cases, three prompt packages, old and simplified prompt snapshots, three repetitions, and two models. Both `openai-codex/gpt-6-astra` and `anthropic/claude-opus-5-5` used high reasoning through the same Draht CLI 2026.10.16 runtime. The baseline was `8705c2adcbf7bcf2ec6093ef48061b8c914729ca`; the suite digest was `0062167bd80d9beee535fe13e7b827a32baa304d89c2a5336beb9550531ba781`.

| Model | Raw strict pass, old → simplified | Reported input change | Output change | Median elapsed change |
|---|---:|---:|---:|---:|
| GPT-6 Astra | 56/90 → 66/90 | −24.6% | +3.9% | −0.4% |
| Opus 5.5 | 67/90 → 74/90 | −11.7% | −0.6% | −2.5% |

Input includes cache reads and writes across all turns. Ordinary feature, regression, multi-file, and documentation acceptance passed 36/36 for each model and variant. Every raw failure was reviewed: narrow wording rubrics and differing STATUS semantics account for many failures. The raw scores therefore do not establish a model ranking. Final-file checks also missed three temporary outside-fixture writes in Opus traces. Up to twelve runners shared the machine; cumulative trial time increased 12.1% for Astra and decreased 5.5% for Opus. There is no demonstrated speedup or general quality gain.

The primary run exposed inherited plugin instructions that led Astra to revert completed work when an external prerequisite blocked verification. The two plugin implementer prompts now preserve completed changes and report them as unverified. A separate, subsequently selected 24-trial follow-up passed all 12 revised-prompt trials, six per model. This validates that narrow repair; it is not part of the primary scores.

Exact prompt snapshots, manifests, raw traces, audited failures, and reports are retained locally under `.artifacts/drahtbank/gpt-astra-opus-2026-10-18/primary/` and `followup/`. Earlier checkout-local runs were excluded after detecting parent-Git context leakage; the runner now constrains Git discovery to the fixture. These cases exercise prompt text on the native runtime, not actual plugin activation, hooks, or the full command catalog. Larger tasks, better text rubrics, and observable transient writes are needed before broader quality claims.

Validation uses isolated repositories, command shims, and the faux provider for lifecycle tests. Focused tests run from their package roots, and `npm run check` validates the repository. No build, development server, or full `npm test` was run; repository changes remain uncommitted. Existing ignored build artifacts from the original same-commit checkout supply workspace dependencies; the original worktree remains untouched.
