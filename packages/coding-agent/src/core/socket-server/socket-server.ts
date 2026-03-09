/**
 * SocketServer - Unix domain socket server for attachable draht sessions
 *
 * Enables tmux-style multi-client attachment:
 * - Multiple readers/writers can connect simultaneously
 * - All clients see the same output
 * - Input from any client is echoed to all others
 * - Clients can join/leave without disrupting the session
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type { ClientMessage, ClientMode, ConnectedClient, ServerMessage } from "./types.js";

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
	#createdAt = new Date();

	/** Callback for input received from any client */
	#onInput: ((data: string, clientId: string) => void) | null = null;

	constructor(options: SocketServerOptions) {
		this.#sessionId = options.sessionId;
		this.#cwd = options.cwd;
		this.#maxClients = options.maxClients ?? 10;
		this.#broadcastInputEcho = options.broadcastInputEcho ?? true;

		this.#socketPath = path.join(options.socketDir, `${options.sessionId}.sock`);
		this.#lockPath = path.join(options.socketDir, `${options.sessionId}.lock`);
	}

	/**
	 * Start the socket server.
	 * Creates socket directory, binds Unix socket, and starts listening.
	 */
	async start(): Promise<void> {
		// Ensure socket directory exists
		const socketDir = path.dirname(this.#socketPath);
		await mkdir(socketDir, { recursive: true, mode: 0o700 });

		// Clean up stale socket if it exists
		if (existsSync(this.#socketPath)) {
			await rm(this.#socketPath, { force: true });
		}

		// Write PID lock file for cleanup on crash
		await writeFile(this.#lockPath, `${process.pid}\n${this.#cwd}\n${this.#createdAt.toISOString()}`);

		// Create Unix domain socket server
		this.#server = createServer((socket) => this.#handleConnection(socket));

		// Bind to socket path
		await new Promise<void>((resolve, reject) => {
			this.#server!.listen(this.#socketPath, () => resolve());
			this.#server!.on("error", reject);
		});

		// Set socket permissions (owner-only)
		await import("node:fs/promises").then((fs) => fs.chmod(this.#socketPath, 0o600));
	}

	/**
	 * Stop the socket server and clean up.
	 */
	async stop(): Promise<void> {
		// Disconnect all clients
		for (const client of this.#clients.values()) {
			client.socket.end();
		}
		this.#clients.clear();

		// Close server
		if (this.#server) {
			await new Promise<void>((resolve) => {
				this.#server!.close(() => resolve());
			});
			this.#server = null;
		}

		// Clean up socket and lock files
		await rm(this.#socketPath, { force: true });
		await rm(this.#lockPath, { force: true });
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
	 * Set callback for input received from clients.
	 */
	onInput(callback: (data: string, clientId: string) => void): void {
		this.#onInput = callback;
	}

	/**
	 * Get socket path for this session.
	 */
	get socketPath(): string {
		return this.#socketPath;
	}

	/**
	 * Get number of connected clients.
	 */
	get clientCount(): number {
		return this.#clients.size;
	}

	/**
	 * Handle new client connection.
	 */
	#handleConnection(socket: Socket): void {
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
		}
	}

	/**
	 * Handle client disconnect.
	 */
	#handleClientDisconnect(clientId: string): void {
		const client = this.#clients.get(clientId);
		if (!client) return;

		this.#clients.delete(clientId);

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
