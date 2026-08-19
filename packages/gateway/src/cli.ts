import { CONFIG_PATH, createDefaultConfigFile, type GatewaySettings, loadConfigSync } from "./config/config";
import { assertBindHostAllowed } from "./gateway/bind-host";
import { GatewayLifecycle } from "./gateway/lifecycle";
import { type Logger, logger } from "./gateway/logger";
import { type BoundServer, startGateway } from "./gateway/server";
import { EventBus } from "./session/event-bus";
import { SessionManager } from "./session/session-manager";

export { isLoopbackHost, nonLoopbackBindError, nonLoopbackBindWarning } from "./gateway/bind-host";

export interface ParsedArgs {
	port: number;
	host: string;
	authToken: string;
	config: GatewaySettings;
	/** True when the operator explicitly opted into a non-loopback bind. */
	allowNonLoopback: boolean;
}

/** Injection seam so the loopback warning can be asserted in tests. */
export interface ParseArgsOptions {
	warn?: (message: string) => void;
}

/**
 * Read the value that follows a value-taking flag.
 *
 * A value that itself looks like a flag is rejected rather than consumed:
 * `--auth --allow-non-loopback` must not start the gateway with the literal
 * string `--allow-non-loopback` as its bearer token *and* silently drop the
 * opt-in the operator asked for.
 *
 * @param flag - The flag being parsed, for the error message.
 * @param value - The next argv entry, if any.
 * @param what - What the flag expects ("a value", "a token name", …).
 * @throws Error when the value is missing or is itself a flag.
 */
function requireValue(flag: string, value: string | undefined, what: string): string {
	if (value === undefined) {
		throw new Error(`${flag} requires ${what}`);
	}
	if (value.startsWith("--")) {
		throw new Error(`${flag} requires ${what}, but got the flag '${value}'`);
	}
	return value;
}

export function parseArgs(argv: string[], config: GatewaySettings, options: ParseArgsOptions = {}): ParsedArgs {
	let port = config.port;
	let host = config.host;
	let authToken: string | undefined;
	let allowNonLoopback = false;

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = argv[i + 1];

		if (flag === "--port") {
			const value = requireValue(flag, next, "a value");
			const parsed = parseInt(value, 10);
			if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
				throw new Error(`--port must be a number between 1 and 65535, got: ${value}`);
			}
			port = parsed;
			i++;
		} else if (flag === "--host") {
			host = requireValue(flag, next, "a value");
			i++;
		} else if (flag === "--auth") {
			authToken = requireValue(flag, next, "a value");
			i++;
		} else if (flag === "--allow-non-loopback") {
			// Explicit, documented opt-out of the loopback-by-default bind posture.
			allowNonLoopback = true;
		} else if (flag === "--token") {
			// Use a named token from config
			const value = requireValue(flag, next, "a token name");
			const token = config.tokens[value];
			if (!token) {
				throw new Error(
					`Token '${value}' not found in config. Available tokens: ${Object.keys(config.tokens).join(", ")}`,
				);
			}
			authToken = token;
			i++;
		}
	}

	// Enforced here as well as in createServer, so a non-loopback host is caught
	// wherever it came from: the --host flag OR a stale
	// ~/.draht/gateway.config.json still carrying host: "0.0.0.0".
	assertBindHostAllowed({ host, allowNonLoopback, warn: options.warn });

	// Try to use default token from config if no --auth or --token provided
	if (authToken === undefined) {
		if (config.tokens.default) {
			authToken = config.tokens.default;
		} else {
			throw new Error("--auth <token> or --token <name> is required (or set tokens.default in config)");
		}
	}

	return { port, host, authToken, config, allowNonLoopback };
}

/**
 * Handle `--init-config`: create the default config file and report the result.
 *
 * An explicit, awaited command rather than a branch inside argv parsing — the
 * previous shape kicked off an unawaited promise and threw an "unreachable"
 * sentinel, which the CLI's error handler turned into a bare `unreachable` on
 * stderr and exit 1 before the message could print.
 *
 * @param configPath - Where to create the file. Defaults to {@link CONFIG_PATH};
 *                     tests pass a temp path so the real `~/.draht` is untouched.
 * @param log - Sink for the operator-facing message. Defaults to `console.log`.
 * @returns The process exit code to use (0).
 */
export async function runInitConfig(
	configPath: string = CONFIG_PATH,
	log: (message: string) => void = console.log,
): Promise<number> {
	const created = await createDefaultConfigFile(configPath);
	log(created ? `Created default config at ${created}` : `Config already exists at ${configPath}`);
	return 0;
}

/** Single wording for the "we are listening" record. */
const LISTENING_MESSAGE = "draht-gateway listening";

/**
 * Emit a structured JSON startup log record.
 *
 * Logs an info-level record indicating the gateway is listening, including
 * the host and port. Accepts an optional custom {@link Logger} to enable
 * testing without writing to `process.stderr`.
 *
 * Prefer {@link startupLogForServer} in application code: the operator record
 * of "what am I exposing" must describe the socket that actually exists.
 *
 * @param host - The host/interface the gateway is bound to.
 * @param port - The TCP port the gateway is bound to.
 * @param log  - Logger instance to write to. Defaults to the module logger singleton.
 */
export function startupLog(host: string, port: number, log: Logger = logger): void {
	log.info({ message: LISTENING_MESSAGE, host, port });
}

/**
 * Log the address the server actually bound.
 *
 * The requested host/port and the bound host/port are not the same thing —
 * `port: 0` becomes an ephemeral port, and the hostname is resolved by the
 * runtime. Reporting the request would make the exposure record untrue.
 *
 * @param server - The listening server to describe.
 * @param log - Logger instance to write to.
 */
export function startupLogForServer(server: BoundServer, log: Logger = logger): void {
	log.info({ message: LISTENING_MESSAGE, host: server.hostname, port: server.port });
}

async function main(argv: string[]): Promise<void> {
	// Handled before anything else: `--init-config` neither needs nor should be
	// blocked by a loadable config or a valid bind host.
	if (argv.includes("--init-config")) {
		process.exit(await runInitConfig());
	}

	// Config and argument/bind-policy failures are operator errors, not crashes —
	// print the message on its own so the guidance is not buried in a stack trace.
	let parsed: ParsedArgs;
	let config: GatewaySettings;
	try {
		config = loadConfigSync();
		// The refusal still happens here (nothing is built if the host is not
		// allowed), but the *warning* is suppressed: startGateway emits it once,
		// at the moment the socket is actually opened, so the operator sees one
		// record rather than two.
		parsed = parseArgs(argv, config, { warn: () => {} });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	const { port, host, authToken, allowNonLoopback } = parsed;

	const bus = new EventBus();
	const manager = new SessionManager(bus);

	const { server } = startGateway({
		port,
		host,
		authToken,
		manager,
		config,
		allowNonLoopback,
	});

	startupLogForServer(server);

	const lifecycle = new GatewayLifecycle(server, manager);

	const handleSignal = (signal: string) => {
		lifecycle.shutdown().then((count) => {
			logger.info({ message: "draht-gateway shutdown complete", signal, sessionsDestroyed: count });
			process.exit(0);
		});
	};

	process.on("SIGTERM", () => handleSignal("SIGTERM"));
	process.on("SIGINT", () => handleSignal("SIGINT"));
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
