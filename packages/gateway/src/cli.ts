import { CONFIG_PATH, createDefaultConfigFile, type GatewaySettings, loadConfigSync } from "./config/config";
import { GatewayLifecycle } from "./gateway/lifecycle";
import { type Logger, logger } from "./gateway/logger";
import { createServer } from "./gateway/server";
import { EventBus } from "./session/event-bus";
import { SessionManager } from "./session/session-manager";

export interface ParsedArgs {
	port: number;
	host: string;
	authToken: string;
	config: GatewaySettings;
}

export function parseArgs(argv: string[], config: GatewaySettings): ParsedArgs {
	let port = config.port;
	let host = config.host;
	let authToken: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];

		if (flag === "--port") {
			if (value === undefined) {
				throw new Error("--port requires a value");
			}
			const parsed = parseInt(value, 10);
			if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
				throw new Error(`--port must be a number between 1 and 65535, got: ${value}`);
			}
			port = parsed;
			i++;
		} else if (flag === "--host") {
			if (value === undefined) {
				throw new Error("--host requires a value");
			}
			host = value;
			i++;
		} else if (flag === "--auth") {
			if (value === undefined) {
				throw new Error("--auth requires a value");
			}
			authToken = value;
			i++;
		} else if (flag === "--token") {
			// Use a named token from config
			if (value === undefined) {
				throw new Error("--token requires a token name");
			}
			const token = config.tokens[value];
			if (!token) {
				throw new Error(
					`Token '${value}' not found in config. Available tokens: ${Object.keys(config.tokens).join(", ")}`,
				);
			}
			authToken = token;
			i++;
		} else if (flag === "--init-config") {
			// Create default config file and exit
			createDefaultConfigFile().then((path) => {
				if (path) {
					console.log(`Created default config at ${path}`);
				} else {
					console.log(`Config already exists at ${CONFIG_PATH}`);
				}
				process.exit(0);
			});
			// This will exit before returning, but TypeScript doesn't know that
			throw new Error("unreachable");
		}
	}

	// Try to use default token from config if no --auth or --token provided
	if (authToken === undefined) {
		if (config.tokens.default) {
			authToken = config.tokens.default;
		} else {
			throw new Error("--auth <token> or --token <name> is required (or set tokens.default in config)");
		}
	}

	return { port, host, authToken, config };
}

/**
 * Emit a structured JSON startup log record.
 *
 * Logs an info-level record indicating the gateway is listening, including
 * the host and port. Accepts an optional custom {@link Logger} to enable
 * testing without writing to `process.stderr`.
 *
 * @param host - The host/interface the gateway is bound to.
 * @param port - The TCP port the gateway is bound to.
 * @param log  - Logger instance to write to. Defaults to the module logger singleton.
 */
export function startupLog(host: string, port: number, log: Logger = logger): void {
	log.info({ message: "draht-gateway listening", host, port });
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const config = loadConfigSync();
	const { port, host, authToken } = parseArgs(args, config);

	const bus = new EventBus();
	const manager = new SessionManager(bus);

	const { app, websocket } = createServer({ port, authToken, manager, config });

	const server = Bun.serve({
		port,
		hostname: host,
		fetch: app.fetch,
		websocket,
		// Use configured idle timeout (max 255)
		idleTimeout: config.idleTimeout,
	});

	startupLog(host, port);

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
