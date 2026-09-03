import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/**
 * The judge gate machinery: a test the agent wrote is a claim, and this suite
 * checks that the claim is turned into evidence correctly.
 *
 * Everything runs against a throwaway git repo whose suite is `node --test`, so
 * there is nothing to install and the replay path (worktree, revert, mutate) is
 * exercised for real rather than mocked.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(ROOT, "packages/draht-claude/scripts");
const HOOK = join(SCRIPTS, "judge-hook.py");

const COMMITTED_SOURCE = `export function pick(providers, status) {
	return providers[0];
}
`;

// Implements the fallback, in enough lines that more than one mutation applies.
const IMPLEMENTED_SOURCE = `export function pick(providers, status) {
	if (status === 429 && providers.length > 1) {
		return providers[1];
	}
	return providers[0];
}
`;

const REAL_RED_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { pick } from "../src/router.mjs";

test("falls back to the next provider on 429", () => {
	assert.equal(pick(["a", "b"], 429), "b");
});
`;

// Asserts what the committed code already does — passes with no implementation.
const FAKE_GATE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { pick } from "../src/router.mjs";

test("returns a provider", () => {
	assert.equal(pick(["a", "b"], 200), "a");
});
`;

function git(repo, ...args) {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "judge-gates-"));
	const repo = join(root, "repo");
	const cfg = join(root, "cfg");
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(join(repo, "test"), { recursive: true });
	mkdirSync(cfg, { recursive: true });
	writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "gatefix", private: true, scripts: { test: "node --test" } }, null, 2));
	writeFileSync(join(repo, "src", "router.mjs"), COMMITTED_SOURCE);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "gate@example.com");
	git(repo, "config", "user.name", "gate");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "initial");
	return { root, repo, cfg, session: "sess-gate" };
}

function env(f) {
	return { ...process.env, CLAUDE_CONFIG_DIR: f.cfg, NO_COLOR: "1" };
}

/** Simulate a running TUI: the heartbeat has to stay fresh or judge stands down. */
function startHeartbeat(f) {
	const path = join(f.cfg, "judge", "heartbeat");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "1");
	const timer = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(path, now, now);
		} catch {}
	}, 500);
	return () => clearInterval(timer);
}

function cardsDir(f) {
	return join(f.cfg, "judge", "cards");
}

function readCards(f) {
	if (!existsSync(cardsDir(f))) return [];
	return readdirSync(cardsDir(f))
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(cardsDir(f), name), "utf8")));
}

const HOOK_KILL_MS = 90000;

function runHook(f, event, payload) {
	return new Promise((resolveRun) => {
		const child = spawn("python3", [HOOK, event], { env: env(f) });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const kill = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, HOOK_KILL_MS);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (status) => {
			clearTimeout(kill);
			resolveRun({ status, stdout, stderr, killed });
		});
		child.stdin.end(JSON.stringify({ session_id: f.session, cwd: f.repo, transcript_path: join(f.root, "none.jsonl"), ...payload }));
	});
}

/** Poll until the hook has filed an open card, then answer it the way the TUI would. */
function answerCard(f, verdict, comment = "", timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	const timer = setInterval(() => {
		const open = readCards(f).find((card) => card.status === "open" && card.kind === "gate");
		// Wait for the replay to finish so the answer lands on real evidence.
		if (open && (open.meta?.verify?.status ?? "done") !== "running") {
			clearInterval(timer);
			open.status = "decided";
			open.verdict = verdict;
			open.comment = comment;
			open.decided_at = Date.now() / 1000;
			writeFileSync(join(cardsDir(f), `${open.id}.json`), JSON.stringify(open, null, 1));
		} else if (Date.now() > deadline) {
			clearInterval(timer);
		}
	}, 150);
	return () => clearInterval(timer);
}

