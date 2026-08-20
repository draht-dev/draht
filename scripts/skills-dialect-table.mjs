#!/usr/bin/env node
/**
 * Dialect substitution data for scripts/generate-skills-artifacts.mjs.
 *
 * The canonical skill tree at repo-root skills/ is provider-neutral: it never
 * names a host ("Claude"/"Codex") or a host-specific dispatch mechanism
 * ("Task tool"/"spawn_agent") and never hardcodes a plugin-root env var. This
 * file records, line-for-line, how each neutral canonical line renders for
 * each host. Every entry is derived from the historical hand-maintained diff
 * between packages/draht-claude and packages/draht-codex (see git history /
 * scripts/check-plugin-mirrors.mjs for the tolerance regexes that used to
 * gate that drift by hand).
 *
 * Matching is exact whole-line string equality — deliberately dumb so the
 * mapping stays auditable. A line that isn't listed renders unchanged
 * (modulo the PLUGIN_ROOT_TOKEN substitution, which is generic).
 */

// Canonical placeholder for the plugin install root. Canonical bodies must
// never contain a literal ${CLAUDE_PLUGIN_ROOT} / ${PLUGIN_ROOT...} token —
// portability.test.ts enforces this — so <PLUGIN_ROOT> stands in for it and
// is resolved per host at render time.
export const PLUGIN_ROOT_TOKEN = "<PLUGIN_ROOT>";

export const PLUGIN_ROOT_RENDER = {
	claude: "${CLAUDE_PLUGIN_ROOT}",
	codex: "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}",
};

