import type { AppKeybinding } from "../../../src/core/keybindings.ts";
import type {
	ClientSnapshot,
	CodingAgentEvent,
	CodingAgentSnapshot,
	ServerWireMessage,
	SessionRequest,
	WireView,
} from "./protocol.ts";

export interface ClientTransport {
	close(): void;
	request(request: SessionRequest): Promise<void>;
	start(listener: (message: ServerWireMessage) => void): void;
}

/** Replicated client state: one app snapshot plus active targeted views. */
export class CodingAgentClientStore {
	readonly events: CodingAgentEvent[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly viewMap = new Map<string, WireView>();
	private appState: CodingAgentSnapshot | undefined;

	get app(): CodingAgentSnapshot {
		if (!this.appState) throw new Error("Session snapshot has not arrived");
		return this.appState;
	}

	get views(): readonly WireView[] {
		return [...this.viewMap.values()];
	}

	apply(message: ServerWireMessage): void {
		if (message.type === "response") return;
		if (message.type === "snapshot") {
			this.replace(message.snapshot);
		} else if (message.type === "event") {
			this.events.push(structuredClone(message.event));
			if (message.event.type === "config_update") {
				this.appState = { ...this.app, configuration: structuredClone(message.event.value) };
			} else {
				this.appState = { ...this.app, providers: structuredClone(message.event.providers) };
			}
		} else if (message.type === "view_updated") {
			this.viewMap.set(message.view.id, structuredClone(message.view));
		} else {
			this.viewMap.delete(message.viewId);
		}
		for (const listener of this.listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private replace(snapshot: ClientSnapshot): void {
		this.appState = structuredClone(snapshot.app);
		this.viewMap.clear();
		for (const view of snapshot.views) this.viewMap.set(view.id, structuredClone(view));
	}
}

export class SessionClient {
	readonly ready: Promise<void>;
	readonly store = new CodingAgentClientStore();
	private readonly resolveReady: () => void;
	private readonly transport: ClientTransport;
	private receivedSnapshot = false;

	constructor(transport: ClientTransport) {
		this.transport = transport;
		let settleReady!: () => void;
		this.ready = new Promise<void>((resolve) => {
			settleReady = resolve;
		});
		this.resolveReady = settleReady;
		transport.start((message) => {
			this.store.apply(message);
			if (message.type === "snapshot" && !this.receivedSnapshot) {
				this.receivedSnapshot = true;
				this.resolveReady();
			}
		});
	}

	close(): void {
		this.transport.close();
	}

	invokeAction(id: AppKeybinding): Promise<void> {
		return this.transport.request({ type: "invoke_action", id });
	}

	sendView(viewId: string, message: unknown): Promise<void> {
		return this.transport.request({ type: "view_message", viewId, message });
	}

	submit(input: string): Promise<void> {
		return this.transport.request({ type: "submit", input });
	}
}
