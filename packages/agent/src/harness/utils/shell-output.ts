import { type ExecutionEnv, ExecutionError, err, ok, type Result, type ShellExecOptions, toError } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	onChunk?: (chunk: string) => void;
	/** Return shell execution failures with captured output instead of as a failed Result. */
	returnExecutionErrors?: boolean;
}

export interface ShellCaptureResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	truncation: TruncationResult;
	fullOutputPath?: string;
	executionError?: ExecutionError;
}

function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0;
	let completedLines = 0;
	let hasOpenLine = false;
	let fullOutputPath: string | undefined;
	let fullOutputRequested = false;
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined;

	const appendFullOutput = (text: string): void => {
		if (!fullOutputRequested || captureError) return;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			if (!fullOutputPath) return err(new ExecutionError("unknown", "Full output path was not created"));
			const appendResult = await env.appendFile(fullOutputPath, text);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputRequested || captureError) return;
		fullOutputRequested = true;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const tempFile = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const appendResult = await env.appendFile(tempFile.value, initialContent);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const onChunk = (chunk: string) => {
		try {
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			totalBytes += encoder.encode(text).byteLength;
			const newlineCount = text.split("\n").length - 1;
			completedLines += newlineCount;
			if (newlineCount > 0) hasOpenLine = !text.endsWith("\n");
			else if (text.length > 0) hasOpenLine = true;
			const totalLines = completedLines + (hasOpenLine ? 1 : 0);
			if ((totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES) && !fullOutputRequested) {
				ensureFullOutputFile(outputChunks.join("") + text);
			} else if (fullOutputRequested) {
				appendFullOutput(text);
			}
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}
			options?.onChunk?.(text);
		} catch (error) {
			captureError = toExecutionError(error);
		}
	};

	try {
		const result = await env.exec(command, {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
			abortSignal: options?.abortSignal,
			onStdout: onChunk,
			onStderr: onChunk,
		});
		const tailOutput = outputChunks.join("");
		const tailTruncation = truncateTail(tailOutput);
		const totalLines = completedLines + (hasOpenLine ? 1 : 0);
		const truncated = totalLines > DEFAULT_MAX_LINES || totalBytes > DEFAULT_MAX_BYTES;
		const truncationResult: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ?? (totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes,
		};
		if (truncated && !fullOutputRequested) ensureFullOutputFile(tailOutput);
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);

		if (!result.ok) {
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({
					output: truncationResult.truncated ? truncationResult.content : tailOutput,
					exitCode: undefined,
					cancelled: true,
					truncated: truncationResult.truncated,
					truncation: truncationResult,
					fullOutputPath,
				});
			}
			if (options?.returnExecutionErrors) {
				return ok({
					output: truncationResult.truncated ? truncationResult.content : tailOutput,
					exitCode: undefined,
					cancelled: false,
					truncated: truncationResult.truncated,
					truncation: truncationResult,
					fullOutputPath,
					executionError: result.error,
				});
			}
			return err(result.error);
		}
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			output: truncationResult.truncated ? truncationResult.content : tailOutput,
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated: truncationResult.truncated,
			truncation: truncationResult,
			fullOutputPath,
		});
	} catch (error) {
		return err(toExecutionError(error));
	}
}
