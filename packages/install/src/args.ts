import { basename } from "node:path";
import { UsageError } from "./errors.ts";

/** The two product surfaces this single entry point serves, selected by the invoked bin's basename. */
export type BinName = "draht-install" | "draht-init";

/** The only channel this MVP resolves (spec §2 row 4 — `next` is a frozen 2026-03 artifact and is refused). */
export const SUPPORTED_CHANNELS = ["latest"] as const;
export type Channel = (typeof SUPPORTED_CHANNELS)[number];

/** Machine-level component-management verbs carried by `draht-install`. */
export const INSTALL_COMMANDS = ["plan", "install", "status", "doctor", "update", "uninstall"] as const;
export type InstallCommand = (typeof INSTALL_COMMANDS)[number];

export interface CliArgs {
	bin: BinName;
	/** The resolved verb. `draht-init` has a single implicit verb, also called `init`. */
	command: InstallCommand | "init";
	/** Explicit component selectors, deduplicated with first-occurrence order preserved. */
	selectors: string[];
	/** Non-selector positionals — currently only `draht-init`'s optional target directory. */
	positionals: string[];
	channel: Channel;
	json: boolean;
	help: boolean;
	version: boolean;
	yes: boolean;
	dryRun: boolean;
	full: boolean;
	failOnEmpty: boolean;
	check: boolean;
	force: boolean;
	all: boolean;
}

type FlagName =
	| "json"
	| "help"
	| "version"
	| "yes"
	| "dry-run"
	| "full"
	| "fail-on-empty"
	| "check"
	| "force"
	| "all"
	| "channel"
	| "component";

const BOOLEAN_FLAGS = new Set<FlagName>([
	"json",
	"help",
	"version",
	"yes",
	"dry-run",
	"full",
	"fail-on-empty",
	"check",
	"force",
	"all",
]);

/** The only short flags the contract allows (spec §3: `-h`, `-y`, `-n`). */
const SHORT_FLAGS: Record<string, FlagName> = {
	h: "help",
	y: "yes",
	n: "dry-run",
};

/** Flags always legal regardless of verb — they never mutate anything. */
const UNIVERSAL_FLAGS: FlagName[] = ["help", "version", "json"];

/** Per-verb flag allowlist. A flag outside its verb's list is a usage error, never silently ignored. */
const COMMAND_FLAGS: Record<CliArgs["command"], FlagName[]> = {
	plan: ["channel", "full", "fail-on-empty"],
	install: ["channel", "full", "fail-on-empty", "yes", "dry-run", "force"],
	status: ["check"],
	doctor: [],
	update: ["channel", "full", "fail-on-empty", "yes", "dry-run"],
	uninstall: ["yes", "dry-run", "all"],
	init: ["channel", "full", "fail-on-empty", "yes", "dry-run", "force", "component"],
};

/** Verbs that accept bare positional component selectors (`draht-init` uses `--component` so its positional can be the target dir). */
const COMMANDS_WITH_POSITIONAL_SELECTORS = new Set<CliArgs["command"]>(["plan", "install", "update", "uninstall"]);

const BIN_ALIASES: Record<string, BinName> = {
	"draht-install": "draht-install",
	// A direct `node dist/cli.js` (or a bundler-renamed entry) has no product
	// basename to dispatch on; the machine-level surface is the default.
	cli: "draht-install",
	index: "draht-install",
	"draht-init": "draht-init",
};

/**
 * Maps an invoked path (`process.argv[1]`, or a bare name) to a product
 * surface. Executable suffixes are stripped so the same bin works when npm
 * links it as `draht-install` and when it is run as `node .../cli.js`. An
 * unrecognized name is refused rather than defaulted, so a mis-linked bin is
 * loud instead of silently behaving like the wrong product.
 */
export function resolveBinName(invokedAs: string): BinName {
	const stripped = basename(invokedAs).replace(/\.(js|mjs|cjs|exe)$/i, "");
	const resolved = BIN_ALIASES[stripped];
	if (!resolved) {
		throw new UsageError(
			`unrecognized bin name "${stripped}": this entry point serves only draht-install and draht-init`,
			{ invokedAs },
		);
	}
	return resolved;
}

function defaults(bin: BinName): CliArgs {
	return {
		bin,
		command: bin === "draht-init" ? "init" : "plan",
		selectors: [],
		positionals: [],
		channel: "latest",
		json: false,
		help: false,
		version: false,
		yes: false,
		dryRun: false,
		full: false,
		failOnEmpty: false,
		check: false,
		force: false,
		all: false,
	};
}

function isInstallCommand(value: string): value is InstallCommand {
	return (INSTALL_COMMANDS as readonly string[]).includes(value);
}

/** Deduplicates while preserving first-occurrence order, so repeated selectors are deterministic. */
function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

/**
 * Parses one command line into a fully-resolved `CliArgs`. Every rejection is
 * a `UsageError`: unknown verbs, unknown flags, flags used on a verb that does
 * not accept them, missing flag values, unsupported channels, and
 * contradictory selection modes all fail closed here rather than reaching the
 * engine with a half-understood request.
 */
