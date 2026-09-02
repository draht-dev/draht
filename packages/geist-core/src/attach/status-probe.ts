/**
 * The deadline-bounded, quad-state git probe behind a fleet row's `status`
 * (R35-ALWAYS.8).
 *
 * ## What this replaces, and why a deadline alone would not have been enough
 *
 * The only status computation this repo had was `isDirtyOrAhead()` in
 * `ledger/sha-ledger.ts`: it caught every git failure and returned `false`.
 * `false` renders as CLEAN. So a repository git refused to read — dubious
 * ownership, a corrupt index, a vanished cwd, a shadowed binary — reported the
 * one answer a human acts on. Bounding the hang would have bounded how long the
 * lie took to arrive; it would not have made it true. A boolean CANNOT express
 * "I could not tell", so the boolean is gone and this module answers with four
 * values:
 *
 *   `clean`   a repository with nothing to commit
 *   `dirty`   a repository with changes
 *   `no_repo` the cwd is not inside a repository — an ORDINARY answer, not a
 *             failure. Measured on the real machine: of 55 non-zero
 *             `git status` exits across 107 live cwds, 54 were "not a git
 *             repository". Folding those into `unknown` would make the majority
 *             of the fleet read as broken and destroy the signal for both.
 *   `unknown` git refused, could not be run, or did not answer inside the
 *             deadline. NEVER `clean`, and never a terminal value: the next
 *             probe may well succeed (GSEC-07).
 *
 * ## Why the probe is async, and where it is NOT allowed to run
 *
 * `buildFleetFrame()` is synchronous and fires on every `hello`
 * (`attach/attach-bridge.ts`). A synchronous probe there turns ONE wedged
 * repository into a daemon-wide stall that any connecting phone can trigger:
 * `spawnSync` burns the whole event loop for the full deadline. So the probe
 * NEVER runs on the hello path. {@link GitStatusProbe.read} is the only thing
 * that path may call, it is synchronous, and it reads the cache and nothing
 * else. {@link GitStatusProbe.refresh} is the only thing that spawns, it is
 * async, and it is awaited by request handlers that can afford to wait.
 *
 * ## The deadline
 *
 * 500 ms per probe. Measured warm `git status --porcelain`: 25–30 ms on this
 * monorepo and on element-x-ios, 126–192 ms on the flutter SDK (15,104 files,
 * 2.5 GB of `.git`), and 157 ms on a cold first read where warm was 26 ms. 500
 * clears the cold case with room to spare, so a healthy repository is never
 * marked `unknown` for being slow, while a wedged one is abandoned in half a
 * second.
 *
 * ## Killing a probe that ignores being killed
 *
 * A deadline that sends SIGTERM is not a deadline. A child that traps TERM
 * survives it — measured: still blocked at 15 s against a 500 ms bound — and
 * `spawnSync`'s default `killSignal` is exactly SIGTERM. Worse, killing the
 * direct child leaves its children: a `sleep 3600` grandchild outlived the
 * `sh` that spawned it. So every probe is spawned `detached` (its own process
 * group) and the deadline kills the GROUP with SIGKILL. `fleet-status-honesty`
 * asserts both halves — that the response returns inside the deadline, and that
 * nothing the shim started is still alive afterwards.
 */

import { type ChildProcess, spawn } from "node:child_process";

/**
 * The PATH a probe runs with — absolute, system-owned, and nothing of the
 * daemon's own.
 *
 * git shells out to its own subcommands and, on macOS, to `xcrun`, so it needs
 * a PATH. It does not need the operator's, which may have a project-local
 * `node_modules/.bin` or a per-user shim directory ahead of the system one.
 */
const TRUSTED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Where a system git actually lives, in the order a trusted PATH would find it. */
const GIT_CANDIDATES = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"] as const;

/**
 * The complete environment a probe child receives — an allowlist, exported so a
 * test asserts what this function BUILDS rather than re-declaring the same keys
 * and asserting its own copy.
 *
 * That distinction is the point. A test that spawns git with a hardcoded
 * allowlist proves the allowlist works; it says nothing about whether this
 * module still uses one, and would go on passing if the call site became
 * `{...process.env}` again — which is the defect it exists to prevent. Measured:
 * with the allowlist reverted, exactly that test still passed.
 *
 * Nothing here is secret. Anything added needs a reason beside it, because
 * whatever is in here is readable by a program the REPOSITORY chose.
 */
