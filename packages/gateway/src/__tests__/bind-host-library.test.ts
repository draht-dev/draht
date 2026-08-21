import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewaySettings } from "../config/config";
import { createServer, isLoopbackHost, startGateway } from "../index";

const LOOPBACK_CONFIG: GatewaySettings = {
	port: 0,
	host: "127.0.0.1",
	tokens: { default: "config-token" },
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

const WILDCARD_CONFIG: GatewaySettings = { ...LOOPBACK_CONFIG, host: "0.0.0.0" };

describe("createServer bind posture (library surface)", () => {
	test("refuses a non-loopback host passed programmatically", () => {
		expect(() => createServer({ port: 0, authToken: "t", host: "0.0.0.0" })).toThrow(
			/Refusing to bind non-loopback host/,
		);
	});

	test("refuses a non-loopback host coming from GatewaySettings", () => {
		expect(() => createServer({ port: 0, authToken: "t", config: WILDCARD_CONFIG })).toThrow(
			/Refusing to bind non-loopback host/,
		);
	});

	test("defaults to loopback and reports the host it enforced", () => {
		expect(createServer({ port: 0, authToken: "t" }).hostname).toBe("127.0.0.1");
		expect(createServer({ port: 0, authToken: "t", config: LOOPBACK_CONFIG }).hostname).toBe("127.0.0.1");
	});

	test("allows a non-loopback host only with the explicit opt-in, and warns", () => {
		const warnings: string[] = [];
		const handle = createServer({
			port: 0,
			authToken: "t",
			host: "0.0.0.0",
			allowNonLoopback: true,
			warn: (message) => warnings.push(message),
		});

		expect(handle.hostname).toBe("0.0.0.0");
		expect(warnings.join("\n")).toMatch(/remote code execution|RCE/i);
	});

	test("rejects a non-string host with a clear error rather than crashing", () => {
		expect(() => createServer({ port: 0, authToken: "t", host: 123 as unknown as string })).toThrow(
			/host must be a string/,
		);
	});
});

describe("startGateway bind posture (library surface)", () => {
	test("refuses a non-loopback bind before any socket is opened", () => {
		expect(() => startGateway({ port: 0, authToken: "t", host: "0.0.0.0" })).toThrow(
			/Refusing to bind non-loopback host/,
		);
	});

	test("binds loopback by default and reports the address actually bound", () => {
		const { server } = startGateway({ port: 0, authToken: "t" });
		try {
			expect(server.hostname).toBe("127.0.0.1");
			expect(server.port).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	});
});

describe("index exports the bind guard", () => {
	test("isLoopbackHost is part of the public surface", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
	});
});

describe("cli end-to-end refusal", () => {
	test("refuses a non-loopback --host without the flag, exits 1, opens no socket", async () => {
		const home = mkdtempSync(join(tmpdir(), "draht-gateway-refuse-"));
		mkdirSync(join(home, ".draht"), { recursive: true });
		writeFileSync(
			join(home, ".draht", "gateway.config.json"),
			JSON.stringify({ host: "127.0.0.1", tokens: { default: "t" } }),
		);

		try {
			const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "--host", "0.0.0.0"], {
				env: { ...process.env, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;

			expect(code).toBe(1);
			expect(stderr).toContain("Refusing to bind non-loopback host '0.0.0.0'.");
			// An operator error, not a crash: no stack trace, no sentinel.
			expect(stderr).not.toContain("at <anonymous>");
			expect(stderr).not.toContain("unreachable");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
