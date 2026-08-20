/**
 * FIX-1 — the daemon's composition root fills the `devices` port.
 *
 * `GatewayConfig.devices` has been declared, forwarded into `createFleetRoutes`
 * and read by `attachAuthentication` since Phase 33 landed, and until this file
 * existed **nothing an operator could type ever filled it**: `cli.ts` built its
 * `startGateway({...})` argument with no `devices` at all, so the shipped binary
 * took `attachAuthentication`'s third branch, handed the bridge
 * `NO_DEVICE_EXCHANGE`, and refused every `pair_device` frame ever sent to it.
 * `geist pair` could mint a bootstrap token that no device could spend.
 *
 * What is asserted here is therefore the *config the CLI constructs*, not a
 * hand-rolled adapter beside it: {@link gatewayOptions} is the single object
 * `main()` passes to `startGateway`, and every clause below reaches through its
 * `devices` field. A test that built its own `DeviceRegistry` adapter would pass
 * while the daemon still shipped without one — which is exactly the defect.
 *
 * The store is driven the way the real deployment drives it: a **second**
 * `DeviceRegistry` object over the same file, because `geist pair` and
 * `geist devices revoke` are other processes with other handles on one file.
 * That is also why the file is deliberately absent when the options are built —
 * on a real machine the daemon starts first and `geist pair` writes the store
 * afterwards, and a wiring that only worked when the file already existed would
 * be unreachable in precisely the order an operator does things.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceRegistry, resolveDeviceRegistryPath } from "@draht/geist-core";
import { gatewayOptions, parseArgs } from "../cli";
import type { GatewaySettings } from "../config/config";
import { Logger } from "../gateway/logger";
import type { AttachDeviceAuthenticator } from "../gateway/routes/fleet";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

/** The daemon's shared operator token. Never a device credential. */
const TOKEN = "cli-devices-wiring-operator-token";

