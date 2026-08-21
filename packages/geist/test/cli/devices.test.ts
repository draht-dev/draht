import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeviceRegistry } from "@draht/geist-core";
import { runCli } from "../../src/cli.js";
import { DEVICES_EXIT, runDevices } from "../../src/commands/devices.js";

/**
 * `geist devices list|revoke` — the enumeration and revocation half of
 * R33-REACH.6.
 *
 * The requirement is two sentences and both of them are load-bearing here.
 *
 * **"individually enumerable"** means an operator can look at a phone in their
 * hand and find its row: an id to revoke by, a name and platform to recognise
 * it by, and a last-seen to tell a live device from one that fell off the
 * tailnet in March. A row that carries only an opaque id is not enumerable in
 * any sense that helps someone decide *which* device to cut off — so the list
 * assertions below check the whole row, not that output was non-empty.
 *
 * **"revocable"** means the revocation outlives the process. The CLI runs in a
 * different process from the daemon; a revocation that lived only in the CLI's
 * in-memory copy would leave the daemon authenticating the revoked phone
 * forever. Every revoke assertion therefore re-reads through a *fresh*
 * `DeviceRegistry` over the same file, and the last test spends the revoked
 * device's still-valid credential against `verify()` to prove the refusal is
 * real rather than cosmetic.
 *
 * The regression that matters most is the credential scan. `DeviceSummary` has
 * no field capable of carrying credential material, but a command is free to
 * open the JSON itself, or to print the registry's raw record while debugging,
 * and a stored digest in a terminal scrollback (or a screenshot of one) is a
 * disclosure. So the scan harvests every secret-derived string that exists —
 * the live credential, the bootstrap token it was exchanged for, and every
 * `hash`/`salt` on disk — and asserts stdout contains none of them.
 */

interface Harness {
	registry: DeviceRegistry;
	registryPath: string;
	out: string[];
	err: string[];
	deps: { registry: DeviceRegistry; stdout: (text: string) => void; stderr: (text: string) => void };
	cleanup: () => void;
}

