/**
 * `draht-acp` — a real ACP *agent-side* process wrapping `@draht/coding-agent`'s
 * `AgentSession` (geist spec §6, §17.1; Phase 35 / M3). This is the ONE package
 * in the geist family allowed to import `@draht/*`: a thin shim that lets draht
 * participate in geist — and in any other ACP client (Zed, JetBrains) — with
 * exactly the privileges of any configured agent, no more.
 *
 * It mirrors the CLIENT-side event bridging of `packages/geist-acp`'s
 * `acp-harness-session.ts`, but in the opposite direction: it translates an
 * `AgentSession`'s internal event stream OUT to ACP `session/update`
 * notifications, and drives ACP's `session/request_permission` round-trip IN
 * before any built-in tool runs (spec §12/§15: "permission requests are never
 * auto-answered", "confinement v1 = ACP permission flow").
 *
 * The model/provider seam is injectable via {@link DrahtAcpAgentConfig.sessionOptions}
 * so the same shim serves a keyless faux-provider model (CI) or a real
 * registry-backed model (deployment).
 */

import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import {
	type AgentApp,
	type AgentConnection,
	type AgentContext,
	agent,
	type ContentBlock,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type Stream,
	type ToolKind,
} from "@agentclientprotocol/sdk";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@draht/coding-agent";

/** Reported to the ACP client in `initialize` unless overridden by config. */
const DEFAULT_AGENT_NAME = "draht-acp";
const AGENT_VERSION = "2026.7.11";

/**
 * A tool definition with erased param/detail types — coding-agent's own `ToolDef`
 * shape. The `any` is load-bearing: `ToolDefinition`'s `renderCall`/`renderResult`
 * are strictly (contravariantly) checked property functions, so a specific
 * `ToolDefinition<Schema, Details>` is not assignable to the default generic
 * form. Erasing the type parameters is exactly how coding-agent passes
 * heterogeneous tools through `customTools`.
 */
type AnyToolDefinition = ToolDefinition<any, any>;

/** Inputs the shim resolves for each new ACP session. */
export interface DrahtAcpSessionContext {
	/** Absolute working directory the ACP client requested for this session. */
	readonly cwd: string;
	/** The ACP session id the shim minted (also the `AgentSession` scope). */
	readonly acpSessionId: string;
}

/**
 * Configuration for {@link buildDrahtAcpAgent}.
 *
 * The shim owns everything ACP: the handshake, the `session/update` translation,
 * and the permission gate. The caller owns only the model/provider seam via
 * {@link sessionOptions}, keeping faux-vs-real fully injectable (never hardcoded).
 */
export interface DrahtAcpAgentConfig {
	/** Human-readable agent name advertised to the ACP client. */
	readonly name?: string;
	/**
	 * Resolves the `@draht/coding-agent` options for a new session's `cwd`.
	 *
	 * Return a `model` (a faux-provider model for keyless CI, or a real model for
	 * deployment) plus any hermetic services (`modelRuntime`, `sessionManager`,
	 * `settingsManager`, ...). The shim layers permission-gated built-in tools on
	 * top and creates the `AgentSession` itself via `createAgentSession`, so
	 * callers never wire ACP or the confinement flow.
	 */
	readonly sessionOptions: (
		context: DrahtAcpSessionContext,
	) => CreateAgentSessionOptions | Promise<CreateAgentSessionOptions>;
}

/**
 * Per-session state shared (by reference) between the `session/new`,
 * `session/prompt`, and `session/cancel` handlers and the permission-gated
 * tools. `client`/`session` are populated after construction; the gated tools
 * only read them at execute time (during a prompt), by which point both exist.
 */
interface SessionHandle {
	readonly acpSessionId: string;
	readonly cwd: string;
	/** Connection context for calling client-side ACP methods; refreshed per request. */
	client: AgentContext | undefined;
	session: AgentSession | undefined;
	/** Set when the client sends `session/cancel` so the prompt reports `cancelled`. */
	cancelled: boolean;
}

/** Maps a built-in tool name to the closest ACP `ToolKind` for client rendering. */
function toolKind(toolName: string): ToolKind {
	switch (toolName) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		case "bash":
			return "execute";
		default:
			return "other";
	}
}

/** Best-effort file path from a tool's arguments, for ACP `locations`. */
function argsPath(args: unknown): string | undefined {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const path = record.path ?? record.file_path;
		if (typeof path === "string" && path.length > 0) return path;
	}
	return undefined;
}

/** `{ locations }` for an ACP tool-call update, or `{}` when no path is known. */
function toolLocations(args: unknown, cwd: string): { locations: Array<{ path: string }> } | Record<string, never> {
	const path = argsPath(args);
	if (!path) return {};
	return { locations: [{ path: isAbsolute(path) ? path : resolve(cwd, path) }] };
}

/**
 * Flattens the incoming ACP `ContentBlock[]` to the plain text
 * `AgentSession.prompt()` expects.
 *
 * v1 only forwards `text` blocks. Image/resource blocks (`image`,
 * `resource_link`, `resource`) are dropped here — carrying them into the
 * `AgentSession` is a v2 concern (spec §6 Dispatch row).
 */
