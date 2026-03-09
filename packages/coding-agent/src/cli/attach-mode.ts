/**
 * Attach mode - Connect to an existing socket-based draht session
 *
 * Provides tmux-style attachment where you can see output and send input
 * to a running session. Multiple clients can attach simultaneously.
 */

import path from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { getAgentDir } from "../config.js";
import { SocketClient } from "../core/socket-server/index.js";

/**
 * Run attach mode - connect to an existing socket session.
 *
 * @param sessionId - Session ID to attach to
 */
export async function runAttachMode(sessionId: string): Promise<void> {
	const agentDir = getAgentDir();
	const socketDir = path.join(agentDir, "sockets");
	const socketPath = path.join(socketDir, `${sessionId}.sock`);

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
	client.onError((message) => {
		console.error(chalk.red(`\nError: ${message}\n`));
		process.exit(1);
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