function python(code) {
	const result = spawnSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})\n${code}`], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function decision(stdout) {
	if (!stdout.trim()) return null;
	return JSON.parse(stdout).hookSpecificOutput ?? JSON.parse(stdout);
}

test("PostToolUse remembers a test edit and ignores a source edit", async () => {
	const f = fixture();
	writeFileSync(join(f.repo, "test", "router.test.mjs"), REAL_RED_TEST);
	await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "test", "router.test.mjs") } });
	await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "src", "router.mjs") } });
	const state = JSON.parse(readFileSync(join(f.cfg, "judge", "sessions", `${f.session}.json`), "utf8"));
	// Paths are stored resolved, so a symlinked cwd cannot escape the repo later.
	assert.deepEqual(Object.keys(state.pending), [realpathSync(join(f.repo, "test", "router.test.mjs"))]);
});

test("a test that passes without the implementation is denied without asking a human", async () => {
	const f = fixture();
	const stop = startHeartbeat(f);
	try {
		writeFileSync(join(f.repo, "test", "router.test.mjs"), FAKE_GATE_TEST);
		await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "test", "router.test.mjs") } });
		const result = await runHook(f, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(f.repo, "src", "router.mjs") } });
		assert.equal(result.status, 0, result.stderr);
		const out = decision(result.stdout);
		assert.equal(out.permissionDecision, "deny");
		assert.match(out.permissionDecisionReason, /PASSES without the implementation/);
		const card = readCards(f).find((c) => c.kind === "gate");
		assert.equal(card.meta.verify.conclusion, "not-a-gate");
		assert.equal(card.meta.auto, true);
		assert.equal(card.verdict, "reject");
	} finally {
		stop();
	}
});

test("a real red waits for the swipe and lets the implementation through when approved", async () => {
	const f = fixture();
	const stop = startHeartbeat(f);
	const cancel = answerCard(f, "approve");
	try {
		writeFileSync(join(f.repo, "test", "router.test.mjs"), REAL_RED_TEST);
		await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "test", "router.test.mjs") } });
		const result = await runHook(f, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(f.repo, "src", "router.mjs") } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "", "an approved gate must not deny the edit");
		const card = readCards(f).find((c) => c.kind === "gate");
		assert.equal(card.meta.verify.conclusion, "real-red");
		assert.equal(card.meta.verify.runs[0].verdict, "assertion");
		assert.deepEqual(card.meta.claims, ["falls back to the next provider on 429"]);
		const state = JSON.parse(readFileSync(join(f.cfg, "judge", "sessions", `${f.session}.json`), "utf8"));
		assert.deepEqual(Object.values(state.gates)[0].files, ["test/router.test.mjs"]);
	} finally {
		cancel();
		stop();
	}
});

test("a rejected gate holds the edit and hands the comment to the session", async () => {
	const f = fixture();
	const stop = startHeartbeat(f);
	const cancel = answerCard(f, "reject", "assert the response, not that the mock was called");
	try {
		writeFileSync(join(f.repo, "test", "router.test.mjs"), REAL_RED_TEST);
		await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "test", "router.test.mjs") } });
		const result = await runHook(f, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(f.repo, "src", "router.mjs") } });
		const out = decision(result.stdout);
		assert.equal(out.permissionDecision, "deny");
		assert.match(out.permissionDecisionReason, /assert the response, not that the mock was called/);
		assert.match(out.permissionDecisionReason, /Strengthen the test/);
		const ledger = readFileSync(join(f.cfg, "judge", "gates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(ledger.at(-1).verdict, "reject");
		assert.equal(ledger.at(-1).conclusion, "real-red");
	} finally {
		cancel();
		stop();
	}
});

test("nothing is gated while the judge TUI is not running", async () => {
	const f = fixture();
	writeFileSync(join(f.repo, "test", "router.test.mjs"), REAL_RED_TEST);
	await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "test", "router.test.mjs") } });
	const result = await runHook(f, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(f.repo, "src", "router.mjs") } });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "");
	assert.deepEqual(readCards(f), []);
});

test("the mutation pass scores a gate against the implementation that landed", () => {
	const f = fixture();
	writeFileSync(join(f.repo, "test", "router.test.mjs"), REAL_RED_TEST);
	writeFileSync(join(f.repo, "src", "router.mjs"), IMPLEMENTED_SOURCE);
	const out = python(`
import json, judgegates as G
repo = ${JSON.stringify(f.repo)}
cfg = G.config(repo)
result = G.verify_green(repo, cfg, ["test/router.test.mjs"], ["src/router.mjs"])
print(json.dumps({
  "baseline": result["baseline"],
  "conclusion": result["conclusion"],
  "killed": result["killed"],
  "scored": result["scored"],
  "survivors": [m["op"] + " @" + str(m["line"]) for m in result["mutants"] if not m["killed"] and not m["invalid"]],
}))
`);
	const result = JSON.parse(out);
	assert.equal(result.baseline, "pass", "the fixture implementation must make the test pass");
	assert.ok(result.scored >= 2, `expected several scored mutants, got ${result.scored}`);
	assert.ok(result.killed >= 1, "the test must catch at least one mutation");
	assert.equal(result.conclusion, result.killed === result.scored ? "bites" : "partial");
	// The unreachable trailing `return providers[0]` is a genuine survivor: the
	// 429 path returns first, so no assertion in this test can notice it.
	if (result.conclusion === "partial") assert.ok(result.survivors.length > 0);
});

test("static smells name the ways a test can look like a gate without being one", () => {
	const out = python(`
import json, judgegates as G
cases = {
  "mock": '+it("routes", () => { expect(send).toHaveBeenCalled(); });',
  "bare": '+it("routes", () => { route(req); });',
  "snap": '+it("routes", () => { expect(out).toMatchSnapshot(); });',
  "skip": '+it.skip("routes", () => { expect(a).toBe(1); });',
  "real": '+it("falls back", () => { expect(res.provider).toBe("b"); });',
}
print(json.dumps({k: [s["code"] for s in G.smells(v)] for k, v in cases.items()}))
`);
	assert.deepEqual(JSON.parse(out), {
		mock: ["mock-only"],
		bare: ["no-assertion"],
		snap: ["snapshot-only"],
		skip: ["skipped"],
		real: [],
	});
});

test("the replay reports a pass as a fact, without deciding what it means", () => {
	const f = fixture();
	writeFileSync(join(f.repo, "test", "router.test.mjs"), FAKE_GATE_TEST);
	const out = python(`
import json, judgegates as G
repo = ${JSON.stringify(f.repo)}
result = G.verify_red(repo, G.config(repo), ["test/router.test.mjs"], [])
print(json.dumps({"conclusion": result["conclusion"], "reverted": result["reverted"]}))
`);
	assert.deepEqual(JSON.parse(out), { conclusion: "passes", reverted: [] });
});

test("a test for behaviour that already exists is carded at Stop, not held", async () => {
	const f = fixture();
	const stop = startHeartbeat(f);
	try {
		writeFileSync(join(f.repo, "test", "router.test.mjs"), FAKE_GATE_TEST);
		await runHook(f, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(f.repo, "test", "router.test.mjs") } });
		// No implementation edit follows, so the safety net at Stop picks it up.
		const result = await runHook(f, "Stop", { last_assistant_message: "added a test" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "", "an already-green test must not block the turn");
		const card = readCards(f).find((c) => c.kind === "gate");
		assert.equal(card.meta.verify.conclusion, "already-green");
		assert.equal(card.status, "open", "the card stands as a record for the reviewer");
	} finally {
		stop();
	}
});