export function probeEnvironment(): Record<string, string> {
	return {
		// git needs to find its own subcommands and, on macOS, xcrun.
		PATH: TRUSTED_PATH,
		// A probe must never sit waiting for a credential prompt.
		GIT_TERMINAL_PROMPT: "0",
		// ...nor for an askpass helper, nor an SSH agent it should not have.
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		// `no_repo` is classified by matching git's own wording, and git translates
		// its messages. Under a localized shell "not a git repository" never matches
		// and the ordinary case reads `unknown`. Pinning the locale keeps the one
		// string this depends on stable.
		LC_ALL: "C",
	};
}

let resolvedGit: string | undefined;

/**
 * The absolute git to run, resolved once.
 *
 * `spawn("git", …)` is a PATH lookup, and the PATH it looks in is whatever the
 * daemon inherited — so a directory earlier in it could supply the binary that
 * then runs in every session cwd the daemon knows about. Resolving to an
 * absolute system path removes the lookup entirely.
 *
 * Falls back to the bare name only when no candidate exists, which is a machine
 * with git somewhere unusual: the probe already treats ENOENT as `unavailable`
 * rather than as a clean tree, so the failure stays honest either way.
 */
function gitExecutable(): string {
	if (resolvedGit !== undefined) return resolvedGit;

	// An explicit override, read from the DAEMON's own environment.
	//
	// This does not reopen what the absolute resolution closes. The threat this
	// module defends against is REPOSITORY-controlled input — a `.git/config` in
	// a cwd the daemon merely observes — and a repository cannot set the
	// daemon's environment. An operator who exports this has chosen their own
	// git, which they could equally do by installing one.
	//
	// It exists because the alternative is worse: without it the only way to
	// point the probe at a different git is to shadow it on PATH, which is
	// precisely the injection this resolution removes. A test that needs a git
	// which fails, hangs, or ignores TERM needs SOME seam, and an explicit
	// operator-set variable is the one that does not also serve an attacker.
	const override = process.env.DRAHT_GIT_BINARY;
	if (override !== undefined && override.length > 0) {
		resolvedGit = override;
		return resolvedGit;
	}
	for (const candidate of GIT_CANDIDATES) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				resolvedGit = candidate;
				return resolvedGit;
			}
		} catch {}
	}
	resolvedGit = "git";
	return resolvedGit;
}

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionStatus } from "@draht/geist-protocol";

/**
 * How long one `git status` gets. See the module comment for the measurements
 * this number comes from.
 */
export const DEFAULT_STATUS_PROBE_DEADLINE_MS = 500;

/**
 * The floor between two probes of one cwd.
 *
 * A fleet request rate is a client's choice, not a budget: without this, a
 * renderer polling `GET /fleet` at 10 Hz spawns 10 `git status` per second per
 * session.
 */
const MIN_PROBE_INTERVAL_MS = 250;

/**
 * How long a probe result is reused when nothing about the repository looks
 * changed.
 *
 * The cache key below moves on a commit, a stage, or a top-level working-tree
 * write; it does NOT move when a file changes deep inside a tracked directory,
 * so this ceiling is what stops such an edit from being invisible forever.
 */
const CACHE_TTL_MS = 2_000;

/**
 * How long a GOOD reading survives probes that fail (the hysteresis ruling).
 *
 * A single failed probe — a momentary `index.lock`, a machine under load — must
 * not flip a row to `unknown` and spam a `fleet_delta` to every connected
 * phone. It is LAST-KNOWN-GOOD, not sticky: the reading keeps its ORIGINAL
 * `statusAt`, so its age is on the wire and a renderer can see it going stale,
 * and once it ages past this window the honest answer takes over. A probe that
 * recovers inside the window replaces it outright.
 */
const LAST_KNOWN_GOOD_TTL_MS = 5_000;

/**
 * How old a cached reading may be and still be served to the SYNCHRONOUS
 * reader.
 *
 * That path cannot refresh anything, so its only choices are a stale answer
 * with an honest timestamp or no answer at all. Past this age it returns
 * nothing and the row reports `unknown` with a null `statusAt` — "nobody has
 * looked recently" rather than a claim about a world an hour old.
 */
const READ_MAX_AGE_MS = 60_000;

/** How many probes may be in flight at once. */
const MAX_CONCURRENT_PROBES = 8;

