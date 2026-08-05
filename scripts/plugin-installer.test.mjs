import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
		marketplaceUpdate: "plugin marketplace update draht",
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
	const config = { ...IMPLEMENTATIONS[implementation] };
	const root = mkdtempSync(join(tmpdir(), `${implementation}-plugin-atomic-`));
	const source = join(root, "source");
	const fakeBin = join(root, "bin");
	const home = join(root, "home");
	const marketplace = join(root, "marketplace");
	const log = join(root, "commands.log");
	const failState = join(root, "fail-state");
	const pluginState = join(root, "plugin-state");
	writeFileSync(pluginState, pluginInstalled ? "1" : "0");
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
  if [ "$(cat "$DRAHT_TEST_PLUGIN_STATE")" = 1 ]; then
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
if [ "\${DRAHT_TEST_NO_MUTATE:-0}" != 1 ]; then
  if [ "$command" = "$DRAHT_TEST_REMOVE_COMMAND" ]; then printf '0' > "$DRAHT_TEST_PLUGIN_STATE"; fi
  if [ "$command" = "$DRAHT_TEST_INSTALL_COMMAND" ]; then printf '1' > "$DRAHT_TEST_PLUGIN_STATE"; fi
fi
exit 0
`);
	chmodSync(join(fakeBin, config.binary), 0o755);
	if (marketplaceExists) writeOldMarketplace(marketplace, config);
	config.validate = config.binary === "claude" ? `plugin validate ${join(marketplace, "plugins", "draht")}` : undefined;
	config.marketplaceAdd = `plugin marketplace add ${marketplace}`;
	config.marketplaceRemove = "plugin marketplace remove draht";
	return { config, root, source, fakeBin, home, marketplace, log, failState, pluginState, pluginInstalled };
}

function writeOldMarketplace(marketplace, config) {
	mkdirSync(join(marketplace, "plugins", "draht"), { recursive: true });
	writeFileSync(join(marketplace, "plugins", "draht", "version-marker.txt"), "old");
	mkdirSync(join(marketplace, config.manifestDir), { recursive: true });
	writeFileSync(join(marketplace, config.manifestDir, "marketplace.json"), "old marketplace manifest\n");
	writeFileSync(join(marketplace, "unrelated.txt"), "keep me");
}

function run(f, extraEnv = {}, command = "update") {
	return spawnSync(process.execPath, [join(f.source, "cli.mjs"), command, "--path", f.marketplace], {
		encoding: "utf8",
		env: runEnvironment(f, extraEnv),
	});
}

function runEnvironment(f, extraEnv = {}) {
	return {
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
		DRAHT_TEST_PLUGIN_STATE: f.pluginState,
		DRAHT_TEST_INSTALL_COMMAND: f.config.install,
		DRAHT_TEST_REMOVE_COMMAND: f.config.remove,
		DRAHT_TEST_MARKETPLACE: f.marketplace,
		...extraEnv,
	};
}

function runAsync(f, extraEnv = {}) {
	return new Promise((resolveResult) => {
		const child = spawn(process.execPath, [join(f.source, "cli.mjs"), "update", "--path", f.marketplace], {
			env: runEnvironment(f, extraEnv),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (status) => resolveResult({ status, stdout, stderr }));
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

for (const implementation of Object.keys(IMPLEMENTATIONS)) {
	test(`${implementation} required CLI failures abort and restore the marketplace`, async (t) => {
		const probe = fixture(implementation, { pluginInstalled: true });
		const required = implementation === "draht-claude"
			? ["remove", "install", "validate", "marketplaceUpdate", "enable", "disable"]
			: ["marketplaceAdd", "remove", "install"];
		for (const commandKey of required) {
			await t.test(commandKey, () => {
				const f = fixture(implementation, { pluginInstalled: true });
				const failedCommand = f.config[commandKey];
				const installedList = commandKey === "disable"
					? '[{"id":"draht@draht","enabled":false}]'
					: f.config.installedList;
				const result = run(f, { DRAHT_TEST_FAIL_COMMAND: failedCommand, DRAHT_TEST_INSTALLED_LIST: installedList });
				assert.notEqual(result.status, 0, `reported success when ${failedCommand} failed`);
				assert.doesNotMatch(result.stdout, /(?:✓ installed|^installed draht@draht)/m);
				assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
				assert.deepEqual(transactionSiblings(f.marketplace), []);
			});
		}
		rmSync(probe.root, { recursive: true, force: true });
	});
}

test("draht-claude marketplace add failure aborts a fresh install without registration", () => {
	const f = fixture("draht-claude", { marketplaceExists: false, pluginInstalled: false });
	const result = run(f, { DRAHT_TEST_FAIL_COMMAND: f.config.marketplaceAdd }, "install");
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(f.marketplace), false);
	assert.doesNotMatch(result.stdout, /✓ installed/);
});

for (const implementation of Object.keys(IMPLEMENTATIONS)) {
	test(`${implementation} removal failure is not hidden by a no-op install and refreshes restored registration`, () => {
		const f = fixture(implementation, { pluginInstalled: true });
		const result = run(f, { DRAHT_TEST_FAIL_COMMAND: f.config.remove });
		assert.notEqual(result.status, 0);
		const log = commands(f);
		const removeAt = log.indexOf(f.config.remove);
		const registration = implementation === "draht-claude" ? f.config.marketplaceUpdate : f.config.marketplaceAdd;
		const restoredRegistrationAt = log.lastIndexOf(registration);
		const rollbackInstallAt = log.indexOf(f.config.install);
		assert.ok(removeAt >= 0 && restoredRegistrationAt > removeAt && rollbackInstallAt > restoredRegistrationAt, log.join("\n"));
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
	});
}

test("draht-claude successful update preserves a previously disabled plugin", () => {
	const f = fixture("draht-claude", { pluginInstalled: true });
	const result = run(f, { DRAHT_TEST_INSTALLED_LIST: '[{"id":"draht@draht","enabled":false}]' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(commands(f).includes(f.config.enable), false);
	assert.equal(commands(f).includes(f.config.disable), true);
});

for (const implementation of Object.keys(IMPLEMENTATIONS)) {
	test(`${implementation} rolls back when post-install state does not exactly match`, () => {
		const f = fixture(implementation, { pluginInstalled: false });
		const result = run(f, { DRAHT_TEST_NO_MUTATE: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /verification|state/i);
		assert.equal(readFileSync(join(f.marketplace, "plugins", "draht", "version-marker.txt"), "utf8"), "old");
		assert.doesNotMatch(result.stdout, /(?:✓ installed|^installed draht@draht)/m);
	});
}

test("draht-codex fresh-install rollback removes the newly added marketplace registration", () => {
	const f = fixture("draht-codex", { marketplaceExists: false, pluginInstalled: false });
	const result = run(f, { DRAHT_TEST_FAIL_COMMAND: f.config.install }, "install");
	assert.notEqual(result.status, 0);
	assert.equal(commands(f).includes(f.config.marketplaceRemove), true);
	assert.equal(existsSync(f.marketplace), false);
});

for (const implementation of Object.keys(IMPLEMENTATIONS)) {
	test(`${implementation} stale-lock contenders cannot delete a newly acquired owner`, async () => {
		const f = fixture(implementation);
		const lockPath = `${f.marketplace}.draht-update-lock`;
		writeFileSync(lockPath, JSON.stringify({
			owner: "draht-plugin-installer",
			pid: process.pid,
			identity: "stale-race-owner",
			createdAt: Date.now(),
			token: "stale-race",
		}));
		const preload = join(f.root, "lock-interleave.cjs");
		writeFileSync(preload, `
