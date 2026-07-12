/**
 * `draht rlm --input <path|glob|url> --query "..." [--max-cost <n>]` and
 * `draht rlm replay <trajectory-id> [--verbose]` CLI subcommand.
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
 *
 * `draht rlm replay <trajectory-id>` (Phase 30, see
 * .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
 * section 4) is a second mode of this same subcommand, dispatched on
 * `args[0] === "replay"` before any of the `--input`/`--query` parsing
 * above. It reads `.draht/rlm/<trajectory-id>.jsonl` via `@draht/rlm`'s
 * `readTrajectory` and prints the recorded final answer straight from that
 * log -- it never imports/constructs a `ModelRouter`, never calls
 * `createRouterBackedSession`, and is not reachable through any code path
 * that touches `RlmCliRuntimeOptions.router`. That's deliberate: replay
 * must make zero network/LLM calls, and the strongest proof of that is
 * that the router dependency simply isn't in this branch at all.
 */

import { createRouterBackedSession, loadInput, parseInputArg, type RlmSession, readTrajectory } from "@draht/rlm";
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
	/** Which of the subcommand's two modes these args parsed into. */
	mode: "query" | "replay";
	input?: string;
	query?: string;
	maxCost?: number;
	/** Replay mode only: the `<trajectory-id>` positional argument. */
	trajectoryId?: string;
	/** Replay mode only: print each step's code/stdout/cost, not just the final answer. */
	verbose?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	invalidMaxCost?: string;
}

const RLM_COMMAND_USAGE = `${APP_NAME} rlm --input <path|glob|url> --query "..." [--max-cost <n>]`;
const RLM_REPLAY_USAGE = `${APP_NAME} rlm replay <trajectory-id> [--verbose]`;

function printRlmCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${RLM_COMMAND_USAGE}
  ${RLM_REPLAY_USAGE}

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

Run "${APP_NAME} rlm replay --help" for how to reconstruct a past session's
answer from its trajectory log alone, with zero LLM calls.
`);
}

function printRlmReplayHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${RLM_REPLAY_USAGE}

Reconstruct a completed RLM session's final answer from its trajectory
JSONL log alone (.draht/rlm/<trajectory-id>.jsonl, written by a prior
"${APP_NAME} rlm" run) -- makes zero network/LLM calls.

Options:
  --verbose, -v   Also print each recorded step's code, stdout, error, and
                   cost, not just the final answer.
  -h, --help      Show this help.

Example:
  ${APP_NAME} rlm replay 3f9e2b7a-1c4d-4e9a-9b2f-7a6d1e0c5f8b
`);
}

/**
 * Parses the `rlm replay` subcommand's arguments (everything after the
 * leading `"replay"` token). Same "collect the first problem" style as
 * `parseRlmArgs`.
 */
function parseRlmReplayArgs(args: string[]): ParsedRlmArgs {
	let help = false;
	let verbose = false;
	let trajectoryId: string | undefined;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;

	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-v" || arg === "--verbose") {
			verbose = true;
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (trajectoryId === undefined) {
			trajectoryId = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	return { mode: "replay", help, verbose, trajectoryId, invalidOption, invalidArgument };
}

/**
 * Parses the `rlm` subcommand's arguments (everything after the leading
 * `"rlm"` token). Mirrors `parsePackageCommand`'s style in
 * `package-manager-cli.ts`: collects the first problem of each kind rather
 * than throwing, so `handleRlmCommand` can report one clear error.
 *
 * Dispatches to `parseRlmReplayArgs` when the first token is literally
 * `"replay"`, before any of the `--input`/`--query` parsing below runs --
 * see the module docstring's note on why replay's zero-LLM-calls guarantee
 * depends on this branch happening first.
 */
export function parseRlmArgs(args: string[]): ParsedRlmArgs {
	if (args[0] === "replay") {
		return parseRlmReplayArgs(args.slice(1));
	}

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

	return {
		mode: "query",
		input,
		query,
		maxCost,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		invalidMaxCost,
	};
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
 * Handles `draht rlm replay <trajectory-id> [--verbose]`. Reads the
 * trajectory's JSONL log via `@draht/rlm`'s `readTrajectory` and prints its
 * recorded final answer -- see the module docstring for why this function
 * never touches `ModelRouter`/`createRouterBackedSession`/
 * `RlmCliRuntimeOptions.router` at all: that omission is the zero-LLM-calls
 * guarantee, not an incidental side effect of this trajectory happening not
 * to need one.
 */
function handleRlmReplayCommand(parsed: ParsedRlmArgs): boolean {
	if (parsed.help) {
		printRlmReplayHelp();
		return true;
	}

	if (parsed.invalidOption) {
		console.error(chalk.red(`Unknown option ${parsed.invalidOption} for "rlm replay".`));
		console.error(chalk.dim(`Usage: ${RLM_REPLAY_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (!parsed.trajectoryId) {
		console.error(chalk.red('Missing <trajectory-id>. Use "rlm replay --help" for usage.'));
		console.error(chalk.dim(`Usage: ${RLM_REPLAY_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	if (parsed.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${parsed.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${RLM_REPLAY_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	const trajectoryId = parsed.trajectoryId;

	try {
		const trajectory = readTrajectory(trajectoryId);

		if (parsed.verbose) {
			for (const step of trajectory.steps) {
				console.log(chalk.dim(`--- step ${step.step} (cost $${step.costUsd.toFixed(6)}) ---`));
				console.log(step.code);
				if (step.truncatedStdout) console.log(`stdout: ${step.truncatedStdout}`);
				if (step.error) console.log(chalk.red(`error: ${step.error}`));
			}
		}

		if (!trajectory.final) {
			console.error(
				chalk.red(`rlm replay: trajectory "${trajectoryId}" has no final entry (the session never completed).`),
			);
			process.exitCode = 1;
			return true;
		}

		const { kind, value } = trajectory.final;
		if (kind === "final" || kind === "final_var") {
			console.log(typeof value === "string" ? value : JSON.stringify(value));
			process.exitCode = 0;
			return true;
		}

		const detail = value !== undefined ? `: ${String(value)}` : "";
		console.error(chalk.red(`rlm replay: trajectory ended without a final answer (${kind})${detail}.`));
		process.exitCode = 1;
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
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

	if (parsed.mode === "replay") {
		return handleRlmReplayCommand(parsed);
	}

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
