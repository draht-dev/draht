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
 *   {"cmd":"permission_request"}                     → broadcast the fixed confirm ask below
 *   {"cmd":"permission_select"}                      → broadcast the fixed SELECT ask below
 *   {"cmd":"permission_answered"}                    → resolve the select ask `answered`
 *   {"cmd":"permission_resolved"}                    → broadcast a fixed cancellation
 *   {"cmd":"stop"}                                   → clean shutdown
 * Readiness is one newline-JSON line on stdout: {"ready":true,"pid":N}
 *
 * The permission ask is a FIXED literal, every field of it, including the ones a
 * real session would generate — the request id, the timestamp, the deadline.
 * Holding them fixed here rather than normalizing them afterwards is what lets
 * the goldens compare byte-wise with nothing substituted: a recorder fixture has
 * no reason to be non-deterministic in the first place.
 *
 * An answer really is routed: `onPermissionResponse` is registered and turns the
 * client's `permission_response` into the `permission_resolved` broadcast, so the
 * corpus records the whole ask → answer → resolution arm under its real
 * conditions rather than three frames pushed from stdin.
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

/**
 * The fixed ask. Its `options` are the two a confirm offers, and `truncated` is
 * false because nothing here needed eliding.
 */
const PERMISSION_REQUEST = {
	type: "permission_request",
	requestId: "conformance-permission-1",
	method: "confirm",
	toolCallId: "conformance-tool-call-1",
	toolName: "bash",
	cwd: "/geist/conformance",
	title: "Run a shell command?",
	message: "bash wants to run a command in /geist/conformance",
	command: "echo geist conformance corpus",
	truncated: false,
	options: [
		{ id: "approve", label: "Approve" },
		{ id: "deny", label: "Deny" },
	],
	requestedAt: "1970-01-01T00:00:00.000Z",
	deadline: null,
};

/**
 * The fixed SELECT ask. It exists to record the one case the wire had no true word
 * for until `geist/0.4`: a `select` grants nothing and refuses nothing — no option
 * of it declares a permission — so an answer to it is `answered`, neither
 * `approved` nor `cancelled`. It carries a `command`, i.e. a `tool_permission`
 * detail, because that is exactly the shape that made the old falsehood DURABLE:
 * the audit row is written for a detail like this one, and the row said either
 * "cancelled" about an ask that was answered or "approved" about a grant nobody
 * made.
 */
const PERMISSION_SELECT_REQUEST = {
	type: "permission_request",
	requestId: "conformance-permission-2",
	method: "select",
	toolCallId: "conformance-tool-call-2",
	toolName: "bash",
	cwd: "/geist/conformance",
	title: "Which branch should the command run against?",
	message: "git wants to know which branch to switch to before running",
	command: "git switch <branch>",
	truncated: false,
	options: [
		{ id: "opt-main", label: "main" },
		{ id: "opt-next", label: "next" },
	],
	requestedAt: "1970-01-01T00:00:00.000Z",
	deadline: null,
};

server.onPermissionResponse((message, clientId) => {
	// Plumbing only, exactly like the real session-side registry would be reached:
	// the id comes from the server's view of who is connected, never from the
	// frame's own `clientId`.
	server.broadcastPermissionResolved({
		type: "permission_resolved",
		requestId: message.requestId,
		decision: message.optionId === "approve" ? "approved" : "denied",
		chosenOptionId: message.optionId,
		surface: "conformance",
		clientId,
	});
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
		} else if (command.cmd === "permission_request") {
			server.broadcastPermissionRequest(PERMISSION_REQUEST);
		} else if (command.cmd === "permission_select") {
			server.broadcastPermissionRequest(PERMISSION_SELECT_REQUEST);
		} else if (command.cmd === "permission_answered") {
			// The LOCAL surface answered the select, so every remote copy comes down and
			// the ending is stated neutrally. `chosenOptionId` carries what was actually
			// chosen — which is the whole of what an answered select means — and
			// `decision` grants nothing.
			server.broadcastPermissionResolved({
				type: "permission_resolved",
				requestId: PERMISSION_SELECT_REQUEST.requestId,
				decision: "answered",
				chosenOptionId: "opt-next",
				surface: "tui",
				clientId: null,
			});
		} else if (command.cmd === "permission_resolved") {
			server.broadcastPermissionResolved({
				type: "permission_resolved",
				requestId: PERMISSION_REQUEST.requestId,
				decision: "cancelled",
				chosenOptionId: null,
				surface: "conformance",
				clientId: null,
			});
		} else if (command.cmd === "stop") {
			void server.stop().then(() => process.exit(0));
		}
	}
});
