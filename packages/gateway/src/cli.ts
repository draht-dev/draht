import { existsSync } from "node:fs";
import {
	DEVICE_REGISTRY_PATH_ENV,
	DeviceRegistry,
	type DeviceRegistryEvent,
	resolveDeviceRegistryPath,
} from "@draht/geist-core";
import { CONFIG_PATH, createDefaultConfigFile, type GatewaySettings, loadConfigSync } from "./config/config";
import { assertBindHostAllowed } from "./gateway/bind-host";
import { GatewayLifecycle } from "./gateway/lifecycle";
import { type Logger, logger } from "./gateway/logger";
import type { AttachDeviceAuthenticator } from "./gateway/routes/fleet";
import { type BoundServer, type StartGatewayOptions, startGateway } from "./gateway/server";
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

/**
 * Credential lifetime the daemon stamps on an issued `device_credential`.
 *
 * A horizon, not an expiry the store enforces: `DeviceRegistry` retires a
 * credential when its successor is minted, and every reconnect mints one, so a
 * device that keeps connecting is re-stamped long before this lapses. It is
 * advertised so a renderer knows when to expect to re-bootstrap rather than to
 * sit on a value forever; the daemon does not yet refuse on it, and that gap
 * belongs to the store, not to this wiring.
 */
const CREDENTIAL_TTL_MS = 86_400_000;

/** Injection seams for the device wiring, so a test needs neither `$HOME` nor stderr. */
export interface DeviceWiringOptions {
	/** Environment the store path is resolved from. Defaults to this process's. */
	env?: NodeJS.ProcessEnv;
	/** Where the store's audit trail goes. Defaults to the module logger. */
	log?: Logger;
}

/**
 * Build the `devices` port `startGateway` reads, or decide this daemon has none.
 *
 * ## Why there is a decision here at all
 *
 * `createServer` hands `config.devices` to `createFleetRoutes` once, when the
 * surface is built, and `attachAuthentication` reads its *presence* on every
 * upgrade: a store means `/attach` authenticates devices, no store means the
 * shared operator token still vouches for a connection the way it did before
 * pairing existed (outcome 2). So the posture is fixed at startup and this
 * function is what fixes it.
 *
 * Two answers count as "this machine has a device store", and both are things
 * an operator did rather than things this code guessed:
 *
 *  - `GEIST_DEVICES_PATH` names one — explicit configuration, and how every
 *    fronted deployment in this repo is wired, because the daemon and
 *    `geist devices` must resolve one file rather than two;
 *  - the default store already exists at {@link resolveDeviceRegistryPath},
 *    which is where `geist pair` wrote it the first time it ran here.
 *
 * A machine with neither has never paired anything, and turning its `/attach`
 * into device-only would lock out the operator token it ships with today. The
 * *file* being absent is emphatically not such a case: a configured daemon
 * starts before `geist pair` writes the store, and `DeviceRegistry` re-stats on
 * every call precisely so the store can appear underneath it.
 *
 * The wart this leaves, named rather than hidden: on the default path the very
 * first `geist pair` on a machine whose daemon is already running writes a store
 * that daemon will not adopt until it restarts — which is what the warning below
 * tells the operator. Closing it means `createFleetRoutes` taking a provider
 * rather than a value, a change to that route's contract and not this file's.
 *
 * @returns the port, or `undefined` on a daemon with no store to authenticate against.
 */
