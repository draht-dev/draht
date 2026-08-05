import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPLEMENTATIONS = {
	"draht-claude": {
		binary: "claude",
		manifestDir: ".claude-plugin",
		list: "plugin list --json",
		installedList: '[{"id":"draht@draht","enabled":true}]',
		absentList: '[{"id":"not-draht@draht-extra","enabled":true}]',
		remove: "plugin uninstall draht@draht",
		install: "plugin install draht@draht --scope user",
		enable: "plugin enable draht@draht",
		disable: "plugin disable draht@draht",
	},
	"draht-codex": {
		binary: "codex",
		manifestDir: ".codex-plugin",
		list: "plugin list --json",
		installedList: '{"installed":[{"id":"draht@draht"}],"available":[]}',
		absentList: '{"installed":[{"id":"not-draht@draht-extra"}],"available":[]}',
		remove: "plugin remove draht@draht",
		install: "plugin add draht@draht",
	},
};

function fixture(implementation, { brokenSource = false, marketplaceExists = true, pluginInstalled = false } = {}) {
	const config = IMPLEMENTATIONS[implementation];
	const root = mkdtempSync(join(tmpdir(), `${implementation}-plugin-atomic-`));
	const source = join(root, "source");
	const fakeBin = join(root, "bin");
	const home = join(root, "home");
	const marketplace = join(root, "marketplace");
	const log = join(root, "commands.log");
	const failState = join(root, "fail-state");
	cpSync(join(ROOT, "packages", implementation), source, { recursive: true });
	writeFileSync(join(source, "version-marker.txt"), "new");
	if (brokenSource) symlinkSync("missing-copy-source", join(source, "agents", "zz-broken-copy"));
	mkdirSync(fakeBin, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(fakeBin, config.binary), `#!/bin/sh
set -eu
command="$*"
printf '%s\\n' "$command" >> "$DRAHT_TEST_COMMAND_LOG"
if [ "$command" = "$DRAHT_TEST_LIST_COMMAND" ]; then
  if [ "$DRAHT_TEST_PLUGIN_INSTALLED" = 1 ]; then
    printf '%s\\n' "$DRAHT_TEST_INSTALLED_LIST"
  else
    printf '%s\\n' "$DRAHT_TEST_ABSENT_LIST"
  fi
  exit 0
fi
if [ "$command" = "$DRAHT_TEST_REMOVE_COMMAND" ]; then
  if [ -f "$DRAHT_TEST_MARKETPLACE/plugins/draht/version-marker.txt" ]; then
    marker=$(cat "$DRAHT_TEST_MARKETPLACE/plugins/draht/version-marker.txt")
  else
    marker=missing
  fi
  printf 'remove-saw:%s\\n' "$marker" >> "$DRAHT_TEST_COMMAND_LOG"
fi
if [ -n "\${DRAHT_TEST_FAIL_COMMAND:-}" ] && [ "$command" = "$DRAHT_TEST_FAIL_COMMAND" ]; then
  if [ ! -f "$DRAHT_TEST_FAIL_STATE" ]; then
    : > "$DRAHT_TEST_FAIL_STATE"
    exit 42
  fi
fi
exit 0
`);
	chmodSync(join(fakeBin, config.binary), 0o755);
	if (marketplaceExists) writeOldMarketplace(marketplace, config);
	return { config, root, source, fakeBin, home, marketplace, log, failState, pluginInstalled };
}

function writeOldMarketplace(marketplace, config) {
	mkdirSync(join(marketplace, "plugins", "draht"), { recursive: true });
	writeFileSync(join(marketplace, "plugins", "draht", "version-marker.txt"), "old");
	mkdirSync(join(marketplace, config.manifestDir), { recursive: true });
	writeFileSync(join(marketplace, config.manifestDir, "marketplace.json"), "old marketplace manifest\n");
	writeFileSync(join(marketplace, "unrelated.txt"), "keep me");
}

function run(f, extraEnv = {}) {
	return spawnSync(process.execPath, [join(f.source, "cli.mjs"), "update", "--path", f.marketplace], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: f.home,
			USERPROFILE: f.home,
			PATH: `${f.fakeBin}:${process.env.PATH}`,
			DRAHT_TEST_COMMAND_LOG: f.log,
			DRAHT_TEST_FAIL_STATE: f.failState,
			DRAHT_TEST_FAIL_COMMAND: "",
			DRAHT_TEST_LIST_COMMAND: f.config.list,
			DRAHT_TEST_INSTALLED_LIST: f.config.installedList,
			DRAHT_TEST_ABSENT_LIST: f.config.absentList,
			DRAHT_TEST_PLUGIN_INSTALLED: f.pluginInstalled ? "1" : "0",
			DRAHT_TEST_REMOVE_COMMAND: f.config.remove,
			DRAHT_TEST_MARKETPLACE: f.marketplace,
			...extraEnv,
		},
	});
}

