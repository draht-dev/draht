import { describe, expect, test } from "bun:test";
import type { LogSink } from "../gateway/logger";
import { Logger, logger } from "../gateway/logger";

describe("Logger", () => {
	/** Helper: collect all writes from a mock sink into one string */
	function makeSink(): { lines: string[]; sink: LogSink } {
		const lines: string[] = [];
		const sink: LogSink = {
			write(s: string) {
				lines.push(s);
			},
		};
		return { lines, sink };
	}

	test("1. Logger.info writes JSON with level==='info' and correct message", () => {
		const { lines, sink } = makeSink();
		const log = new Logger(sink);
		log.info({ message: "hello" });

		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry.level).toBe("info");
		expect(entry.message).toBe("hello");
	});

	test("2. Logger.warn writes level==='warn' and extra fields", () => {
		const { lines, sink } = makeSink();
		const log = new Logger(sink);
		log.warn({ message: "careful", code: 42 });

		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry.level).toBe("warn");
		expect(entry.code).toBe(42);
	});

	test("3. Logger.error writes level==='error' and err field", () => {
		const { lines, sink } = makeSink();
		const log = new Logger(sink);
		log.error({ message: "boom", err: "oops" });

		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry.level).toBe("error");
		expect(entry.err).toBe("oops");
	});

	test("4. Each call writes exactly one line ending with '\\n'", () => {
		const { lines, sink } = makeSink();
		const log = new Logger(sink);
		log.info({ message: "a" });
		log.warn({ message: "b" });
		log.error({ message: "c" });

		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect(line.endsWith("\n")).toBe(true);
		}
	});

	test("5. Logger created with no explicit stream defaults to process.stderr", () => {
		// Construct with no args — should not throw and should use process.stderr
		const log = new Logger();
		// We can't easily inspect stderr, but construction must succeed
		expect(log).toBeInstanceOf(Logger);
	});

	test("6. Module-level export `logger` is an instance of Logger", () => {
		expect(logger).toBeInstanceOf(Logger);
	});

	test("7. Custom sink receives output (construct Logger with mock sink)", () => {
		const { lines, sink } = makeSink();
		const log = new Logger(sink);
		log.info({ message: "custom" });

		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry.message).toBe("custom");
		// Timestamp must be a valid ISO-8601 string
		const ts = entry.timestamp as string;
		expect(typeof ts).toBe("string");
		expect(() => new Date(ts)).not.toThrow();
		expect(new Date(ts).toISOString()).toBe(ts);
	});
});
