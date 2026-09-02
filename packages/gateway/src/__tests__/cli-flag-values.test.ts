import { describe, expect, test } from "bun:test";
import { parseArgs } from "../cli";
import type { GatewaySettings } from "../config/config";

const CONFIG: GatewaySettings = {
	port: 7878,
	host: "127.0.0.1",
	tokens: { default: "config-token", named: "named-token" },
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

describe("value-taking flags reject a flag as their value", () => {
	test("--auth does not swallow --allow-non-loopback as a bearer token", () => {
		expect(() => parseArgs(["--auth", "--allow-non-loopback"], CONFIG)).toThrow(/--auth/);
		expect(() => parseArgs(["--auth", "--allow-non-loopback"], CONFIG)).toThrow(/--allow-non-loopback/);
	});

	test("--host does not swallow the next flag", () => {
		expect(() => parseArgs(["--host", "--auth", "t"], CONFIG)).toThrow(/--host/);
	});

	test("--port does not swallow the next flag", () => {
		expect(() => parseArgs(["--port", "--auth", "t"], CONFIG)).toThrow(/--port/);
	});

	test("--token does not swallow the next flag", () => {
		expect(() => parseArgs(["--token", "--auth", "t"], CONFIG)).toThrow(/--token/);
	});

	test("a swallowed flag never becomes the bearer token", () => {
		let authToken: string | undefined;
		try {
			authToken = parseArgs(["--auth", "--allow-non-loopback"], CONFIG).authToken;
		} catch {
			authToken = undefined;
		}
		expect(authToken).not.toBe("--allow-non-loopback");
	});

	test("a legitimate value that merely starts with a dash still works", () => {
		expect(parseArgs(["--auth", "-not-a-flag"], CONFIG).authToken).toBe("-not-a-flag");
	});

	test("missing values are still reported", () => {
		expect(() => parseArgs(["--auth"], CONFIG)).toThrow(/--auth requires/);
		expect(() => parseArgs(["--host"], CONFIG)).toThrow(/--host requires/);
		expect(() => parseArgs(["--port"], CONFIG)).toThrow(/--port requires/);
		expect(() => parseArgs(["--token"], CONFIG)).toThrow(/--token requires/);
	});
});
