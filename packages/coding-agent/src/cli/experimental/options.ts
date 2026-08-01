import { type AuthInput, parseAuthInput } from "./auth-options.ts";
import { parseTransportAddress, type TransportAddress } from "./transport-address.ts";

interface ExperimentalOptionsBase {
	readonly role: "combined" | "server" | "client";
	readonly auth?: AuthInput;
	readonly remainingArgs: readonly string[];
}

export interface ExperimentalCombinedOptions extends ExperimentalOptionsBase {
	readonly role: "combined";
	readonly listen?: readonly TransportAddress[];
}

export interface ExperimentalServerOptions extends ExperimentalOptionsBase {
	readonly role: "server";
	readonly listen?: readonly TransportAddress[];
}

export interface ExperimentalClientOptions extends ExperimentalOptionsBase {
	readonly role: "client";
	readonly connect?: TransportAddress;
}

export type ExperimentalCliOptions =
	| ExperimentalCombinedOptions
	| ExperimentalServerOptions
	| ExperimentalClientOptions;

export type ExperimentalCliParseResult =
	| { readonly ok: true; readonly options: ExperimentalCliOptions }
	| { readonly ok: false; readonly errors: readonly string[] };

const VALUE_OPTIONS = new Set(["--listen", "--connect", "--auth-token", "--auth-token-file"]);

interface RawExperimentalOptions {
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

function parseRawOptions(argv: readonly string[]): { raw: RawExperimentalOptions; errors: string[] } {
	const raw: RawExperimentalOptions = { listenValues: [], remainingArgs: [] };
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

export function parseExperimentalCliOptions(argv: readonly string[]): ExperimentalCliParseResult {
	const [candidate, ...rest] = argv;
	const role = candidate === "server" || candidate === "client" ? candidate : "combined";
	const { raw, errors } = parseRawOptions(role === "combined" ? argv : rest);
	const listen = raw.listenValues.flatMap((value) => {
		const result = parseTransportAddress(value, "--listen");
		if (result.error) errors.push(result.error);
		return result.address ? [result.address] : [];
	});
	const connectResult = raw.connectValue ? parseTransportAddress(raw.connectValue, "--connect") : undefined;
	if (connectResult?.error) errors.push(connectResult.error);
	const { auth, errors: authErrors } = parseAuthInput(raw);
	errors.push(...authErrors);
	if (role === "client" && raw.listenValues.length > 0) {
		errors.push("--listen is only valid for combined or server mode");
	}
	if (role !== "client" && raw.connectValue !== undefined) errors.push("--connect is only valid for client mode");
	if (errors.length > 0) return { ok: false, errors };

	const common = {
		remainingArgs: raw.remainingArgs,
		...(auth === undefined ? {} : { auth }),
	};
	if (role === "client") {
		return {
			ok: true,
			options: {
				...common,
				role,
				...(connectResult?.address === undefined ? {} : { connect: connectResult.address }),
			},
		};
	}
	return {
		ok: true,
		options: {
			...common,
			role,
			...(listen.length === 0 ? {} : { listen }),
		},
	};
}
