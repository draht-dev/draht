/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import type { PermissionAskDetail } from "../../core/extensions/types.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { RelayOutcome } from "../../core/permission-relay/types.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	/** One option as it was OFFERED, carrying its own decision. Never re-derived from an answer. */
	type OfferedOption = PermissionAskDetail["options"][number];

	// Pending extension UI requests waiting for response.
	//
	// `offeredOptions` is the immutable set this exact request went out with (R34-PERM.5). It is
	// stored at emit time, never taken from the answer, and is what an incoming `optionId` is
	// checked against — the answering client does not get to name a vocabulary of its own.
	const pendingExtensionRequests = new Map<
		string,
		{
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			offeredOptions?: readonly OfferedOption[];
			/**
			 * How this surface tells the caller what it ACTUALLY did (T8-FIX2).
			 *
			 * `ExtensionUIContext.confirm` returns a bare `Promise<boolean>`, so the `false` this
			 * mode resolves on shutdown, on stdin EOF and on `abort` is indistinguishable from a
			 * human pressing "No" — and it was recorded as one: `{decision: "denied", decidedBy:
			 * {surface: "rpc"}}` for asks nobody ever saw. This is where that stops being a guess.
			 */
			reportOutcome?: (outcome: RelayOutcome) => void;
		}
	>();

	/**
	 * Resolve every outstanding extension UI dialog as cancelled.
	 *
	 * Without this, an abort issued while a dialog is open (the permission gate's
	 * `ctx.ui.confirm`, say) leaves its promise unsettled forever: the agent loop
	 * stays parked in `beforeToolCall`, `session.abort()` never observes idle, and
	 * the session is wedged for the life of the process. Interactive mode has no
	 * equivalent hole because Esc reaches the selector's own onCancel.
	 *
	 * Fail closed: each dialog resolves to its *negative* default — `confirm` to
	 * `false`, `select`/`input`/`editor` to `undefined` — exactly as the existing
	 * `{ cancelled: true }` wire response resolves them. A cancellation can never
	 * be mistaken for an approval.
	 */
	const cancelPendingExtensionRequests = (): void => {
		if (pendingExtensionRequests.size === 0) return;
		const cancelled = [...pendingExtensionRequests.entries()];
		pendingExtensionRequests.clear();
		for (const [id, pending] of cancelled) {
			// SAID BEFORE IT IS RESOLVED. Nobody answered this dialog — the process is shutting
			// down, stdin reached EOF, or an `abort` came in — and the `false` below cannot carry
			// that. Without this line the audit row reads as a human at this surface refusing a
			// tool call they were never shown.
			pending.reportOutcome?.({ kind: "cancelled" });
			pending.resolve({ type: "extension_ui_response", id, cancelled: true } satisfies RpcExtensionUIResponse);
		}
	};

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				// An abort is not an answer. Same reasoning as `cancelPendingExtensionRequests`.
				opts?.reportOutcome?.({ kind: "cancelled" });
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					// Nor is a timeout: the human simply never got to it.
					opts.reportOutcome?.({ kind: "cancelled" });
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
				offeredOptions: opts?.detail?.options,
				reportOutcome: opts?.reportOutcome,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		// `detail` is threaded through verbatim so an RPC client sees the same canonical facts the
		// TUI does. It is already neutralized and bounded at construction; nothing is reshaped here.
		select: (title, options, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout, detail: opts?.detail },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise(
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout, detail: opts?.detail },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				// Start the abort first so the agent's signal is already set by the time
				// the parked continuation resumes. The loop then reports the tool call as
				// "Operation aborted" instead of falling through to the dialog's own block
				// reason, which is what lets a surface tell an abort from a user pressing
				// "No". Resolving the dialogs is in turn what lets the idle that
				// `session.abort()` awaits ever arrive.
				const aborted = session.abort();
				cancelPendingExtensionRequests();
				await aborted;
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRuntime.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRuntime.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	/**
	 * Upper bound on the unwind in {@link settlePendingDialogsForShutdown}. Nothing
	 * should come close: resolving the dialogs releases the parked continuation
	 * immediately. The bound exists so that a wedge somewhere else in the loop can
	 * never turn "the bridge died" into "the process never exits".
	 */
	const SHUTDOWN_DIALOG_UNWIND_TIMEOUT_MS = 5000;

	/**
	 * Settle every outstanding dialog before the process goes away.
	 *
	 * Shutdown has three doorways — an extension's `shutdownHandler`, SIGTERM /
	 * SIGHUP, and stdin EOF — and all three land here. The last one is the one
	 * that bites: stdin EOF is how a child learns its parent died, so if the relay
	 * bridge crashes while Oskar is away with a permission ask outstanding, this
	 * runs with a live `extension_ui_request` on the wire and the agent loop parked
	 * in `beforeToolCall` waiting for an answer that can no longer arrive.
	 *
	 * Exiting from under that promise is not merely untidy: the dialog is garbage
	 * collected unsettled, so the ask is lost with no record of it, and the session
	 * is persisted with a tool call that neither ran nor was refused. Resolving the
	 * dialogs fail-closed (`cancelPendingExtensionRequests`) and letting the loop
	 * unwind to idle first means the transcript shows the call as aborted, and no
	 * tool can execute on the way out.
	 *
	 * Deliberately *not* in scope: keeping the agent alive past its bridge. That is
	 * a product decision (DECISIONS-PENDING #5), not a bug fix — stdin EOF stays a
	 * termination signal here, exactly as it has always been.
	 *
	 * No pending dialogs means no work: the ordinary teardown path is untouched.
	 */
	const settlePendingDialogsForShutdown = async (): Promise<void> => {
		if (pendingExtensionRequests.size === 0) return;
		// Same ordering as the `abort` command: arm the signal first so the resumed
		// continuation reports "Operation aborted" rather than the dialog's own
		// block reason, then release the dialogs so idle can actually arrive.
		const aborted = session.abort();
		cancelPendingExtensionRequests();
		let unwindTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				aborted,
				new Promise<void>((resolve) => {
					unwindTimer = setTimeout(resolve, SHUTDOWN_DIALOG_UNWIND_TIMEOUT_MS);
				}),
			]);
		} catch {
			// A failed abort must not strand the shutdown; we are exiting regardless.
		} finally {
			if (unwindTimer) clearTimeout(unwindTimer);
		}
	};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await settlePendingDialogsForShutdown();
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (!pending) return;

			// R34-PERM.5 on the RPC surface. An answer that NAMES an option is decided by that
			// option's own `decision`, checked against the immutable set this request was emitted
			// with. Without this, `{confirmed: true, optionId: "deny"}` — a client whose operator
			// pressed DENY — was recorded as an APPROVAL, and the resolution disagreed with what
			// the operator's client believes it sent.
			// PRESENCE, not type. `rpc-types.ts` says an `optionId`, WHEN PRESENT, must be one of the
			// ids the matching request offered — and `123` or `null` is present and is not among
			// them. Gating on `typeof === "string"` would reclassify a wrongly-typed optionId as
			// ABSENT and fall back to `confirmed`, which is the one shape a buggy or hostile
			// middlebox produces. (`undefined` cannot reach here from the wire — this is JSON — and
			// is excluded so an in-process caller spreading an absent field reads as absent.)
			const named: unknown = "optionId" in response ? (response as { optionId?: unknown }).optionId : undefined;
			// A request that recorded NO offered set has nothing for an `optionId` to be validated
			// against, so R34-PERM.5 — whose rule is about the offered set a request actually
			// carries — has no subject here, and the answer decides on `confirmed` as it always
			// did. Do NOT "tighten" this into a refusal: five in-repo dialogs (`/rewind`'s "Restore
			// files?" confirm, `/agent`'s picker, two llama dialogs, `promptForMissingSessionCwd`)
			// pass no `detail`, no `timeout` and no `signal`, so nothing but an answer can ever
			// settle them — refusing there wedges the agent loop permanently. (An offered set that is
			// EMPTY is still a set: a caller that authorised no option authorised none, and every
			// `optionId` against it is refused.)
			if (named !== undefined && pending.offeredOptions !== undefined) {
				// Never by position, index, label or a magic id string: an option's meaning is only
				// ever its own `decision` field. A repeated id makes "which option was named"
				// undecidable, so that is a refusal too rather than a coin flip on the first match.
				const matches = pending.offeredOptions.filter((option) => (option.id as unknown) === named);
				if (matches.length !== 1) {
					// Refuse WITHOUT consuming the request: it stays pending and answerable, so a
					// later valid answer still decides it. Dropping it here would strand the agent
					// loop; resolving it here would let an unoffered word decide a permission.
					output(
						error(
							response.id,
							"extension_ui_response",
							matches.length === 0
								? `optionId ${JSON.stringify(named)} is not one of the options offered for this request; the request is still pending`
								: `optionId ${JSON.stringify(named)} is ambiguous in the offered options for this request; the request is still pending`,
						),
					);
					await waitForRawStdoutBackpressure();
					return;
				}

				// The offered set wins over `confirmed`. A client that sends both is already
				// confused about its own answer, and only one of the two was ever offered to it.
				const chosen = matches[0] as OfferedOption;
				pendingExtensionRequests.delete(response.id);
				// THE ID THE OPERATOR ACTUALLY NAMED, carried through instead of being flattened
				// into a boolean. `confirmed` below is the same fact for a caller that can only
				// read a boolean; this is the same fact for a caller that can record which of
				// `deny-once` and `deny-always` was pressed. Said BEFORE the resolve.
				pending.reportOutcome?.({
					kind: chosen.decision === "approve" ? "approved" : "denied",
					chosenOptionId: chosen.id,
				});
				pending.resolve({ ...response, confirmed: chosen.decision === "approve" } as RpcExtensionUIResponse);
				return;
			}

			// No `optionId` to validate — absent, or present on a request that offered no set to
			// validate it against: decide on `confirmed`, exactly as before. Clients that only know
			// yes/no keep working unchanged.
			pendingExtensionRequests.delete(response.id);
			pending.resolve(response);
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
