/**
 * SocketClient - Client for attaching to a draht socket session
 *
 * Connects to a Unix domain socket, sends input, and receives output.
 * Used when running `draht --attach <session-id>`.
 */

import { connect, type Socket } from "node:net";
import type { ClientMessage, ClientMode, ServerMessage } from "./types.js";

export interface SocketClientOptions {
	/** Path to the Unix socket */
	socketPath: string;
	/** Client identifier (defaults to random ID) */
	clientId?: string;
	/** Connection mode */
	mode?: ClientMode;
}

/**
 * SocketClient connects to a socket-based draht session.
 *
 * Provides callbacks for output, metadata, and connection events.
 */
export class SocketClient {
	readonly #socketPath: string;
	readonly #clientId: string;
	readonly #mode: ClientMode;

	#socket: Socket | null = null;
	#buffer = "";

	/** Callbacks */
	#onOutput: ((data: string, stream: "stdout" | "stderr") => void) | null = null;
	#onMetadata: ((sessionId: string, cwd: string, createdAt: Date) => void) | null = null;
	#onClientJoined: ((clientId: string, mode: ClientMode) => void) | null = null;
	#onClientLeft: ((clientId: string) => void) | null = null;
	#onInputEcho: ((data: string, clientId: string) => void) | null = null;
	#onError: ((message: string) => void) | null = null;
	#onDisconnect: (() => void) | null = null;

	constructor(options: SocketClientOptions) {
		this.#socketPath = options.socketPath;
		this.#clientId = options.clientId ?? `client-${crypto.randomUUID().slice(0, 8)}`;
		this.#mode = options.mode ?? "read-write";
	}

	/**
	 * Connect to the socket server.
	 */
	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#socket = connect(this.#socketPath);

			this.#socket.on("connect", () => {
				// Send attach message
				const attach: ClientMessage = {
					type: "attach",
					clientId: this.#clientId,
					mode: this.#mode,
				};
				this.#send(attach);
				resolve();
			});

			this.#socket.on("data", (data) => {
				this.#handleData(data);
			});

			this.#socket.on("close", () => {
				if (this.#onDisconnect) {
					this.#onDisconnect();
				}
			});

			this.#socket.on("error", (err) => {
				reject(err);
			});
		});
	}

	/**
	 * Disconnect from the socket server.
	 */
	disconnect(): void {
		if (this.#socket) {
			const detach: ClientMessage = {
				type: "detach",
				clientId: this.#clientId,
			};
			this.#send(detach);
			this.#socket.end();
			this.#socket = null;
		}
	}

	/**
	 * Send input to the session.
	 */
	sendInput(data: string): void {
		if (!this.#socket) {
			throw new Error("Not connected");
		}

		const input: ClientMessage = {
			type: "input",
			data,
			clientId: this.#clientId,
		};
		this.#send(input);
	}

	/**
	 * Set callback for output received from session.
	 */
	onOutput(callback: (data: string, stream: "stdout" | "stderr") => void): void {
		this.#onOutput = callback;
	}

	/**
	 * Set callback for session metadata (received on attach).
	 */
	onMetadata(callback: (sessionId: string, cwd: string, createdAt: Date) => void): void {
		this.#onMetadata = callback;
	}

	/**
	 * Set callback for when another client joins.
	 */
	onClientJoined(callback: (clientId: string, mode: ClientMode) => void): void {
		this.#onClientJoined = callback;
	}

	/**
	 * Set callback for when another client leaves.
	 */
	onClientLeft(callback: (clientId: string) => void): void {
		this.#onClientLeft = callback;
	}

	/**
	 * Set callback for input echo from other clients.
	 */
	onInputEcho(callback: (data: string, clientId: string) => void): void {
		this.#onInputEcho = callback;
	}

	/**
	 * Set callback for errors.
	 */
	onError(callback: (message: string) => void): void {
		this.#onError = callback;
	}

	/**
	 * Set callback for disconnect.
	 */
	onDisconnect(callback: () => void): void {
		this.#onDisconnect = callback;
	}

	/**
	 * Handle incoming data from server.
	 */
	#handleData(data: Buffer): void {
		this.#buffer += data.toString();
		const lines = this.#buffer.split("\n");
		this.#buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const message = JSON.parse(line) as ServerMessage;
				this.#handleServerMessage(message);
			} catch {
				// Ignore malformed messages
			}
		}
	}

	/**
	 * Handle a server message.
	 */
	#handleServerMessage(message: ServerMessage): void {
		switch (message.type) {
			case "output":
				if (this.#onOutput) {
					this.#onOutput(message.data, message.stream);
				}
				break;

			case "input_echo":
				if (this.#onInputEcho) {
					this.#onInputEcho(message.data, message.clientId);
				}
				break;

			case "client_joined":
				if (this.#onClientJoined) {
					this.#onClientJoined(message.clientId, message.mode);
				}
				break;

			case "client_left":
				if (this.#onClientLeft) {
					this.#onClientLeft(message.clientId);
				}
				break;

			case "session_metadata":
				if (this.#onMetadata) {
					this.#onMetadata(message.sessionId, message.cwd, new Date(message.createdAt));
				}
				break;

			case "error":
				if (this.#onError) {
					this.#onError(message.message);
				}
				break;
		}
	}

	/**
	 * Send a message to the server.
	 */
	#send(message: ClientMessage): void {
		if (!this.#socket) return;
		const json = `${JSON.stringify(message)}\n`;
		this.#socket.write(json);
	}
}
