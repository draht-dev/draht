/**
 * Attach mode - Connect to an existing socket-based draht session
 *
 * Provides tmux-style attachment where you can see output and send input
 * to a running session. Multiple clients can attach simultaneously.
 *
 * It is also the THIRD renderer of a permission ask (R34-PERM.2), and the one that used to
 * swallow answers: every typed line went out as an `input` frame, so a human typing "Yes" at a
 * dialog the session had raised did not answer it — the word arrived as a queued chat prompt
 * while the agent sat parked inside `beforeToolCall` waiting for a decision that could never
 * come. The answer mode below is that bug's fix: while an ask is outstanding, a typed line is an
 * ANSWER or it is nothing at all.
 */

import path from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.js";
import { assertValidSessionId } from "../core/session-manager.js";
import {
	type PermissionOption,
	type PermissionRequestMessage,
	type PermissionResolvedMessage,
	SocketClient,
} from "../core/socket-server/index.js";

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
 *
 * The `PERMISSION_*` codes are every way the session can REFUSE ONE ANSWER (R34-PERM.1): the
 * ask is gone, the option was never offered, somebody else already decided, this connection is
 * read-only or never declared the capability. A refusal is a statement about that one keystroke
 * and about nothing else — the session is still running and this client is still attached — so
 * exiting on it would turn "you named an option I did not offer" into a lost session.
 */
const NON_FATAL_ERROR_CODES = new Set([
	"PROMPT_FAILED",
	"PROMPT_QUEUED",
	"SESSION_REPLACED",
	"PERMISSION_UNKNOWN_REQUEST",
	"PERMISSION_INVALID_OPTION",
	"PERMISSION_ALREADY_RESOLVED",
	"PERMISSION_NOT_ATTACHED",
	"PERMISSION_READ_ONLY",
	"PERMISSION_NOT_CAPABLE",
]);

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
 * Resolve a typed line against the options an ask actually offered.
 *
 * Three spellings are accepted, and all three name an OFFERED option: its id, its label, or its
 * 1-based position in the rendered list. Nothing else resolves — there is deliberately no
 * "y"/"yes" fallback, no prefix match and no default, because every one of those invents an
 * option the session did not offer and the whole point of answering by id is that the ask
 * decides what may happen, not the renderer.
 *
 * Id and label are tried BEFORE the ordinal, so an ask that offers an option literally called
 * "1" is answered by naming it rather than by whatever happens to sit first in the list.
 *
 * Exported for the option-matching tests; `runAttachMode` is the only production caller.
 */
export function matchPermissionAnswer(
	line: string,
	options: readonly PermissionOption[],
): PermissionOption | undefined {
	const typed = line.trim();
	if (typed === "") return undefined;

	const folded = typed.toLowerCase();
	const named = options.find(
		(option) => option.id.toLowerCase() === folded || option.label.trim().toLowerCase() === folded,
	);
	if (named !== undefined) return named;

	if (!/^\d+$/.test(typed)) return undefined;
	const ordinal = Number.parseInt(typed, 10);
	if (ordinal < 1 || ordinal > options.length) return undefined;
	return options[ordinal - 1];
}

/** The one-line "that was not one of the choices" reminder, listing what IS on offer. */
export function permissionAnswerReminder(options: readonly PermissionOption[]): string {
	const offered = options.map((option, index) => `${index + 1}) ${option.label} [${option.id}]`).join("  ");
	return `Not one of the offered answers — nothing was sent. Answer with: ${offered}`;
}

/**
 * Render one permission ask from its TYPED fields.
 *
 * Deliberately NOT built from the legacy `title`/`message` prose: that sentence is
 * `${toolName}: ${reason}`, which cannot say which directory the command would run in or what
 * the command actually is, and a human approving a `bash` call needs both. The typed fields are
 * already neutralized and bounded where the frame was CONSTRUCTED (`safe-text.ts`), so nothing
 * here re-sanitizes them — doing so twice is how a doubly-escaped command stops being the
 * command the human is deciding about.
 *
 * NOTE ON `reason`: the socket frame carries no dedicated field for it. The permission gate
 * folds it into `message` as `${toolName}: ${reason}`, so that field is rendered under its own
 * name, on its own line, AFTER the typed facts rather than instead of them.
 *
 * Returned as lines rather than printed so the shape is testable without a socket.
 */
