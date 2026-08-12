import { type BinName, type CliArgs, parseCliArgs, resolveBinName } from "./args.ts";
import { executeCommand } from "./commands.ts";
import { type CliError, toCliError } from "./errors.ts";
import { EXIT_OK } from "./exit-codes.ts";
import { helpText } from "./help.ts";
import type { HostRunner } from "./host.ts";
import { jsonDocument, jsonError, renderJson, renderNdjson } from "./json.ts";
import type { RegistryClient } from "./sources/types.ts";
import { packageVersion } from "./version.ts";

/** Every stream and terminal capability the CLI is allowed to touch, injected so tests never depend on the real process. */
export interface CliIo {
	stdout: (chunk: string) => void;
	stderr: (chunk: string) => void;
	/** Whether stdin is an interactive terminal — mutating verbs need this or `--yes`. */
	isTTY: boolean;
	/** Asks the operator to confirm a mutation. Only ever called when `isTTY` is true. */
	confirm?: (question: string) => Promise<boolean>;
}

export interface RunCliOptions {
	/** Arguments after the node binary and the script path. */
	argv: string[];
	/** `process.argv[1]` (or a bare bin name). Determines which product surface runs. */
	binName: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	io: CliIo;
	/** Injected package source. Defaults to the npm registry client honoring `DRAHT_REGISTRY`. */
	registry?: RegistryClient;
	/** Injected host-process runner. Defaults to a real `spawnSync` with no shell. */
	hostRunner?: HostRunner;
	/** Aborted on SIGINT/SIGTERM so an in-flight transaction can stop at a safe point. */
	signal?: AbortSignal;
}

/** Resolved, validated inputs handed to a command implementation. */
export interface CommandContext {
	bin: BinName;
	args: CliArgs;
	env: NodeJS.ProcessEnv;
	cwd: string;
	io: CliIo;
	registry?: RegistryClient;
	hostRunner?: HostRunner;
	signal?: AbortSignal;
}

function jsonRequested(argv: string[]): boolean {
	return argv.includes("--json");
}

/**
 * The whole CLI as one awaitable function returning the process exit code.
 * The real entry point (`cli.ts`) does nothing but wire `process` into this
 * and set `process.exitCode`, so every behavior below is reachable from a test
 * without spawning a process or mutating global state.
 */
export async function runCli(opts: RunCliOptions): Promise<number> {
	const { argv, io } = opts;
	let bin: BinName = "draht-install";

	try {
		bin = resolveBinName(opts.binName);
		const args = parseCliArgs(bin, argv);

		if (args.help) {
			io.stdout(helpText(bin));
			return EXIT_OK;
		}

		if (args.version) {
			const version = packageVersion();
			io.stdout(args.json ? renderJson(jsonDocument("version", { bin, version })) : `${version}\n`);
			return EXIT_OK;
		}

		return await executeCommand({
			bin,
			args,
			env: opts.env,
			cwd: opts.cwd,
			io,
			registry: opts.registry,
			hostRunner: opts.hostRunner,
			signal: opts.signal,
		});
	} catch (error) {
		const cliError = toCliError(error);
		reportError(io, cliError, jsonRequested(argv), commandLabel(argv, bin), bin);
		return cliError.exitCode;
	}
}

function commandLabel(argv: string[], bin: BinName): string {
	if (bin === "draht-init") return "init";
	const first = argv.find((token) => !token.startsWith("-"));
	return first ?? "help";
}

/**
 * Human mode puts the message on stderr and leaves stdout untouched; JSON mode
 * emits exactly one schema-stable error document on stdout so a `--json`
 * consumer always has something parseable, and repeats the message on stderr
 * for anyone watching the terminal.
 */
function reportError(io: CliIo, error: CliError, json: boolean, command: string, bin: BinName): void {
	if (json) {
		const document = jsonError(command, error.code, error.message, error.detail);
		const mutating = bin === "draht-init" || new Set(["install", "update", "uninstall"]).has(command);
		io.stdout(mutating ? renderNdjson(document) : renderJson(document));
	}
	io.stderr(`${bin}: ${error.message}\n`);
}
