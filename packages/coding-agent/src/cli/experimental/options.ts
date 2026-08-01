import { posix } from "node:path";
import type { ThinkingLevel } from "@draht/agent-core";
import { isValidThinkingLevel, VALID_THINKING_LEVELS } from "../thinking-level.ts";
import { type ClientAuthInput, parseAuthInput, type ServerAuthInput } from "./auth-options.ts";

interface CommonOptions {
	readonly socketPath?: string;
	readonly cwd?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly help: boolean;
	readonly version: boolean;
}

export interface ExperimentalCombinedOptions extends CommonOptions {
	readonly role: "combined";
	readonly auth?: ServerAuthInput;
	readonly sessionId?: string;
	readonly initialPrompt?: string;
}

export interface ExperimentalServerOptions extends CommonOptions {
	readonly role: "server";
	readonly auth?: ServerAuthInput;
}

export interface ExperimentalClientOptions extends CommonOptions {
	readonly role: "client";
	readonly auth?: ClientAuthInput;
	readonly sessionId?: string;
	readonly initialPrompt?: string;
}

export type ExperimentalCliOptions =
	| ExperimentalCombinedOptions
	| ExperimentalServerOptions
	| ExperimentalClientOptions;

export type ExperimentalCliParseResult =
	| { readonly ok: true; readonly options: ExperimentalCliOptions }
	| { readonly ok: false; readonly errors: readonly string[] };

const VALUE_OPTIONS = new Set([
	"--socket",
	"--auth-token",
	"--auth-token-file",
	"--write-auth-token",
	"--session",
	"--cwd",
	"--provider",
	"--model",
	"--thinking",
]);

interface RawOptions {
	authToken?: string;
	authTokenFile?: string;
	writeAuthToken?: string;
	socketPath?: string;
	sessionId?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	help: boolean;
	version: boolean;
	positionals: string[];
}

function splitOption(argument: string): { option: string; inlineValue?: string } {
	const equals = argument.indexOf("=");
	return equals === -1
		? { option: argument }
		: { option: argument.slice(0, equals), inlineValue: argument.slice(equals + 1) };
}

function parseRawOptions(argv: readonly string[]): { raw: RawOptions; errors: string[] } {
	const raw: RawOptions = { help: false, version: false, positionals: [] };
	const errors: string[] = [];
	let positionalsOnly = false;

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (positionalsOnly) {
			raw.positionals.push(argument);
			continue;
		}
		if (argument === "--") {
			positionalsOnly = true;
			continue;
		}
		if (argument.startsWith("@")) {
			errors.push("@file arguments are not supported in experimental mode");
			continue;
		}
		if (!argument.startsWith("-")) {
			raw.positionals.push(argument);
			continue;
		}

		const { option, inlineValue } = splitOption(argument);
		if (option === "--help" || option === "-h" || option === "--version" || option === "-v") {
			if (inlineValue !== undefined) {
				errors.push(`${option} does not take a value`);
				continue;
			}
			if (option === "--help" || option === "-h") raw.help = true;
			else raw.version = true;
			continue;
		}
		if (!VALUE_OPTIONS.has(option)) {
			errors.push(`Unknown option: ${option}`);
			continue;
		}

		let value = inlineValue;
		if (value === undefined) {
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				value = next;
				index++;
			}
		}
		if (value === undefined || value === "") {
			errors.push(`${option} requires a value`);
			continue;
		}

		switch (option) {
			case "--socket":
				raw.socketPath = value;
				break;
			case "--auth-token":
				raw.authToken = value;
				break;
			case "--auth-token-file":
				raw.authTokenFile = value;
				break;
			case "--write-auth-token":
				raw.writeAuthToken = value;
				break;
			case "--session":
				raw.sessionId = value;
				break;
			case "--cwd":
				raw.cwd = value;
				break;
			case "--provider":
				raw.provider = value;
				break;
			case "--model":
				raw.model = value;
				break;
			case "--thinking":
				if (isValidThinkingLevel(value)) raw.thinking = value;
				else errors.push(`Invalid thinking level "${value}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`);
				break;
		}
	}
	return { raw, errors };
}

export function parseExperimentalCliOptions(argv: readonly string[]): ExperimentalCliParseResult {
	const [candidate, ...rest] = argv;
	const role = candidate === "server" || candidate === "client" ? candidate : "combined";
	const { raw, errors } = parseRawOptions(role === "combined" ? argv : rest);

	if (raw.provider !== undefined && raw.model === undefined) errors.push("--provider requires --model");
	if (raw.socketPath !== undefined && !posix.isAbsolute(raw.socketPath)) {
		errors.push("--socket requires an absolute Unix socket path");
	}
	const authErrors = role === "client" ? parseAuthInput(raw, "client").errors : parseAuthInput(raw, role).errors;
	errors.push(...authErrors);
	if (role === "server") {
		if (raw.sessionId !== undefined) errors.push("--session is only valid for combined or client mode");
		if (raw.positionals.length > 0) errors.push("An initial prompt is only valid for combined or client mode");
	}
	if (errors.length > 0) return { ok: false, errors };

	const common = {
		...(raw.socketPath === undefined ? {} : { socketPath: raw.socketPath }),
		...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
		...(raw.provider === undefined ? {} : { provider: raw.provider }),
		...(raw.model === undefined ? {} : { model: raw.model }),
		...(raw.thinking === undefined ? {} : { thinking: raw.thinking }),
		help: raw.help,
		version: raw.version,
	};
	if (role === "server") {
		const { auth } = parseAuthInput(raw, "server");
		return { ok: true, options: { role, ...common, ...(auth === undefined ? {} : { auth }) } };
	}
	const roleOptions = {
		...common,
		...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId }),
		...(raw.positionals.length === 0 ? {} : { initialPrompt: raw.positionals.join(" ") }),
	};
	if (role === "client") {
		const { auth } = parseAuthInput(raw, "client");
		return { ok: true, options: { role, ...roleOptions, ...(auth === undefined ? {} : { auth }) } };
	}
	const { auth } = parseAuthInput(raw, "combined");
	return { ok: true, options: { role, ...roleOptions, ...(auth === undefined ? {} : { auth }) } };
}
