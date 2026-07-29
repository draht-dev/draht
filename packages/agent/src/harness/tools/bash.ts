import { type Static, Type } from "typebox";
import type { AgentHarnessTool, ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { executeShellWithCapture } from "../utils/shell-output.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateTail,
} from "../utils/truncate.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const BASH_UPDATE_THROTTLE_MS = 100;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolContext {
	env: ExecutionEnv;
	sessionId: string;
}

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env?: Record<string, string>;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
	commandPrefix?: string;
	spawnHook?: BashSpawnHook;
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

export function createBashTool<TContext extends BashToolContext = BashToolContext>(
	options?: BashToolOptions,
): AgentHarnessTool<TContext, typeof bashSchema, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, signal, onUpdate, { env }) {
			validateTimeout(timeout);
			const resolvedCommand = options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command;
			const spawnContext = options?.spawnHook?.({ command: resolvedCommand, cwd: env.cwd }) ?? {
				command: resolvedCommand,
				cwd: env.cwd,
			};
			let partialOutput = "";
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = (): void => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const truncation = truncateTail(partialOutput);
				onUpdate({
					content: [{ type: "text", text: truncation.content }],
					details: { truncation: truncation.truncated ? truncation : undefined },
				});
			};
			const clearUpdateTimer = (): void => {
				if (!updateTimer) return;
				clearTimeout(updateTimer);
				updateTimer = undefined;
			};
			const scheduleOutputUpdate = (): void => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			onUpdate?.({ content: [], details: undefined });
			try {
				const capture = getOrThrow(
					await executeShellWithCapture(env, spawnContext.command, {
						cwd: spawnContext.cwd,
						env: spawnContext.env,
						timeout,
						abortSignal: signal,
						returnExecutionErrors: true,
						onChunk: (chunk) => {
							partialOutput += chunk;
							if (partialOutput.length > DEFAULT_MAX_BYTES * 4) {
								partialOutput = partialOutput.slice(-DEFAULT_MAX_BYTES * 2);
							}
							scheduleOutputUpdate();
						},
					}),
				);
				clearUpdateTimer();
				emitOutputUpdate();

				let outputText = capture.output;
				let details: BashToolDetails | undefined;
				if (capture.truncation.truncated) {
					details = { truncation: capture.truncation, fullOutputPath: capture.fullOutputPath };
					const startLine = capture.truncation.totalLines - capture.truncation.outputLines + 1;
					const endLine = capture.truncation.totalLines;
					if (capture.truncation.lastLinePartial) {
						outputText += `\n\n[Showing last ${formatSize(capture.truncation.outputBytes)} of line ${endLine}. Full output: ${capture.fullOutputPath}]`;
					} else if (capture.truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines}. Full output: ${capture.fullOutputPath}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${capture.fullOutputPath}]`;
					}
				}

				const appendStatus = (status: string): string => `${outputText ? `${outputText}\n\n` : ""}${status}`;
				if (capture.cancelled) throw new Error(appendStatus("Command aborted"));
				if (capture.executionError?.code === "timeout") {
					throw new Error(appendStatus(`Command timed out after ${timeout} seconds`), {
						cause: capture.executionError,
					});
				}
				if (capture.executionError) throw capture.executionError;
				if (capture.exitCode !== 0 && capture.exitCode !== undefined) {
					throw new Error(appendStatus(`Command exited with code ${capture.exitCode}`));
				}
				return { content: [{ type: "text", text: outputText || "(no output)" }], details };
			} finally {
				clearUpdateTimer();
			}
		},
	};
}
