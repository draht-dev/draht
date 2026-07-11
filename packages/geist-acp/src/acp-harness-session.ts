import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
	type ActiveSession,
	type ClientConnection,
	type ClientContext,
	type ContentBlock,
	client,
	type InitializeResponse,
	methods,
	ndJsonStream,
	type PermissionOption,
	type Plan,
	type PlanEntry,
	PROTOCOL_VERSION,
	type RequestPermissionResponse,
	type SessionUpdate,
	type ToolCall,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
	type HarnessCapabilities,
	type HarnessSession,
	type HarnessSessionStatus,
	isDirtyOrAhead,
	type SituationPrompt,
} from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

/**
 * A tool-call the agent reported over `session/update` (either a fresh
 * `tool_call` or a `tool_call_update`), flattened to the fields geist-core /
 * the console care about, with the raw ACP payload kept for run-lane rendering
 * (spec §13's "run lanes fed by ACP tool/plan updates").
 */
export interface ToolCallEvent {
	readonly toolCallId: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	/** `true` for a `tool_call_update`, `false` for an initial `tool_call`. */
	readonly isUpdate: boolean;
	readonly raw: ToolCall | ToolCallUpdate;
}

/** A plan the agent reported over `session/update` (`plan`). */
export interface PlanUpdateEvent {
	readonly entries: readonly PlanEntry[];
	readonly raw: Plan;
}

/**
 * A pending ACP `session/request_permission` surfaced to the caller (spec §9.2
 * `permission_request`). The caller learns the `requestId` and offered
 * `options` here, then resolves it via {@link HarnessSession.answerPermission}.
 */
export interface PermissionRequestEvent {
	readonly requestId: string;
	readonly toolCall: ToolCallUpdate;
	readonly options: readonly PermissionOption[];
}

/**
 * `geist-acp`'s concrete `HarnessSession`. Extends the harness-agnostic port
 * `geist-core` owns with the small typed event surface the console/WS layer
 * needs to render ACP tool/plan updates and permission chips — none of which
 * are ACP wire types, so the boundary (spec §17.1) stays intact.
 *
 * Each `on*` method returns an unsubscribe function.
 */
export interface AcpHarnessSession extends HarnessSession {
	/** PID of the underlying ACP subprocess, or `undefined` once it has exited. */
	readonly pid: number | undefined;
	onToolCall(listener: (event: ToolCallEvent) => void): () => void;
	onPlanUpdate(listener: (event: PlanUpdateEvent) => void): () => void;
	onPermissionRequest(listener: (event: PermissionRequestEvent) => void): () => void;
}

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
	".webp": "image/webp",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
};

function imageMimeType(path: string): string {
	return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Runs `git <args>` in `cwd`, returning trimmed stdout or `null` on any failure. */
function runGit(cwd: string, args: readonly string[]): string | null {
	const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	return result.stdout.trim();
}

/**
 * Captures the worktree's `HEAD` at spawn time as `baseSha` (spec §12's spawn
 * step). Returns `null` when `cwd` is not a git worktree — geist always spawns
 * in one, but a null base just means the turn-end review check falls back to a
 * pure dirty check.
 */
function captureBaseSha(cwd: string): string | null {
	const sha = runGit(cwd, ["rev-parse", "HEAD"]);
	return sha != null && sha.length > 0 ? sha : null;
}

/**
 * Translates a `SituationPrompt` (geist-core's harness-agnostic dispatch
 * payload) into ACP `ContentBlock[]` (spec §6 Dispatch row, §9.4):
 *
 * - `text` → ACP `text` content (baseline).
 * - `image` (present only when `capabilities.images` was advertised — Phase 34
 *   gates this) → ACP `image` content. Phase 34 only carries a path, not bytes,
 *   so we read the crop file and base64-encode it, which is what ACP's
 *   `ImageContent` requires (`data` + `mimeType`).
 * - `path-reference` (always present) → ACP `resource_link`. ACP has no
 *   bare-path content type; `resource_link` is the baseline-supported way to
 *   reference an on-disk artifact (a `file://` URI), so the crop path travels
 *   even to agents without image capability.
 */
async function toContentBlocks(prompt: SituationPrompt): Promise<ContentBlock[]> {
	const blocks: ContentBlock[] = [];
	for (const block of prompt.blocks) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const bytes = await readFile(block.path);
			blocks.push({ type: "image", data: bytes.toString("base64"), mimeType: imageMimeType(block.path) });
		} else {
			blocks.push({ type: "resource_link", name: basename(block.path), uri: pathToFileURL(block.path).href });
		}
	}
	return blocks;
}