/**
 * The wall-clock budget for one {@link GitStatusProbe.refresh}.
 *
 * The per-probe deadline bounds ONE spawn; with the socket cap at 64 live
 * sessions and a concurrency limit of 8, a fleet of wedged repositories would
 * otherwise cost 8 × 500 ms. Once this is spent, no further probes are STARTED
 * — the cwds that did not get one keep whatever they had, which is exactly what
 * the cache is for.
 */
const REFRESH_BUDGET_MS = 1_500;

/** Bytes of stderr kept for classification. Enough for a `fatal:` line. */
const STDERR_CAP_BYTES = 4_096;

/** One completed observation of one working tree. */
export interface FleetStatusReading {
	/** What the last completed probe saw. */
	readonly status: SessionStatus;
	/** When it saw it, ISO-8601. Never invented: a reading always has a moment. */
	readonly statusAt: string;
}

/**
 * The cache-only view a projection is allowed to use.
 *
 * Deliberately narrow, and deliberately synchronous: `listAttachableSessions()`
 * takes one of these and therefore cannot start a subprocess however it is
 * called.
 */
export interface FleetStatusSource {
	/** The last reading for `cwd`, or null if there is none worth reporting. */
	read(cwd: string): FleetStatusReading | null;
	/** Bring `cwds` up to date. Absent on a source that only ever reads. */
	refresh?(cwds: readonly string[]): Promise<void>;
}

/** Why a probe could not answer. Kept apart so a timeout is distinguishable. */
export type ProbeFailure = "timeout" | "refused" | "unavailable";

/** One raw probe result, before any caching or hysteresis. */
export interface GitStatusProbeResult {
	readonly status: SessionStatus;
	/** Set only when `status` is `unknown`; says which way it failed. */
	readonly failure?: ProbeFailure;
}

/** Whether a status is an ANSWER rather than an admission of ignorance. */
function isGood(status: SessionStatus): boolean {
	return status !== "unknown";
}

/**
 * Kill a probe's whole process group.
 *
 * `detached: true` made the child a group leader, so its pgid is its pid and
 * one negative-pid SIGKILL takes the child and anything it started. The direct
 * kill afterwards is the fallback for a child that never got as far as its own
 * group.
 */
function killProbeGroup(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone, or never became a group leader.
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// Already reaped.
	}
}

/**
 * Run one `git status --porcelain` in `cwd`, bounded by `deadlineMs`.
 *
 * `--no-optional-locks` is not decoration: without it a status read can take —
 * and can leave behind — an `index.lock`, which is one more way for a probe to
 * block on a repository somebody else is using. Measured, it also shaves 2–5 ms.
 *
 * Exported for a caller that wants a single reading with no cache; the daemon
 * goes through {@link GitStatusProbe}.
 */