function promptToText(blocks: ContentBlock[]): string {
	return blocks
		.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Requests ACP permission for one tool call and returns whether it was approved.
 *
 * This is the AGENT side of the exact round-trip `acp-harness-session.ts`
 * implements on the client side: it blocks until the client answers
 * `session/request_permission`. With no connected client there is nothing to
 * ask, so the call is declined — permission is never auto-answered (spec §12).
 */
async function requestToolPermission(
	handle: SessionHandle,
	toolCallId: string,
	toolName: string,
	title: string,
): Promise<boolean> {
	const client = handle.client;
	if (!client) return false;
	const response = await client.request(methods.client.session.requestPermission, {
		sessionId: handle.acpSessionId,
		toolCall: {
			toolCallId,
			title,
			kind: toolKind(toolName),
			status: "pending",
		},
		options: [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
		],
	});
	return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
}

/**
 * Wraps one built-in `ToolDefinition` so its execution first requests ACP
 * permission and only calls through to the real implementation on approval. On
 * rejection it returns a tool result marking the call declined — never silently
 * doing nothing, and never throwing an unhandled error.
 */
function gateToolDefinition(base: AnyToolDefinition, handle: SessionHandle): AnyToolDefinition {
	return {
		...base,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const approved = await requestToolPermission(handle, toolCallId, base.name, base.label ?? base.name);
			if (!approved) {
				return {
					content: [
						{
							type: "text",
							text: `Permission denied: the "${base.name}" tool call was declined by the user and was not executed.`,
						},
					],
					details: undefined as unknown,
				};
			}
			return base.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/** Builds the permission-gated built-in coding tools (read, bash, edit, write). */
function buildGatedCodingTools(cwd: string, handle: SessionHandle): AnyToolDefinition[] {
	const bases: AnyToolDefinition[] = [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
	return bases.map((base) => gateToolDefinition(base, handle));
}

/**
 * Builds the ACP agent app. Register-only; call `.connect(stream)` (or use
 * {@link runDrahtAcpAgentStdio}) to serve a client.
 */
export function buildDrahtAcpAgent(config: DrahtAcpAgentConfig): AgentApp {
	const name = config.name ?? DEFAULT_AGENT_NAME;
	const sessions = new Map<string, SessionHandle>();
	let sessionCounter = 0;

	return agent({ name })
		.onRequest(methods.agent.initialize, () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: false },
			},
			agentInfo: { name, version: AGENT_VERSION },
		}))
		.onRequest(methods.agent.session.new, async ({ params, client }) => {
			const acpSessionId = `draht-session-${++sessionCounter}`;
			const handle: SessionHandle = {
				acpSessionId,
				cwd: params.cwd,
				client,
				session: undefined,
				cancelled: false,
			};
			const options = await config.sessionOptions({ cwd: params.cwd, acpSessionId });
			const gatedTools = buildGatedCodingTools(params.cwd, handle);
			// `noTools: "builtin"` suppresses the un-gated built-ins; the gated
			// versions (same names) are supplied as customTools and become the
			// active tool set — so no tool can run without the permission gate.
			const { session } = await createAgentSession({
				...options,
				cwd: params.cwd,
				customTools: [...gatedTools, ...(options.customTools ?? [])],
				noTools: "builtin",
			});
			handle.session = session;
			sessions.set(acpSessionId, handle);
			return { sessionId: acpSessionId };
		})
		.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
			const handle = sessions.get(params.sessionId);
			if (!handle?.session) throw new Error(`unknown session ${params.sessionId}`);
			handle.client = client;
			handle.cancelled = false;

			// Bridge AgentSession events OUT to ACP session/update notifications,
			// mirroring acp-harness-session.ts in reverse. Subscribe BEFORE
			// prompting so no tool event is missed.
			const unsubscribe = handle.session.subscribe((event: AgentSessionEvent) => {
				if (event.type === "tool_execution_start") {
					void client
						.notify(methods.client.session.update, {
							sessionId: params.sessionId,
							update: {
								sessionUpdate: "tool_call",
								toolCallId: event.toolCallId,
								title: event.toolName,
								kind: toolKind(event.toolName),
								status: "in_progress",
								...toolLocations(event.args, handle.cwd),
							},
						})
						.catch(() => {});
				} else if (event.type === "tool_execution_end") {
					void client
						.notify(methods.client.session.update, {
							sessionId: params.sessionId,
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: event.toolCallId,
								status: event.isError ? "failed" : "completed",
							},
						})
						.catch(() => {});
				}
			});

			try {
				// Resolves once the turn genuinely ends (the underlying agent run
				// settles). Permission requests raised by gated tools mid-turn block
				// here until the client answers.
				await handle.session.prompt(promptToText(params.prompt));
			} finally {
				unsubscribe();
			}

			return { stopReason: handle.cancelled ? "cancelled" : "end_turn" };
		})
		.onNotification(methods.agent.session.cancel, ({ params }) => {
			const handle = sessions.get(params.sessionId);
			if (!handle?.session) return;
			handle.cancelled = true;
			// AgentSession exposes cancellation via abort() (aborts the current run,
			// then waits for idle). Fire it; the in-flight prompt resolves once the
			// run settles and reports `cancelled`.
			void handle.session.abort().catch(() => {});
		});
}

/**
 * Connects a {@link buildDrahtAcpAgent} app to this process's stdio as an ACP
 * newline-delimited JSON stream — exactly how a real launch spec spawns it.
 */
export function runDrahtAcpAgentStdio(config: DrahtAcpAgentConfig): AgentConnection {
	const outgoing = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
	const incoming = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
	const stream: Stream = ndJsonStream(outgoing, incoming);
	return buildDrahtAcpAgent(config).connect(stream);
}
