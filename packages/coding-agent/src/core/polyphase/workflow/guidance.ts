/**
 * Model-facing text for the `workflow` tool (§14.5): the tool description, prompt snippet and
 * guidelines shown while the tool is active, and the longer authoring guide sent once when the
 * keyword first enables it.
 */

export const WORKFLOW_TOOL_DESCRIPTION =
	"Runs a workflow script that orchestrates one or more subagents through a multi-phase task, " +
	"with live oversight in the TUI (a running-agents dock and an agent inspector).\n\n" +
	"The script is plain JavaScript with no imports. It must start with `export const meta = " +
	"{ name, description, phases: [{ title, detail?, model? }, ...] }` as a pure literal (no " +
	"identifiers, calls, spreads, computed keys or template-literal interpolation), then an async body using:\n" +
	"  agent(prompt, opts) -> string | object | null\n" +
	"  parallel(thunks) -> array (barrier; a failed thunk becomes null)\n" +
	"  pipeline(items, ...stages) -> array (no barrier between stages)\n" +
	"  phase(title), log(...parts), args, budget\n\n" +
	"agent() returns null when the agent failed, was cancelled, or produced no valid structured " +
	"output. It throws for invalid options, an unknown agentType/model, an invalid effort, or the " +
	"per-run agent cap. Reserved names (never redeclare): agent, parallel, pipeline, phase, log, " +
	"args, budget, meta. Math.random, Date.now, Date() and new Date() throw; new Date(value) works. " +
	"No workflow can start another workflow.\n\n" +
	"Call this tool with either `script` (a new script) or `name` (a saved workflow). Set `args` " +
	"for the script's input string and `budgetTokens` to cap total billable tokens.";

export const WORKFLOW_PROMPT_SNIPPET =
	"Run a multi-agent workflow script (phases, parallel agents, pipelines) with live oversight";

export const WORKFLOW_PROMPT_GUIDELINES: readonly string[] = [
	"Use the workflow tool for multi-phase tasks that benefit from several subagents running in parallel or in a pipeline, with live oversight in the TUI.",
	"Write `export const meta = {...}` first, as a plain literal (no identifiers, calls, or template-literal interpolation), then an async body using agent, parallel, pipeline, phase, log, args and budget.",
	"Each agent() call is a separate paid model session that cannot ask for permissions; give it a self-contained task and ask it to end with a STATUS line.",
	"agent() returns null on failure, cancellation, or budget exhaustion; always check for null before using the result.",
];

export interface AuthoringGuideInput {
	agentTypes: readonly string[];
	savedNames: readonly string[];
	limits: { concurrency: number; maxAgents: number; maxItems: number };
}

export function buildAuthoringGuide(input: AuthoringGuideInput): string {
	const agentTypesLine = input.agentTypes.length > 0 ? input.agentTypes.join(", ") : "(none discovered)";
	const savedNamesLine = input.savedNames.length > 0 ? input.savedNames.join(", ") : "(none saved)";

	return `# Writing a polyphase workflow

A workflow script is plain JavaScript. It runs in a sandbox with no imports and no filesystem or
network access of its own -- all real work happens inside the subagents it starts with agent().

## 1. The meta block comes first

\`\`\`js
export const meta = {
  name: "review-pr",            // ^[a-z][a-z0-9-]{0,47}$, used for /review-pr if you save it
  description: "Review a change in parallel and synthesize findings", // 1-300 chars
  whenToUse: "...",             // optional, <= 300 chars
  phases: [                     // 1-20 entries
    { title: "Scan" },
    { title: "Review" },
    { title: "Synthesize", model: "anthropic/claude-opus-5-5" }, // optional per-phase model
  ],
};
\`\`\`

meta must be a pure literal: no identifiers, function calls, spreads, computed keys, template
interpolation (\${...}), or regex literals. Unknown keys are warnings, not errors.

## 2. The API

- \`agent(prompt, opts)\` starts one subagent and returns its final text, or the schema-validated
  object when \`opts.schema\` is set. It returns \`null\` when the agent failed, was cancelled (by
  the user or the token budget), the budget was already exhausted, or no valid structured output
  was produced -- always check for null. It throws for invalid options, an unknown model/agentType,
  an invalid effort, or hitting the per-run agent cap.
  opts: { label, phase, schema, model, effort, isolation: "worktree", agentType }
- \`parallel(thunks)\` runs an array of zero-argument thunks (each should call agent()) and waits
  for all of them (a barrier). A thunk that throws becomes null in the result array, with a
  warning logged; parallel() itself never rejects.
- \`pipeline(items, ...stages)\` runs each item through the same stages in sequence, with no
  barrier between stages: each stage \`(prev, item, index)\` receives the previous stage's result
  (or the item itself, for the first stage). A throwing stage makes that item null and skips its
  later stages for that item.
- \`phase(title)\` groups the agents started after it under that phase for the live view. Titles
  not declared in meta.phases become dynamic phases, logged once.
- \`log(...parts)\` writes a narrator line visible in the dock and inspector.
- \`args\` is the verbatim string passed to this call (or to /<name>). \`meta\` is the frozen meta
  object.
- \`budget\`: { total, spent(), remaining() }. spent() is this run's total billable tokens as of
  the latest agent() reply.

## 3. Determinism and reserved names

Math.random, Date.now, Date() and new Date() all throw -- workflows must be deterministic.
new Date(value) still works. Never redeclare: agent, parallel, pipeline, phase, log, args, budget, meta.

## 4. Each agent is a separate paid session

Every agent() call spawns an independent subagent process. It cannot ask for permissions or see
anything outside its own prompt, so give it a self-contained task and ask it to end with a
STATUS: line you can look for in its output.

## 5. Limits

- Up to ${input.limits.concurrency} agents run at once in this session.
- Up to ${input.limits.maxAgents} agent() calls total in one workflow run.
- Up to ${input.limits.maxItems} items per parallel()/pipeline() call.

## 6. Available agent types

${agentTypesLine}

## 7. Saved workflows

${savedNamesLine}

## Example

\`\`\`js
export const meta = { name: "review-pr", description: "Review a change in parallel and synthesize findings",
  phases: [{ title: "Scan" }, { title: "Review" }, { title: "Synthesize", model: "anthropic/claude-opus-5-5" }] };
phase("Scan");
const scan = await agent(\`List the areas touched by \${args}\`, { label: "scan",
  schema: { type: "object", properties: { areas: { type: "array", items: { type: "string" } } }, required: ["areas"] } });
phase("Review");
const reviews = await parallel((scan?.areas ?? []).map((area) => () =>
  agent(\`Review \${area} for \${args}. End with a STATUS line.\`, { label: \`review:\${area}\`, agentType: "reviewer" })));
phase("Synthesize");
return await agent(\`Synthesize these reviews:\\n\${reviews.filter(Boolean).join("\\n---\\n")}\`, { label: "synthesize" });
\`\`\`
`;
}
