/**
 * R35-ALWAYS.8 (and the field half of R35-ALWAYS.7) — proved end to end,
 * against the daemon's own `GET /fleet`, with a real `git` that the test
 * controls.
 *
 * Two real processes, neither of them imported: the emitted draht binary
 * publishing genuine `<id>.sock` + `.lock` pairs, and the daemon its own bin
 * starts. Every assertion below reads the HTTP body a phone would read. A
 * package-level test that called `probeGitStatus()` directly could pass while
 * the shipped daemon reported `clean` for every wedged repository on the
 * machine — which is precisely the defect this task exists to remove.
 *
 * ## The mechanism: PATH shadowing, and why it works here
 *
 * MEASURED, NOT ASSUMED: every git call site in this repo spawns the bare
 * string `"git"` — `attach/status-probe.ts`, `ledger/sha-ledger.ts` and
 * `geist-acp/src/acp-harness-session.ts` — with no absolute path, no `GIT_BIN`
 * override and no config key. The daemon is spawned here with an explicit
 * environment (the same shape `fleet-attach.e2e.test.ts` uses), so prepending a
 * fixture directory containing an executable `git` to that environment's PATH
 * decides what every probe in the daemon runs. Nothing else on the machine is
 * affected: the shim is visible to one child process.
 *
 * ## Three shims, three daemon runs, and why the third one is not redundant
 *
 * A fresh daemon per shim, because a daemon that has already answered once
 * holds a last-known-good reading and the point of shims 1–3 is what happens
 * when there has never been a good answer.
 *
 *  1. exits 128 with `fatal: detected dubious ownership` against a genuinely
 *     DIRTY repository. The old code caught that error and returned `false` —
 *     `clean` — for a tree with uncommitted work in it.
 *  2. `sleep 3600`. The response must still arrive, and must say `unknown`.
 *  3. `trap '' TERM; sleep 3600`. REQUIRED, and not a duplicate of 2: a
 *     deadline that sends SIGTERM is defeated by this shim (measured: still
 *     blocked at 15 s), so shim 2 alone would pass an implementation whose
 *     "deadline" leaks a process per probe forever. Both 2 and 3 therefore also
 *     assert that NOTHING THE SHIM STARTED IS STILL ALIVE afterwards — the
 *     `sleep` is a grandchild, and killing the direct child does not touch it.
 *
 * A fourth run uses a shim that `exec`s the real git after logging its cwd, so
 * the honest answers (`clean`, `dirty`, `no_repo`), the "history rows are never
 * probed" claim, and the hysteresis rule are read off real git behaviour.
 *
 * ## `unknown` is also the default, so it needs a witness
 *
 * A cwd the daemon has never probed reads `{status: "unknown", statusAt: null}`
 * — the same `status` a wedged repository gets. So `toBe("unknown")` on its own
 * asserts nothing: it holds identically if the refresh never ran. Every
 * `unknown` expectation below therefore goes through `expectProbedUnknown()`,
 * which requires a `statusAt` stamped after this daemon started. And the
 * `clean` case exists at all because everything else here proves only that bad
 * things produce `unknown`; a probe hard-wired to answer `unknown` would pass
 * the rest of the file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AttachableSessionSchema, FleetFrameSchema } from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "fleet-status-honesty-token";

/** The per-probe deadline the daemon is built with, plus room for a round trip. */
const PROBE_DEADLINE_MS = 500;

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended.
 * Everything here therefore lives directly under /tmp with a short name.
 */
const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		last = await probe();
		if (last) return last as T;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Drain a pipe into a string so a failing child's diagnostics survive. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** A real repository with one commit and nothing uncommitted — genuinely clean. */
function makeCleanRepo(prefix: string): string {
	const dir = tempDir(prefix);
	git(dir, ["init", "--quiet"]);
	git(dir, ["config", "user.email", "test@geist.local"]);
	git(dir, ["config", "user.name", "Geist Test"]);
	writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
	git(dir, ["add", "."]);
	git(dir, ["commit", "--quiet", "-m", "initial"]);
	return realpathSync(dir);
}

/** A real repository with one commit and one untracked file — genuinely dirty. */
function makeDirtyRepo(prefix: string): string {
	const dir = makeCleanRepo(prefix);
	writeFileSync(join(dir, "uncommitted.txt"), "work in progress\n", "utf8");
	return dir;
}

// ── the git shims ────────────────────────────────────────────────────────────

