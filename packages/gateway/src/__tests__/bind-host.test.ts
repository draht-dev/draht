import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackHost, nonLoopbackBindError, nonLoopbackBindWarning, parseArgs } from "../cli";
import { DEFAULT_CONFIG, type GatewaySettings } from "../config/config";

const LOOPBACK_CONFIG: GatewaySettings = {
	port: 7878,
	host: "127.0.0.1",
	tokens: { default: "config-token" },
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

/** Simulates an old on-disk ~/.draht/gateway.config.json that still says 0.0.0.0. */
const LEGACY_WILDCARD_CONFIG: GatewaySettings = { ...LOOPBACK_CONFIG, host: "0.0.0.0" };

describe("isLoopbackHost", () => {
	test.each(["127.0.0.1", "::1", "localhost"])("classifies %s as loopback", (host) => {
		expect(isLoopbackHost(host)).toBe(true);
	});

	test.each(["0.0.0.0", "::", "100.72.9.11", "192.168.1.10", "10.0.0.5", "gateway.example.com", ""])(
		"classifies %s as non-loopback",
		(host) => {
			expect(isLoopbackHost(host)).toBe(false);
		},
	);

	test("normalizes case, surrounding whitespace, and IPv6 brackets", () => {
		expect(isLoopbackHost("LocalHost")).toBe(true);
		expect(isLoopbackHost("  127.0.0.1  ")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
	});
});

describe("DEFAULT_CONFIG", () => {
	test("binds loopback by default", () => {
		expect(DEFAULT_CONFIG.host).toBe("127.0.0.1");
		expect(isLoopbackHost(DEFAULT_CONFIG.host)).toBe(true);
	});
});

describe("parseArgs loopback guard", () => {
	test("rejects a non-loopback --host without --allow-non-loopback", () => {
		expect(() => parseArgs(["--host", "100.72.9.11", "--auth", "t"], LOOPBACK_CONFIG)).toThrow(
			/Refusing to bind non-loopback host/,
		);
		expect(() => parseArgs(["--host", "100.72.9.11", "--auth", "t"], LOOPBACK_CONFIG)).toThrow(/tailscale serve/);
	});

	test("rejects --host 0.0.0.0 without --allow-non-loopback", () => {
		expect(() => parseArgs(["--host", "0.0.0.0", "--auth", "t"], LOOPBACK_CONFIG)).toThrow(
			/Refusing to bind non-loopback host/,
		);
	});

	test("rejects a non-loopback host coming from the config file, with no --host flag", () => {
		expect(() => parseArgs(["--auth", "t"], LEGACY_WILDCARD_CONFIG)).toThrow(/Refusing to bind non-loopback host/);
	});

	test("accepts a non-loopback host when --allow-non-loopback is passed", () => {
		const warnings: string[] = [];
		const result = parseArgs(["--host", "100.72.9.11", "--auth", "t", "--allow-non-loopback"], LOOPBACK_CONFIG, {
			warn: (message) => warnings.push(message),
		});

		expect(result.host).toBe("100.72.9.11");
		expect(result.allowNonLoopback).toBe(true);
		expect(warnings.join("\n")).toMatch(/command/i);
		expect(warnings.join("\n")).toMatch(/remote code execution|RCE/i);
	});

	test("accepts a non-loopback config-file host when --allow-non-loopback is passed", () => {
		const warnings: string[] = [];
		const result = parseArgs(["--auth", "t", "--allow-non-loopback"], LEGACY_WILDCARD_CONFIG, {
			warn: (message) => warnings.push(message),
		});

		expect(result.host).toBe("0.0.0.0");
		expect(result.allowNonLoopback).toBe(true);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("accepts loopback hosts without the flag and warns about nothing", () => {
		const warnings: string[] = [];
		for (const host of ["127.0.0.1", "::1", "localhost"]) {
			const result = parseArgs(["--host", host, "--auth", "t"], LOOPBACK_CONFIG, {
				warn: (message) => warnings.push(message),
			});
			expect(result.host).toBe(host);
			expect(result.allowNonLoopback).toBe(false);
		}
		expect(warnings).toEqual([]);
	});

	test("--allow-non-loopback on a loopback bind stays silent", () => {
		const warnings: string[] = [];
		const result = parseArgs(["--auth", "t", "--allow-non-loopback"], LOOPBACK_CONFIG, {
			warn: (message) => warnings.push(message),
		});
		expect(result.host).toBe("127.0.0.1");
		expect(warnings).toEqual([]);
	});
});

/**
 * The gateway's loopback-by-default bind posture is NOT a closure of GSEC-04.
 *
 * GSEC-04's named component in `.planning/geist/SECURITY-2026-07-13.md` is the
 * PAIRING SERVER, which this package does not contain or touch. Stamping the ID
 * across gateway code and docs would manufacture closure evidence for a finding
 * that is still open — the exact failure mode the 2026-07-13 audit recorded.
 */
describe("no manufactured GSEC-04 closure evidence", () => {
	const PKG_ROOT = join(import.meta.dir, "..", "..");
	const SCANNED = [
		"src/cli.ts",
		"src/gateway/bind-host.ts",
		"src/gateway/server.ts",
		"src/config/config.ts",
		"src/gateway/routes/sessions.ts",
		"README.md",
		"SPEC.md",
		"TAILSCALE_SETUP.md",
	];

	test("the operator-facing guard strings never cite GSEC-04", () => {
		expect(nonLoopbackBindError("0.0.0.0")).not.toMatch(/GSEC-04/);
		expect(nonLoopbackBindWarning("0.0.0.0")).not.toMatch(/GSEC-04/);
		expect(nonLoopbackBindError("0.0.0.0")).toMatch(/Refusing to bind non-loopback host/);
	});

	test.each(SCANNED)("%s only mentions GSEC-04 as the still-open pairing-server finding", (relative) => {
		const text = readFileSync(join(PKG_ROOT, relative), "utf-8");
		for (let at = text.indexOf("GSEC-04"); at !== -1; at = text.indexOf("GSEC-04", at + 1)) {
			const context = text.slice(Math.max(0, at - 400), at + 400);
			expect(context).toMatch(/pairing/i);
			expect(context).toMatch(/remains open|not close|does not close|still open/i);
		}
	});
});