// ── 10 discipline skills — line-scoped dialect spans ────────────────────────
// Only 5 of the 10 discipline skills have any host-specific span; the other 5
// (brainstorming, ddd-workflow, loop-workflow, model-tiering, tdd-workflow)
// render identically for every host and have no entry here. saga-spawner
// carries the table's one asymmetric pair: the canonical "strongest tier"
// line renders with a Claude model example on the claude side but a generic
// "strongest available Codex reasoning tier" on the codex side.
export const DISCIPLINE_DIALECT = {
	"atomic-reasoning": [
		{
			canonical:
				'description: Decompose work into atomic reasoning units before acting — state the logical component, validate independence, verify correctness. The discipline that opens every draht slash command. Use whenever planning, designing, refactoring, breaking down a feature, structuring a commit, or scoping work. Triggers on "plan", "decompose", "break down", "scope", "split", "atomic", "how should I structure", or any moment the agent is about to spawn many parallel changes without first carving the work into independently-verifiable units.',
			claude:
				'description: Decompose work into atomic reasoning units before acting — state the logical component, validate independence, verify correctness. The discipline that opens every draht slash command. Use whenever planning, designing, refactoring, breaking down a feature, structuring a commit, or scoping work. Triggers on "plan", "decompose", "break down", "scope", "split", "atomic", "how should I structure", or any moment Claude is about to spawn many parallel changes without first carving the work into independently-verifiable units.',
			codex: 'description: Decompose work into atomic reasoning units before acting — state the logical component, validate independence, verify correctness. The discipline that opens every draht slash command. Use whenever planning, designing, refactoring, breaking down a feature, structuring a commit, or scoping work. Triggers on "plan", "decompose", "break down", "scope", "split", "atomic", "how should I structure", or any moment Codex is about to spawn many parallel changes without first carving the work into independently-verifiable units.',
		},
	],
	"debugging-workflow": [
		{
			canonical:
				"Random fixes create new bugs. This skill enforces the four-phase systematic debugging protocol whenever the agent is investigating any technical failure — independent of whether the user invoked `/fix`.",
			claude:
				"Random fixes create new bugs. This skill enforces the four-phase systematic debugging protocol whenever Claude is investigating any technical failure — independent of whether the user invoked `/fix`.",
			codex: "Random fixes create new bugs. This skill enforces the four-phase systematic debugging protocol whenever Codex is investigating any technical failure — independent of whether the user invoked `/fix`.",
		},
	],
	"gsd-workflow": [
		{
			canonical: "The plugin distributions ship workflow hooks under the plugin root's `scripts/` directory:",
			claude: "The plugin ships workflow hooks under `${CLAUDE_PLUGIN_ROOT}/scripts/`:",
			codex: "The plugin ships workflow hooks under `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/`:",
		},
	],
	"saga-spawner": [
		{
			canonical:
				"description: The saga graph reconciliation loop — unattended repo advancement as a cloud routine. The saga is a repository's long-running arc of work; a beat is its smallest independently shippable quantum, and the saga graph is a DAG of beats. The spawner is a stateless controller that diffs the graph (desired state) against merged PRs (actual state) and dispatches /orchestrate-style subagent teams to advance the saga one beat at a time. Use when the user mentions the saga graph, beats, spawner, routines, unattended or autonomous repo work, \"work the backlog overnight\", a self-optimizing repository, reconciliation runs, or when a cloud routine session must decide what to work on next. Also consult before designing any always-on or scheduled agent workflow for a draht repo.",
			claude:
				"description: The saga graph reconciliation loop — unattended repo advancement as a Claude Code cloud routine. The saga is a repository's long-running arc of work; a beat is its smallest independently shippable quantum, and the saga graph is a DAG of beats. The spawner is a stateless controller that diffs the graph (desired state) against merged PRs (actual state) and dispatches /orchestrate-style subagent teams to advance the saga one beat at a time. Use when the user mentions the saga graph, beats, spawner, routines, unattended or autonomous repo work, \"work the backlog overnight\", a self-optimizing repository, reconciliation runs, or when a cloud routine session must decide what to work on next. Also consult before designing any always-on or scheduled agent workflow for a draht repo.",
			codex: "description: The saga graph reconciliation loop — unattended repo advancement as a Codex cloud routine. The saga is a repository's long-running arc of work; a beat is its smallest independently shippable quantum, and the saga graph is a DAG of beats. The spawner is a stateless controller that diffs the graph (desired state) against merged PRs (actual state) and dispatches /orchestrate-style subagent teams to advance the saga one beat at a time. Use when the user mentions the saga graph, beats, spawner, routines, unattended or autonomous repo work, \"work the backlog overnight\", a self-optimizing repository, reconciliation runs, or when a cloud routine session must decide what to work on next. Also consult before designing any always-on or scheduled agent workflow for a draht repo.",
		},
		{
			canonical:
				"The **saga** is a repository's whole long-running arc of advancement — episodic, spanning many sessions, no author present. A **beat** is the smallest independently shippable quantum of that saga. The **saga graph** is a DAG of beats in `.planning/saga-graph.yaml`. The **spawner** is one reconciliation iteration over that graph, designed to run as a cloud routine: fresh session, fresh clone, no memory of the last run. It advances the saga one beat at a time.",
			claude:
				"The **saga** is a repository's whole long-running arc of advancement — episodic, spanning many sessions, no author present. A **beat** is the smallest independently shippable quantum of that saga. The **saga graph** is a DAG of beats in `.planning/saga-graph.yaml`. The **spawner** is one reconciliation iteration over that graph, designed to run as a Claude Code cloud routine: fresh session, fresh clone, no memory of the last run. It advances the saga one beat at a time.",
			codex: "The **saga** is a repository's whole long-running arc of advancement — episodic, spanning many sessions, no author present. A **beat** is the smallest independently shippable quantum of that saga. The **saga graph** is a DAG of beats in `.planning/saga-graph.yaml`. The **spawner** is one reconciliation iteration over that graph, designed to run as a Codex cloud routine: fresh session, fresh clone, no memory of the last run. It advances the saga one beat at a time.",
		},
		{
			canonical:
				"4. **Spawn** — per selected beat: acquire the lease, then drive the inner cycle on the branch with your host's subagent mechanism, `/orchestrate` discipline throughout:",
			claude:
				"4. **Spawn** — per selected beat: acquire the lease, then drive the inner cycle on the branch with the Task tool, `/orchestrate` discipline throughout:",
			codex: "4. **Spawn** — per selected beat: acquire the lease, then drive the inner cycle on the branch through Codex subagents with `spawn_agent`, `/orchestrate` discipline throughout:",
		},
		{
			canonical:
				"Run this command's session on the strongest tier and let workers execute on the executor tier — the spawner is pure steering, its tokens are the ones that decide where all the volume tokens go (`model-tiering`).",
			claude:
				"Run this command's session on the strongest tier (e.g. Claude Fable 5) and let workers execute on the executor tier — the spawner is pure steering, its tokens are the ones that decide where all the volume tokens go (`model-tiering`).",
			codex: "Run this command's session on the strongest available Codex reasoning tier and let workers execute on the executor tier — the spawner is pure steering, its tokens are the ones that decide where all the volume tokens go (`model-tiering`).",
		},
	],
	"verification-gate": [
		{
			canonical:
				'description: Evidence before claims — before stating that work is done, fixed, passing, working, ready, complete, or successful, run the command that proves it and read the output. Triggers on language like "done", "fixed", "should work", "looks good", "passing", "ready to ship", "complete", or whenever the agent is about to assert positive state. Applies everywhere — feature work, bug fixes, refactors, infra, docs that depend on code state.',
			claude:
				'description: Evidence before claims — before stating that work is done, fixed, passing, working, ready, complete, or successful, run the command that proves it and read the output. Triggers on language like "done", "fixed", "should work", "looks good", "passing", "ready to ship", "complete", or whenever Claude is about to assert positive state. Applies everywhere — feature work, bug fixes, refactors, infra, docs that depend on code state.',
			codex: 'description: Evidence before claims — before stating that work is done, fixed, passing, working, ready, complete, or successful, run the command that proves it and read the output. Triggers on language like "done", "fixed", "should work", "looks good", "passing", "ready to ship", "complete", or whenever Codex is about to assert positive state. Applies everywhere — feature work, bug fixes, refactors, infra, docs that depend on code state.',
		},
		{
			canonical: '| "The user can verify themselves" | The user asked the agent to do the work. The work isn\'t done until proven. |',
			claude: '| "The user can verify themselves" | The user asked Claude to do the work. The work isn\'t done until proven. |',
			codex: '| "The user can verify themselves" | The user asked Codex to do the work. The work isn\'t done until proven. |',
		},
	],
};

