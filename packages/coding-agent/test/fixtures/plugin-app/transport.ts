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
		const requests = new Map<number, AbortController>();
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
			if (message.type === "cancel") {
				requests.get(message.id)?.abort();
				return;
			}
			const controller = new AbortController();
			requests.set(message.id, controller);
			void this.driver
				.request(clientId, message.request, controller.signal)
				.then(
					(result) => peer.send({ type: "response", id: message.id, result }),
					(error: unknown) =>
						peer.send({
							type: "response",
							id: message.id,
							error: error instanceof Error ? error.message : String(error),
						}),
				)
				.finally(() => requests.delete(message.id));
		});
		socket.once("close", () => {
			for (const controller of requests.values()) controller.abort();
			requests.clear();
			disconnect?.();
			this.sockets.delete(socket);
		});
	}
}

export class TcpClientTransport implements ClientTransport {
	private readonly buffered: ServerWireMessage[] = [];
	private readonly peer: JsonLineSocket<ServerWireMessage, ClientWireMessage>;
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: unknown): void; stopAbort(): void }
	>();
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
				pending.stopAbort();
				if (message.error) pending.reject(new Error(message.error));
				else pending.resolve(message.result);
			} else if (this.listener) {
				this.listener(message);
			} else {
				this.buffered.push(message);
			}
		});
		socket.once("close", () => {
			for (const pending of this.pending.values()) {
				pending.stopAbort();
				pending.reject(new Error("Session connection closed"));
			}
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

	request(request: SessionRequest, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		const id = this.nextRequestId++;
		return new Promise<unknown>((resolve, reject) => {
			const abort = () => {
				if (!this.pending.delete(id)) return;
				this.peer.send({ type: "cancel", id });
				reject(signal?.reason ?? new Error("RPC aborted"));
			};
			const stopAbort = () => signal?.removeEventListener("abort", abort);
			this.pending.set(id, { resolve, reject, stopAbort });
			signal?.addEventListener("abort", abort, { once: true });
			this.peer.send({ type: "request", id, request });
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

export class LoopbackTransport implements ClientTransport {
	private readonly active = new Set<AbortController>();
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

	request(request: SessionRequest, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		const controller = new AbortController();
		this.active.add(controller);
		return new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const finish = (settle: () => void) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				this.active.delete(controller);
				settle();
			};
			const abort = () => {
				controller.abort(signal?.reason);
				finish(() => reject(signal?.reason ?? new Error("RPC aborted")));
			};
			signal?.addEventListener("abort", abort, { once: true });
			void this.driver.request(this.clientId, request, controller.signal).then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(error)),
			);
		});
	}

	close(): void {
		for (const controller of this.active) controller.abort();
		this.active.clear();
		this.disconnect();
	}
}
