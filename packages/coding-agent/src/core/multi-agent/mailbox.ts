import { EventEmitter } from "node:events";

/**
 * Teammate mailbox system: in-process pub/sub message passing between agents
 * within a session. No external dependency (e.g. Redis) is required — this is
 * built for single-machine, single-process multi-agent orchestration.
 */

export type MessageType = "TaskRequest" | "TaskResult" | "DataExchange" | "Abort";

export interface Message<TPayload = unknown> {
	id: string;
	type: MessageType;
	from: string;
	to: string;
	payload?: TPayload;
	timestamp: number;
}

export interface MessageInput<TPayload = unknown> {
	type: MessageType;
	payload?: TPayload;
}

export interface SendResult {
	ok: boolean;
	error?: string;
}

interface AgentMailbox {
	agentId: string;
	queue: Message[];
	emitter: EventEmitter;
}

let messageSequence = 0;

function nextMessageId(): string {
	messageSequence += 1;
	return `msg-${Date.now().toString(36)}-${messageSequence}`;
}

/**
 * MailboxSystem coordinates named mailboxes for agents within a session.
 * Mailboxes are created on register() (mirroring agent spawn) and destroyed
 * on deregister() (mirroring agent exit), per the multi-agent architecture.
 */
export class MailboxSystem {
	private mailboxes = new Map<string, AgentMailbox>();

	/** Create a mailbox for the given agent. Idempotent. */
	register(agentId: string): void {
		if (this.mailboxes.has(agentId)) {
			return;
		}
		this.mailboxes.set(agentId, { agentId, queue: [], emitter: new EventEmitter() });
	}

	/** Destroy the mailbox for the given agent, discarding any pending messages. */
	deregister(agentId: string): void {
		const mailbox = this.mailboxes.get(agentId);
		if (!mailbox) {
			return;
		}
		mailbox.emitter.removeAllListeners();
		this.mailboxes.delete(agentId);
	}

	isRegistered(agentId: string): boolean {
		return this.mailboxes.has(agentId);
	}

	/** List currently registered agent ids. */
	agents(): string[] {
		return [...this.mailboxes.keys()];
	}

	/**
	 * Send a message from one agent to another. Returns an error result
	 * (rather than throwing) when the target mailbox does not exist, so
	 * callers can handle unreachable teammates gracefully.
	 */
	send<TPayload = unknown>(from: string, to: string, message: MessageInput<TPayload>): SendResult {
		const mailbox = this.mailboxes.get(to);
		if (!mailbox) {
			return { ok: false, error: `Mailbox not found for agent "${to}"` };
		}

		const full: Message<TPayload> = {
			id: nextMessageId(),
			type: message.type,
			from,
			to,
			payload: message.payload,
			timestamp: Date.now(),
		};

		mailbox.queue.push(full);
		mailbox.emitter.emit("message", full);
		return { ok: true };
	}

	/** Send a message to every registered agent except the sender. */
	broadcast<TPayload = unknown>(from: string, message: MessageInput<TPayload>): SendResult {
		let delivered = 0;
		for (const agentId of this.mailboxes.keys()) {
			if (agentId === from) {
				continue;
			}
			const result = this.send(from, agentId, message);
			if (result.ok) {
				delivered += 1;
			}
		}
		return delivered > 0 ? { ok: true } : { ok: false, error: "No recipients for broadcast" };
	}

	/** Non-destructively inspect the pending messages for an agent. */
	peek(agentId: string): Message[] {
		const mailbox = this.mailboxes.get(agentId);
		return mailbox ? [...mailbox.queue] : [];
	}

	/** Return all pending messages for an agent, in FIFO order, and clear the queue. */
	drain(agentId: string): Message[] {
		const mailbox = this.mailboxes.get(agentId);
		if (!mailbox) {
			return [];
		}
		const messages = mailbox.queue;
		mailbox.queue = [];
		return messages;
	}

	/**
	 * Async iterator over an agent's mailbox: yields already-queued messages
	 * first (FIFO), then awaits and yields new messages as they arrive.
	 * Stops once the agent is deregistered.
	 */
	async *receive(agentId: string): AsyncGenerator<Message, void, void> {
		while (true) {
			const mailbox = this.mailboxes.get(agentId);
			if (!mailbox) {
				return;
			}

			const next = mailbox.queue.shift();
			if (next) {
				yield next;
				continue;
			}

			await new Promise<void>((resolve) => {
				mailbox.emitter.once("message", () => resolve());
			});
		}
	}
}