/** Where every shim appends the cwd it was invoked in, one per line. */
let probeLog = "";
/** Where the blocking shims record their own pid and their `sleep`'s pid. */
let probePids = "";
/** Touch this and the counting shim refuses instead of running real git. */
let failFlag = "";

/** Every cwd a shim has been invoked in since the log was last cleared. */
function probedCwds(): string[] {
	try {
		return readFileSync(probeLog, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** Every pid a blocking shim recorded. */
function recordedPids(): number[] {
	try {
		return readFileSync(probePids, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => Number.parseInt(line, 10))
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch {
		return [];
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Write an executable `git` into a fresh directory and return the directory. */
function makeShim(prefix: string, body: string): string {
	const dir = tempDir(prefix);
	const path = join(dir, "git");
	writeFileSync(path, `#!/bin/sh\n${body}`, "utf8");
	chmodSync(path, 0o755);
	return dir;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

let agentDir = "";
let home = "";
/** A live session whose cwd is a genuinely dirty git repository. */
let dirtySession = { id: "", cwd: "" };
/** A live session whose cwd is a clean git repository — the honest POSITIVE answer. */
let cleanSession = { id: "", cwd: "" };
/** A live session whose cwd is not a repository at all. */
let plainSession = { id: "", cwd: "" };
/** A recorded session with no socket, whose cwd IS an existing dirty repository. */
let historyRow = { id: "", cwd: "" };

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
}

async function startDrahtSession(cwd: string): Promise<DrahtSession> {
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
			},
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);

	// Matched by the LOCK'S OWN cwd rather than by "whichever socket is new".
	// Two sessions started together publish two sockets in an order nothing
	// promises, and a fixture that mixed them up would assert the dirty repo's
	// status against the plain directory's row — which is exactly how this test
	// first "failed".
	const socketDir = join(agentDir, "sockets");
	const entry = await until(() => {
		if (proc.exitCode !== null) {
			throw new Error(`draht exited with ${proc.exitCode} before publishing a socket:\n${stderr.text}`);
		}
		return sockets(socketDir).find((name) => lockCwd(join(socketDir, name.replace(/\.sock$/, ".lock"))) === cwd);
	}, `draht to publish a socket for ${cwd} (stderr: ${stderr.text})`);
	return { proc, id: entry.slice(0, -".sock".length), cwd };
}

/** Line 2 of a `<id>.lock` — the cwd the session was started in. */
function lockCwd(lockPath: string): string | null {
	try {
		return readFileSync(lockPath, "utf8").split("\n")[1] ?? null;
	} catch {
		return null;
	}
}

function sockets(socketDir: string): string[] {
	try {
		return readdirSync(socketDir).filter((entry) => entry.endsWith(".sock"));
	} catch {
		return [];
	}
}

/**
 * Seed one recorded session with no live socket.
 *
 * Written as the draht binary writes it — a slug directory under the agent
 * dir's `sessions/`, and a JSONL whose FIRST LINE is the session header — so
 * the daemon's history index reads it exactly as it reads a real one.
 */
function seedHistorySession(cwd: string): { id: string; cwd: string } {
	const id = crypto.randomUUID();
	const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const dir = join(agentDir, "sessions", slug);
	mkdirSync(dir, { recursive: true });
	const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
	writeFileSync(join(dir, `2026-08-22_${id}.jsonl`), `${JSON.stringify(header)}\n`, "utf8");
	return { id, cwd };
}

/** One daemon, with `shimDir` prepended to the PATH every probe resolves against. */
async function startDaemon(shimDir: string | null): Promise<{ base: string; stop: () => void }> {
	const port = freeLoopbackPort();
	const stderr = { text: "" };
	const path = shimDir === null ? process.env.PATH : `${shimDir}:${process.env.PATH}`;
	const proc = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: { ...process.env, PATH: path, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	await until(() => stderr.text.includes("draht-gateway listening"), "the daemon to report a bound port");
	return {
		base: `http://127.0.0.1:${port}`,
		stop: () => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
	};
}

/** `GET /fleet`, parsed against the shipped schema. */
async function fleet(base: string): Promise<ReturnType<typeof FleetFrameSchema.parse>> {
	const response = await fetch(`${base}/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	expect(response.status).toBe(200);
	return FleetFrameSchema.parse(await response.json());
}

function rowFor(frame: { sessions: unknown[] }, id: string): ReturnType<typeof AttachableSessionSchema.parse> {
	const row = frame.sessions.map((s) => AttachableSessionSchema.parse(s)).find((s) => s.id === id);
	if (row === undefined) throw new Error(`no fleet row for ${id}`);
	return row;
}

/**
 * Assert a row says `unknown` BECAUSE A PROBE SAID SO.
 *
 * `unknown` is also the daemon's default: `read()` returns
 * `{status: "unknown", statusAt: null}` for a cwd it has never heard of, so a
 * bare `expect(row.status).toBe("unknown")` holds just as well when the refresh
 * never ran at all — it would survive deleting the probe. `statusAt` is the
 * difference: a probe that could not tell STAMPS its failure, and only a probe
 * can produce a timestamp at all. `floorMs` is read before the daemon starts,
 * so the stamp cannot be a leftover from an earlier run either.
 */
function expectProbedUnknown(
	row: ReturnType<typeof AttachableSessionSchema.parse>,
	floorMs: number,
	what: string,
): void {
	expect(`${what}: ${row.status}`).toBe(`${what}: unknown`);
	expect(`${what}: ${row.statusAt}`).not.toBe(`${what}: null`);
	const at = Date.parse(row.statusAt ?? "");
	expect(Number.isFinite(at)).toBe(true);
	// "the probe ran and could not tell", not "no probe ever ran".
	expect(at).toBeGreaterThanOrEqual(floorMs);
}

beforeAll(async () => {
	// Built unconditionally: the artifact under test is emitted, not committed,
	// so "it already exists" says nothing about whether it matches this tree.
	const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("gsa-");
	home = tempDir("gsh-");

	const shimState = tempDir("gss-");
	probeLog = join(shimState, "invocations");
	probePids = join(shimState, "pids");
	failFlag = join(shimState, "refuse");

	const dirtyRepo = makeDirtyRepo("gsd-");
	const cleanRepo = makeCleanRepo("gsc-");
	const plainDir = realpathSync(tempDir("gsp-"));
	const historyRepo = makeDirtyRepo("gsq-");

	historyRow = seedHistorySession(historyRepo);
	dirtySession = await startDrahtSession(dirtyRepo);
	cleanSession = await startDrahtSession(cleanRepo);
	plainSession = await startDrahtSession(plainDir);
	const ids = new Set([dirtySession.id, cleanSession.id, plainSession.id]);
	if (ids.size !== 3) throw new Error("the fixture sessions do not have distinct ids");

	// The clean fixture is only meaningful if starting a session in it did not
	// itself dirty it. Asserted here, against real git, before any daemon runs:
	// a `clean` expectation that quietly became a `dirty` one would be worse
	// than no expectation at all.
	if (git(cleanSession.cwd, ["status", "--porcelain"]).trim() !== "") {
		throw new Error(`the clean fixture repo is not clean: ${git(cleanSession.cwd, ["status", "--porcelain"])}`);
	}
}, 300_000);

afterAll(() => {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const pid of recordedPids()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone — which is what the assertions below require anyway.
		}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("a git that refuses (R35-ALWAYS.8)", () => {
	test("a dirty repo whose git exits 128 reports `unknown` — never `clean`, never terminal", async () => {
		const shim = makeShim(
			"gfx-",
			`echo "$PWD" >> ${probeLog}\n` +
				`echo "fatal: detected dubious ownership in repository at '$PWD'" >&2\n` +
				"exit 128\n",
		);
		const floorMs = Date.now();
		const daemon = await startDaemon(shim);
		try {
			const frame = await fleet(daemon.base);

			// The whole defect in one assertion: this tree HAS uncommitted work in
			// it, and the old code answered `false` — clean — for exactly this exit.
			// `unknown` is an observation, not an absence of one: it is stamped, so a
			// renderer can age it, and so a later probe can replace it.
			expectProbedUnknown(rowFor(frame, dirtySession.id), floorMs, "the refused dirty repo");

			// And it is not terminal: the other sessions are refused by the same shim
			// and read the same way, rather than being frozen into anything. The CLEAN
			// repo is here on purpose — a refusal must beat a tree that really is
			// clean, or `clean` would just be the shape of "no answer".
			expectProbedUnknown(rowFor(frame, cleanSession.id), floorMs, "the refused clean repo");
			expectProbedUnknown(rowFor(frame, plainSession.id), floorMs, "the refused non-repo");
		} finally {
			daemon.stop();
		}
	}, 60_000);
});

describe("a git that never answers (R35-ALWAYS.8)", () => {
	/** Both blocking shims record the pid of the shell AND of its `sleep`. */
	const blocking = (extra: string): string =>
		`${extra}echo "$PWD" >> ${probeLog}\n` +
		`echo $$ >> ${probePids}\n` +
		"sleep 3600 &\n" +
		`echo $! >> ${probePids}\n` +
		"wait\n";

	async function assertBounded(shimBody: string, label: string): Promise<void> {
		writeFileSync(probePids, "", "utf8");
		const floorMs = Date.now();
		const daemon = await startDaemon(makeShim("gfx-", shimBody));
		try {
			const startedAt = Date.now();
			const frame = await fleet(daemon.base);
			const elapsed = Date.now() - startedAt;

			// The response arrived at all, and it arrived in half a second-ish
			// rather than in an hour.
			expect(elapsed).toBeLessThan(10 * PROBE_DEADLINE_MS);
			// Stamped, so these rows say "a probe ran and timed out" rather than
			// "nobody has ever looked" — which is the OTHER thing `unknown` means and
			// the reason a bare `toBe("unknown")` here could not fail.
			expectProbedUnknown(rowFor(frame, dirtySession.id), floorMs, `${label}: the dirty repo`);
			expectProbedUnknown(rowFor(frame, cleanSession.id), floorMs, `${label}: the clean repo`);
			expectProbedUnknown(rowFor(frame, plainSession.id), floorMs, `${label}: the non-repo`);

			// THE HALF SHIM 2 ALONE WOULD NOT CATCH. The deadline must take the
			// process GROUP: the `sleep` is a grandchild, and a SIGTERM to the
			// direct child leaves both of them running for the next hour.
			const pids = recordedPids();
			expect(pids.length).toBeGreaterThanOrEqual(2);
			await until(() => pids.every((pid) => !alive(pid)), `${label}: every shim process to be dead`, 10_000);
		} finally {
			daemon.stop();
		}
	}

	test("`sleep 3600` — the response still returns inside the deadline and says `unknown`", async () => {
		await assertBounded(blocking(""), "sleep");
	}, 60_000);

	test("`trap '' TERM; sleep 3600` — a SIGTERM-only deadline would leak this one", async () => {
		await assertBounded(blocking("trap '' TERM\n"), "trapped sleep");
	}, 60_000);
});

describe("the honest answers, and who is asked for them (R35-ALWAYS.7, R35-ALWAYS.8)", () => {
	let daemon: { base: string; stop: () => void };

	beforeAll(async () => {
		writeFileSync(probeLog, "", "utf8");
		const realGit = Bun.which("git");
		if (realGit === null) throw new Error("no git on PATH to shim");
		// Logs, then optionally refuses, then becomes the real git. The absolute
		// path is what keeps `exec` from finding this shim again.
		daemon = await startDaemon(
			makeShim(
				"gfx-",
				`echo "$PWD" >> ${probeLog}\n` +
					`if [ -f ${failFlag} ]; then\n` +
					`  echo "fatal: detected dubious ownership in repository at '$PWD'" >&2\n` +
					"  exit 128\n" +
					"fi\n" +
					`exec ${realGit} "$@"\n`,
			),
		);
	}, 60_000);

	afterAll(() => daemon?.stop());

	test("a live session in a dirty repo is `socket`/attachable with a pid, and reports `dirty`", async () => {
		const row = await until(async () => {
			const found = rowFor(await fleet(daemon.base), dirtySession.id);
			return found.status === "dirty" ? found : undefined;
		}, "the dirty repo to be reported dirty");

		expect(row.origin).toBe("socket");
		expect(row.attachable).toBe(true);
		expect(row.resumable).toBe(false);
		expect(typeof row.pid).toBe("number");
		expect(row.cwd).toBe(dirtySession.cwd);
		expect(row.statusAt).not.toBeNull();
	}, 60_000);

	test("a healthy repo reports `clean`, and real work in it moves the row AND its statusAt", async () => {
		// THE HONEST POSITIVE ANSWER. Every other test in this file proves that a
		// bad thing produces `unknown`; a probe that returned `unknown`
		// unconditionally would satisfy all of them and be useless. This is the one
		// that requires the daemon to actually look and actually say so.
		const clean = await until(async () => {
			const found = rowFor(await fleet(daemon.base), cleanSession.id);
			return found.status === "clean" ? found : undefined;
		}, "the clean repo to be reported clean");

		expect(clean.origin).toBe("socket");
		expect(clean.attachable).toBe(true);
		expect(clean.cwd).toBe(cleanSession.cwd);
		expect(clean.statusAt).not.toBeNull();
		const cleanAt = Date.parse(clean.statusAt ?? "");
		expect(Number.isFinite(cleanAt)).toBe(true);

		// Real git agrees, independently of the daemon: the row is not `clean`
		// because nothing was checked.
		expect(git(cleanSession.cwd, ["status", "--porcelain"]).trim()).toBe("");
		expect(probedCwds()).toContain(cleanSession.cwd);

		// Now put genuine uncommitted work in that same tree. The row must FOLLOW
		// it — a status that never moves off `clean` is the original fail-open with
		// extra steps.
		writeFileSync(join(cleanSession.cwd, "uncommitted.txt"), "work in progress\n", "utf8");

		const dirtied = await until(async () => {
			const found = rowFor(await fleet(daemon.base), cleanSession.id);
			return found.status === "dirty" ? found : undefined;
		}, "the newly dirtied repo to be reported dirty");

		// And the new reading is a NEW OBSERVATION, not the old one relabelled.
		expect(dirtied.statusAt).not.toBeNull();
		expect(Date.parse(dirtied.statusAt ?? "")).toBeGreaterThan(cleanAt);
	}, 60_000);

	test("a real non-git cwd is `no_repo`, which is an answer and not a failure", async () => {
		const row = await until(async () => {
			const found = rowFor(await fleet(daemon.base), plainSession.id);
			return found.status === "no_repo" ? found : undefined;
		}, "the plain directory to be reported no_repo");

		// The distinction the quad-state exists for: 54 of the 55 non-zero exits
		// on the real machine are this case. Folding it into `unknown` would make
		// the majority of the fleet read as broken.
		expect(row.status).not.toBe("unknown");
		expect(row.origin).toBe("socket");
	}, 60_000);

	test("a history-only session is `history`/resumable, has no pid, and is NEVER probed", async () => {
		const frame = await fleet(daemon.base);
		const row = rowFor(frame, historyRow.id);

		expect(row.origin).toBe("history");
		expect(row.attachable).toBe(false);
		expect(row.resumable).toBe(true);
		// `pid` was made optional in geist/0.4 for exactly this row: there is no
		// process, and a required pid could only have been satisfied by inventing
		// one.
		expect(row.pid).toBeUndefined();
		expect(row.status).toBe("unknown");
		expect(row.statusAt).toBeNull();

		// The cwd EXISTS and is a real dirty repository, so "no probe ran" cannot
		// be explained away by the cwd gate: it is the origin gate that stopped
		// it. 945 of 1,052 corpus cwds are gone; probing every history row per
		// request measured 12.17 s for the 107 that survive.
		expect(probedCwds()).not.toContain(historyRow.cwd);
		expect(probedCwds()).toContain(dirtySession.cwd);
	}, 60_000);

	test("a probe that starts failing keeps the last good reading AND its timestamp, then gives up", async () => {
		const before = await until(async () => {
			const found = rowFor(await fleet(daemon.base), dirtySession.id);
			return found.status === "dirty" ? found : undefined;
		}, "a good reading to hold on to");

		writeFileSync(failFlag, "refuse\n", "utf8");

		// Hysteresis: a probe that fails once must not flip the row and spam a
		// delta to every connected phone. The reading survives WITH ITS ORIGINAL
		// `statusAt` — re-stamping it would be the fail-open again, dressed up as
		// freshness — so its age is visible on the wire.
		await Bun.sleep(2_500);
		const held = rowFor(await fleet(daemon.base), dirtySession.id);
		expect(held.status).toBe("dirty");
		expect(held.statusAt).toBe(before.statusAt);

		// And it is last-known-good, not sticky: once the good reading ages out,
		// the honest answer takes over.
		const surrendered = await until(
			async () => {
				const found = rowFor(await fleet(daemon.base), dirtySession.id);
				return found.status === "unknown" ? found : undefined;
			},
			"the stale good reading to be given up",
			20_000,
		);
		expect(surrendered.statusAt).not.toBe(before.statusAt);

		rmSync(failFlag, { force: true });
	}, 90_000);
});
