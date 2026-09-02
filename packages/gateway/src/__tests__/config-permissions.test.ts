import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureConfigPrivate, loadConfig, loadConfigSync } from "../config/config";

const POSIX = process.platform !== "win32";

const temps: string[] = [];
afterAll(() => {
	for (const dir of temps) {
		// One case leaves a 0500 directory behind on purpose; make it removable.
		for (const path of [dir, join(dir, ".draht"), join(dir, "shared-config")]) {
			try {
				chmodSync(path, 0o700);
			} catch {
				/* not every temp home has every subdirectory */
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A config file as the *previous* version of the gateway left it: written with
 * the process umask, so world-readable, in a world-readable directory.
 */
function legacyInstall(dirName = ".draht"): string {
	const home = mkdtempSync(join(tmpdir(), "draht-gateway-perm-"));
	temps.push(home);
	const dir = join(home, dirName);
	mkdirSync(dir, { recursive: true });
	const configPath = join(dir, "gateway.config.json");
	writeFileSync(configPath, JSON.stringify({ port: 7878, tokens: { default: "root-equivalent-token" } }));
	chmodSync(configPath, 0o644);
	chmodSync(dir, 0o755);
	return configPath;
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe.skipIf(!POSIX)("upgraded installs get their token file mode repaired", () => {
	test("loadConfigSync narrows a 0644 config inside a 0755 dir", () => {
		const configPath = legacyInstall();
		expect(mode(configPath)).toBe(0o644);

		const settings = loadConfigSync(configPath);

		expect(mode(configPath)).toBe(0o600);
		expect(mode(dirname(configPath))).toBe(0o700);
		// The repair must not disturb what was loaded.
		expect(settings.tokens.default).toBe("root-equivalent-token");
	});

	test("loadConfig (async) repairs the same way", async () => {
		const configPath = legacyInstall();

		const settings = await loadConfig(configPath);

		expect(mode(configPath)).toBe(0o600);
		expect(mode(dirname(configPath))).toBe(0o700);
		expect(settings.tokens.default).toBe("root-equivalent-token");
	});

	test("warns, naming the file and what was done", () => {
		const configPath = legacyInstall();
		const warnings: string[] = [];

		ensureConfigPrivate(configPath, (m) => warnings.push(m));

		expect(warnings.join("\n")).toContain(configPath);
		expect(warnings.join("\n")).toMatch(/0600|permission/i);
	});

	test("leaves an already-private install alone and says nothing", () => {
		const configPath = legacyInstall();
		chmodSync(configPath, 0o600);
		chmodSync(dirname(configPath), 0o700);
		const warnings: string[] = [];

		ensureConfigPrivate(configPath, (m) => warnings.push(m));

		expect(warnings).toEqual([]);
		expect(mode(configPath)).toBe(0o600);
		expect(mode(dirname(configPath))).toBe(0o700);
	});

	test("never widens a mode that is already narrower than 0600", () => {
		const configPath = legacyInstall();
		chmodSync(configPath, 0o400);
		chmodSync(dirname(configPath), 0o500);

		ensureConfigPrivate(configPath, () => {});

		expect(mode(configPath)).toBe(0o400);
		expect(mode(dirname(configPath))).toBe(0o500);
	});

	test("repairs the file but never chmods a directory it does not own", () => {
		const configPath = legacyInstall("shared-config");

		ensureConfigPrivate(configPath, () => {});

		expect(mode(configPath)).toBe(0o600);
		// `~/.draht` is ours to tighten; an arbitrary directory the operator
		// pointed us at (`/etc`, a shared config dir) is not.
		expect(mode(dirname(configPath))).toBe(0o755);
	});

	test("does not follow a symlinked config path", () => {
		const configPath = legacyInstall();
		const linkHome = mkdtempSync(join(tmpdir(), "draht-gateway-perm-link-"));
		temps.push(linkHome);
		mkdirSync(join(linkHome, ".draht"));
		const link = join(linkHome, ".draht", "gateway.config.json");
		symlinkSync(configPath, link);

		expect(() => ensureConfigPrivate(link, () => {})).not.toThrow();
		expect(mode(configPath)).toBe(0o644);
	});

	test("a missing config is not an error", () => {
		const home = mkdtempSync(join(tmpdir(), "draht-gateway-perm-none-"));
		temps.push(home);

		expect(() => ensureConfigPrivate(join(home, ".draht", "gateway.config.json"), () => {})).not.toThrow();
		expect(() => loadConfigSync(join(home, ".draht", "gateway.config.json"))).not.toThrow();
	});
});

describe("mode repair is skipped where mode bits are not meaningful", () => {
	test("ensureConfigPrivate is a no-op that never throws on non-POSIX", () => {
		// The guard is `process.platform === "win32"`; on POSIX this test only
		// documents that the entry point tolerates junk input without crashing.
		expect(() => ensureConfigPrivate("", () => {})).not.toThrow();
	});
});