export function renderPermissionAsk(message: PermissionRequestMessage): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push(chalk.bold.yellow("Permission required"));
	lines.push(`  Tool: ${message.toolName}`);
	lines.push(`  Directory: ${message.cwd}`);
	if (message.command !== undefined) {
		lines.push(`  Command: ${message.command}`);
	}
	if (message.path !== undefined) {
		lines.push(`  Path: ${message.path}`);
	}
	if (message.operation !== undefined) {
		lines.push(`  Operation: ${message.operation}`);
	}
	if (message.message !== "") {
		lines.push(`  Reason: ${message.message}`);
	}
	if (message.truncated) {
		// Said out loud: a decision made on an elided string is a decision made on less than the
		// whole truth, and the human is entitled to know that before answering.
		lines.push(chalk.yellow("  (some fields were too long and were shortened for display)"));
	}
	for (const [index, option] of message.options.entries()) {
		lines.push(`  ${index + 1}) ${option.label} [${option.id}]`);
	}
	lines.push(chalk.dim("Type the number, the label or the id to answer. Anything else is not sent."));
	return lines;
}

/** How a settled ask is reported back to the operator, naming who actually decided it. */
export function renderPermissionResolution(message: PermissionResolvedMessage): string {
	const who = message.clientId === null ? message.surface : `${message.surface} (${message.clientId})`;
	const chosen = message.chosenOptionId === null ? "" : ` [${message.chosenOptionId}]`;
	return `Permission ${message.decision}${chosen} — answered on ${who}`;
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

	/**
	 * Asks this client has been shown and that nobody has settled yet, oldest first.
	 *
	 * A list rather than a single slot because the session may legitimately have several asks in
	 * flight, and because a REPLAY after reconnect re-sends everything still pending: keying by
	 * `requestId` is what makes the same ask arriving twice re-render once instead of queueing a
	 * phantom second dialog whose answer would be refused as `PERMISSION_ALREADY_RESOLVED`.
	 *
	 * Only the head is answerable. Answer mode ends for an ask when its `permission_resolved`
	 * arrives — never when this client sends an answer, because the answer may be refused, and a
	 * client that dropped out of answer mode on send would forward the operator's second attempt
	 * to the model as a chat prompt.
	 */
	const pendingAsks: PermissionRequestMessage[] = [];

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

	// A permission ask raised by the session. Printed on its own, never spliced into the output
	// stream: the output stream is the agent talking, and this is the session asking THIS human a
	// question it will block on until somebody answers.
	client.onPermissionRequest((message) => {
		const known = pendingAsks.findIndex((ask) => ask.requestId === message.requestId);
		if (known >= 0) {
			// A replay of something already outstanding (a reconnect shows every pending ask again).
			// Refresh what is on file and re-render only if it is the one being answered right now.
			pendingAsks[known] = message;
			if (known === 0) {
				for (const line of renderPermissionAsk(message)) console.log(line);
			}
			return;
		}

		pendingAsks.push(message);
		if (pendingAsks.length === 1) {
			for (const line of renderPermissionAsk(message)) console.log(line);
			return;
		}
		console.log(chalk.dim(`[${pendingAsks.length - 1} more permission ask(s) waiting]`));
	});

	// How an ask ended, whoever ended it. This is R34-PERM.2's echo arriving at this surface: when
	// a phone answered first, the operator sitting here must be told that, not left holding a
	// dialog that has already been decided somewhere else.
	client.onPermissionResolved((message) => {
		const index = pendingAsks.findIndex((ask) => ask.requestId === message.requestId);
		console.log(chalk.cyan(`\n${renderPermissionResolution(message)}\n`));
		if (index < 0) return;
		pendingAsks.splice(index, 1);
		const next = pendingAsks[0];
		if (index === 0 && next !== undefined) {
			for (const line of renderPermissionAsk(next)) console.log(line);
		}
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
		const ask = pendingAsks[0];
		if (ask !== undefined) {
			// ANSWER MODE. The session is blocked on a decision, so this line is a decision or it
			// is nothing — it is never forwarded as a prompt. A line that names no offered option
			// is refused HERE, locally, and costs the ask nothing: bouncing it off the session
			// would either be rejected there anyway or, worse, land in the model's context as a
			// chat message the human meant as an answer.
			const option = matchPermissionAnswer(line, ask.options);
			if (option === undefined) {
				console.log(chalk.yellow(permissionAnswerReminder(ask.options)));
				rl.prompt();
				return;
			}
			client.sendPermissionResponse(ask.requestId, option.id);
			console.log(chalk.dim(`Answered "${option.label}" — waiting for the session to confirm...`));
			rl.prompt();
			return;
		}

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
