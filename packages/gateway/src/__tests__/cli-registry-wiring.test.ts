/**
 * R36-SPAWN.1, R36-SPAWN.3 — the daemon's composition root fills `GatewayConfig.userRegistry`.
 *
 * That is what lets `/attach` offer `session_spawn`. What is asserted is the object
 * {@link gatewayOptions} constructs, the single thing `main()` hands `startGateway`,
 * and never a registry built beside it.
 *
 * The path rules are the ones that decide which file names the programs this
 * daemon will run: absolute only, defaulted under the user's HOME, and never
 * resolved against the directory the daemon happened to be started in.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistryWiring, gatewayOptions, parseArgs } from "../cli";
import type { GatewaySettings } from "../config/config";
import { Logger } from "../gateway/logger";
import { EventBus } from "../session/event-bus";
import type { UserRegistry } from "../session/harness-resolver";
import { SessionManager } from "../session/session-manager";

const TOKEN = "cli-registry-wiring-operator-token";

const SETTINGS: GatewaySettings = {
	port: 0,
	host: "127.0.0.1",
	tokens: {},
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

const NOTICE = /no spawn registry/;

let home: string;
let cwdBefore: string;
let records: Record<string, unknown>[];
let log: Logger;

beforeEach(() => {
	home = realpathSync(mkdtempSync("/tmp/crw-home-"));
	cwdBefore = process.cwd();
	records = [];
	log = new Logger({
		write: (line: string) => {
			records.push(JSON.parse(line) as Record<string, unknown>);
		},
	});
});

afterEach(() => {
	process.chdir(cwdBefore);
	rmSync(home, { recursive: true, force: true });
});

/** The registry the CLI hands `startGateway` for these arguments, built exactly as `main()` builds it. */
function registryFor(argv: string[], env: NodeJS.ProcessEnv = { HOME: home }): UserRegistry {
	const parsed = parseArgs(["--auth", TOKEN, ...argv], SETTINGS, { warn: () => {} });
	const { userRegistry } = gatewayOptions(parsed, new SessionManager(new EventBus()), { env, log });
	if (userRegistry === undefined) throw new Error("gatewayOptions filled no registry");
	return userRegistry;
}

/** A 0600 file in a 0700 directory: what the loader would accept. */
function registryFileAt(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = join(dir, "config.yaml");
	writeFileSync(path, "{}", { mode: 0o600 });
	return path;
}

function notices(): Record<string, unknown>[] {
	return records.filter((record) => NOTICE.test(String(record.message)));
}

test("an absolute --registry is the path the daemon's registry reads", () => {
	const path = join(home, "elsewhere", "registry.yaml");

	expect(parseArgs(["--auth", TOKEN, "--registry", path], SETTINGS, { warn: () => {} }).registryPath).toBe(path);
	expect(registryFor(["--registry", path]).path).toBe(path);
});

test("with no flag the path is under the injected HOME, and a geist.yaml in cwd is never consulted", () => {
	const decoyDir = join(home, "launched-from");
	mkdirSync(decoyDir, { recursive: true });
	writeFileSync(join(decoyDir, "geist.yaml"), "{}", { mode: 0o600 });
	process.chdir(decoyDir);

	const registry = registryFor([]);

	expect(registry.path).toBe(join(home, ".geist", "config.yaml"));
	expect(registry.path).not.toBe(join(decoyDir, "geist.yaml"));
	// The decoy is a real file the loader could read; nothing at the default path means nothing is offered.
	expect(registry.present()).toBe(false);
});

test("a relative --registry is refused at parse time, naming the flag and the rule", () => {
	for (const relative of ["geist.yaml", "./geist.yaml", "../up/geist.yaml", "~/geist.yaml", ""]) {
		expect(() => parseArgs(["--auth", TOKEN, "--registry", relative], SETTINGS)).toThrow(
			`--registry must be an absolute path, got: ${relative}`,
		);
	}
});

test("--registry given a flag or nothing is refused rather than swallowing it", () => {
	expect(() => parseArgs(["--registry", "--auth", TOKEN], SETTINGS)).toThrow(
		"--registry requires an absolute path, but got the flag '--auth'",
	);
	expect(() => parseArgs(["--auth", TOKEN, "--registry"], SETTINGS)).toThrow("--registry requires an absolute path");
});

test("nothing at the registry path logs one notice naming the path and how to create the file", () => {
	const path = join(home, "absent", "config.yaml");

	const registry = registryFor(["--registry", path]);
	// Asking again, as every connection does, must not repeat the notice.
	registry.present();
	registry.present();

	const [notice, ...rest] = notices();
	expect(rest).toHaveLength(0);
	expect(notice?.level).toBe("warn");
	expect(notice?.path).toBe(path);
	expect(String(notice?.hint)).toContain("mode 0600");
	expect(String(notice?.hint)).toContain("mode 0700");
	// The daemon adopts the file on the next connection, so the notice promises no restart.
	expect(JSON.stringify(notice)).not.toMatch(/restart/i);
});

test("the default path with nothing there logs the same single notice", () => {
	registryFor([]);

	const [notice, ...rest] = notices();
	expect(rest).toHaveLength(0);
	expect(notice?.path).toBe(join(home, ".geist", "config.yaml"));
});

test("a file at the registry path logs no notice, whether it was named or defaulted", () => {
	const named = registryFileAt(join(home, "named"));
	expect(registryFor(["--registry", named]).present()).toBe(true);

	registryFileAt(join(home, ".geist"));
	expect(registryFor([]).present()).toBe(true);

	expect(notices()).toHaveLength(0);
});

test("a file the loader will refuse is still present, so the notice does not claim nothing is there", () => {
	const path = registryFileAt(join(home, "loose"));
	chmodSync(path, 0o644);

	expect(registryFor(["--registry", path]).present()).toBe(true);
	expect(notices()).toHaveLength(0);
});

for (const [label, badHome] of [
	["empty", ""],
	["relative", "relative/home"],
] as const) {
	test(`a ${label} HOME offers no registry and warns once, instead of failing the daemon's start`, () => {
		const parsed = parseArgs(["--auth", TOKEN], SETTINGS, { warn: () => {} });

		const options = gatewayOptions(parsed, new SessionManager(new EventBus()), { env: { HOME: badHome }, log });

		expect(options.userRegistry).toBeUndefined();
		expect(options.authToken).toBe(TOKEN);
		expect(options.devices).toBeFunction();
		const [notice, ...rest] = notices();
		expect(rest).toHaveLength(0);
		expect(notice?.level).toBe("warn");
		expect(notice?.message).toBe(
			"no spawn registry: HOME is empty or not an absolute path, so the default registry path cannot be resolved; pass --registry <absolute path> to offer session_spawn",
		);
	});
}

test("an explicit --registry is still honoured when HOME is unusable", () => {
	const path = registryFileAt(join(home, "named"));

	expect(registryFor(["--registry", path], { HOME: "" }).path).toBe(path);
	expect(notices()).toHaveLength(0);
});

test("an invalid explicit path stays a hard error rather than being absorbed into the HOME warning", () => {
	expect(() => createRegistryWiring({ explicit: "geist.yaml", env: { HOME: home }, log })).toThrow(
		"an explicit registry path must be absolute",
	);
	expect(() => createRegistryWiring({ explicit: "geist.yaml", env: { HOME: "" }, log })).toThrow(
		"an explicit registry path must be absolute",
	);
	expect(notices()).toHaveLength(0);
});
