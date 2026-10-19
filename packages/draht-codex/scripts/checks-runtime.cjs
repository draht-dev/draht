#!/usr/bin/env node
"use strict";

// Canonical runtime. scripts/sync-checks-runtime.mjs copies this into each plugin.
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const TOTAL_TIMEOUT_MS = 150000;
const MAX_OUTPUT = 4000;

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function findConfig(cwd) {
	let directory = path.resolve(cwd);
	while (true) {
		const file = path.join(directory, ".draht", "checks.json");
		if (fs.existsSync(file)) return { file, root: directory };
		const parent = path.dirname(directory);
		if (fs.existsSync(path.join(directory, ".git")) || parent === directory) return null;
		directory = parent;
	}
}

function relativePath(value, field) {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0") || /[*?\[\]{}]/.test(value)) {
		throw new Error(`${field} must be a relative file or directory path (no globs)`);
	}
	const normalized = path.normalize(value);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${field} must stay inside the project`);
	return normalized.split(path.sep).join("/").replace(/\/+$/, "");
}

function loadConfig(location) {
	const source = fs.readFileSync(location.file, "utf8");
	const raw = JSON.parse(source);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("checks.json must contain an object");
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be a boolean");
	if (raw.enabled === false) return { enabled: false, checks: [] };
	if (!Array.isArray(raw.checks) || raw.checks.length === 0) throw new Error("checks must be a nonempty array");
	const names = new Set();
	const checks = raw.checks.map((check) => {
		if (!check || typeof check !== "object" || typeof check.name !== "string" || !check.name.trim() || names.has(check.name)) {
			throw new Error("each check needs a unique nonempty name");
		}
		names.add(check.name);
		if (!Array.isArray(check.command) || check.command.length === 0 || check.command.some((part) => typeof part !== "string" || part.includes("\0")) || !check.command[0]) {
			throw new Error(`${check.name}: command must be an argv array`);
		}
		if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > TOTAL_TIMEOUT_MS)) {
			throw new Error(`${check.name}: timeoutMs must be between 1 and ${TOTAL_TIMEOUT_MS}`);
		}
		if (check.cache !== undefined && typeof check.cache !== "boolean") throw new Error(`${check.name}: cache must be a boolean`);
		if (check.inputs !== undefined && (!Array.isArray(check.inputs) || check.inputs.length === 0)) throw new Error(`${check.name}: inputs must be a nonempty array`);
		return {
			name: check.name,
			command: check.command,
			cwd: relativePath(check.cwd ?? ".", `${check.name}.cwd`),
			inputs: (check.inputs ?? ["."]).map((input) => relativePath(input, `${check.name}.inputs`)),
			timeoutMs: check.timeoutMs ?? 30000,
			cache: check.cache !== false,
		};
	});
	return { enabled: true, checks, sourceHash: digest(source) };
}

function repository(root) {
	// Outside Git, configured checks still run; there is no evidence cache.
	let directory = root;
	while (!fs.existsSync(path.join(directory, ".git"))) {
		const parent = path.dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
	const cachePath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", `draht/checks/${digest(root)}.json`]).trim();
	let revision = "unborn";
	try { revision = git(root, ["rev-parse", "--verify", "HEAD"]).trim(); } catch { /* initial repository */ }
	return { cachePath, revision };
}

function fingerprint(root, check, config, repo) {
	if (!repo || !check.cache) return null;
	const files = new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
	for (const input of check.inputs) {
		// Include explicit ignored files too (e.g. a generated schema).
		try { if (!fs.statSync(path.join(root, input)).isDirectory()) files.add(input); } catch { files.add(input); }
	}
	const hash = createHash("sha256").update(JSON.stringify({ version: VERSION, root, check, config, node: process.version, platform: process.platform, arch: process.arch }));
	hash.update(fs.readFileSync(path.join(root, ".draht", "checks.json")));
	for (const file of [...files].sort()) {
		if (!check.inputs.some((input) => input === "." || file === input || file.startsWith(`${input}/`))) continue;
		hash.update(`\0${file}\0`);
		try {
			const absolute = path.join(root, file);
			const stat = fs.lstatSync(absolute);
			// Submodules and symlinks can depend on content outside this snapshot.
			if (!stat.isFile()) return null;
			hash.update(`${stat.mode}\0`).update(fs.readFileSync(absolute));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			hash.update("missing");
		}
	}
	return hash.digest("hex");
}

function readCache(repo) {
	if (!repo) return {};
	try {
		const cached = JSON.parse(fs.readFileSync(repo.cachePath, "utf8"));
		return cached.version === VERSION && cached.checks && typeof cached.checks === "object" ? cached.checks : {};
	} catch { return {}; }
}

function writeCache(repo, checks) {
	if (!repo) return;
	fs.mkdirSync(path.dirname(repo.cachePath), { recursive: true });
	const temporary = `${repo.cachePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify({ version: VERSION, revision: repo.revision, checks }));
	fs.renameSync(temporary, repo.cachePath);
}

