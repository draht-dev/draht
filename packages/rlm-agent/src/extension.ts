/**
 * `@draht/rlm-agent` — coding-agent extension surface for `@draht/rlm`.
 *
 * Registers, per .planning/phases/29-agent-cli-integration/29-01-PLAN.md,
 * Architecture section 2:
 * - a `/rlm <input> <query>` slash command, and
 * - an `rlm_query` tool, letting a normal agent session defer an oversize
 *   read to a Recursive Language Model sub-session instead of dumping it
 *   into its own context.
 *
 * Shape follows `packages/coding-agent/src/core/builtins/subagent.ts`'s
 * default export -- the most recent working example of an extension factory
 * in this codebase, and the pattern the Phase 23 dead-code lesson (see this
 * phase's plan) specifically calls out as the one to copy: a real
 * `(pi: ExtensionAPI) => void` default export, not a plain factory function
 * that merely *looks* like one (contrast `packages/compliance/src/
 * extension.ts`, which returns a bag of methods and never calls
 * `pi.registerTool`/`pi.registerCommand` at all).
 *
 * Both entry points share `runRlmQuery`: `@draht/rlm`'s `parseInputArg`/
 * `loadInput` load the requested input, the loaded content is combined with
 * the caller's query into one `context` string -- `RlmSession` has no
 * separate "query" input of its own (see `RlmSessionOptions.prompt`'s doc
 * comment: it "becomes the `context` variable"), so the question is placed
 * at the head of `context`, where the root LM's first exploratory step will
 * see it -- and a `createRouterBackedSession` (backed by a fresh
 * `@draht/router` `ModelRouter`) runs the session to completion.
 */

import type { ExtensionAPI } from "@draht/coding-agent";
import type { RlmResult } from "@draht/rlm";
import { createRouterBackedSession, loadInput, parseInputArg } from "@draht/rlm";
import { loadConfig, ModelRouter } from "@draht/router";
import { Type } from "typebox";

const USAGE = "Usage: /rlm <input> <query>";

const RlmQueryParams = Type.Object({
	input: Type.String({
		description:
			"What to load: a file path, a glob pattern, an http(s):// URL, or knowledge:<client-slug> for a named client knowledge base.",
	}),
	query: Type.String({ description: "The question to answer about the loaded input." }),
});

/**
 * Renders an `RlmResult` into the text handed back to the caller (command
 * output or tool result content). `"final"`/`"final_var"` carry the actual
 * answer; every other `kind` means the session stopped without one, so the
 * `kind` (and any diagnostic `value`, e.g. a timeout/error message) is
 * surfaced instead of silently returning nothing.
 */
export function formatRlmResult(result: RlmResult): string {
	if (result.kind === "final" || result.kind === "final_var") {
		return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
	}
	const detail = result.value !== undefined ? `: ${String(result.value)}` : "";
	const stepWord = result.steps === 1 ? "step" : "steps";
	return `RLM session did not produce a final answer (${result.kind} after ${result.steps} ${stepWord})${detail}`;
}

/**
 * Loads `inputArg` via `@draht/rlm`'s loaders, runs a router-backed RLM
 * session to answer `query` about it, and returns the rendered answer.
 * Shared by both the `/rlm` command and the `rlm_query` tool below.
 */
export async function runRlmQuery(cwd: string, inputArg: string, query: string): Promise<string> {
	const source = parseInputArg(inputArg, cwd);
	const { content, contextType } = await loadInput(source);
	const prompt = `QUESTION: ${query}\n\n---\n\n${content}`;
	const router = new ModelRouter(loadConfig(cwd));
	const session = createRouterBackedSession({ prompt, router, contextType });
	try {
		const result = await session.run();
		return formatRlmResult(result);
	} finally {
		session.dispose();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rlm_query",
		label: "RLM Query",
		description:
			"Defer reading an oversize input (file, glob, URL, or knowledge:<client-slug>) to a Recursive Language Model sub-session instead of loading it directly into this agent's own context. Returns the sub-session's final answer.",
		promptSnippet: "answer a question about a large file/glob/URL/knowledge base without reading it directly",
		parameters: RlmQueryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const answer = await runRlmQuery(ctx.cwd, params.input, params.query);
				return { content: [{ type: "text", text: answer }], details: {} };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `rlm_query failed: ${message}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerCommand("rlm", {
		description: `Answer a question about a large input via a Recursive Language Model sub-session. ${USAGE}`,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIndex = trimmed.search(/\s/);
			if (!trimmed || spaceIndex === -1) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const inputArg = trimmed.slice(0, spaceIndex);
			const query = trimmed.slice(spaceIndex).trim();
			if (!query) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			try {
				const answer = await runRlmQuery(ctx.cwd, inputArg, query);
				ctx.ui.notify(answer, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`/rlm failed: ${message}`, "error");
			}
		},
	});
}