function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "geist-devices-"));
	const registryPath = join(dir, "devices.json");
	const registry = new DeviceRegistry({ path: registryPath });
	const out: string[] = [];
	const err: string[] = [];

	return {
		registry,
		registryPath,
		out,
		err,
		deps: {
			registry,
			stdout: (text: string) => out.push(text),
			stderr: (text: string) => err.push(text),
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Pairs a device the way the wire does: mint a bootstrap, spend it once. */
function pair(
	registry: DeviceRegistry,
	name: string,
	platform: string,
): { id: string; credential: string; bootstrap: string } {
	const bootstrap = registry.mintBootstrap();
	const exchanged = registry.exchange(bootstrap.token, { name, platform });
	if (!exchanged.ok) throw new Error(`fixture failed to pair ${name}: ${exchanged.reason}`);
	return { id: exchanged.deviceId, credential: exchanged.credential, bootstrap: bootstrap.token };
}

/** Every secret-derived string on disk: salts, digests of credentials, digests of bootstrap tokens. */
function storedSecretStrings(registryPath: string): string[] {
	const found: string[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if ((key === "hash" || key === "salt") && typeof value === "string") found.push(value);
			if (key === "retiredHashes" && Array.isArray(value)) {
				for (const entry of value) if (typeof entry === "string") found.push(entry);
			}
			walk(value);
		}
	};
	walk(JSON.parse(readFileSync(registryPath, "utf-8")));
	return found;
}

describe("geist devices list", () => {
	test("devices list prints id, name, platform and last-seen for each paired device and never prints credential material", async () => {
		const h = harness();
		try {
			const phone = pair(h.registry, "Oskar's iPhone", "ios");
			const headset = pair(h.registry, "Quest 3", "android");

			const code = await runCli(["devices", "list"], h.deps);
			expect(code).toBe(DEVICES_EXIT.OK);
			expect(h.err.join("\n")).toBe("");

			const printed = h.out.join("\n");
			const rows = printed.split("\n").filter((line) => line.includes("dev_"));
			expect(rows).toHaveLength(2);

			const phoneRow = rows.find((line) => line.includes(phone.id)) as string;
			const headsetRow = rows.find((line) => line.includes(headset.id)) as string;
			expect(phoneRow).toBeDefined();
			expect(headsetRow).toBeDefined();

			// (1) every field an operator needs to recognise the device in their hand
			expect(phoneRow).toContain("Oskar's iPhone");
			expect(phoneRow).toContain("ios");
			expect(headsetRow).toContain("Quest 3");
			expect(headsetRow).toContain("android");

			// (2) last-seen is a real, parseable instant — not a raw epoch integer
			const lastSeen = h.registry.list().find((device) => device.id === phone.id)?.lastSeen as number;
			expect(phoneRow).toContain(new Date(lastSeen).toISOString());

			// (3) nothing in the output is, or is derived from, a secret
			for (const secret of [
				phone.credential,
				phone.bootstrap,
				headset.credential,
				headset.bootstrap,
				...storedSecretStrings(h.registryPath),
			]) {
				expect(secret.length).toBeGreaterThan(16);
				expect(printed).not.toContain(secret);
			}
		} finally {
			h.cleanup();
		}
	});

	test("a revoked device still has a row, and the row says revoked", async () => {
		const h = harness();
		try {
			const live = pair(h.registry, "iPhone", "ios");
			const dead = pair(h.registry, "old iPad", "ios");
			h.registry.revoke(dead.id);

			const code = await runCli(["devices", "list"], h.deps);
			expect(code).toBe(DEVICES_EXIT.OK);

			const rows = h.out.join("\n").split("\n");
			const deadRow = rows.find((line) => line.includes(dead.id)) as string;
			const liveRow = rows.find((line) => line.includes(live.id)) as string;
			expect(deadRow).toMatch(/revoked/);
			expect(liveRow).not.toMatch(/revoked/);
		} finally {
			h.cleanup();
		}
	});

	test("an empty registry says so and exits 0, rather than printing an empty table", async () => {
		const h = harness();
		try {
			const code = await runCli(["devices", "list"], h.deps);
			expect(code).toBe(DEVICES_EXIT.OK);
			const printed = h.out.join("\n").trim();
			expect(printed).not.toBe("");
			expect(printed).toMatch(/no paired devices/i);
			// The remediation is the point: an operator who sees this should know what to run.
			expect(printed).toContain("geist pair");
		} finally {
			h.cleanup();
		}
	});
});

describe("geist devices revoke", () => {
	test("revoke marks the device revoked, persists it for another process, exits 0, and is idempotent", async () => {
		const h = harness();
		try {
			const device = pair(h.registry, "iPhone", "ios");

			const first = await runDevices(["revoke", device.id], h.deps);
			expect(first).toBe(DEVICES_EXIT.OK);
			expect(h.out.join("\n")).toContain(device.id);

			// A *fresh* registry over the same file — the daemon's view, not the CLI's.
			const reread = new DeviceRegistry({ path: h.registryPath }).list().find((row) => row.id === device.id);
			expect(reread?.revoked).toBe(true);

			// Written atomically at 0600, with no temp file left behind.
			expect(statSync(h.registryPath).mode & 0o777).toBe(0o600);
			expect(readdirSync(dirname(h.registryPath)).filter((name) => name.includes(".tmp-"))).toEqual([]);

			// Second call: same exit code, still revoked, no crash and no "unknown device".
			const second = await runDevices(["revoke", device.id], h.deps);
			expect(second).toBe(DEVICES_EXIT.OK);
			expect(h.err.join("\n")).toBe("");
			expect(new DeviceRegistry({ path: h.registryPath }).list()[0]?.revoked).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("an unknown id exits non-zero with a message naming it, and mutates nothing", async () => {
		const h = harness();
		try {
			const device = pair(h.registry, "iPhone", "ios");
			const before = readFileSync(h.registryPath, "utf-8");

			const code = await runCli(["devices", "revoke", "dev_deadbeefdeadbeef"], h.deps);
			expect(code).not.toBe(DEVICES_EXIT.OK);

			const complaint = h.err.join("\n");
			expect(complaint).toContain("dev_deadbeefdeadbeef");
			expect(complaint).toMatch(/no such device|unknown device/i);
			// Operator-facing refusals never quote an internal finding id (R33-REACH.10).
			expect(complaint).not.toMatch(/GSEC-\d+/);

			expect(readFileSync(h.registryPath, "utf-8")).toBe(before);
			expect(new DeviceRegistry({ path: h.registryPath }).list().find((row) => row.id === device.id)?.revoked).toBe(
				false,
			);
		} finally {
			h.cleanup();
		}
	});

	test("revoke with no id is a usage error, not a mass revocation", async () => {
		const h = harness();
		try {
			const device = pair(h.registry, "iPhone", "ios");
			const code = await runCli(["devices", "revoke"], h.deps);
			expect(code).toBe(DEVICES_EXIT.USAGE);
			expect(h.err.join("\n")).toMatch(/device id/i);
			expect(new DeviceRegistry({ path: h.registryPath }).list().find((row) => row.id === device.id)?.revoked).toBe(
				false,
			);
		} finally {
			h.cleanup();
		}
	});

	test("after revoke the device's still-valid credential is refused — the revocation is real, not cosmetic", async () => {
		const h = harness();
		try {
			const device = pair(h.registry, "iPhone", "ios");
			expect(h.registry.verify(device.id, device.credential).ok).toBe(true);

			expect(await runCli(["devices", "revoke", device.id], h.deps)).toBe(DEVICES_EXIT.OK);

			const daemonView = new DeviceRegistry({ path: h.registryPath });
			expect(daemonView.verify(device.id, device.credential)).toEqual({ ok: false, outcome: "revoked" });
		} finally {
			h.cleanup();
		}
	});

	test("an unknown devices action is a usage error naming it", async () => {
		const h = harness();
		try {
			const code = await runCli(["devices", "detonate"], h.deps);
			expect(code).toBe(DEVICES_EXIT.USAGE);
			expect(h.err.join("\n")).toContain("detonate");
		} finally {
			h.cleanup();
		}
	});
});
