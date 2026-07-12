/**
 * `draht rlm --input <path|glob|url> --query "..." [--max-cost <n>]` CLI
 * subcommand.
 *
 * Follows the same "check args, return true/false" dispatch convention as
 * `handlePackageCommand`/`handleConfigCommand` in `package-manager-cli.ts`:
 * `handleRlmCommand` returns `false` (no output, no side effects) unless
 * `args[0] === "rlm"`, letting `main()` fall through to the normal
 * interactive/print-mode session for everything else.
 *
 * Loads `--input` via `@draht/rlm`'s `parseInputArg`/`loadInput` (a file
 * path, glob pattern, `http(s)://` URL, or `knowledge:<client-slug>`
 * reference -- see `packages/rlm/src/loaders.ts`), then runs a
 * `createRouterBackedSession`-backed `RlmSession` to completion and prints
 * the final answer. See
 * .planning/phases/29-agent-cli-integration/29-01-PLAN.md, Architecture
 * section 3.
 *
 * Note on `--query`: `CreateRouterBackedSessionOptions`/`RlmSessionOptions`
 * have no dedicated "question" field -- the whole `prompt` string becomes
 * the REPL's `context` variable (see `router-session.ts`). This phase's
 * scope is input loaders + integration surfaces, not changes to the
 * session/prompt internals (26-28), so `buildRlmPrompt` embeds `--query` as
 * a clearly delimited header ahead of the loaded content instead of adding
 * a new session-level parameter.
 *
 * Note on `--max-cost`: parsed and validated here, but
 * `createRouterBackedSession` currently has no `maxTotalCostUsd`/
 * `getAccumulatedCostUsd` passthrough (those are `RlmSessionOptions` fields
 * that the router-backed factory doesn't yet wire up), so it isn't enforced
 * against the run yet -- flagged as a follow-up rather than widening this
 * plan's scope into `router-session.ts`.
 */

import { createRouterBackedSession, loadInput, parseInputArg, type RlmSession } from "@draht/rlm";
import { ModelRouter } from "@draht/router";
import chalk from "chalk";
import { APP_NAME } from "./config.ts";

export interface RlmCliRuntimeOptions {
	/**
	 * Injectable for tests: a fake object shaped like `ModelRouter`'s public
	 * API (`resolve`/`resolveModel`/`streamSimple`), cast to `ModelRouter` at
	 * the call site -- see `packages/rlm/test/router-session.test.ts`'s
	 * `FakeModelRouter` for the established pattern. No real network/API call
	 * happens when this is supplied. Defaults to a real `new ModelRouter()`.
	 */
	router?: ModelRouter;
}

export interface ParsedRlmArgs {
	input?: string;
	query?: string;
	maxCost?: number;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	invalidMaxCost?: string;
}

const RLM_COMMAND_USAGE = `${APP_NAME} rlm --input <path|glob|url> --query "..." [--max-cost <n>]`;

function printRlmCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${RLM_COMMAND_USAGE}

Run a Recursive Language Model (RLM) query against a large input without
loading it into this session's own context. The root model writes Python
that inspects/chunks/searches the loaded input inside a sandboxed REPL and
calls FINAL(...)/FINAL_VAR(...) once it has the answer.

Options:
  --input <path|glob|url>   Required. A file path, glob pattern,
                             http(s):// URL, or knowledge:<client-slug>
                             reference to load.
  --query <text>            Required. The question to answer about --input.
  --max-cost <n>            Optional. Soft USD cost hint for this run.

Examples:
  ${APP_NAME} rlm --input ./big-log.txt --query "What caused the outage?"
  ${APP_NAME} rlm --input "src/**/*.ts" --query "Where is auth handled?"
  ${APP_NAME} rlm --input knowledge:acme-corp --query "What's our deploy process?"
`);
}

/**
 * Parses the `rlm` subcommand's arguments (everything after the leading
 * `"rlm"` token). Mirrors `parsePackageCommand`'s style in
 * `package-manager-cli.ts`: collects the first problem of each kind rather
 * than throwing, so `handleRlmCommand` can report one clear error.
 */
export function parseRlmArgs(args: string[]): ParsedRlmArgs {
	let input: string | undefined;
	let query: string | undefined;
	let maxCost: number | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let invalidMaxCost: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "--input") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else {
				input = value;
				index++;
			}
			continue;
		}

		if (arg === "--query") {
			const value = args[index + 1];
			if (value === undefined) {
				missingOptionValue = missingOptionValue ?? arg;
			} else {
				query = value;
				index++;
			}
			continue;
		}

		if (arg === "--max-cost") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else {
				const parsedValue = Number(value);
				if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
					invalidMaxCost = invalidMaxCost ?? value;
				} else {
					maxCost = parsedValue;
				}
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		invalidArgument = invalidArgument ?? arg;
	}

	return { input, query, maxCost, help, invalidOption, invalidArgument, missingOptionValue, invalidMaxCost };
}

/**
 * Prepends `query` as a clearly delimited question header ahead of
 * `content`. The combined string becomes the RLM session's `context` (see
 * module docstring's note on `--query`).
 */
function buildRlmPrompt(query: string, content: string): string {
	return `Question: ${query}\n\n---\n\n${content}`;
}

/**
 * Handles the `draht rlm ...` subcommand. Returns `false` immediately (no
 * side effects) if `args[0]` isn't `"rlm"`; otherwise always returns `true`
 * after setting `process.exitCode` to reflect success/failure, matching
 * `handlePackageCommand`'s contract so `main.ts` can dispatch identically.
 */
export async function handleRlmCommand(args: string[], runtimeOptions: RlmCliRuntimeOptions = {}): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "rlm") {
		return false;
	}

	const parsed = parseRlmArgs(rest);

	if (parsed.help) {
		printRlmCommandHelp();
		return true;
	}

	if (parsed.invalidOption) {
		console.error(chalk.red(`Unknown option ${parsed.invalidOption} for "rlm".`));
		console.error(chalk.dim(`Usage: ${RLM_COMMAND_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (parsed.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${parsed.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${RLM_COMMAND_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (parsed.invalidMaxCost) {
		console.error(chalk.red(`Invalid --max-cost value "${parsed.invalidMaxCost}" (must be a positive number).`));
		console.error(chalk.dim(`Usage: ${RLM_COMMAND_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (parsed.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${parsed.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${RLM_COMMAND_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (!parsed.input) {
		console.error(chalk.red('Missing --input. Use "--help" for usage.'));
		console.error(chalk.dim(`Usage: ${RLM_COMMAND_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (!parsed.query) {
		console.error(chalk.red('Missing --query. Use "--help" for usage.'));
		console.error(chalk.dim(`Usage: ${RLM_COMMAND_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	const input = parsed.input;
	const query = parsed.query;

	let session: RlmSession | undefined;
	try {
		const cwd = process.cwd();
		const source = parseInputArg(input, cwd);
		const loaded = await loadInput(source);
		const router = runtimeOptions.router ?? new ModelRouter();

		session = createRouterBackedSession({
			prompt: buildRlmPrompt(query, loaded.content),
			contextType: loaded.contextType,
			router,
		});

		const result = await session.run();

		if (result.kind === "final" || result.kind === "final_var") {
			console.log(typeof result.value === "string" ? result.value : JSON.stringify(result.value));
			process.exitCode = 0;
			return true;
		}

		const detail = "value" in result && result.value !== undefined ? `: ${String(result.value)}` : "";
		console.error(chalk.red(`rlm: session ended without a final answer (${result.kind})${detail}.`));
		process.exitCode = 1;
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	} finally {
		session?.dispose();
	}
}