/**
 * Maps ACP's advertised capabilities to geist's four capability axes
 * (spec §9.2 `fleet_state`). ACP models these across two handshake steps rather
 * than one flat block, so we read each from its real source field:
 *
 * - `images`  ← `initialize` → `agentCapabilities.promptCapabilities.image`.
 * - `resume`  ← `initialize` → `agentCapabilities.sessionCapabilities.resume`
 *   (presence = supported, per the schema: omitted/null = unsupported, `{}` =
 *   supported).
 * - `modes`   ← `session/new` → `SessionModeState.availableModes` non-empty.
 *   ACP models modes at the session layer, not `initialize`.
 * - `commands` ← runtime `available_commands_update` notifications. ACP's ONLY
 *   command-advertisement mechanism is a session update, so `commands` starts
 *   `false` and flips `true` the moment the agent advertises any (tracked live
 *   in {@link AcpHarnessSessionImpl.handleUpdate}), which matches `fleet_state`
 *   being a live B→H push rather than a frozen snapshot.
 */
function deriveCapabilities(init: InitializeResponse, session: ActiveSession): HarnessCapabilities {
	const agent = init.agentCapabilities;
	const modeState = session.modes;
	return {
		images: agent?.promptCapabilities?.image === true,
		commands: false,
		modes: modeState != null && modeState.availableModes.length > 0,
		resume: agent?.sessionCapabilities?.resume != null,
	};
}

interface AcpHarnessSessionInit {
	readonly id: string;
	readonly harness: string;
	readonly cwd: string;
	readonly baseSha: string | null;
	readonly child: ChildProcess;
	readonly connection: ClientConnection;
	readonly ctx: ClientContext;
	readonly session: ActiveSession;
	readonly capabilities: HarnessCapabilities;
	/** Shared with the `session/request_permission` handler registered before connect. */
	readonly pendingPermissions: Map<string, (response: RequestPermissionResponse) => void>;
	/** Shared with the `session/request_permission` handler registered before connect. */
	readonly permissionListeners: Set<(event: PermissionRequestEvent) => void>;
}

class AcpHarnessSessionImpl implements AcpHarnessSession {
	readonly id: string;
	readonly harness: string;

	private readonly cwd: string;
	private readonly baseSha: string | null;
	private readonly child: ChildProcess;
	private readonly connection: ClientConnection;
	private readonly ctx: ClientContext;
	private readonly session: ActiveSession;
	private readonly pendingPermissions: Map<string, (response: RequestPermissionResponse) => void>;
	private readonly permissionListeners: Set<(event: PermissionRequestEvent) => void>;

	private readonly toolCallListeners = new Set<(event: ToolCallEvent) => void>();
	private readonly planListeners = new Set<(event: PlanUpdateEvent) => void>();
	private readonly exited: Promise<void>;

	private _status: HarnessSessionStatus = "running";
	private _capabilities: HarnessCapabilities;

	constructor(init: AcpHarnessSessionInit) {
		this.id = init.id;
		this.harness = init.harness;
		this.cwd = init.cwd;
		this.baseSha = init.baseSha;
		this.child = init.child;
		this.connection = init.connection;
		this.ctx = init.ctx;
		this.session = init.session;
		this._capabilities = init.capabilities;
		this.pendingPermissions = init.pendingPermissions;
		this.permissionListeners = init.permissionListeners;
		this.exited = new Promise<void>((resolve) => {
			if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
			else this.child.once("exit", () => resolve());
		});
	}

	get status(): HarnessSessionStatus {
		return this._status;
	}