const SETTINGS: GatewaySettings = {
	port: 0,
	host: "127.0.0.1",
	tokens: {},
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

let home: string;
let devicesPath: string;
/** Every structured record the CLI's logger wrote while a clause ran. */
let records: Record<string, unknown>[];
let log: Logger;

beforeEach(() => {
	home = mkdtempSync("/tmp/cdw-home-");
	devicesPath = join(home, ".geist", "devices.json");
	records = [];
	log = new Logger({
		write: (line: string) => {
			records.push(JSON.parse(line) as Record<string, unknown>);
		},
	});
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/**
 * Build the exact options object the CLI hands `startGateway`.
 *
 * `parseArgs` runs first, as it does in `main()`, so a change that moved the
 * device wiring behind a flag or a config key would show up here rather than
 * being quietly bypassed.
 */
function optionsFor(env: NodeJS.ProcessEnv) {
	const parsed = parseArgs(["--auth", TOKEN], SETTINGS, { warn: () => {} });
	return gatewayOptions(parsed, new SessionManager(new EventBus()), { env, log });
}

/** The `devices` port as the CLI filled it, or a failure naming what is missing. */
function authenticatorFrom(env: NodeJS.ProcessEnv): AttachDeviceAuthenticator {
	const options = optionsFor(env);
	if (options.devices === undefined) {
		throw new Error("the CLI built its gateway options with no devices port");
	}
	return options.devices;
}

/** The environment the daemon is deployed with: a store location, named. */
function configuredEnv(): NodeJS.ProcessEnv {
	return { HOME: home, GEIST_DEVICES_PATH: devicesPath };
}

/** `geist pair` / `geist devices revoke`: another process, another handle, one file. */
function elsewhere(): DeviceRegistry {
	return new DeviceRegistry({ path: devicesPath });
}

function pair(devices: AttachDeviceAuthenticator, name: string): { deviceId: string; credential: string } {
	const bootstrap = elsewhere().mintBootstrap().token;
	const result = devices.pair({ bootstrapToken: bootstrap, device: { name, platform: "ios" } });
	if (!result.ok) throw new Error(`pairing was refused: ${result.reason ?? "no reason given"}`);
	return { deviceId: result.deviceId, credential: result.credential };
}

async function until<T>(probe: () => T | undefined | false | null, what: string, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = probe();
		if (value) return value as T;
		await Bun.sleep(10);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

test("the authenticator the CLI builds spends a bootstrap minted into the store after the daemon was built", () => {
	const env = configuredEnv();
	// The order a real machine does this in: the daemon exists, the store does not.
	const devices = authenticatorFrom(env);
	expect(existsSync(devicesPath)).toBe(false);

	const bootstrap = elsewhere().mintBootstrap().token;
	const issued = devices.pair({ bootstrapToken: bootstrap, device: { name: "oskar's phone", platform: "ios" } });

	if (!issued.ok) throw new Error(`pairing was refused: ${issued.reason ?? "no reason given"}`);
	expect(issued.deviceId).toMatch(/^dev_/);
	expect(issued.credential).not.toBe(bootstrap);
	expect(Date.parse(issued.issuedAt)).not.toBeNaN();
	expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.parse(issued.issuedAt));

	// One file, and it is the one `geist devices` resolves from the same env —
	// by construction, through `resolveDeviceRegistryPath`, not by coincidence.
	expect(resolveDeviceRegistryPath(env)).toBe(devicesPath);
	const stored = readFileSync(devicesPath, "utf-8");
	expect(stored).toContain(issued.deviceId);
	// Nothing the daemon persists can pair or authenticate anybody.
	expect(stored).not.toContain(issued.credential);
	expect(stored).not.toContain(bootstrap);
});

test("a replayed bootstrap token is refused by the authenticator the CLI builds", () => {
	const devices = authenticatorFrom(configuredEnv());
	const bootstrap = elsewhere().mintBootstrap().token;

	const first = devices.pair({ bootstrapToken: bootstrap, device: { name: "first", platform: "ios" } });
	if (!first.ok) throw new Error(`the first exchange was refused: ${first.reason ?? "no reason given"}`);

	const replay = devices.pair({ bootstrapToken: bootstrap, device: { name: "replay", platform: "ios" } });
	expect(replay.ok).toBe(false);

	// R33-REACH.7: the refusal does not disturb the device the first exchange
	// minted — it authenticates immediately afterwards.
	const still = devices.authenticate({ deviceId: first.deviceId, credential: first.credential });
	expect(still.ok).toBe(true);
});

test("authenticate rotates, and the retired predecessor is refused and reported as credential_reuse on the daemon's log", () => {
	const devices = authenticatorFrom(configuredEnv());
	const first = pair(devices, "rotating-phone");

	const second = devices.authenticate({ deviceId: first.deviceId, credential: first.credential });
	if (!second.ok) throw new Error(`the reconnect was refused: ${second.reason ?? "no reason given"}`);
	expect(second.deviceId).toBe(first.deviceId);
	expect(second.credential).not.toBe(first.credential);

	const before = records.length;
	const thief = devices.authenticate({ deviceId: first.deviceId, credential: first.credential });
	expect(thief.ok).toBe(false);

	// GSEC-04's theft signal has to reach an operator, which for this daemon
	// means its structured stderr.
	const since = records.slice(before);
	const reuse = since.filter((record) => JSON.stringify(record).includes("credential_reuse"));
	expect(reuse).toHaveLength(1);
	const line = JSON.stringify(reuse[0]);
	expect(line).toContain(first.deviceId);
	// …naming the device and carrying no credential material, in either direction.
	expect(line).not.toContain(first.credential);
	expect(line).not.toContain(second.credential);
});

test("a device revoked by another handle on the same file is refused, and the revocation is pushed", async () => {
	const devices = authenticatorFrom(configuredEnv());
	const device = pair(devices, "stolen-phone");
	expect(devices.isRevoked?.(device.deviceId)).toBe(false);

	// The push half of R33-REACH.6: a connection that sends nothing has to be
	// told, so the store the CLI built must be observable.
	if (devices.subscribe === undefined) throw new Error("the CLI's device store cannot be observed");
	let changes = 0;
	const unsubscribe = devices.subscribe(() => {
		changes += 1;
	});

	try {
		expect(elsewhere().revoke(device.deviceId)).toEqual({ ok: true, deviceId: device.deviceId });

		// Generous, and deliberately not a measurement: R33-REACH.6's 1s budget is
		// proved against a live wire in `device-revocation-live.e2e.test.ts`. What
		// is asserted here is only that the CLI wired the observation up at all —
		// a store the daemon never watches pushes nothing, ever, however fast the
		// filesystem is.
		await until(() => changes > 0, "the CLI's device store to observe the out-of-process revocation", 10_000);
		expect(devices.isRevoked?.(device.deviceId)).toBe(true);
		// A revoked device holding a perfectly valid credential is still refused.
		expect(devices.authenticate({ deviceId: device.deviceId, credential: device.credential }).ok).toBe(false);
	} finally {
		unsubscribe();
	}
}, 20_000);

test("the default store location is the one the CLI uses when no path is configured", () => {
	// `geist pair` on a machine with no `GEIST_DEVICES_PATH` writes here, and the
	// daemon must read the same file rather than a second one under some other name.
	mkdirSync(join(home, ".geist"), { recursive: true, mode: 0o700 });
	const bootstrap = new DeviceRegistry({ path: devicesPath }).mintBootstrap().token;

	const env: NodeJS.ProcessEnv = { HOME: home };
	expect(resolveDeviceRegistryPath(env)).toBe(devicesPath);

	const devices = authenticatorFrom(env);
	const issued = devices.pair({ bootstrapToken: bootstrap, device: { name: "default-path", platform: "android" } });
	if (!issued.ok) throw new Error(`pairing was refused: ${issued.reason ?? "no reason given"}`);
	expect(readFileSync(devicesPath, "utf-8")).toContain(issued.deviceId);
});

test("an unreadable store refuses every exchange rather than throwing out of the frame handler", () => {
	// `DeviceRegistry` throws on a store it cannot parse, on purpose: "empty"
	// would silently discard the revocation list. But the caller here is a
	// WebSocket message callback, and an exception thrown through it refuses
	// nobody, answers nobody and is logged by nothing. So the composition root
	// turns it into this port's own vocabulary — a refusal — and says loudly
	// where the unreadable file is.
	mkdirSync(join(home, ".geist"), { recursive: true, mode: 0o700 });
	writeFileSync(devicesPath, "{not json", { mode: 0o600 });
	const devices = authenticatorFrom(configuredEnv());

	expect(devices.pair({ bootstrapToken: "anything", device: { name: "nobody", platform: "ios" } }).ok).toBe(false);
	expect(devices.authenticate({ deviceId: "dev_absent", credential: "nothing" }).ok).toBe(false);

	const errors = records.filter((record) => record.level === "error");
	expect(errors.length).toBeGreaterThan(0);
	expect(JSON.stringify(errors)).toContain(devicesPath);
});

test("a daemon whose store file does not exist yet still builds its options and refuses cleanly", () => {
	const env = configuredEnv();
	const options = optionsFor(env);

	// Backward compatibility: a missing store is not fatal — the daemon is built,
	// keeps the operator token it was started with, and touches no file until
	// something actually pairs.
	expect(options.authToken).toBe(TOKEN);
	expect(existsSync(devicesPath)).toBe(false);

	const devices = options.devices;
	if (devices === undefined) throw new Error("the CLI built its gateway options with no devices port");
	expect(devices.pair({ bootstrapToken: "not-a-token", device: { name: "nobody", platform: "ios" } }).ok).toBe(false);
	expect(devices.authenticate({ deviceId: "dev_absent", credential: "nothing" }).ok).toBe(false);
	// Fail closed: an id this store never heard of is not an allowed one.
	expect(devices.isRevoked?.("dev_absent")).toBe(true);
	expect(existsSync(devicesPath)).toBe(false);
});

test("an unconfigured daemon with no store keeps the operator-token posture and says so", () => {
	// The branch that decides the SHIPPED default on a fresh machine: no
	// GEIST_DEVICES_PATH, no store file. Every other clause in this file
	// configures a store, so without this one the posture the product actually
	// ships with is the only branch nothing exercises.
	const options = optionsFor({ HOME: home });

	// No devices port at all — `attachAuthentication` therefore takes outcome 2
	// for a request bearing the operator token, which is the pre-Phase-33
	// behaviour `fleet-attach.e2e.test.ts` still proves end to end.
	expect(options.devices).toBeUndefined();
	expect(options.authToken).toBe(TOKEN);
	expect(existsSync(devicesPath)).toBe(false);

	// And it is not silent about it: an operator who has not paired must be able
	// to tell from the log why a QR they scanned was refused.
	const warned = records.filter((record) => record.level === "warn");
	expect(warned.length).toBeGreaterThan(0);
	expect(JSON.stringify(warned)).toMatch(/pair|device/i);
});
