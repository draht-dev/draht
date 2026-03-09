import { describe, expect, test } from "bun:test";
import { parseArgs, startupLog } from "../cli";
import type { GatewaySettings } from "../config/config";
import { Logger } from "../gateway/logger";

const DEFAULT_CONFIG: GatewaySettings = {
	port: 7878,
	host: "0.0.0.0",
	tokens: {},
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

describe("parseArgs", () => {
	test("parses --port, --host, and --auth flags", () => {
		const result = parseArgs(["--port", "9999", "--host", "127.0.0.1", "--auth", "token123"], DEFAULT_CONFIG);
		expect(result.port).toBe(9999);
		expect(result.host).toBe("127.0.0.1");
		expect(result.authToken).toBe("token123");
		expect(result.config).toEqual(DEFAULT_CONFIG);
	});

	test("defaults port to 7878 and host to 0.0.0.0 when not provided", () => {
		const result = parseArgs(["--auth", "token123"], DEFAULT_CONFIG);
		expect(result.port).toBe(7878);
		expect(result.host).toBe("0.0.0.0");
	});

	test("allows custom host", () => {
		const result = parseArgs(["--auth", "my-token", "--host", "localhost"], DEFAULT_CONFIG);
		expect(result.host).toBe("localhost");
	});

	test("throws when --auth is missing and no default token", () => {
		expect(() => parseArgs(["--port", "8080"], DEFAULT_CONFIG)).toThrow(
			"--auth <token> or --token <name> is required",
		);
	});

	test("throws when port is out of range", () => {
		expect(() => parseArgs(["--port", "99999", "--auth", "token"], DEFAULT_CONFIG)).toThrow(
			"--port must be a number between 1 and 65535",
		);
	});
});

describe("startupLog", () => {
	test("6. startupLog calls logger.info with host and port", () => {
		const lines: string[] = [];
		const sink = { write: (s: string) => lines.push(s) };
		const log = new Logger(sink);

		startupLog("0.0.0.0", 7878, log);

		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(entry.level).toBe("info");
		expect(entry.host).toBe("0.0.0.0");
		expect(entry.port).toBe(7878);
	});
});
