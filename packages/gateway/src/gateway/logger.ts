/**
 * Structured JSON logger for the Draht Gateway.
 *
 * Writes newline-delimited JSON records to a {@link LogSink}. Each record
 * includes `level`, `timestamp` (ISO-8601), and any caller-supplied fields.
 *
 * @example
 * ```ts
 * import { logger } from './logger';
 * logger.info({ message: 'Gateway started', port: 7878 });
 * // → {"level":"info","timestamp":"...","message":"Gateway started","port":7878}
 * ```
 */

/**
 * Minimal write-only stream interface. Compatible with `process.stderr`
 * and easily mockable in tests.
 */
export interface LogSink {
	write(s: string): void;
}

type Level = "info" | "warn" | "error";

/** Additional fields passed to a log method. */
type LogFields = Record<string, unknown>;

/**
 * Structured JSON logger. Each method writes a single newline-terminated JSON
 * line to the configured {@link LogSink}.
 *
 * Construct with a custom sink in tests; use the module-level {@link logger}
 * singleton for application code.
 */
export class Logger {
	readonly #sink: LogSink;

	/**
	 * @param sink - Destination for log output. Defaults to `process.stderr`.
	 */
	constructor(sink: LogSink = process.stderr) {
		this.#sink = sink;
	}

	/** Write a structured record at the given level. */
	#write(level: Level, fields: LogFields): void {
		const record: LogFields = {
			level,
			timestamp: new Date().toISOString(),
			...fields,
		};
		this.#sink.write(`${JSON.stringify(record)}\n`);
	}

	/**
	 * Log an informational event.
	 * @param fields - Arbitrary key-value pairs to include in the record.
	 */
	info(fields: LogFields): void {
		this.#write("info", fields);
	}

	/**
	 * Log a warning event.
	 * @param fields - Arbitrary key-value pairs to include in the record.
	 */
	warn(fields: LogFields): void {
		this.#write("warn", fields);
	}

	/**
	 * Log an error event.
	 * @param fields - Arbitrary key-value pairs to include in the record.
	 */
	error(fields: LogFields): void {
		this.#write("error", fields);
	}
}

/** Module-level logger singleton writing to `process.stderr`. */
export const logger = new Logger();
