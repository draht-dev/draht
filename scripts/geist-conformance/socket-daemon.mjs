/**
 * A real draht attach daemon, spawned as its own process, for recording the
 * conformance corpus (R32-FLEET.5).
 *
 * This is deliberately the REAL `SocketServer` from `@draht/coding-agent`, not
 * a stand-in: the six relayed server frames and two relayed client frames in
 * `geist-protocol`'s wire are mirrors of the socket wire, and a corpus recorded
 * against a hand-written fake would mirror the fake instead of the contract.
 * It creates a real `<id>.sock` + `.lock` pair under `--socket-dir` with a real
 * live PID, exactly what the fleet projection reads.
 *
 * Control plane is newline-JSON on stdin (the socket wire itself is the thing
 * under test, so it is never used for control):
 *   {"cmd":"output","data":"…","stream":"stdout"}   → broadcast to attached clients
 *   {"cmd":"stop"}                                   → clean shutdown
 * Readiness is one newline-JSON line on stdout: {"ready":true,"pid":N}
 *
 * Usage: bun scripts/geist-conformance/socket-daemon.mjs --socket-dir <dir> --session-id <id> --cwd <cwd>
 */

import { SocketServer } from "../../packages/coding-agent/src/core/socket-server/index.js";

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined) {
		if (fallback !== undefined) return fallback;
		throw new Error(`missing required --${name}`);
	}
	return value;
}

const server = new SocketServer({
	sessionId: arg("session-id"),
	socketDir: arg("socket-dir"),
	cwd: arg("cwd"),
});

await server.start();
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		if (command.cmd === "output") {
			server.broadcastOutput(command.data ?? "", command.stream ?? "stdout");
		} else if (command.cmd === "stop") {
			void server.stop().then(() => process.exit(0));
		}
	}
});
