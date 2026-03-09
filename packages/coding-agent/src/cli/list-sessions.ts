/**
 * List all running attachable socket sessions
 */

import path from "node:path";
import chalk from "chalk";
import { getAgentDir } from "../config.js";
import { discoverSocketSessions } from "../core/socket-server/index.js";

/**
 * List all running attachable sessions and print to console.
 */
export async function listSessions(): Promise<void> {
	const agentDir = getAgentDir();
	const socketDir = path.join(agentDir, "sockets");

	console.log(chalk.bold("\n📡 Attachable Sessions\n"));

	const sessions = await discoverSocketSessions(socketDir);

	if (sessions.length === 0) {
		console.log(chalk.dim("No running attachable sessions found."));
		console.log(chalk.dim('\nStart one with: draht --attachable "Your prompt"\n'));
		return;
	}

	console.log(
		`Found ${chalk.green(sessions.length.toString())} running ${sessions.length === 1 ? "session" : "sessions"}:\n`,
	);

	for (const session of sessions) {
		const elapsed = formatElapsed(Date.now() - session.createdAt.getTime());

		console.log(chalk.cyan(`  ${session.sessionId}`));
		console.log(chalk.dim(`    CWD:     ${session.cwd}`));
		console.log(chalk.dim(`    PID:     ${session.pid}`));
		console.log(chalk.dim(`    Uptime:  ${elapsed}`));
		console.log(chalk.dim(`    Socket:  ${session.socketPath}`));
		console.log();
	}

	console.log(chalk.dim(`Attach to a session: draht --attach <session-id>\n`));
}

/**
 * Format elapsed time in human-readable format
 */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) {
		return `${days}d ${hours % 24}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
}
