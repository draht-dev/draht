/**
 * SocketServer - Unix domain socket server for attachable draht sessions
 *
 * Enables tmux-style multi-client attachment:
 * - Multiple readers/writers can connect simultaneously
 * - All clients see the same output
 * - Input from any client is echoed to all others
 * - Clients can join/leave without disrupting the session
 */

import { rmSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { assertValidSessionId } from "../session-manager.js";
import { isProcessRunning } from "./discovery.js";
import {
	CLIENT_MODES,
	type ClientMessage,
	type ClientMode,
	type ConnectedClient,
	PERMISSION_RELAY_CAPABILITY,
	type PermissionRequestMessage,
	type PermissionResolvedMessage,
	type PermissionResponseMessage,
	type ServerMessage,
} from "./types.js";

/**
 * How long {@link SocketServer.stop} waits for peers to close their end before it
 * forces the remaining sockets down.
 */
const STOP_CLOSE_TIMEOUT_MS = 1000;

/**
 * How long a lock file with no readable PID has to sit untouched before it counts as
 * debris rather than as a claim another starter is in the middle of writing.
 */
const UNWRITTEN_LOCK_STALE_MS = 10_000;

export interface SocketServerOptions {
	/** Session ID (used for socket filename) */
	sessionId: string;
	/** Directory for socket files (default: ~/.draht/agent/sockets) */
	socketDir: string;
	/** Current working directory (included in metadata) */
	cwd: string;
	/** Maximum number of concurrent clients */
	maxClients?: number;
	/** Whether to echo input to all clients (tmux-style) */
	broadcastInputEcho?: boolean;
}

/**
 * Thrown when another live process already owns the socket for this session id.
 *
 * Taking the socket over would silently steal attachments from a running session,
 * so the second process refuses to bind instead.
 */
export class SocketSessionBusyError extends Error {
	readonly sessionId: string;
	/** PID of the owning process, or null when the lock exists but names no readable PID. */
	readonly ownerPid: number | null;
	readonly socketPath: string;

	constructor(sessionId: string, ownerPid: number | null, socketPath: string) {
		// Two genuinely different situations - do not describe them the same way. A
		// readable PID means a live process really does own this session. An
		// unreadable lock usually means another process is claiming it right now, but
		// it is equally a lock left truncated by a process killed mid-claim, in which
		// case nothing is running and the claim clears itself shortly.
		super(
			ownerPid === null
				? `Session "${sessionId}" has an attachable lock that names no readable PID. ` +
						`Another process is probably claiming it right now; it can also be debris from a ` +
						`process killed mid-claim, in which case it clears itself within ` +
						`${Math.round(UNWRITTEN_LOCK_STALE_MS / 1000)}s. Retry shortly. Socket: ${socketPath}`
				: `Session "${sessionId}" is already attachable from a running process (PID ${ownerPid}). ` +
						`Attach to it instead, or stop that process. Socket: ${socketPath}`,
		);
		this.name = "SocketSessionBusyError";
		this.sessionId = sessionId;
		this.ownerPid = ownerPid;
		this.socketPath = socketPath;
	}
}

/**
 * SocketServer manages a Unix domain socket for a single draht session.
 *
 * Clients connect, send input, and receive output in real-time.
 * All communication uses JSON-over-socket with newline framing.
 */
export class SocketServer {
	readonly #sessionId: string;
	readonly #socketPath: string;
	readonly #lockPath: string;
	readonly #cwd: string;
	readonly #maxClients: number;
	readonly #broadcastInputEcho: boolean;

	#server: Server | null = null;
	#clients = new Map<string, ConnectedClient>();
	/**
	 * Every accepted connection, including ones that never sent an `attach` frame.
	 * `#clients` only holds attached peers, and shutdown has to reach the others too.
	 */
	#sockets = new Set<Socket>();
	#createdAt = new Date();
	#stopped = false;
	/**
	 * Whether THIS instance won the exclusive lock create. Only an owner may remove
	 * the socket/lock files; an instance whose start() was refused must never delete
	 * the live owner's files.
	 */
	#ownsLock = false;
	#rejectListen: ((error: Error) => void) | null = null;

	/** Callback for input received from any client */
	#onInput: ((data: string, clientId: string) => void) | null = null;

	/**
	 * Callback for a permission answer from a client. Nothing here decides
	 * anything: this class is plumbing, and the pending-ask registry that owns
	 * validation, first-answer-wins and expiry lives on the session side.
	 *
	 * With no callback registered, an answer is refused with a targeted
	 * `PERMISSION_UNKNOWN_REQUEST` error rather than swallowed — a phone must be
	 * able to tell "answered" from "this draht is too old to have asked".
	 */
	#onPermissionResponse: ((message: PermissionResponseMessage, clientId: string) => void) | null = null;

	/**
	 * Fired immediately after a newly attached client has been sent
	 * `session_metadata`, so whatever holds unanswered asks can replay them to a
	 * client that arrived after they were raised.
	 */
	#onAttachReplay: ((clientId: string) => void) | null = null;

	/**
	 * Fired when an attached client's connection ends. Everything that keeps
	 * per-connection state outside this class resets it here.
	 */
	#onClientDisconnect: ((clientId: string) => void) | null = null;

	constructor(options: SocketServerOptions) {
		// The id becomes a path component of the .sock and .lock files, and it arrives here
		// straight from a session file on disk, so it is untrusted input. Reject anything
		// that is not a plain session id rather than trying to sanitize it.
		assertValidSessionId(options.sessionId);
		this.#sessionId = options.sessionId;
		this.#cwd = options.cwd;
		this.#maxClients = options.maxClients ?? 10;
		this.#broadcastInputEcho = options.broadcastInputEcho ?? true;

		this.#socketPath = path.join(options.socketDir, `${options.sessionId}.sock`);
		this.#lockPath = path.join(options.socketDir, `${options.sessionId}.lock`);
	}

	/**
	 * Start the socket server.
	 * Creates socket directory, claims the session lock, binds the Unix socket, and listens.
	 *
	 * @throws {SocketSessionBusyError} When another live process already owns this session's socket.
	 */
	async start(): Promise<void> {
		// Ensure socket directory exists and is owner-only. `mkdir` applies its mode only
		// when it creates the directory, and masks it with the umask, so re-assert it.
		const socketDir = path.dirname(this.#socketPath);
		await mkdir(socketDir, { recursive: true, mode: 0o700 });
		await chmod(socketDir, 0o700);

		// Take ownership of the session id before touching the socket path.
		await this.#claimLock();

		try {
			this.#server = createServer((socket) => this.#handleConnection(socket));
			const server = this.#server;

			// One long-lived error listener: it rejects the pending listen() and swallows
			// post-startup server errors, which must not become uncaught exceptions.
			server.on("error", (error: Error) => {
				const reject = this.#rejectListen;
				this.#rejectListen = null;
				reject?.(error);
			});

			await new Promise<void>((resolve, reject) => {
				this.#rejectListen = reject;
				server.listen(this.#socketPath, () => {
					this.#rejectListen = null;
					resolve();
				});
			});

			// bind(2) applies the process umask, so tighten the socket explicitly. Between
			// bind and this chmod the socket is still unreachable for other users: it can
			// only be named through the 0700 directory above, and Unix-domain permissions
			// are enforced at connect(2) time. Mutating the process-global umask instead
			// would leak into every unrelated file this process creates concurrently.
			await chmod(this.#socketPath, 0o600);
		} catch (error) {
			// Never leave a lock behind that advertises a socket which was never bound.
			this.#server = null;
			this.#rejectListen = null;
			await rm(this.#lockPath, { force: true }).catch(() => {});
			await rm(this.#socketPath, { force: true }).catch(() => {});
			throw error;
		}
	}

	/**
	 * Stop the socket server and clean up.
	 */
	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;

		// Half-close every accepted connection, not just the attached clients: a peer that
		// connected and never sent an `attach` frame is not in #clients, and leaving it open
		// would keep server.close() from ever calling back.
		for (const socket of this.#sockets) {
			try {
				socket.end();
			} catch {}
		}
		this.#clients.clear();

		// Close server
		if (this.#server) {
			const server = this.#server;
			this.#server = null;
			await new Promise<void>((resolve) => {
				// A peer that never closes its own half - a non-Node bridge, say - must not be
				// able to wedge shutdown forever. Force the stragglers down after a grace
				// period and carry on; the .sock/.lock cleanup below then runs either way.
				const timer = setTimeout(() => {
					for (const socket of this.#sockets) {
						try {
							socket.destroy();
						} catch {}
					}
					this.#sockets.clear();
					resolve();
				}, STOP_CLOSE_TIMEOUT_MS);
				server.close(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		this.#sockets.clear();

		// Clean up socket and lock files — but only if this instance owns them. A
		// server whose start() was refused with SocketSessionBusyError never claimed
		// the lock; deleting these paths would destroy the LIVE owner's files and let
		// a third process steal the session id.
		if (this.#ownsLock) {
			this.#ownsLock = false;
			await rm(this.#socketPath, { force: true });
			await rm(this.#lockPath, { force: true });
		}
	}

	/**
	 * Stop the socket server from a synchronous exit path.
	 *
	 * `process.on("exit")` and signal handlers cannot await, so this does the same
	 * teardown as {@link stop} without yielding to the event loop.
	 */
	stopSync(): void {
		if (this.#stopped) return;
		this.#stopped = true;

		for (const socket of this.#sockets) {
			try {
				socket.destroy();
			} catch {}
		}
		this.#sockets.clear();
		this.#clients.clear();

		if (this.#server) {
			const server = this.#server;
			this.#server = null;
			try {
				server.close();
			} catch {}
		}

		// Only remove files this instance actually claimed — see stop().
		if (this.#ownsLock) {
			this.#ownsLock = false;
			try {
				rmSync(this.#socketPath, { force: true });
			} catch {}
			try {
				rmSync(this.#lockPath, { force: true });
			} catch {}
		}
	}

	/**
	 * Broadcast output to all connected clients.
	 *
	 * @param data - Output text
	 * @param stream - Output stream (stdout or stderr)
	 */
	broadcastOutput(data: string, stream: "stdout" | "stderr" = "stdout"): void {
		const message: ServerMessage = {
			type: "output",
			data,
			stream,
		};
		this.#broadcast(message);
	}

	/**
	 * Broadcast an error to all connected clients.
	 */
	broadcastError(message: string, code?: string): void {
		const error: ServerMessage = { type: "error", message, code };
		this.#broadcast(error);
	}

	/**
	 * Send an error to one specific client, if it is still connected.
	 */
	sendErrorToClient(clientId: string, message: string, code?: string): void {
		const client = this.#clients.get(clientId);
		if (!client) return;
		this.#sendError(client.socket, message, code);
	}

	/**
	 * Send a permission ask to one client, if it is still connected and may have it.
	 *
	 * Silently does nothing for a client that is gone, read-only, or never
	 * declared {@link PERMISSION_RELAY_CAPABILITY}: not being asked is the
	 * correct outcome for all three, and none of them is an error the asker can
	 * act on.
	 */
	sendPermissionRequest(clientId: string, message: PermissionRequestMessage): void {
		const client = this.#clients.get(clientId);
		if (!client || !this.#mayReceivePermissionFrames(client)) return;
		this.#send(client.socket, message);
	}

	/**
	 * Broadcast a permission ask to every client that may answer it.
	 *
	 * @returns the ids that were actually sent the ask — the asker needs to know
	 *          whether anybody at all can answer, and an empty result is the
	 *          honest answer "nobody remote is listening".
	 */
	broadcastPermissionRequest(message: PermissionRequestMessage): string[] {
		const reached: string[] = [];
		for (const client of this.#clients.values()) {
			if (!this.#mayReceivePermissionFrames(client)) continue;
			this.#send(client.socket, message);
			reached.push(client.id);
		}
		return reached;
	}

	/**
	 * Broadcast the outcome of a permission ask.
	 *
	 * Gated exactly like the ask itself: a client that could not have been asked
	 * is not told how somebody else's ask ended, and a client that never declared
	 * the capability is never sent a frame it cannot decode.
	 */
	broadcastPermissionResolved(message: PermissionResolvedMessage): void {
		for (const client of this.#clients.values()) {
			if (!this.#mayReceivePermissionFrames(client)) continue;
			this.#send(client.socket, message);
		}
	}

	/**
	 * How many attached clients could answer a permission ask RIGHT NOW.
	 *
	 * Gated by exactly the predicate emission is gated by, so the count and the
	 * fan-out can never disagree. This is what `ExtensionRunner.hasUI()` becomes
	 * for a headless attachable session, and it must therefore stay honest in
	 * both directions: reporting a client that cannot be asked turns today's loud
	 * "no UI available to request approval" block into an instant `false` that
	 * the permission gate reports as "User denied approval" — a user action in
	 * the transcript that no user took.
	 */
	get permissionCapableClientCount(): number {
		let count = 0;
		for (const client of this.#clients.values()) {
			if (this.#mayReceivePermissionFrames(client)) count++;
		}
		return count;
	}

	/**
	 * Whether this client is eligible for permission frames at all: read-write
	 * (a read-only peer may watch but never decide) and capability-declaring.
	 */
	#mayReceivePermissionFrames(client: ConnectedClient): boolean {
		return client.mode !== "read-only" && client.capabilities.includes(PERMISSION_RELAY_CAPABILITY);
	}

	/**
	 * Set callback for input received from clients.
	 */
	onInput(callback: (data: string, clientId: string) => void): void {
		this.#onInput = callback;
	}

	/**
	 * Set callback for a permission answer received from a client.
	 */
	onPermissionResponse(callback: (message: PermissionResponseMessage, clientId: string) => void): void {
		this.#onPermissionResponse = callback;
	}

	/**
	 * Set callback fired right after a client has been sent `session_metadata`.
	 */
	onAttachReplay(callback: (clientId: string) => void): void {
		this.#onAttachReplay = callback;
	}

	/**
	 * Set callback fired when an attached client's connection ends, however it
	 * ended — a graceful `detach`, a closed socket, or a socket error.
	 *
	 * Per-connection bookkeeping outside this class needs the same signal the
	 * `client_left` broadcast carries, and it needs it for the same reason: a
	 * client that reconnects under the same id is a NEW connection with nothing
	 * on its screen. Whatever tracked what that client had already been shown has
	 * to forget it here, or the reconnecting peer is never shown it again.
	 */
	onClientDisconnect(callback: (clientId: string) => void): void {
		this.#onClientDisconnect = callback;
	}

	/**
	 * Get socket path for this session.
	 */
	get socketPath(): string {
		return this.#socketPath;
	}

	/**
	 * Get the session id this socket is bound to.
	 */
	get sessionId(): string {
		return this.#sessionId;
	}

	/**
	 * Get number of connected clients.
	 */
	get clientCount(): number {
		return this.#clients.size;
	}

	/**
	 * Claim the session lock, or refuse when a live process already holds it.
	 *
	 * The lock file is created exclusively so two processes racing for the same session id
	 * cannot both believe they won. An existing lock is only reaped when its PID is dead
	 * (or is our own leftover, e.g. re-binding after a session switch). A lock that exists
	 * but names no readable PID counts as held, not as dead: the exclusive create and the
	 * PID write are two steps, and reaping in between would steal a live owner's session.
	 */
	async #claimLock(): Promise<void> {
		const contents = `${process.pid}\n${this.#cwd}\n${this.#createdAt.toISOString()}`;

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await writeFile(this.#lockPath, contents, { flag: "wx", mode: 0o600 });
				// A leftover socket from a dead owner cannot be connected to; remove it so
				// listen() can bind the path.
				await rm(this.#socketPath, { force: true });
				this.#ownsLock = true;
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			}

			const ownerPid = await this.#readLockPid();
			if (ownerPid === null) {
				// The lock exists but names no readable PID. The likely cause is a starter that
				// won the exclusive create microseconds ago and has not written its PID yet;
				// reaping it here would hand the same session id to two live processes. Only a
				// lock that has sat unwritten far longer than any write takes counts as debris.
				if (!(await this.#lockIsAbandoned())) {
					throw new SocketSessionBusyError(this.#sessionId, null, this.#socketPath);
				}
			} else if (ownerPid !== process.pid && isProcessRunning(ownerPid)) {
				throw new SocketSessionBusyError(this.#sessionId, ownerPid, this.#socketPath);
			}

			// Dead owner, our own leftover, or abandoned debris: reap and retry the create.
			await rm(this.#lockPath, { force: true });
			await rm(this.#socketPath, { force: true });
		}

		throw new Error(`Could not claim the attachable-session lock at ${this.#lockPath}`);
	}

	/**
	 * Whether an existing lock with no readable PID is old enough to count as debris
	 * rather than as a claim another process is in the middle of writing.
	 */
	async #lockIsAbandoned(): Promise<boolean> {
		try {
			const info = await stat(this.#lockPath);
			return Date.now() - info.mtimeMs > UNWRITTEN_LOCK_STALE_MS;
		} catch {
			// It vanished while we looked at it: the session id is free again.
			return true;
		}
	}

	/**
	 * Read the PID recorded in an existing lock file, or null when it is unreadable.
	 */
	async #readLockPid(): Promise<number | null> {
		try {
			const contents = await readFile(this.#lockPath, "utf-8");
			const pid = Number.parseInt(contents.trim().split("\n")[0], 10);
			return Number.isInteger(pid) ? pid : null;
		} catch {
			return null;
		}
	}

	/**
	 * Handle new client connection.
	 */
	#handleConnection(socket: Socket): void {
		this.#sockets.add(socket);
		let clientId: string | null = null;
		let _mode: ClientMode = "read-write";
		let buffer = "";

		// Handle incoming data (JSON messages)
		socket.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;

				try {
					const message = JSON.parse(line) as ClientMessage;
					this.#handleClientMessage(message, socket, (id, m) => {
						clientId = id;
						_mode = m;
					});
				} catch (_err) {
					this.#sendError(socket, "Invalid JSON message");
				}
			}
		});

		// Handle client disconnect
		socket.on("close", () => {
			this.#sockets.delete(socket);
			if (clientId) {
				this.#handleClientDisconnect(clientId);
			}
		});

		socket.on("error", () => {
			if (clientId) {
				this.#handleClientDisconnect(clientId);
			}
		});
	}

	/**
	 * Handle a client message.
	 */
	#handleClientMessage(
		message: ClientMessage,
		socket: Socket,
		onAttach: (id: string, mode: ClientMode) => void,
	): void {
		switch (message.type) {
			case "attach": {
				// Check max clients
				if (this.#clients.size >= this.#maxClients) {
					this.#sendError(socket, "Maximum clients reached");
					socket.end();
					return;
				}

				// The mode decides whether this peer's keystrokes reach the session, so
				// it is validated against the closed set rather than tested for one
				// value. A negative `=== "read-only"` check would let `mode: "banana"`
				// attach with full write access on the strength of not being the one
				// string that is refused.
				if (!CLIENT_MODES.includes(message.mode)) {
					this.#sendError(socket, `Unknown client mode ${JSON.stringify(message.mode)}`, "UNKNOWN_CLIENT_MODE");
					socket.end();
					return;
				}

				// Check for duplicate client ID
				if (this.#clients.has(message.clientId)) {
					this.#sendError(socket, "Client ID already connected");
					socket.end();
					return;
				}

				// Register client
				const client: ConnectedClient = {
					id: message.clientId,
					mode: message.mode,
					socket,
					connectedAt: new Date(),
					// Only strings, and only what was actually declared. An absent
					// `capabilities` is an older client, which is exactly the case the
					// gating exists for.
					capabilities: Array.isArray(message.capabilities)
						? message.capabilities.filter((entry): entry is string => typeof entry === "string")
						: [],
				};
				this.#clients.set(message.clientId, client);
				onAttach(message.clientId, message.mode);

				// Send session metadata
				const metadata: ServerMessage = {
					type: "session_metadata",
					sessionId: this.#sessionId,
					cwd: this.#cwd,
					createdAt: this.#createdAt.toISOString(),
				};
				this.#send(socket, metadata);

				// Whatever holds unanswered asks gets its chance now: the client is
				// registered and has its metadata, so a replayed ask lands on a surface
				// that already knows which session it is looking at.
				this.#onAttachReplay?.(message.clientId);

				// Notify other clients
				const joined: ServerMessage = {
					type: "client_joined",
					clientId: message.clientId,
					mode: message.mode,
				};
				this.#broadcast(joined, message.clientId);
				break;
			}

			case "input": {
				// Check if client is in read-write mode
				const client = this.#clients.get(message.clientId);
				if (!client || client.mode === "read-only") {
					this.#sendError(socket, "Read-only clients cannot send input");
					return;
				}

				// Forward input to session
				if (this.#onInput) {
					this.#onInput(message.data, message.clientId);
				}

				// Echo input to all other clients (tmux-style)
				if (this.#broadcastInputEcho) {
					const echo: ServerMessage = {
						type: "input_echo",
						data: message.data,
						clientId: message.clientId,
					};
					this.#broadcast(echo, message.clientId);
				}
				break;
			}

			case "detach": {
				this.#handleClientDisconnect(message.clientId);
				socket.end();
				break;
			}

			case "permission_response": {
				const client = this.#clients.get(message.clientId);
				if (!client || client.socket !== socket) {
					// Either nobody attached under this id, or somebody else did. Both are
					// "you are not that client", said the same way so neither answer is an
					// oracle for which.
					this.#sendError(socket, "Unknown client", "PERMISSION_NOT_ATTACHED");
					return;
				}
				if (client.mode === "read-only") {
					this.#sendError(socket, "Read-only clients cannot answer permissions", "PERMISSION_READ_ONLY");
					return;
				}
				if (!client.capabilities.includes(PERMISSION_RELAY_CAPABILITY)) {
					// It was never sent an ask, so it cannot be answering one it saw.
					this.#sendError(
						socket,
						`Client did not declare the ${PERMISSION_RELAY_CAPABILITY} capability on attach`,
						"PERMISSION_NOT_CAPABLE",
					);
					return;
				}
				if (!this.#onPermissionResponse) {
					// Nothing in this process is holding permission asks. Saying so is the
					// point: silence here is indistinguishable from "accepted", and a phone
					// would sit forever on a dialog nobody is going to resolve.
					this.#sendError(
						socket,
						`No permission ask ${JSON.stringify(message.requestId)} is pending`,
						"PERMISSION_UNKNOWN_REQUEST",
					);
					return;
				}
				this.#onPermissionResponse(message, message.clientId);
				break;
			}

			default: {
				// A client message type this build does not know. Answering is what makes
				// version skew visible in the client→server direction: without this case
				// an unknown frame vanished with no reply at all, so a newer renderer
				// could not tell a draht that had handled its frame from one that had
				// never heard of it.
				const unknown = (message as { type?: unknown }).type;
				this.#sendError(socket, `Unknown message type ${JSON.stringify(unknown)}`, "UNKNOWN_MESSAGE_TYPE");
				break;
			}
		}
	}

	/**
	 * Handle client disconnect.
	 */
	#handleClientDisconnect(clientId: string): void {
		const client = this.#clients.get(clientId);
		if (!client) return;

		this.#clients.delete(clientId);

		// Before the other clients are told, because a listener that keeps
		// per-connection state has to have dropped it by the time anything
		// observable about this session changes.
		this.#onClientDisconnect?.(clientId);

		// Notify other clients
		const left: ServerMessage = {
			type: "client_left",
			clientId,
		};
		this.#broadcast(left);
	}

	/**
	 * Broadcast a message to all clients (or all except one).
	 */
	#broadcast(message: ServerMessage, excludeClientId?: string): void {
		const json = `${JSON.stringify(message)}\n`;
		for (const client of this.#clients.values()) {
			if (client.id !== excludeClientId) {
				client.socket.write(json);
			}
		}
	}

	/**
	 * Send a message to a specific socket.
	 */
	#send(socket: Socket, message: ServerMessage): void {
		const json = `${JSON.stringify(message)}\n`;
		socket.write(json);
	}

	/**
	 * Send an error message to a specific socket.
	 */
	#sendError(socket: Socket, message: string, code?: string): void {
		const error: ServerMessage = {
			type: "error",
			message,
			code,
		};
		this.#send(socket, error);
	}
}
