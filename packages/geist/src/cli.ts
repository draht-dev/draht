#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { DeviceRegistry } from "@draht/geist-core";
import { runDevices } from "./commands/devices.js";
import { runPair } from "./commands/pair.js";
import { resolveConfigPath } from "./index.js";
import type { CommandRunner } from "./tailscale.js";

/**
 * The `geist` CLI's front door.
 *
 * Two shapes matter here and neither is incidental.
 *
 * **Dispatch is a real function, not a top-level script.** {@link runCli} takes
 * argv and its dependencies and returns an exit code; the module only runs
 * itself when it *is* the entry point. That is what lets `geist pair` be tested
 * against a stubbed `tailscale serve status --json` and a temporary device
 * store, in-process, with no tailnet and no subprocess. A CLI whose behaviour
 * only exists at module scope is a CLI whose behaviour is only ever asserted by
 * spawning it and grepping, which is how the interesting cases — no serve
 * mapping, a bypassed origin — end up untested.
 *
 * **An unknown subcommand fails loudly at exit 2.** Not 0, not 1: 2 is the
 * conventional usage error, and it is distinct from every failure `geist pair`
 * itself can return, so a script wrapping this CLI can tell "you typed it
 * wrong" from "the tailnet is not ready". Silently doing nothing on a
 * mistyped subcommand is how an operator concludes pairing is broken.
 *
 * `--config` is global and parsed out before dispatch, so it keeps working
 * wherever it appears (spec §6's precedence lives in {@link resolveConfigPath}).
 */

const USAGE = [
	"usage: geist <command> [options]",
	"",
	"commands:",
	"  geist pair                 print a QR and deep link that pair a phone with this daemon",
	"  geist devices list         list paired devices",
	"  geist devices revoke <id>  revoke a paired device",
	"",
	"global options:",
	"  --config <path>            geist.yaml to use (default: ./geist.yaml, then ~/.geist/config.yaml)",
].join("\n");

export interface CliDeps {
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	/** Seam to the `tailscale` binary, threaded through to `geist pair`. */
	run?: CommandRunner;
	/** Device credential store. Injected so a test — or a daemon — can supply its own path. */
	registry?: DeviceRegistry;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

interface Split {
	config?: string;
	rest: string[];
	error?: string;
}

/** Pulls the global `--config <path>` out of argv wherever it appears, leaving the subcommand's own flags. */
function splitGlobalFlags(argv: string[]): Split {
	const rest: string[] = [];
	let config: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--config") {
			rest.push(argv[i] as string);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined) return { rest, error: "--config needs a path" };
		config = value;
		i++;
	}

	return { config, rest };
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? ((text: string) => console.log(text));
	const stderr = deps.stderr ?? ((text: string) => console.error(text));

	const split = splitGlobalFlags(argv);
	if (split.error) {
		stderr(`geist: ${split.error}`);
		stderr(USAGE);
		return 2;
	}

	const [subcommand, ...rest] = split.rest;

	if (subcommand === undefined) {
		stdout(USAGE);
		stdout("");
		stdout(`config: ${resolveConfigPath({ explicit: split.config, cwd: deps.cwd })}`);
		return 0;
	}

	switch (subcommand) {
		case "pair":
			return runPair(rest, {
				registry: deps.registry,
				run: deps.run,
				stdout,
				stderr,
				env: deps.env,
			});
		case "devices":
			return runDevices(rest, { stdout, stderr, registry: deps.registry });
		default:
			stderr(`geist: unknown subcommand '${subcommand}'`);
			stderr("run `geist` with no arguments for the list of commands");
			return 2;
	}
}

/**
 * True when this module is the process entry point. `realpathSync` matters:
 * the installed binary is a symlink (`node_modules/.bin/geist`), Node resolves
 * the ES module to its real path, and a naive comparison against `argv[1]`
 * would therefore be false exactly when the CLI is installed — the one case
 * that must work.
 */
function isEntryPoint(moduleUrl: string): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return moduleUrl === pathToFileURL(realpathSync(entry)).href;
	} catch {
		return false;
	}
}

if (isEntryPoint(import.meta.url)) {
	runCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(`geist: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		});
}
