import type { ThinkingLevel } from "@draht/agent-core";
import { isValidThinkingLevel, VALID_THINKING_LEVELS } from "../thinking-level.ts";
import { type AuthInput, parseAuthInput } from "./auth-options.ts";
import { type ExperimentalEndpoint, parseExperimentalEndpoint } from "./endpoint.ts";

interface CommonOptions {
	readonly cwd?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly help: boolean;
	readonly version: boolean;
}

export interface ExperimentalCombinedOptions extends CommonOptions {
	readonly role: "combined";
	readonly listen?: readonly ExperimentalEndpoint[];
	readonly auth?: AuthInput;
	readonly sessionId?: string;
	readonly initialPrompt?: string;
}

export interface ExperimentalServerOptions extends CommonOptions {
	readonly role: "server";
	readonly listen?: readonly ExperimentalEndpoint[];
	readonly auth?: AuthInput;
}

export interface ExperimentalClientOptions extends CommonOptions {
	readonly role: "client";
	readonly connect?: ExperimentalEndpoint;
	readonly auth?: AuthInput;
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
	"--listen",
	"--connect",
	"--auth-token",
	"--auth-token-file",
	"--session",
	"--cwd",
	"--provider",
	"--model",
	"--thinking",
]);

interface RawOptions {
	authToken?: string;
	authTokenFile?: string;
	listenValues: string[];
	connectValue?: string;
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
	const raw: RawOptions = { listenValues: [], help: false, version: false, positionals: [] };
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
			case "--listen":
				raw.listenValues.push(value);
				break;
			case "--connect":
				if (raw.connectValue !== undefined) errors.push("--connect may only be specified once");
				raw.connectValue = value;
				break;
			case "--auth-token":
				raw.authToken = value;
				break;
			case "--auth-token-file":
				raw.authTokenFile = value;
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
	const listen = raw.listenValues.flatMap((value) => {
		const result = parseExperimentalEndpoint(value, "--listen");
		if (result.error) errors.push(result.error);
		return result.endpoint ? [result.endpoint] : [];
	});
	const connectResult = raw.connectValue ? parseExperimentalEndpoint(raw.connectValue, "--connect") : undefined;
	if (connectResult?.error) errors.push(connectResult.error);
	errors.push(...parseAuthInput(raw).errors);
	if (role === "client" && raw.listenValues.length > 0) {
		errors.push("--listen is only valid for combined or server mode");
	}
	if (role !== "client" && raw.connectValue !== undefined) errors.push("--connect is only valid for client mode");
	if (role === "server") {
		if (raw.sessionId !== undefined) errors.push("--session is only valid for combined or client mode");
		if (raw.positionals.length > 0) errors.push("An initial prompt is only valid for combined or client mode");
	}
	if (errors.length > 0) return { ok: false, errors };

	const common = {
		...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
		...(raw.provider === undefined ? {} : { provider: raw.provider }),
		...(raw.model === undefined ? {} : { model: raw.model }),
		...(raw.thinking === undefined ? {} : { thinking: raw.thinking }),
		help: raw.help,
		version: raw.version,
	};
	const { auth } = parseAuthInput(raw);
	if (role === "server") {
		return {
			ok: true,
			options: {
				role,
				...common,
				...(listen.length === 0 ? {} : { listen }),
				...(auth === undefined ? {} : { auth }),
			},
		};
	}
	const roleOptions = {
		...common,
		...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId }),
		...(raw.positionals.length === 0 ? {} : { initialPrompt: raw.positionals.join(" ") }),
	};
	if (role === "client") {
		return {
			ok: true,
			options: {
				role,
				...roleOptions,
				...(connectResult?.endpoint === undefined ? {} : { connect: connectResult.endpoint }),
				...(auth === undefined ? {} : { auth }),
			},
		};
	}
	return {
		ok: true,
		options: {
			role,
			...roleOptions,
			...(listen.length === 0 ? {} : { listen }),
			...(auth === undefined ? {} : { auth }),
		},
	};
}
