import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { ClientTransport } from "./client.ts";
import type { ClientWireMessage, ServerWireMessage, SessionRequest } from "./protocol.ts";
import type { SessionDriver } from "./session.ts";

class JsonLineSocket<Incoming, Outgoing> {
	private buffer = "";
	private readonly listeners = new Set<(message: Incoming) => void>();
	private readonly socket: Socket;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (!line) continue;
				const message = JSON.parse(line) as Incoming;
				for (const listener of this.listeners) listener(message);
			}
		});
	}

	onMessage(listener: (message: Incoming) => void): void {
		this.listeners.add(listener);
	}

	send(message: Outgoing): void {
		this.socket.write(`${JSON.stringify(message)}\n`);
	}
}

export class SessionTcpServer {
	private readonly driver: SessionDriver;
	private readonly host: string;
	private readonly port: number;
	private readonly sockets = new Set<Socket>();
	private server: Server | undefined;

	constructor(driver: SessionDriver, options: { host: string; port: number }) {
		this.driver = driver;
		this.host = options.host;
		this.port = options.port;
	}

	async start(): Promise<{ host: string; port: number }> {
		if (this.server) throw new Error("Session server already started");
		this.server = createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.port, this.host, () => {
				this.server!.removeListener("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Session server has no TCP address");
		return { host: this.host, port: address.port };
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		const peer = new JsonLineSocket<ClientWireMessage, ServerWireMessage>(socket);
		let clientId: string | undefined;
		let disconnect: (() => void) | undefined;
		peer.onMessage((message) => {
			if (message.type === "hello") {
				disconnect?.();
				clientId = message.clientId;
				disconnect = this.driver.connect(clientId, (outgoing) => peer.send(outgoing));
				return;
			}
			if (!clientId) {
				peer.send({ type: "response", id: message.id, error: "Client has not sent hello" });
				return;
			}
			void this.driver.request(clientId, message.request).then(
				() => peer.send({ type: "response", id: message.id }),
				(error: unknown) =>
					peer.send({
						type: "response",
						id: message.id,
						error: error instanceof Error ? error.message : String(error),
					}),
			);
		});
		socket.once("close", () => {
			disconnect?.();
			this.sockets.delete(socket);
		});
	}
}

export class TcpClientTransport implements ClientTransport {
	private readonly buffered: ServerWireMessage[] = [];
	private readonly peer: JsonLineSocket<ServerWireMessage, ClientWireMessage>;
	private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
	private readonly socket: Socket;
	private listener: ((message: ServerWireMessage) => void) | undefined;
	private nextRequestId = 1;

	private constructor(socket: Socket, clientId: string) {
		this.socket = socket;
		this.peer = new JsonLineSocket(socket);
		this.peer.onMessage((message) => {
			if (message.type === "response") {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				if (message.error) pending.reject(new Error(message.error));
				else pending.resolve();
			} else if (this.listener) {
				this.listener(message);
			} else {
				this.buffered.push(message);
			}
		});
		socket.once("close", () => {
			for (const pending of this.pending.values()) pending.reject(new Error("Session connection closed"));
			this.pending.clear();
		});
		this.peer.send({ type: "hello", clientId });
	}

	static async connect(options: { host: string; port: number; clientId: string }): Promise<TcpClientTransport> {
		const socket = createConnection({ host: options.host, port: options.port });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new TcpClientTransport(socket, options.clientId);
	}

	start(listener: (message: ServerWireMessage) => void): void {
		this.listener = listener;
		for (const message of this.buffered.splice(0)) listener(message);
	}

	request(request: SessionRequest): Promise<void> {
		const id = this.nextRequestId++;
		return new Promise<void>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.peer.send({ type: "request", id, request });
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

export class LoopbackTransport implements ClientTransport {
	private readonly buffered: ServerWireMessage[] = [];
	private readonly disconnect: () => void;
	private readonly driver: SessionDriver;
	private readonly clientId: string;
	private listener: ((message: ServerWireMessage) => void) | undefined;

	constructor(driver: SessionDriver, clientId: string) {
		this.clientId = clientId;
		this.driver = driver;
		this.disconnect = driver.connect(clientId, (message) => {
			if (this.listener) this.listener(message);
			else this.buffered.push(message);
		});
	}

	start(listener: (message: ServerWireMessage) => void): void {
		this.listener = listener;
		for (const message of this.buffered.splice(0)) listener(message);
	}

	request(request: SessionRequest): Promise<void> {
		return this.driver.request(this.clientId, request);
	}

	close(): void {
		this.disconnect();
	}
}