export function createDeviceAuthenticator(options: DeviceWiringOptions = {}): AttachDeviceAuthenticator | undefined {
	const env = options.env ?? process.env;
	const log = options.log ?? logger;
	// The same helper `geist devices` resolves from, given the same environment:
	// one file by construction rather than by two agreeing conventions.
	const path = resolveDeviceRegistryPath(env);
	const configured = env[DEVICE_REGISTRY_PATH_ENV] !== undefined && env[DEVICE_REGISTRY_PATH_ENV] !== "";

	if (!configured && !existsSync(path)) {
		log.warn({
			message: "no device store: /attach still accepts the operator token",
			path,
			hint: `run 'geist pair' to create the store, then restart the daemon (or set ${DEVICE_REGISTRY_PATH_ENV}) to require per-device credentials`,
		});
		return undefined;
	}

	const registry = new DeviceRegistry({
		path,
		// The audit trail an operator actually sees. `DeviceRegistryEvent` carries
		// a type, a device id and a timestamp and has no field a credential could
		// travel in — which is why this can be logged verbatim.
		onEvent: (event: DeviceRegistryEvent) => {
			const record = { event: event.type, deviceId: event.deviceId, at: new Date(event.at).toISOString(), path };
			if (event.type === "credential_reuse") {
				// The theft signal: somebody presented a credential that was rotated
				// away, which is not a typo — a wrong guess is reported as a
				// mismatch and raises nothing. Deliberately unlabelled with a
				// finding id; operator-facing records carry none.
				log.warn({
					message: "a retired device credential was presented; treat this device as compromised",
					...record,
				});
				return;
			}
			log.info({ message: "device registry event", ...record });
		},
		// A store that cannot watch itself has lost the push half of R33-REACH.6.
		// It still cuts a revoked device off, one poll later, but an operator who
		// is not told has a control that only looks like it works.
		onDegraded: (message: string) => log.warn({ message }),
	});

	log.info({ message: "device credentials enabled", path });

	/** Success, in the shape the `device_credential` frame is built from. */
	const issued = (result: { deviceId: string; credential: string }) => {
		const at = Date.now();
		return {
			ok: true as const,
			deviceId: result.deviceId,
			credential: result.credential,
			issuedAt: new Date(at).toISOString(),
			expiresAt: new Date(at + CREDENTIAL_TTL_MS).toISOString(),
		};
	};

	/**
	 * Run one exchange, and turn a store that could not answer into a refusal.
	 *
	 * `DeviceRegistry` throws on a store it cannot parse rather than degrading to
	 * empty — the right call, because "empty" would silently discard the
	 * revocation list. But these two methods are called from a WebSocket message
	 * callback, and an exception thrown through one refuses nobody, answers
	 * nobody and is recorded nowhere. So the composition root translates it into
	 * this port's own vocabulary, which is a refusal, and says on the daemon's
	 * log exactly which file it could not read. Failing closed and loudly: no
	 * caller is authenticated by a store that is not readable.
	 */
	const attempt = (what: string, run: () => ReturnType<typeof issued> | { ok: false; reason?: string }) => {
		try {
			return run();
		} catch (error) {
			log.error({
				message: `the device store could not be read; ${what} was refused`,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			return { ok: false as const, reason: "the device store could not be read" };
		}
	};

	return {
		pair(input) {
			return attempt("a pairing exchange", () => {
				const result = registry.exchange(input.bootstrapToken, input.device);
				return result.ok ? issued(result) : { ok: false, reason: result.reason };
			});
		},
		authenticate(input) {
			return attempt("an authentication", () => {
				// Verify then rotate, in that order and never one without the other:
				// R33-REACH.5 makes the predecessor dead the instant the successor is
				// minted, so a credential that authenticated once cannot do it twice.
				const verified = registry.verify(input.deviceId, input.credential);
				if (!verified.ok) return { ok: false, reason: verified.outcome };
				const rotated = registry.rotate(input.deviceId);
				return rotated.ok ? issued(rotated) : { ok: false, reason: rotated.reason };
			});
		},
		// Asked about an identity rather than a secret, before every frame the
		// bridge emits — the half that reaches a phone that is only reading.
		isRevoked: (deviceId: string) => registry.isRevoked(deviceId),
		// And the push, so a revocation reaches a connection with no traffic at all.
		subscribe: (listener: () => void) => registry.subscribe(listener),
	};
}

/**
 * The single options object the daemon starts from.
 *
 * Exported because it is the composition root: everything the shipped binary
 * exposes is decided here, and a port that is only filled inside `main()` is a
 * port nothing can prove is filled. `main()` calls this and passes the result
 * straight to `startGateway`.
 */
export function gatewayOptions(
	parsed: ParsedArgs,
	manager: SessionManager,
	options: DeviceWiringOptions = {},
): StartGatewayOptions {
	return {
		port: parsed.port,
		host: parsed.host,
		authToken: parsed.authToken,
		manager,
		config: parsed.config,
		allowNonLoopback: parsed.allowNonLoopback,
		devices: createDeviceAuthenticator(options),
	};
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
	const bus = new EventBus();
	const manager = new SessionManager(bus);

	const { server } = startGateway(gatewayOptions(parsed, manager));

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