function commands(f) {
	return existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split("\n") : [];
}

function transactionSiblings(marketplace) {
	const prefix = `${basename(marketplace)}.`;
	return readdirSync(dirname(marketplace)).filter((entry) => {
		for (const kind of ["tmp", "backup"]) {
			const transactionPrefix = `${prefix}${kind}-`;
			if (entry.startsWith(transactionPrefix) && /^\d+-[0-9a-f]{16}$/.test(entry.slice(transactionPrefix.length))) return true;
		}
		return false;
	});
}

function processIdentity(pid) {
	if (process.platform === "linux") {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
	}
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
}

for (const implementation of Object.keys(IMPLEMENTATIONS)) {
	test(`${implementation} refuses a concurrent update without touching its marketplace transaction`, () => {
		const f = fixture(implementation);
		const lockPath = `${f.marketplace}.draht-update-lock`;
		writeFileSync(lockPath, JSON.stringify({
			owner: "draht-plugin-installer",
			pid: process.pid,
			identity: processIdentity(process.pid),
			createdAt: Date.now(),
			token: "active-test",
		}));
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /update is already in progress/i);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
		assert.deepEqual(commands(f), []);
		assert.equal(existsSync(lockPath), true);
	});

	test(`${implementation} refuses a symlink marketplace without touching its target`, () => {
		const f = fixture(implementation);
		const target = join(f.root, "marketplace-target");
		rmSync(f.marketplace, { recursive: true });
		writeOldMarketplace(target, f.config);
		symlinkSync(target, f.marketplace, "dir");
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.equal(readFileSync(join(target, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
		assert.equal(readFileSync(join(target, "unrelated.txt"), "utf8"), "keep me");
		assert.deepEqual(commands(f), []);
		assert.deepEqual(transactionSiblings(f.marketplace), []);
	});

	test(`${implementation} copy failure leaves the old marketplace intact and occurs before unregister`, () => {
		const f = fixture(implementation, { brokenSource: true });
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
		assert.equal(readFileSync(join(f.marketplace, f.config.manifestDir, "marketplace.json"), "utf8"), "old marketplace manifest\n");
		assert.equal(commands(f).includes(f.config.remove), false);
		assert.deepEqual(transactionSiblings(f.marketplace), []);
	});

	test(`${implementation} failed replacement install restores content and reinstalls the old plugin`, () => {
		const f = fixture(implementation, { pluginInstalled: true });
		const result = run(f, { DRAHT_TEST_FAIL_COMMAND: f.config.install });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /replacement install failed/i);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
		assert.equal(readFileSync(join(f.marketplace, "unrelated.txt"), "utf8"), "keep me");
		const log = commands(f);
		const listAt = log.indexOf(f.config.list);
		const removeAt = log.indexOf(f.config.remove);
		const firstInstallAt = log.indexOf(f.config.install);
		const rollbackInstallAt = log.lastIndexOf(f.config.install);
		assert.ok(listAt >= 0 && removeAt > listAt && firstInstallAt > removeAt && rollbackInstallAt > firstInstallAt, log.join("\n"));
		assert.equal(log[removeAt + 1], "remove-saw:new");
		assert.deepEqual(transactionSiblings(f.marketplace), []);
	});

	test(`${implementation} initially absent plugin is not installed during rollback`, () => {
		const f = fixture(implementation);
		const result = run(f, { DRAHT_TEST_FAIL_COMMAND: f.config.install });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /replacement install failed/i);
		assert.equal(commands(f).filter((command) => command === f.config.install).length, 1);
		assert.equal(commands(f).includes(f.config.remove), false);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
	});

	test(`${implementation} reports both replacement and rollback registration failures`, () => {
		const f = fixture(implementation, { pluginInstalled: true });
		writeFileSync(join(f.fakeBin, f.config.binary), `#!/bin/sh
set -eu
command="$*"
printf '%s\\n' "$command" >> "$DRAHT_TEST_COMMAND_LOG"
if [ "$command" = "$DRAHT_TEST_LIST_COMMAND" ]; then printf '%s\\n' "$DRAHT_TEST_INSTALLED_LIST"; exit 0; fi
if [ "$command" = "$DRAHT_TEST_REMOVE_COMMAND" ]; then exit 0; fi
if [ "$command" = "$DRAHT_TEST_FAIL_COMMAND" ]; then exit 42; fi
exit 0
`);
		chmodSync(join(f.fakeBin, f.config.binary), 0o755);
		const result = run(f, { DRAHT_TEST_FAIL_COMMAND: f.config.install });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /replacement install failed/i);
		assert.match(result.stderr, /rollback failed.*previously working plugin/i);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
	});

	test(`${implementation} recovers stale transaction paths and cleans up after a successful update`, () => {
		const f = fixture(implementation);
		const suffix = "1234-aaaaaaaaaaaaaaaa";
		const staleTemp = `${f.marketplace}.tmp-${suffix}`;
		const staleBackup = `${f.marketplace}.backup-${suffix}`;
		const unrelatedTemp = `${f.marketplace}.tmp-notes`;
		const unrelatedBackup = `${f.marketplace}.backup-manual`;
		writeFileSync(join(f.marketplace, "unrelated.txt"), "discard interrupted replacement");
		mkdirSync(unrelatedTemp, { recursive: true });
		writeFileSync(join(unrelatedTemp, "keep"), "keep");
		mkdirSync(unrelatedBackup, { recursive: true });
		writeFileSync(join(unrelatedBackup, "keep"), "keep");
		mkdirSync(staleTemp, { recursive: true });
		writeFileSync(join(staleTemp, "partial"), "partial");
		writeOldMarketplace(staleBackup, f.config);
		const result = run(f);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "new");
		assert.equal(readFileSync(join(f.marketplace, "unrelated.txt"), "utf8"), "keep me");
		assert.equal(existsSync(staleTemp), false);
		assert.equal(existsSync(staleBackup), false);
		assert.equal(readFileSync(join(unrelatedTemp, "keep"), "utf8"), "keep");
		assert.equal(readFileSync(join(unrelatedBackup, "keep"), "utf8"), "keep");
		assert.deepEqual(transactionSiblings(f.marketplace), []);
	});

	test(`${implementation} restores an orphan backup before updating a missing live marketplace`, () => {
		const f = fixture(implementation, { marketplaceExists: false });
		const staleBackup = `${f.marketplace}.backup-1234-bbbbbbbbbbbbbbbb`;
		const staleLock = `${f.marketplace}.draht-update-lock`;
		writeOldMarketplace(staleBackup, f.config);
		writeFileSync(staleLock, JSON.stringify({
			owner: "draht-plugin-installer",
			pid: process.pid,
			identity: "reused-pid-owner",
			createdAt: Date.now(),
			token: "stale-test",
		}));
		const result = run(f);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "new");
		assert.equal(readFileSync(join(f.marketplace, "unrelated.txt"), "utf8"), "keep me");
		assert.equal(existsSync(staleBackup), false);
		assert.equal(existsSync(staleLock), false);
		assert.deepEqual(transactionSiblings(f.marketplace), []);
	});

	test(`${implementation} successful update switches content before unregister and removes transaction artifacts`, () => {
		const f = fixture(implementation, { pluginInstalled: true });
		const result = run(f);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "new");
		assert.equal(readFileSync(join(f.marketplace, "unrelated.txt"), "utf8"), "keep me");
		const log = commands(f);
		const listAt = log.indexOf(f.config.list);
		const removeAt = log.indexOf(f.config.remove);
		assert.ok(listAt >= 0 && removeAt > listAt && log.indexOf(f.config.install) > removeAt, log.join("\n"));
		assert.equal(log[removeAt + 1], "remove-saw:new");
		assert.deepEqual(transactionSiblings(f.marketplace), []);
	});
}

test("draht-claude failed replacement preserves a previously disabled plugin state", () => {
	const f = fixture("draht-claude", { pluginInstalled: true });
	const result = run(f, {
		DRAHT_TEST_FAIL_COMMAND: f.config.install,
		DRAHT_TEST_INSTALLED_LIST: '[{"id":"draht@draht","enabled":false}]',
	});
	assert.notEqual(result.status, 0);
	const log = commands(f);
	assert.equal(log.filter((command) => command === f.config.install).length, 2);
	assert.equal(log.includes(f.config.enable), false);
	assert.equal(log.includes(f.config.disable), true);
});