export function probeGitStatus(cwd: string, options: { deadlineMs?: number } = {}): Promise<GitStatusProbeResult> {
	const deadlineMs = options.deadlineMs ?? DEFAULT_STATUS_PROBE_DEADLINE_MS;

	return new Promise<GitStatusProbeResult>((resolve) => {
		let settled = false;
		const settle = (result: GitStatusProbeResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		/**
		 * THE DEADLINE IS AN OWN TIMER, NOT `AbortSignal.timeout` HANDED TO
		 * `spawn`.
		 *
		 * Two reasons, and both are load-bearing. `spawn`'s `signal` option kills
		 * the direct child and NOTHING IT STARTED — a `sleep 3600` grandchild
		 * outlives it — and its `killSignal` defaults to SIGTERM, which a child
		 * that traps TERM simply ignores. And this module runs under Bun inside
		 * the daemon and under Node everywhere else; a timer plus an explicit
		 * `kill(-pid)` is the mechanism both runtimes implement identically,
		 * where support for `signal`/`killSignal` in `node:child_process` is not
		 * something to bet a deadline on.
		 */
		let timedOut = false;
		let child: ChildProcess;
		try {
			child = spawn(
				gitExecutable(),
				[
					// `status` RUNS PROGRAMS THE REPOSITORY CHOOSES. `core.fsmonitor` is a
					// path git executes on every status, and `.git/config` belongs to
					// whoever wrote the repository — so a cwd this daemon merely OBSERVES
					// could run code, and before this line it ran with the daemon's whole
					// environment. Demonstrated, not theorised: a fixture repo with
					// `core.fsmonitor` set to a shell script saw an exported secret in its
					// own env, twice per status. Both halves are now closed — these `-c`
					// overrides win over any repository config, and the environment below
					// is an allowlist. The overrides come FIRST because a later `-c` wins
					// and these must not be overridable by anything.
					"-c",
					"core.fsmonitor=",
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"uploadpack.packObjectsHook=",
					"-c",
					"diff.external=",
					"--no-optional-locks",
					"status",
					"--porcelain",
				],
				{
					cwd,
					// Its own process group, so the deadline can take the whole tree.
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					// AN ALLOWLIST, NOT `{...process.env}`. This probe runs in every cwd
					// the daemon knows about, on every fleet refresh, so anything it
					// inherits is exposed to every repository the operator has ever opened
					// a session in — including whatever credentials the daemon was started
					// with. Nothing here is secret, and nothing is added without a reason
					// written next to it.
					env: probeEnvironment(),
				},
			);
		} catch {
			// A spawn that throws synchronously (a cwd that vanished between the
			// existence check and here) is not evidence of a clean tree.
			return settle({ status: "unknown", failure: "unavailable" });
		}

		const timer = setTimeout(() => {
			timedOut = true;
			killProbeGroup(child);
			settle({ status: "unknown", failure: "timeout" });
		}, deadlineMs);
		// A probe must never be the reason a process cannot exit.
		timer.unref?.();

		let sawOutput = false;
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			// Only ever asked "is there any output?" — a porcelain line means dirty.
			// Never accumulated, so a repository with 200k changed files cannot make
			// the daemon's heap the interesting failure.
			if (!sawOutput && chunk.toString("utf8").trim().length > 0) sawOutput = true;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString("utf8");
		});
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});

		child.on("error", () => {
			clearTimeout(timer);
			// ENOENT: no git on PATH at all. Not a clean tree; not a missing repo.
			settle({ status: "unknown", failure: timedOut ? "timeout" : "unavailable" });
		});

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (timedOut || signal !== null) {
				settle({ status: "unknown", failure: "timeout" });
				return;
			}
			if (code === 0) {
				settle({ status: sawOutput ? "dirty" : "clean" });
				return;
			}
			// The one non-zero exit that is a FACT rather than a failure. Matched on
			// git's own wording; anything else it refuses with stays `unknown`,
			// including `detected dubious ownership`, which exits 128 on a tree that
			// is genuinely dirty and would be a lie as `clean`.
			if (/not a git repository/i.test(stderr)) {
				settle({ status: "no_repo" });
				return;
			}
			settle({ status: "unknown", failure: "refused" });
		});
	});
}

/** What the cache holds per cwd. */
interface CacheEntry {
	/** Repository fingerprint the reading was taken against. */
	key: string;
	/** The reading being reported. `unknown` once no good one survives. */
	status: SessionStatus;
	/** When {@link status} was observed. Preserved across failing probes. */
	statusAt: string;
	/** {@link statusAt} in ms, for the age comparisons. */
	observedAtMs: number;
	/** When a probe last ran at all, good or not. */
	probedAtMs: number;
}

/**
 * Every working tree's status, probed off the request path and cached per cwd.
 *
 * The cache is OWNED — one instance per daemon surface, handed to the
 * projection — rather than a module global. Phase 35 is already removing one
 * module global; a second one here would be a second thing no test can reset
 * and no second daemon in one process can keep apart.
 *
 * ## The key, and what it deliberately does not catch
 *
 * `(cwd mtime, .git/index mtime, .git/HEAD mtime)`. A commit moves HEAD, a
 * stage moves the index, a top-level write moves the directory. An edit deep
 * inside a tracked subdirectory moves NONE of them, which is why the key is
 * paired with {@link CACHE_TTL_MS} rather than trusted on its own. The key is
 * the fast path, the TTL is the correctness floor.
 */
export class GitStatusProbe implements FleetStatusSource {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly deadlineMs: number;
	private readonly now: () => number;
	private readonly run: (cwd: string, deadlineMs: number) => Promise<GitStatusProbeResult>;

	constructor(
		options: {
			deadlineMs?: number;
			/** Clock seam. Tests inject one; nothing else should. */
			now?: () => number;
			/** Probe seam, for a unit test that must not spawn. */
			probe?: (cwd: string, deadlineMs: number) => Promise<GitStatusProbeResult>;
		} = {},
	) {
		this.deadlineMs = options.deadlineMs ?? DEFAULT_STATUS_PROBE_DEADLINE_MS;
		this.now = options.now ?? Date.now;
		this.run = options.probe ?? ((cwd, deadlineMs) => probeGitStatus(cwd, { deadlineMs }));
	}