// ── 19 command templates — line-scoped dialect spans ────────────────────────
// Lines that differ only by the plugin-root token (e.g. every tool-note line
// in discuss-phase, init-project, next-milestone, pause-work, progress,
// resume-work) are not listed — PLUGIN_ROOT_TOKEN handles those generically.
export const COMMAND_DIALECT = {
	"atomic-commit": [
		{
			canonical:
				"You may delegate this work to the `git-committer` subagent if the change set is large or spans multiple areas — dispatch it the way your host runs subagents. The git-committer will review diffs, group changes, and create commits with conventional commit messages.",
			claude:
				'You may delegate this work to the `git-committer` subagent via the **Task tool** with `subagent_type: "git-committer"` if the change set is large or spans multiple areas. The git-committer will review diffs, group changes, and create commits with conventional commit messages.',
			codex: "You may delegate this work to the `git-committer` subagent via Codex subagents with ``git-committer` agent prompt` if the change set is large or spans multiple areas. The git-committer will review diffs, group changes, and create commits with conventional commit messages.",
		},
	],
	"execute-phase": [
		{
			canonical:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagent delegation, dispatch one subagent per role (`implementer`, `spec-reviewer`, `reviewer`). When your host supports concurrent subagent calls, dispatch multiple parallel roles in a single assistant turn.',
			claude:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagent delegation, use the **Task tool** with `subagent_type: "implementer" | "spec-reviewer" | "reviewer"`. Dispatch multiple parallel tasks in a single assistant turn by making multiple Task tool calls at once.',
			codex: '> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. For subagent delegation, spawn Codex subagents using the `implementer`, `spec-reviewer`, or `reviewer` agent prompts. Dispatch multiple parallel tasks in a single assistant turn by making multiple Codex subagent calls at once.',
		},
		{
			canonical:
				"   Dispatch the `implementer` subagent with the prompt from the template below. Read the final `STATUS:` line in the response.",
			claude:
				'   Dispatch a Task with `subagent_type: "implementer"` and the prompt from the template below. Read the final `STATUS:` line in the response.',
			codex: "   Dispatch a Codex subagent using the `implementer` agent prompt and the prompt from the template below. Read the final `STATUS:` line in the response.",
		},
		{
			canonical: "   Once the implementer is DONE, dispatch the `spec-reviewer` subagent with a prompt of the form:",
			claude: '   Once the implementer is DONE, dispatch a Task with `subagent_type: "spec-reviewer"` and a prompt of the form:',
			codex: "   Once the implementer is DONE, dispatch a Codex subagent using the `spec-reviewer` agent prompt and a prompt of the form:",
		},
		{
			canonical: "   Once spec compliance is ✅, dispatch the `reviewer` subagent with a prompt of the form:",
			claude: '   Once spec compliance is ✅, dispatch a Task with `subagent_type: "reviewer"` and a prompt of the form:',
			codex: "   Once spec compliance is ✅, dispatch a Codex subagent using the `reviewer` agent prompt and a prompt of the form:",
		},
		{
			canonical:
				"[Optional — orchestrator MAY paste a `draht-tools graph-context <task files>` slice here for orientation (pkg/layer/importers/imports/sinks). Subagents typically cannot run draht-tools themselves.]",
			claude:
				"[Optional — orchestrator MAY paste a `draht-tools graph-context <task files>` slice here for orientation (pkg/layer/importers/imports/sinks). Subagents cannot run draht-tools.]",
			codex: "[Optional — orchestrator MAY paste a `draht-tools graph-context <task files>` slice here for orientation (pkg/layer/importers/imports/sinks). Codex subagents cannot run draht-tools.]",
		},
	],
	fix: [
		{
			canonical:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch the `debugger` or `implementer` role.',
			claude:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "debugger"` or `"implementer"`.',
			codex: '> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. For subagents, spawn Codex subagents using the `debugger` or `implementer` agent prompts.',
		},
		{
			canonical:
				'Once the affected/buggy file is identified, run `draht-tools graph-context <buggy-file>` and `draht-tools graph-callers <buggy-file>` to orient (package, layer, who calls it) — paste the summary into the `debugger` subagent\'s prompt to support its "trace UPWARD" step.',
			claude:
				'Once the affected/buggy file is identified, run `draht-tools graph-context <buggy-file>` and `draht-tools graph-callers <buggy-file>` to orient (package, layer, who calls it) — paste the summary into the `debugger` prompt to support its "trace UPWARD" step.',
			codex: 'Once the affected/buggy file is identified, run `draht-tools graph-context <buggy-file>` and `draht-tools graph-callers <buggy-file>` to orient (package, layer, who calls it) — paste the summary into the Codex subagent prompt to support its "trace UPWARD" step.',
		},
	],
	grill: [
		{
			canonical:
				"> **Tool note**: For environment facts, dispatch the `architect` subagent the way your host runs subagents — read-only fact-finding; never block the current round on it.",
			claude:
				'> **Tool note**: For environment facts, use the **Task tool** with `subagent_type: "architect"` — read-only fact-finding; never block the current round on it.',
			codex: "> **Tool note**: For environment facts, spawn a Codex subagent using the `architect` agent prompt — read-only fact-finding; never block the current round on it.",
		},
	],
	"map-codebase": [
		{
			canonical:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch the matching Draht agent role (for example `architect` and `verifier`).',
			claude:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type` matching the agent name (e.g. `architect`, `verifier`).',
			codex: '> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. For subagents, spawn Codex subagents using the matching Draht agent prompts (for example `architect` and `verifier`).',
		},
		{
			canonical: "3. **Run parallel deep analysis via subagents**:",
			claude: "3. **Run parallel deep analysis via the Task tool**:",
			codex: "3. **Run parallel deep analysis via Codex subagents**:",
		},
		{
			canonical: "   Dispatch these two subagents in parallel (single assistant turn, two subagent calls):",
			claude: "   Dispatch these two subagents in parallel (single assistant turn, two Task tool calls):",
			codex: "   Dispatch these two subagents in parallel (single assistant turn, two Codex subagent calls):",
		},
		{
			canonical: "   - **Subagent** — dispatch the `architect` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "architect"` and prompt:',
			codex: "   - **Codex subagent** with ``architect` agent prompt` and prompt:",
		},
		{
			canonical: "   - **Subagent** — dispatch the `verifier` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "verifier"` and prompt:',
			codex: "   - **Codex subagent** with ``verifier` agent prompt` and prompt:",
		},
	],
	"new-project": [
		{
			canonical:
				'> **Tool note**: When this command says `draht-tools <subcommand>`, invoke it as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>` via your host\'s shell-execution tool. `<PLUGIN_ROOT>` resolves to the plugin\'s install directory; the exact environment variable is host-specific.',
			claude:
				'> **Tool note**: When this command says `draht-tools <subcommand>`, invoke it as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool. `CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin\'s install directory.',
			codex: '> **Tool note**: When this command says `draht-tools <subcommand>`, invoke it as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>` via the Bash tool. `PLUGIN_ROOT` is used when Codex exposes it; `CLAUDE_PLUGIN_ROOT` is a compatibility fallback.',
		},
	],
	"orchestrate-loop": [
		{
			canonical:
				"> **Tool note**: Dispatch subagents using the matching Draht agent role. Workers are `implementer` (or `debugger` for pure-diagnosis goals); the final gate is `spec-reviewer`. One worker per iteration — never parallel workers inside the loop.",
			claude:
				"> **Tool note**: Use the **Task tool** with `subagent_type`. Workers are `implementer` (or `debugger` for pure-diagnosis goals); the final gate is `spec-reviewer`. One worker per iteration — never parallel workers inside the loop.",
			codex: "> **Tool note**: Spawn Codex subagents using the matching Draht agent prompts. Workers are `implementer` (or `debugger` for pure-diagnosis goals); the final gate is `spec-reviewer`. One worker per iteration — never parallel workers inside the loop.",
		},
	],
	orchestrate: [
		{
			canonical:
				"> **Tool note**: Dispatch subagents using the matching Draht agent role: `architect`, `implementer`, `spec-reviewer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`, `advisor`. Dispatch multiple tasks in the same assistant turn for parallel execution.",
			claude:
				"> **Tool note**: Use the **Task tool** with `subagent_type` set to one of: `architect`, `implementer`, `spec-reviewer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`, `advisor`. Dispatch multiple tasks in the same assistant turn for parallel execution.",
			codex: "> **Tool note**: Spawn Codex subagents using the matching Draht `architect` agent prompt, `implementer`, `spec-reviewer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`, `advisor`. Dispatch multiple tasks in the same assistant turn for parallel execution.",
		},
		{
			canonical:
				"3. **Determine order** — What can run in parallel vs what must be sequential? For **code-touching** sub-tasks (skip for doc-only work), run `draht-tools graph-impact <files>` on each sub-task's targets: disjoint impact sets parallelize, overlapping ones sequence. The orchestrator runs it and pastes the summary into each subagent's prompt. Among independent sub-tasks, dispatch the riskiest first (highest uncertainty × blast radius): its failure invalidates the rest of the graph most cheaply, before effort is sunk into work it would obsolete.",
			claude:
				"3. **Determine order** — What can run in parallel vs what must be sequential? Among independent sub-tasks, dispatch the riskiest first (highest uncertainty × blast radius): its failure invalidates the rest of the graph most cheaply, before effort is sunk into work it would obsolete. For **code-touching** sub-tasks (skip for doc-only work), run `draht-tools graph-impact <files>` on each sub-task's targets: disjoint impact sets parallelize, overlapping ones sequence. The orchestrator runs it and pastes the summary into each Task subagent's prompt.",
			codex: "3. **Determine order** — What can run in parallel vs what must be sequential? For **code-touching** sub-tasks (skip for doc-only work), run `draht-tools graph-impact <files>` on each sub-task's targets: disjoint impact sets parallelize, overlapping ones sequence. The orchestrator runs it and pastes the summary into each Codex subagent's prompt. Among independent sub-tasks, dispatch the riskiest first (highest uncertainty × blast radius): its failure invalidates the rest of the graph most cheaply, before effort is sunk into work it would obsolete.",
		},
		{
			canonical:
				"Dispatch several subagent calls in a single assistant turn when the sub-tasks don't depend on each other. Example: review + security audit of the same change set.",
			claude:
				"Dispatch several Task tool calls in a single assistant turn when the sub-tasks don't depend on each other. Example: review + security audit of the same change set.",
			codex: "Dispatch several Codex subagent calls in a single assistant turn when the sub-tasks don't depend on each other. Example: review + security audit of the same change set.",
		},
		{
			canonical:
				"Dispatch subagent calls sequentially when later work depends on earlier output. Example: architect produces plan → implementer executes plan → verifier runs tests → reviewer audits the diff.",
			claude:
				"Dispatch Task tool calls sequentially when later work depends on earlier output. Example: architect produces plan → implementer executes plan → verifier runs tests → reviewer audits the diff.",
			codex: "Dispatch Codex subagent calls sequentially when later work depends on earlier output. Example: architect produces plan → implementer executes plan → verifier runs tests → reviewer audits the diff.",
		},
		{
			canonical: "4. Dispatch subagent calls accordingly",
			claude: "4. Dispatch Task tool calls accordingly",
			codex: "4. Dispatch Codex subagent calls accordingly",
		},
	],
	"plan-phase": [
		{
			canonical:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch the `architect` role. When your host supports concurrent subagent calls, dispatch multiple parallel roles in a single assistant turn.',
			claude:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "architect"`. Dispatch multiple parallel tasks in a single assistant turn by making multiple Task tool calls at once.',
			codex: '> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. For subagents, spawn a Codex subagent using the `architect` agent prompt. Dispatch multiple parallel tasks in a single assistant turn by making multiple Codex subagent calls at once.',
		},
		{
			canonical: "5. **Delegate plan creation to subagents:**",
			claude: "5. **Delegate plan creation to subagents via the Task tool:**",
			codex: "5. **Delegate plan creation to subagents via Codex subagents:**",
		},
		{
			canonical:
				"   - For **independent plans**: dispatch multiple subagent calls in parallel (single assistant turn), each using the `architect` role, one per plan.",
			claude:
				'   - For **independent plans**: dispatch multiple `Task` tool calls in parallel (single assistant turn), each with `subagent_type: "architect"`, one per plan.',
			codex: "   - For **independent plans**: dispatch multiple `spawn_agent` calls in parallel (single assistant turn), each using the `architect` agent prompt, one per plan.",
		},
		{
			canonical:
				"   - For **dependent plans**: dispatch sequentially — one subagent call per plan, feeding predecessor outputs as context into the next.",
			claude:
				"   - For **dependent plans**: dispatch sequentially — one `Task` call per plan, feeding predecessor outputs as context into the next.",
			codex: "   - For **dependent plans**: dispatch sequentially — one `spawn_agent` call per plan, feeding predecessor outputs as context into the next.",
		},
	],
	quick: [
		{
			canonical:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch one of `implementer`, `spec-reviewer`, or `reviewer`.',
			claude:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "implementer" | "spec-reviewer" | "reviewer"`.',
			codex: '> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. For subagents, spawn Codex subagents using the `implementer`, `spec-reviewer`, or `reviewer` agent prompts.',
		},
		{
			canonical:
				"3. **Stage 1 — Implementer.** _Optional scoping (multi-file tasks):_ run `draht-tools graph-context <files>` and paste the pkg/layer/importers summary into the subagent's prompt. Then dispatch the `implementer` subagent with prompt:",
			claude:
				'3. **Stage 1 — Implementer.** _Optional scoping (multi-file tasks):_ run `draht-tools graph-context <files>` and paste the pkg/layer/importers summary into the implementer prompt. Then dispatch via the Task tool with `subagent_type: "implementer"` and prompt:',
			codex: "3. **Stage 1 — Implementer.** _Optional scoping (multi-file tasks):_ run `draht-tools graph-context <files>` and paste the pkg/layer/importers summary into the Codex subagent prompt. Then dispatch a Codex subagent using the `implementer` agent prompt:",
		},
		{
			canonical:
				"4. **Stage 2 — Spec-reviewer (skip for pure-config / pure-docs).** Dispatch the `spec-reviewer` subagent with prompt:",
			claude:
				'4. **Stage 2 — Spec-reviewer (skip for pure-config / pure-docs).** Dispatch with `subagent_type: "spec-reviewer"` and prompt:',
			codex: "4. **Stage 2 — Spec-reviewer (skip for pure-config / pure-docs).** Dispatch a Codex subagent using the `spec-reviewer` agent prompt and prompt:",
		},
		{
			canonical:
				"5. **Stage 3 — Reviewer (optional code-quality pass).** For non-trivial quick tasks (touches more than one file or modifies domain code), _optionally_ run `draht-tools graph-impact <changed files>` and paste its reverse-dependents + boundary warnings into the subagent's prompt. Then dispatch the `reviewer` subagent:",
			claude:
				'5. **Stage 3 — Reviewer (optional code-quality pass).** For non-trivial quick tasks (touches more than one file or modifies domain code), _optionally_ run `draht-tools graph-impact <changed files>` and paste its reverse-dependents + boundary warnings into the reviewer prompt. Then dispatch with `subagent_type: "reviewer"`:',
			codex: "5. **Stage 3 — Reviewer (optional code-quality pass).** For non-trivial quick tasks (touches more than one file or modifies domain code), _optionally_ run `draht-tools graph-impact <changed files>` and paste its reverse-dependents + boundary warnings into the Codex subagent prompt. Then dispatch a Codex subagent using the `reviewer` agent prompt:",
		},
	],
	review: [
		{
			canonical:
				"> **Tool note**: For subagents, dispatch multiple in parallel when your host allows it (single assistant turn = multiple subagent calls).",
			claude:
				"> **Tool note**: For subagents, use the **Task tool** and dispatch multiple in parallel (single assistant turn = multiple Task tool calls).",
			codex: "> **Tool note**: For subagents, spawn Codex subagents and dispatch multiple in parallel (single assistant turn = multiple Codex subagent calls).",
		},
		{
			canonical:
				"   - Subagents cannot run draht-tools: paste the affected-contexts / boundary-violation summary into the reviewer and security-auditor prompts below.",
			claude:
				"   - Subagents cannot run draht-tools: paste the affected-contexts / boundary-violation summary into the reviewer and security-auditor prompts below.",
			codex: "   - Codex subagents cannot run draht-tools: paste the affected-contexts / boundary-violation summary into the reviewer and security-auditor prompts below.",
		},
		{
			canonical: "4. **Delegate to subagents in parallel** (dispatch all in the same assistant turn):",
			claude: "4. **Delegate to subagents in parallel via the Task tool** (dispatch all in the same assistant turn):",
			codex: "4. **Delegate to subagents in parallel via Codex subagents** (dispatch all in the same assistant turn):",
		},
		{
			canonical: "   - **Subagent** — dispatch the `reviewer` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "reviewer"` and prompt:',
			codex: "   - **Codex subagent** with ``reviewer` agent prompt` and prompt:",
		},
		{
			canonical: "   - **Subagent** — dispatch the `security-auditor` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "security-auditor"` and prompt:',
			codex: "   - **Codex subagent** with ``security-auditor` agent prompt` and prompt:",
		},
		{
			canonical: "   - **(If spec context exists)** dispatch the `spec-reviewer` role with prompt:",
			claude: '   - **(If spec context exists)** Task tool with `subagent_type: "spec-reviewer"` and prompt:',
			codex: "   - **(If spec context exists)** Codex subagent using the `spec-reviewer` agent prompt and prompt:",
		},
	],
	"verify-work": [
		{
			canonical:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch multiple in parallel when your host allows it (single assistant turn = multiple subagent calls).',
			claude:
				'> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** and dispatch multiple in parallel (single assistant turn = multiple Task tool calls).',
			codex: '> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. For subagents, spawn Codex subagents and dispatch multiple in parallel (single assistant turn = multiple Codex subagent calls).',
		},
		{
			canonical:
				"3. **Run parallel verification via subagents.** Dispatch four subagents in parallel (single assistant turn, four subagent calls):",
			claude:
				"3. **Run parallel verification via the Task tool.** Dispatch four subagents in parallel (single assistant turn, four Task tool calls):",
			codex: "3. **Run parallel verification via Codex subagents.** Dispatch four subagents in parallel (single assistant turn, four Codex subagent calls):",
		},
		{
			canonical: "   - **Subagent** — dispatch the `verifier` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "verifier"` and prompt:',
			codex: "   - **Codex subagent** with ``verifier` agent prompt` and prompt:",
		},
		{
			canonical: "   - **Subagent** — dispatch the `security-auditor` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "security-auditor"` and prompt:',
			codex: "   - **Codex subagent** with ``security-auditor` agent prompt` and prompt:",
		},
		{
			canonical: "   - **Subagent** — dispatch the `reviewer` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "reviewer"` and prompt:',
			codex: "   - **Codex subagent** with ``reviewer` agent prompt` and prompt:",
		},
		{
			canonical: "   - **Subagent** — dispatch the `spec-reviewer` role with prompt:",
			claude: '   - **Task tool** with `subagent_type: "spec-reviewer"` and prompt:',
			codex: "   - **Codex subagent** with ``spec-reviewer` agent prompt` and prompt:",
		},
	],
};

// ── 19 command-wrapper skills (codex-only) — one shared span ────────────────
// Claude never renders these files at all (no wrapper skills on the claude
// side), so there is no "claude" field: only "codex" is ever read.
export const WRAPPER_DIALECT = [
	{
		canonical: "This skill exposes the Draht prompt command template to the host's skill-invocation surface.",
		codex: "This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.",
	},
];
