import { describe, expect, test } from "bun:test";
import { parseArgs, startupLog } from "../cli";
import type { LogSink } from "../gateway/logger";
import { Logger } from "../gateway/logger";

describe("parseArgs", () => {
	test("parses --port and --auth flags", () => {
		const result = parseArgs(["--port", "7878", "--auth", "mytoken"]);
		expect(result.port).toBe(7878);
		expect(result.authToken).toBe("mytoken");
	});

	test("defaults port to 7878 when not provided", () => {
		const result = parseArgs(["--auth", "mytoken"]);
		expect(result.port).toBe(7878);
		expect(result.authToken).toBe("mytoken");
	});

	test("throws when --auth is missing", () => {
		expect(() => parseArgs(["--port", "7878"])).toThrow();
	});

	test("throws when port is out of range", () => {
		expect(() => parseArgs(["--port", "0", "--auth", "tok"])).toThrow();
		expect(() => parseArgs(["--port", "65536", "--auth", "tok"])).toThrow();
	});
});

describe("startupLog", () => {
	test("6. startupLog calls logger.info with the port", () => {
		const lines: string[] = [];
		const sink: LogSink = { write: (s) => lines.push(s) };
		const log = new Logger(sink);

		startupLog(7878, log);

		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry.level).toBe("info");
		expect(entry.port).toBe(7878);
	});
});
