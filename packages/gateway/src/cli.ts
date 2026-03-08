import { GatewayLifecycle } from "./gateway/lifecycle";
import { type Logger, logger } from "./gateway/logger";
import { createServer } from "./gateway/server";
import { EventBus } from "./session/event-bus";
import { SessionManager } from "./session/session-manager";

export interface ParsedArgs {
	port: number;
	authToken: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
	let port = 7878;
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
		} else if (flag === "--auth") {
			if (value === undefined) {
				throw new Error("--auth requires a value");
			}
			authToken = value;
			i++;
		}
	}

	if (authToken === undefined) {
		throw new Error("--auth <token> is required");
	}

	return { port, authToken };
}

/**
 * Emit a structured JSON startup log record.
 *
 * Logs an info-level record indicating the gateway is listening, including
 * the port number. Accepts an optional custom {@link Logger} to enable
 * testing without writing to `process.stderr`.
 *
 * @param port - The TCP port the gateway is bound to.
 * @param log  - Logger instance to write to. Defaults to the module logger singleton.
 */
export function startupLog(port: number, log: Logger = logger): void {
	log.info({ message: "draht-gateway listening", port });
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const { port, authToken } = parseArgs(args);

	const bus = new EventBus();
	const manager = new SessionManager(bus);

	const { app, websocket } = createServer({ port, authToken, manager });

	const server = Bun.serve({
		port,
		fetch: app.fetch,
		websocket,
	});

	startupLog(port);

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