+const fs = require("node:fs");
+const originalRead = fs.readFileSync;
+const originalUnlink = fs.unlinkSync;
+const lock = process.env.DRAHT_TEST_LOCK_PATH;
+const ready = process.env.DRAHT_TEST_READY;
+fs.readFileSync = function(path, ...args) {
+  const value = originalRead.call(this, path, ...args);
+  if (path === lock && String(value).includes('"token":"stale-race"')) {
+    try { fs.writeFileSync(ready + "." + process.env.DRAHT_TEST_ROLE, "ready", { flag: "wx" }); } catch {}
+    const until = Date.now() + 5000;
+    while (Date.now() < until && (!fs.existsSync(ready + ".A") || !fs.existsSync(ready + ".B"))) {}
+  }
+  return value;
+};
+fs.unlinkSync = function(path, ...args) {
+  if (path === lock && process.env.DRAHT_TEST_ROLE === "B") {
+    const until = Date.now() + 5000;
+    while (Date.now() < until) {
+      try {
+        if (!String(originalRead.call(fs, lock, "utf8")).includes('"token":"stale-race"')) break;
+      } catch {}
+    }
+  }
+  return originalUnlink.call(this, path, ...args);
+};
+` .replace(/^\+/gm, ""));
		const shared = {
			NODE_OPTIONS: `--require=${preload}`,
			DRAHT_TEST_LOCK_PATH: lockPath,
			DRAHT_TEST_READY: join(f.root, "ready"),
		};
		const [a, b] = await Promise.all([
			runAsync(f, { ...shared, DRAHT_TEST_ROLE: "A" }),
			runAsync(f, { ...shared, DRAHT_TEST_ROLE: "B" }),
		]);
		const results = [a, b];
		assert.equal(results.filter((result) => result.status === 0).length, 1, JSON.stringify(results));
		const loser = results.find((result) => result.status !== 0);
		assert.match(loser.stderr, /already in progress/i);
		assert.doesNotMatch(loser.stderr, /ownership changed/i);
		assert.equal(existsSync(lockPath), false);
	});
}
