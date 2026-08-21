import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry } from "@draht/geist-core";
import * as QRCode from "qrcode";
import { type CliDeps, runCli } from "../../src/cli.js";
import type { CommandRunner } from "../../src/tailscale.js";

/**
 * `geist pair` — the QR and deep link that put a phone on this daemon
 * (R33-REACH.4, and the sign-off condition that the bootstrap token never
 * appears in a URL's query string, R33-REACH.3).
 *
 * Three things are asserted here that a looser test would miss:
 *
 *  1. **The origin comes from the live `tailscale serve` mapping.** The
 *     requirement says "derived from the live `tailscale serve` mapping rather
 *     than typed into config", so the test stubs the command runner and proves
 *     `serve status --json` was actually consulted. A test that let the origin
 *     come from anywhere else would pass against the exact implementation the
 *     requirement forbids.
 *  2. **The QR encodes the printed string byte-for-byte.** The QR is re-encoded
 *     here from the URL the command printed, with the same renderer options,
 *     and compared to the block the command emitted. A phone that scans a QR
 *     encoding anything other than the copyable link — a stale token, a
 *     truncated URL, a different origin — fails in a way no assertion on the
 *     printed text alone would catch.
 *  3. **The token is in the fragment and is real.** The fragment is spent
 *     against the registry: it must actually exchange. Asserting only the shape
 *     `#token=<64 hex>` would pass on a token the daemon never minted.
 */

/** A `tailscale serve status --json` payload publishing loopback 7878 on a MagicDNS name. */
const SERVE_STATUS = {
	TCP: { 443: { HTTPS: true } },
	Web: {
		"fake-mac.tailbeef.ts.net:443": {
			Handlers: { "/": { Proxy: "http://127.0.0.1:7878" } },
		},
	},
};

interface Harness {
	deps: CliDeps;
	registry: DeviceRegistry;
	registryPath: string;
	out: string[];
	err: string[];
	calls: string[][];
	cleanup: () => void;
}

function harness(serveStatus: unknown = SERVE_STATUS): Harness {
	const dir = mkdtempSync(join(tmpdir(), "geist-pair-"));
	const registryPath = join(dir, "devices.json");
	const registry = new DeviceRegistry({ path: registryPath });
	const out: string[] = [];
	const err: string[] = [];
	const calls: string[][] = [];

	const run: CommandRunner = (_bin, args) => {
		calls.push([...args]);
		if (args[0] === "serve" && args[1] === "status" && args.includes("--json")) {
			return { code: 0, stdout: `${JSON.stringify(serveStatus, null, 2)}\n`, stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `fake tailscale: unexpected argv ${args.join(" ")}` };
	};

	return {
		deps: {
			run,
			registry,
			stdout: (text: string) => out.push(text),
			stderr: (text: string) => err.push(text),
		},
		registry,
		registryPath,
		out,
		err,
		calls,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function lines(chunks: string[]): string[] {
	return chunks.join("\n").split("\n");
}

describe("geist pair", () => {
	test("pair prints a deep link whose bootstrap token is in the fragment and a QR encoding that same string byte-for-byte, with the origin read from a stubbed `tailscale serve status --json`", async () => {
		const h = harness();
		try {
			const code = await runCli(["pair", "--port", "7878"], h.deps);
			expect(h.err.join("\n")).not.toMatch(/error/i);
			expect(code).toBe(0);

			// (1) the origin was read from the live serve mapping, not from config
			expect(h.calls).toContainEqual(["serve", "status", "--json"]);

			// (2) the deep link carries the MagicDNS origin and the token in the fragment
			const link = lines(h.out).find((line) => line.startsWith("https://"));
			expect(link).toBeDefined();
			expect(link).toMatch(/^https:\/\/fake-mac\.tailbeef\.ts\.net\/ui#token=[0-9a-f]{64}$/);

			// (3) the QR encodes that exact string — re-encoded here, compared byte-for-byte
			const expectedQr = await QRCode.toString(link as string, { type: "terminal", small: true });
			expect(h.out.join("\n")).toContain(expectedQr.trimEnd());

			// (4) the fragment is a real, spendable bootstrap token
			const token = (link as string).split("#token=")[1] as string;
			const exchanged = new DeviceRegistry({ path: h.registryPath }).exchange(token, {
				name: "iPhone",
				platform: "ios",
			});
			expect(exchanged.ok).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("no credential ever reaches a query string — the printed link has no `?` and no `&token=`", async () => {
		const h = harness();
		try {
			await runCli(["pair", "--port", "7878"], h.deps);
			const printed = h.out.join("\n");
			const link = lines(h.out).find((line) => line.startsWith("https://")) as string;
			expect(link).not.toContain("?");
			expect(link).not.toContain("&token=");
			expect(printed).not.toMatch(/[?&]token=/);
		} finally {
			h.cleanup();
		}
	});

	test("with no serve mapping the command exits non-zero, prints the remediation, and mints no token", async () => {
		const h = harness({ TCP: {}, Web: {} });
		try {
			const code = await runCli(["pair", "--port", "7878"], h.deps);
			expect(code).not.toBe(0);
			const complaint = h.err.join("\n");
			expect(complaint).toContain("tailscale serve");
			expect(complaint).toContain("geist-tailscale-serve.mjs");
			// A refusal an operator reads must not quote an internal finding id (R33-REACH.10).
			expect(complaint).not.toMatch(/GSEC-\d+/);
			// Nothing was printed that could be scanned or photographed…
			expect(h.out.join("\n")).not.toMatch(/#token=/);
			// …and, decisively, no bootstrap token was minted: the store was never written.
			expect(existsSync(h.registryPath)).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	test("`--origin` bypasses the live mapping and says so on stderr", async () => {
		const h = harness();
		try {
			const code = await runCli(["pair", "--origin", "https://manual.example.ts.net"], h.deps);
			expect(code).toBe(0);
			expect(h.calls).toEqual([]);
			expect(h.err.join("\n")).toContain("--origin");
			expect(h.err.join("\n")).toMatch(/bypass/i);
			const link = lines(h.out).find((line) => line.startsWith("https://")) as string;
			expect(link).toMatch(/^https:\/\/manual\.example\.ts\.net\/ui#token=[0-9a-f]{64}$/);
		} finally {
			h.cleanup();
		}
	});
});

describe("geist subcommand dispatch", () => {
	test("bare invocation prints usage naming the subcommands, and still resolves `--config`", async () => {
		const h = harness();
		try {
			const code = await runCli(["--config", "/tmp/geist-explicit.yaml"], h.deps);
			expect(code).toBe(0);
			const printed = h.out.join("\n");
			expect(printed).toContain("geist pair");
			expect(printed).toContain("geist devices");
			expect(printed).toContain("/tmp/geist-explicit.yaml");
		} finally {
			h.cleanup();
		}
	});

	test("an unknown subcommand exits 2 with a message naming it", async () => {
		const h = harness();
		try {
			const code = await runCli(["frobnicate"], h.deps);
			expect(code).toBe(2);
			expect(h.err.join("\n")).toContain("frobnicate");
			expect(h.err.join("\n")).toMatch(/unknown subcommand/i);
		} finally {
			h.cleanup();
		}
	});

	test("`devices` is a known subcommand, not an unknown-subcommand refusal", async () => {
		const h = harness();
		try {
			const code = await runCli(["devices", "list"], h.deps);
			expect(h.err.join("\n")).not.toMatch(/unknown subcommand/i);
			expect(code).toBe(0);
		} finally {
			h.cleanup();
		}
	});
});