function runChecks({ cwd = process.cwd(), force = false } = {}) {
	const checks = [];
	let configured = false;
	try {
		const location = findConfig(cwd);
		if (!location) return { status: "skipped", configured, summary: "No .draht/checks.json configured", checks };
		configured = true;
		const config = loadConfig(location);
		if (!config.enabled) return { status: "skipped", configured, summary: "Project checks explicitly disabled", checks };
		const repo = repository(location.root);
		const cache = readCache(repo);
		const current = Object.create(null);
		const snapshots = new Map();
		const deadline = Date.now() + TOTAL_TIMEOUT_MS;
		for (const check of config.checks) {
			const before = fingerprint(location.root, check, config, repo);
			snapshots.set(check.name, before);
			if (!force && before && cache[check.name]?.fingerprint === before && cache[check.name]?.status === "passed") {
				checks.push({ name: check.name, status: "cached", fingerprint: before });
				current[check.name] = cache[check.name];
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				checks.push({ name: check.name, status: "failed", reason: "Total check time limit reached" });
				continue;
			}
			const started = Date.now();
			let result;
			try {
				result = spawnSync(check.command[0], check.command.slice(1), {
					cwd: path.resolve(location.root, check.cwd), encoding: "utf8", timeout: Math.min(check.timeoutMs, remaining),
					killSignal: "SIGKILL", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) { result = { error }; }
			const passed = !result.error && !result.signal && result.status === 0;
			const reason = passed ? undefined : String(result.error?.code || result.signal || (typeof result.status === "number" ? `exit ${result.status}` : "unknown exit"));
			const record = { name: check.name, status: passed ? "passed" : "failed", reason, durationMs: Date.now() - started,
				output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").slice(0, MAX_OUTPUT), fingerprint: before };
			checks.push(record);
			current[check.name] = { ...record, checkedAt: new Date().toISOString() };
		}
		// A formatter or concurrent edit invalidates earlier evidence from this run.
		const configChanged = digest(fs.readFileSync(location.file, "utf8")) !== config.sourceHash;
		for (const check of config.checks) {
			const record = checks.find((entry) => entry.name === check.name);
			const before = snapshots.get(check.name);
			if (record.status !== "failed" && (configChanged || (before && before !== fingerprint(location.root, check, config, repo)))) {
				record.status = "failed";
				record.reason = "Check inputs changed during verification; run again";
				delete current[check.name];
			}
		}
		writeCache(repo, current);
		const failed = checks.filter((check) => check.status === "failed");
		return { status: failed.length ? "failed" : "passed", configured, checks,
			summary: failed.length ? `Project checks failed: ${failed.map((check) => `${check.name} (${check.reason})`).join(", ")}` : `Project checks passed (${checks.filter((check) => check.status === "cached").length} reused, ${checks.filter((check) => check.status === "passed").length} run)` };
	} catch (error) {
		return { status: "failed", configured, checks, summary: `Project checks failed: ${error.message}` };
	}
}

module.exports = { findConfig, runChecks };

if (require.main === module) {
	const cwdIndex = process.argv.indexOf("--cwd");
	const result = runChecks({ cwd: cwdIndex < 0 ? process.cwd() : process.argv[cwdIndex + 1], force: process.argv.includes("--force") });
	if (process.argv.includes("--json")) console.log(JSON.stringify(result));
	else {
		console.log(result.summary);
		for (const check of result.checks) if (check.output) console.log(`${check.name}: ${check.output}`);
	}
	process.exitCode = result.status === "failed" ? 1 : 0;
}