	get capabilities(): HarnessCapabilities {
		return this._capabilities;
	}

	get pid(): number | undefined {
		return this.child.exitCode === null && this.child.signalCode === null ? this.child.pid : undefined;
	}

	async dispatch(prompt: SituationPrompt): Promise<void> {
		if (this._status === "stopped") {
			throw new Error("cannot dispatch on a stopped ACP session");
		}
		this._status = "running";
		const blocks = await toContentBlocks(prompt);

		// Fire the prompt but drive it from the update stream: the turn is not
		// over until `nextUpdate()` yields `stop`, and the prompt itself only
		// resolves once permission requests (handled out-of-band) are answered.
		const promptPromise = this.session.prompt(blocks);
		promptPromise.catch(() => {
			// Swallow here to avoid an unhandled rejection while draining; the
			// same rejection is re-observed by the `await` below.
		});

		for (;;) {
			const message = await this.session.nextUpdate();
			if (message.kind === "stop") break;
			this.handleUpdate(message.update);
		}
		await promptPromise;

		// "git is the truth, not the agent's claim" (spec §12): the turn ending
		// only means review is due if the worktree is actually dirty/ahead.
		this._status = isDirtyOrAhead(this.cwd, this.baseSha) ? "awaiting_review" : "running";
	}

	async cancel(): Promise<void> {
		await this.ctx.notify(methods.agent.session.cancel, { sessionId: this.session.sessionId });
		// A cancelled turn must still answer any in-flight permission request —
		// with `cancelled`, per ACP (spec docs: RequestPermissionOutcome::Cancelled).
		for (const resolve of this.pendingPermissions.values()) {
			resolve({ outcome: { outcome: "cancelled" } });
		}
		this.pendingPermissions.clear();
	}

	async answerPermission(requestId: string, optionId: string): Promise<void> {
		const resolve = this.pendingPermissions.get(requestId);
		if (!resolve) {
			throw new Error(`no pending permission request with id "${requestId}"`);
		}
		this.pendingPermissions.delete(requestId);
		resolve({ outcome: { outcome: "selected", optionId } });
	}

	async stop(): Promise<void> {
		this.connection.close();
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill();
		}
		await this.exited;
		this._status = "stopped";
	}

	onToolCall(listener: (event: ToolCallEvent) => void): () => void {
		this.toolCallListeners.add(listener);
		return () => {
			this.toolCallListeners.delete(listener);
		};
	}

	onPlanUpdate(listener: (event: PlanUpdateEvent) => void): () => void {
		this.planListeners.add(listener);
		return () => {
			this.planListeners.delete(listener);
		};
	}

	onPermissionRequest(listener: (event: PermissionRequestEvent) => void): () => void {
		this.permissionListeners.add(listener);
		return () => {
			this.permissionListeners.delete(listener);
		};
	}

	private handleUpdate(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case "tool_call":
				this.emitToolCall(update, false);
				break;
			case "tool_call_update":
				this.emitToolCall(update, true);
				break;
			case "plan":
				for (const listener of this.planListeners) listener({ entries: update.entries, raw: update });
				break;
			case "available_commands_update":
				this._capabilities = { ...this._capabilities, commands: update.availableCommands.length > 0 };
				break;
			default:
				break;
		}
	}

	private emitToolCall(update: ToolCall | ToolCallUpdate, isUpdate: boolean): void {
		const event: ToolCallEvent = {
			toolCallId: update.toolCallId,
			title: update.title ?? undefined,
			kind: update.kind ?? undefined,
			status: update.status ?? undefined,
			isUpdate,
			raw: update,
		};
		for (const listener of this.toolCallListeners) listener(event);
	}
}

/**
 * Spawns one ACP agent subprocess and drives it as a `HarnessSession`
 * (spec §5–§7, §12; Phase 35 / M3). This is the only code in geist that speaks
 * ACP wire shapes.
 *
 * Async because a real session cannot exist before the subprocess is spawned,
 * the `initialize` handshake completes, and `session/new` returns — all of
 * which are needed to report accurate {@link HarnessCapabilities}.
 */
