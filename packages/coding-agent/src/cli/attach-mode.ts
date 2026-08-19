/**
 * Attach mode - Connect to an existing socket-based draht session
 *
 * Provides tmux-style attachment where you can see output and send input
 * to a running session. Multiple clients can attach simultaneously.
 */

import path from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.js";
import { assertValidSessionId } from "../core/session-manager.js";
import { SocketClient } from "../core/socket-server/index.js";

/**
 * Build the socket path for a session id supplied on the command line.
 *
 * The value is validated with the same rule the session manager applies when creating
 * ids, so a `--attach` argument can never traverse out of the socket directory.
 *
 * @throws {Error} When the session id is not a valid session id.
 */
export function resolveAttachSocketPath(sessionId: string, socketDir: string): string {
	assertValidSessionId(sessionId);
	return path.join(socketDir, `${sessionId}.sock`);
}

/**
 * Error frames that report a recoverable condition rather than a dead session.
 *
 * `PROMPT_FAILED` means one prompt was rejected (no model, no credentials),
 * `PROMPT_QUEUED` means a prompt sent mid-turn was accepted and runs when the current
 * turn finishes (R32-FLEET.7), and `SESSION_REPLACED` means the runtime switched
 * sessions - in all three cases the client is still attached and the session is still
 * there, so the client prints the message and stays.
 */
const NON_FATAL_ERROR_CODES = new Set(["PROMPT_FAILED", "PROMPT_QUEUED", "SESSION_REPLACED"]);

/**
 * Whether an `error` frame from the server should end the attached client.
 *
 * Uncoded frames stay fatal: they report protocol or attach failures.
 */
export function isFatalAttachError(code?: string): boolean {
	return code === undefined || !NON_FATAL_ERROR_CODES.has(code);
}

/**
 * Codes that ride the `error` channel while reporting something that went RIGHT.
 *
 * The socket wire has one server→client channel for out-of-band messages, so
 * R32-FLEET.7's "your prompt was queued" arrives as an `error` frame. Printing
 * it in red under an "Error:" heading would tell the operator their prompt
 * failed at the exact moment it did not.
 */
const NOTICE_ERROR_CODES = new Set(["PROMPT_QUEUED"]);

/** Whether an `error` frame is a notice rather than a failure. */
export function isAttachNotice(code?: string): boolean {
	return code !== undefined && NOTICE_ERROR_CODES.has(code);
}

/**
 * Run attach mode - connect to an existing socket session.
 *
 * @param sessionId - Session ID to attach to
 */
export async function runAttachMode(sessionId: string): Promise<void> {
	const agentDir = getAgentDir();
	const socketDir = path.join(agentDir, "sockets");

	let socketPath: string;
	try {
		socketPath = resolveAttachSocketPath(sessionId, socketDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid session id";
		console.error(chalk.red(`Invalid --attach value: ${sessionId}`));
		console.error(chalk.dim(message));
		console.error(chalk.dim(`\nList running sessions with: ${APP_NAME} --list-sessions\n`));
		process.exit(1);
	}

	console.log(chalk.dim(`Attaching to session ${chalk.cyan(sessionId)}...`));

	const client = new SocketClient({
		socketPath,
		mode: "read-write",
	});

	// Handle session metadata
	client.onMetadata((sessionId, cwd, createdAt) => {
		console.log(chalk.dim(`Connected to session ${chalk.cyan(sessionId)}`));
		console.log(chalk.dim(`CWD: ${cwd}`));
		console.log(chalk.dim(`Created: ${createdAt.toLocaleString()}`));
		console.log(chalk.dim(`\nType messages to send input, Ctrl+D to detach\n`));
	});

	// Handle output from session
	client.onOutput((data, stream) => {
		if (stream === "stderr") {
			process.stderr.write(chalk.red(data));
		} else {
			process.stdout.write(data);
		}
	});

	// Handle input echo from other clients
	client.onInputEcho((data, clientId) => {
		// Show who typed what (tmux-style)
		console.log(chalk.dim(`[${clientId}] `) + chalk.yellow(data));
	});

	// Handle other clients joining/leaving
	client.onClientJoined((clientId, mode) => {
		console.log(chalk.dim(`\n[${clientId} joined (${mode})]\n`));
	});

	client.onClientLeft((clientId) => {
		console.log(chalk.dim(`\n[${clientId} left]\n`));
	});

	// Handle errors
	client.onError((message, code) => {
		if (isAttachNotice(code)) {
			console.log(chalk.dim(`\n[${message}]\n`));
			return;
		}
		console.error(chalk.red(`\nError: ${message}\n`));
		if (isFatalAttachError(code)) {
			process.exit(1);
		}
	});

	// Handle disconnect
	client.onDisconnect(() => {
		console.log(chalk.dim("\nDisconnected from session.\n"));
		process.exit(0);
	});

	// Connect to socket
	try {
		await client.connect();
	} catch (err) {
		console.error(chalk.red(`Failed to connect: ${err instanceof Error ? err.message : "Unknown error"}`));
		console.error(chalk.dim(`\nSocket path: ${socketPath}`));
		console.error(chalk.dim(`\nCheck if the session is running with: draht --list-sessions\n`));
		process.exit(1);
	}

	// Set up readline for input
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: chalk.dim("> "),
	});

	rl.prompt();

	rl.on("line", (line) => {
		if (line.trim()) {
			client.sendInput(`${line}\n`);
		}
		rl.prompt();
	});

	rl.on("close", () => {
		client.disconnect();
		process.exit(0);
	});

	// Handle Ctrl+C
	process.on("SIGINT", () => {
		client.disconnect();
		process.exit(0);
	});
}