	/**
	 * The last reading for `cwd`. Synchronous, and it NEVER spawns anything —
	 * this is what the `hello` path is allowed to call.
	 */
	read(cwd: string): FleetStatusReading | null {
		const entry = this.entries.get(cwd);
		if (entry === undefined) return null;
		if (this.now() - entry.observedAtMs > READ_MAX_AGE_MS) return null;
		return { status: entry.status, statusAt: entry.statusAt };
	}

	/**
	 * Bring the given cwds up to date, in parallel and within a budget.
	 *
	 * A cwd that does not exist is never spawned into: 945 of the 1,052 cwds in
	 * the real corpus are gone, and a probe per row per request would be ~90%
	 * doomed spawns — measured at 12.17 s serial for just the 107 that survive.
	 */
	async refresh(cwds: readonly string[]): Promise<void> {
		const startedAt = this.now();
		const pending: string[] = [];
		const seen = new Set<string>();

		for (const cwd of cwds) {
			if (cwd.length === 0 || seen.has(cwd)) continue;
			seen.add(cwd);
			if (!existsSync(cwd)) {
				// A live session whose directory was deleted under it. Not `no_repo`
				// (that is a statement about a directory that exists) and certainly
				// not `clean`.
				this.record(cwd, "", { status: "unknown", failure: "unavailable" });
				continue;
			}
			if (this.isFresh(cwd)) continue;
			pending.push(cwd);
		}

		let next = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				if (this.now() - startedAt >= REFRESH_BUDGET_MS) return;
				const index = next++;
				const cwd = pending[index];
				if (cwd === undefined) return;
				const key = this.fingerprint(cwd);
				this.record(cwd, key, await this.run(cwd, this.deadlineMs));
			}
		};

		await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, pending.length) }, () => worker()));
	}

	/** Drop everything remembered. For a caller that owns a cache's lifetime. */
	clear(): void {
		this.entries.clear();
	}

	/** Whether the cached reading may be reused without probing again. */
	private isFresh(cwd: string): boolean {
		const entry = this.entries.get(cwd);
		if (entry === undefined) return false;
		const age = this.now() - entry.probedAtMs;
		if (age < MIN_PROBE_INTERVAL_MS) return true;
		if (age >= CACHE_TTL_MS) return false;
		return entry.key === this.fingerprint(cwd);
	}

	/**
	 * Fold one probe result into the cache, applying the hysteresis rule.
	 *
	 * A good result always wins. A failure keeps the last good reading AND ITS
	 * ORIGINAL TIMESTAMP for {@link LAST_KNOWN_GOOD_TTL_MS} — re-stamping it
	 * would be the fail-open all over again, dressed as freshness — and after
	 * that the row says `unknown`.
	 */
	private record(cwd: string, key: string, result: GitStatusProbeResult): void {
		const nowMs = this.now();
		if (isGood(result.status)) {
			this.entries.set(cwd, {
				key,
				status: result.status,
				statusAt: new Date(nowMs).toISOString(),
				observedAtMs: nowMs,
				probedAtMs: nowMs,
			});
			return;
		}

		const previous = this.entries.get(cwd);
		if (previous !== undefined && isGood(previous.status) && nowMs - previous.observedAtMs < LAST_KNOWN_GOOD_TTL_MS) {
			this.entries.set(cwd, { ...previous, key, probedAtMs: nowMs });
			return;
		}
		this.entries.set(cwd, {
			key,
			status: "unknown",
			statusAt: new Date(nowMs).toISOString(),
			observedAtMs: nowMs,
			probedAtMs: nowMs,
		});
	}

	/** `(cwd, .git/index, .git/HEAD)` mtimes, or "" for whatever cannot be stat'd. */
	private fingerprint(cwd: string): string {
		return [cwd, join(cwd, ".git", "index"), join(cwd, ".git", "HEAD")].map(mtimeOf).join("|");
	}
}

/** A path's mtime in nanoseconds as a string, or "" when it cannot be read. */
function mtimeOf(path: string): string {
	try {
		return statSync(path, { bigint: true }).mtimeNs.toString();
	} catch {
		return "";
	}
}
