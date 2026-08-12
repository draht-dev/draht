import { EXIT_ERROR } from "./exit-codes.ts";

/**
 * An error the CLI knows how to report: it carries a stable machine-readable
 * `code` (which appears verbatim in `--json` error documents, so it is part of
 * the published contract) and the exit code the process should end with.
 *
 * Anything thrown that is *not* a `CliError` is an internal fault and is
 * reported under the `internal` code with exit 1 — never swallowed.
 */
export class CliError extends Error {
	public readonly code: string;
	public readonly exitCode: number;
	public readonly detail?: Record<string, unknown>;

	constructor(
		code: string,
		message: string,
		options: { exitCode?: number; detail?: Record<string, unknown>; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "CliError";
		this.code = code;
		this.exitCode = options.exitCode ?? EXIT_ERROR;
		this.detail = options.detail;
	}
}

/** Bad command line: unknown verb, unknown flag, missing value, contradictory flags. */
export class UsageError extends CliError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super("usage", message, { detail });
		this.name = "UsageError";
	}
}

/** A refusal: the command would mutate but is not allowed to (no confirmation, lock held, unsafe state). */
export class BlockedError extends CliError {
	constructor(code: string, message: string, detail?: Record<string, unknown>) {
		super(code, message, { exitCode: 3, detail });
		this.name = "BlockedError";
	}
}

/** Normalizes anything thrown into a `CliError` without losing the original message. */
export function toCliError(error: unknown): CliError {
	if (error instanceof CliError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new CliError("internal", message, { cause: error });
}