export function parseCliArgs(bin: BinName, argv: string[]): CliArgs {
	const args = defaults(bin);
	const rawSelectors: string[] = [];
	let commandSeen = bin === "draht-init";
	let sawExplicitSelector = false;
	// Flags are collected before the verb is known (`draht-install --json plan`
	// is legal), then validated against the verb's allowlist at the end.
	const usedFlags: Array<{ name: FlagName; token: string }> = [];

	const setFlag = (name: FlagName, token: string, value?: string): void => {
		usedFlags.push({ name, token });
		switch (name) {
			case "json":
				args.json = true;
				return;
			case "help":
				args.help = true;
				return;
			case "version":
				args.version = true;
				return;
			case "yes":
				args.yes = true;
				return;
			case "dry-run":
				args.dryRun = true;
				return;
			case "full":
				args.full = true;
				return;
			case "fail-on-empty":
				args.failOnEmpty = true;
				return;
			case "check":
				args.check = true;
				return;
			case "force":
				args.force = true;
				return;
			case "all":
				args.all = true;
				return;
			case "channel": {
				if (value === undefined) throw new UsageError(`--channel requires a value`);
				if (!(SUPPORTED_CHANNELS as readonly string[]).includes(value)) {
					throw new UsageError(`unsupported channel "${value}": this release resolves only the "latest" channel`, {
						channel: value,
					});
				}
				args.channel = value as Channel;
				return;
			}
			case "component": {
				if (value === undefined) throw new UsageError(`--component requires a value`);
				sawExplicitSelector = true;
				rawSelectors.push(value);
				return;
			}
		}
	};

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];

		if (token === "--") {
			// Everything after `--` is a positional, never a flag.
			for (let j = i + 1; j < argv.length; j++) rawSelectors.push(argv[j]);
			break;
		}

		if (token.startsWith("--")) {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			const name = (eq === -1 ? body : body.slice(0, eq)) as FlagName;
			const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

			if (!BOOLEAN_FLAGS.has(name) && name !== "channel" && name !== "component") {
				throw new UsageError(`unknown flag "${token}"`, { flag: token });
			}
			if (BOOLEAN_FLAGS.has(name)) {
				if (inlineValue !== undefined)
					throw new UsageError(`flag "--${name}" does not take a value`, { flag: token });
				setFlag(name, token);
				continue;
			}
			// Value flag: accept both `--flag=value` and `--flag value`.
			let value = inlineValue;
			if (value === undefined) {
				value = argv[i + 1];
				if (value === undefined || value.startsWith("-")) {
					throw new UsageError(`flag "--${name}" requires a value`, { flag: token });
				}
				i += 1;
			}
			setFlag(name, token, value);
			continue;
		}

		if (token.startsWith("-") && token.length > 1) {
			// Short flags are single-letter only; no clustering, no short value flags.
			const letter = token.slice(1);
			const mapped = SHORT_FLAGS[letter];
			if (!mapped) throw new UsageError(`unknown flag "${token}"`, { flag: token });
			setFlag(mapped, token);
			continue;
		}

		if (!commandSeen) {
			if (!isInstallCommand(token)) {
				throw new UsageError(`unknown command "${token}"`, { command: token });
			}
			args.command = token;
			commandSeen = true;
			continue;
		}

		if (bin === "draht-init") {
			if (args.positionals.length > 0) {
				throw new UsageError(`draht-init accepts at most one target directory (got "${token}" as a second)`, {
					positional: token,
				});
			}
			args.positionals.push(token);
			continue;
		}

		sawExplicitSelector = true;
		rawSelectors.push(token);
	}

	if (bin === "draht-install" && !commandSeen && !args.help && !args.version) {
		// No verb at all: a bare invocation prints usage rather than guessing a
		// command, and a flags-only invocation is a usage error.
		if (argv.length === 0) args.help = true;
		else throw new UsageError("missing command");
	}

	args.selectors = dedupe(rawSelectors);

	if (args.help || args.version) return args;

	if (!COMMANDS_WITH_POSITIONAL_SELECTORS.has(args.command) && args.selectors.length > 0 && args.command !== "init") {
		throw new UsageError(`"${args.command}" does not accept component selectors`, { selectors: args.selectors });
	}

	const allowed = new Set<FlagName>([...UNIVERSAL_FLAGS, ...COMMAND_FLAGS[args.command]]);
	for (const used of usedFlags) {
		if (!allowed.has(used.name)) {
			throw new UsageError(`flag "${used.token}" is not valid for "${args.command}"`, {
				flag: used.token,
				command: args.command,
			});
		}
	}

	if (args.full && sawExplicitSelector) {
		throw new UsageError("--full selects every component and cannot be combined with explicit component selectors", {
			selectors: args.selectors,
		});
	}

	if (args.command === "uninstall" && args.selectors.length === 0 && !args.all) {
		throw new UsageError("uninstall requires explicit component selectors or --all");
	}
	if (args.command === "uninstall" && args.selectors.length > 0 && args.all) {
		throw new UsageError("--all removes every installed component and cannot be combined with selectors");
	}

	return args;
}
