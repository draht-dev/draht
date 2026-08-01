import { type AuthInput, parseAuthInput } from "./auth.ts";
import { parseTransportAddress, type TransportAddress } from "./transport-address.ts";

interface CommandBase {
	readonly command: "combined" | "server" | "client";
	readonly auth?: AuthInput;
	readonly remainingArgs: readonly string[];
}

export interface CombinedCommand extends CommandBase {
	readonly command: "combined";
	readonly listen?: readonly TransportAddress[];
}

export interface ServerCommand extends CommandBase {
	readonly command: "server";
	readonly listen?: readonly TransportAddress[];
}

export interface ClientCommand extends CommandBase {
	readonly command: "client";
	readonly connect?: TransportAddress;
}

export type CliCommand = CombinedCommand | ServerCommand | ClientCommand;

export type CliCommandParseResult =
	| { readonly ok: true; readonly command: CliCommand }
	| { readonly ok: false; readonly errors: readonly string[] };

const VALUE_OPTIONS = new Set(["--listen", "--connect", "--auth-token", "--auth-token-file"]);

interface RawCommandOptions {
	authToken?: string;
	authTokenFile?: string;
	listenValues: string[];
	connectValue?: string;
	remainingArgs: string[];
}

function splitOption(argument: string): { option: string; inlineValue?: string } {
	const equals = argument.indexOf("=");
	return equals === -1
		? { option: argument }
		: { option: argument.slice(0, equals), inlineValue: argument.slice(equals + 1) };
}

function parseRawOptions(argv: readonly string[]): { raw: RawCommandOptions; errors: string[] } {
	const raw: RawCommandOptions = { listenValues: [], remainingArgs: [] };
	const errors: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "--") {
			raw.remainingArgs.push(...argv.slice(index));
			break;
		}

		const { option, inlineValue } = splitOption(argument);
		if (!VALUE_OPTIONS.has(option)) {
			raw.remainingArgs.push(argument);
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
		}
	}
	return { raw, errors };
}

export function parseCliCommand(argv: readonly string[]): CliCommandParseResult {
	const [candidate, ...rest] = argv;
	const commandName = candidate === "server" || candidate === "client" ? candidate : "combined";
	const { raw, errors } = parseRawOptions(commandName === "combined" ? argv : rest);
	const listen = raw.listenValues.flatMap((value) => {
		const result = parseTransportAddress(value, "--listen");
		if (result.error) errors.push(result.error);
		return result.address ? [result.address] : [];
	});
	const connectResult = raw.connectValue ? parseTransportAddress(raw.connectValue, "--connect") : undefined;
	if (connectResult?.error) errors.push(connectResult.error);
	const { auth, errors: authErrors } = parseAuthInput(raw);
	errors.push(...authErrors);
	if (commandName === "client" && raw.listenValues.length > 0) {
		errors.push("--listen is only valid for combined or server mode");
	}
	if (commandName !== "client" && raw.connectValue !== undefined) {
		errors.push("--connect is only valid for client mode");
	}
	if (errors.length > 0) return { ok: false, errors };

	const common = {
		remainingArgs: raw.remainingArgs,
		...(auth === undefined ? {} : { auth }),
	};
	if (commandName === "client") {
		return {
			ok: true,
			command: {
				...common,
				command: commandName,
				...(connectResult?.address === undefined ? {} : { connect: connectResult.address }),
			},
		};
	}
	return {
		ok: true,
		command: {
			...common,
			command: commandName,
			...(listen.length === 0 ? {} : { listen }),
		},
	};
}