export async function createAcpHarnessSession(launchSpec: AgentLaunchSpec, cwd: string): Promise<AcpHarnessSession> {
	const child = spawn(launchSpec.cmd, launchSpec.args ?? [], { cwd, stdio: ["pipe", "pipe", "inherit"] });
	if (!child.stdin || !child.stdout) {
		child.kill();
		throw new Error(`failed to open stdio pipes for ACP agent "${launchSpec.cmd}"`);
	}

	// A misconfigured `launchSpec.cmd` (e.g. ENOENT for a path that doesn't
	// exist) fails the spawn ASYNCHRONOUSLY: Node emits an 'error' event on the
	// ChildProcess rather than throwing from `spawn`. With no listener, that is
	// an uncaught exception that crashes the whole host process. Register the
	// listener synchronously (before any await, so it's in place before the
	// event can fire) and race the handshake against it, turning a bad command
	// into a clean rejection. The listener stays attached for the process
	// lifetime so a later mid-session 'error' is still handled, never fatal.
	const spawnFailure = new Promise<never>((_resolve, reject) => {
		child.once("error", (err: Error) => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			reject(new Error(`failed to spawn ACP agent "${launchSpec.cmd}": ${err.message}`));
		});
	});
	// Keep a permanent handler on the failure promise so that if the handshake
	// wins the race (normal case) and an 'error' arrives later, the eventual
	// rejection is observed rather than becoming an unhandled rejection.
	spawnFailure.catch(() => {});

	const handshake = buildHandshake(launchSpec, cwd, child);
	// If the spawn fails first, the in-flight handshake will reject later (its
	// stdio has gone away). Observe that rejection so it can't surface as an
	// unhandled rejection once the race has already settled on `spawnFailure`.
	handshake.catch(() => {});

	return Promise.race([spawnFailure, handshake]);
}

/**
 * The ACP handshake proper (connect, `initialize`, `session/new`), split out so
 * {@link createAcpHarnessSession} can race it against an async spawn failure.
 */
async function buildHandshake(
	launchSpec: AgentLaunchSpec,
	cwd: string,
	child: ChildProcess,
): Promise<AcpHarnessSession> {
	// Bridge the subprocess's stdio into an ACP stdio Stream: we write outgoing
	// JSON-RPC to the agent's stdin and read incoming from its stdout. Non-null
	// asserted — the caller already guarded `!child.stdin || !child.stdout`.
	const toAgent = Writable.toWeb(
		child.stdin as NonNullable<typeof child.stdin>,
	) as unknown as WritableStream<Uint8Array>;
	const fromAgent = Readable.toWeb(
		child.stdout as NonNullable<typeof child.stdout>,
	) as unknown as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(toAgent, fromAgent);

	// The permission-request handler must be registered before `connect`, but
	// resolves only when the OUTSIDE caller answers. Its pending map + listener
	// set are shared (by reference) with the session object built below.
	const pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();
	const permissionListeners = new Set<(event: PermissionRequestEvent) => void>();
	let permissionCounter = 0;

	const connection = client({ name: "geist" })
		.onRequest(methods.client.session.requestPermission, ({ params }) => {
			const requestId = `perm-${++permissionCounter}`;
			const response = new Promise<RequestPermissionResponse>((resolve) => {
				pendingPermissions.set(requestId, resolve);
			});
			const event: PermissionRequestEvent = {
				requestId,
				toolCall: params.toolCall,
				options: params.options,
			};
			for (const listener of permissionListeners) listener(event);
			return response;
		})
		.connect(stream);

	const ctx = connection.agent;
	const initResponse = await ctx.request(methods.agent.initialize, {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
	});

	const session = await ctx.buildSession(cwd).start();
	const baseSha = captureBaseSha(cwd);
	const capabilities = deriveCapabilities(initResponse, session);

	return new AcpHarnessSessionImpl({
		id: randomUUID(),
		harness: launchSpec.cmd,
		cwd,
		baseSha,
		child,
		connection,
		ctx,
		session,
		capabilities,
		pendingPermissions,
		permissionListeners,
	});
}
