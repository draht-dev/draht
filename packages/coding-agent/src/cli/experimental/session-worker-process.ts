import { type AgentHarness, BACKGROUND_CONTEXT, MemorySessionRepo } from "@draht/agent-core";
import { isDemoSessionId } from "./demo-sessions.ts";

// Prototype-only control protocol. Real Harness operations will require a
// transport-independent protocol rather than additional ad hoc IPC messages.
export type SessionWorkerCommand = { type: "shutdown" };
export type SessionWorkerEvent =
	| { type: "ready"; sessionId: string; pid: number }
	| { type: "failed"; message: string };

function send(event: SessionWorkerEvent): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) {
			reject(new Error("Session worker requires an IPC channel"));
			return;
		}
		process.send(event, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function run(): Promise<void> {
	// Prototype-only catalog validation. A production worker will resolve the
	// requested session through durable storage.
	const sessionId = process.argv[2];
	if (!sessionId || !isDemoSessionId(sessionId)) throw new Error(`Unknown demo session: ${sessionId ?? ""}`);

	// Prototype-only isolated state. The parent and child intentionally seed
	// separate repositories; this does not provide persistence or shared state.
	const repo = new MemorySessionRepo();
	// Seed, close, list, and reopen to model restoring an existing Session
	// instead of handing the freshly created facade directly to the Harness.
	const created = await repo.create({ id: sessionId }, BACKGROUND_CONTEXT);
	await created.close(BACKGROUND_CONTEXT);
	const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((candidate) => candidate.id === sessionId);
	if (!metadata) throw new Error(`Unknown demo session: ${sessionId}`);
	const session = await repo.open(metadata, BACKGROUND_CONTEXT);
	// Prototype-only close-capable Harness placeholder. A production worker will
	// construct and own the real AgentHarness for this durable Session.
	const harnessOwner: Pick<AgentHarness, "close"> = { close: () => session.close(BACKGROUND_CONTEXT) };

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (!closing) {
			closing = harnessOwner.close(BACKGROUND_CONTEXT).finally(() => repo.close(BACKGROUND_CONTEXT));
		}
		return closing;
	};

	process.on("message", (message: SessionWorkerCommand) => {
		if (message?.type !== "shutdown") return;
		void close().then(
			() => process.exit(0),
			(error: unknown) => {
				console.error(error);
				process.exit(1);
			},
		);
	});
	process.once("disconnect", () => void close().finally(() => process.exit(0)));
	process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
	process.once("SIGINT", () => void close().finally(() => process.exit(0)));

	await send({ type: "ready", sessionId, pid: process.pid });
}

void run().catch(async (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	await send({ type: "failed", message }).catch(() => {});
	process.exit(1);
});
