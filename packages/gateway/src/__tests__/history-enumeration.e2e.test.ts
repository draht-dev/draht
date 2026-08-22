/**
 * R35-ALWAYS.6 — history enumeration, proved end to end over HTTP only.
 *
 * One real process, not imported: the daemon its own bin starts
 * (`bun packages/gateway/src/cli.ts`) on an ephemeral loopback port, pointed by
 * `DRAHT_CODING_AGENT_DIR` at a synthesised session store. Every assertion below
 * crosses the wire with `fetch`. Nothing here constructs `createServer()` or a
 * `HistoryIndex` — a package-level test that did could pass while the shipped
 * daemon served no `/history` at all, which is this repo's recorded failure
 * mode.
 *
 * The draht binary is deliberately NOT built or spawned here. This surface
 * reads files, and the thing under test is what it reads and how much of each
 * file it touches; a real session would give one row and no corpus. What the
 * corpus is instead is a copy of the REAL one, measured on Oskar's machine
 * 2026-08-22:
 *
 *   1,686 slug directories, 634 of them empty
 *   1,854 session `.jsonl` files
 *      10 `*.jsonl.checkpoints.jsonl` SIDECARS, which also end in `.jsonl`,
 *         carry no session header, and make a suffix-filtering enumerator
 *         report 1,864
 *       2 different projects sharing ONE slug directory, because the slug is
 *         built by collapsing `/` and `:` to `-` and is therefore lossy:
 *         `/seed/collide/a-b` and `/seed/collide/a/b` slugify identically
 *       4 multi-megabyte files, so "never read past line 1" is exercised
 *         against files where reading further would actually cost something
 *
 * ## Why the budget is asserted as counters and not as milliseconds
 *
 * The roadmap's "21–48 ms warm" is a page-cache measurement: unreproducible on
 * a cold machine and guaranteed to rot as the store grows. The invariant that
 * survives both is per file, per enumeration — ≤1 open, ≤4,096 bytes read, ≤2
 * stats — and `GET /history` hands back the counters that prove it. The
 * wall-clock ceilings below are asserted too, but only as a smoke alarm, and
 * generously: this suite runs alongside four other agents on one machine.
 *
 * ## Why the counters are NOT what proves "no file is read past its first line"
 *
 * A counter is a number the code under test computes about itself. An enumerator
 * that read every byte of every file and still reported `Math.min(bytesRead,
 * 4096)` would satisfy every assertion in the budget block above — measured:
 * 21 pass, 0 fail, faster than baseline — and the wall clock cannot rescue that,
 * because a fixture of a few megabytes is well inside a 2 s ceiling however much
 * of it gets read.
 *
 * So the corpus carries three facts the reader cannot report its way past,
 * because they are properties of the BYTES ON DISK and are read back out of the
 * ANSWER rather than out of the receipts:
 *
 *   1. A **poisoned session file**: line 1 is its real header, line 2 is a
 *      SECOND, later, well-formed `type:"session"` record with a different id
 *      and a different cwd. A reader that lets anything past line 1 reach the
 *      answer — last-header-wins, or a map built from every session record in
 *      the file — reports the impostor's project.
 *   2. A **poisoned sidecar**: line 1 is an ordinary checkpoint record, line 2 is
 *      a well-formed session header. This is the one that discriminates against
 *      the plausible implementation rather than a strawman: the kernel's own
 *      `readSessionHeader` (`coding-agent/src/core/session-manager.ts`) scans up
 *      to 1 MB for the FIRST line that parses as a header, so a faithful port of
 *      it skips this file's line 1 and enumerates a checkpoint sidecar as a
 *      session. The correct rule — "line 1 or nothing" — rejects it.
 *   3. One **8 GiB session file**, made of a header line and a sparse hole. It
 *      costs 4 KB of real disk and is invisible to a header-only reader; a reader
 *      that sizes a buffer to the file cannot even allocate it (Bun caps a Buffer
 *      at 4 GiB), and one that streams to EOF pays for eight gigabytes of zeroes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "history-enumeration-e2e-token";

/** The measured shape of the real store. Every number here was counted, not guessed. */
const SLUG_DIRS = 1686;
const NON_EMPTY_DIRS = 1052;
const SESSION_FILES = 1854;
const SIDECARS = 10;
/** What a naive `endsWith(".jsonl")` enumerator would report. */
const NAIVE_FILE_COUNT = SESSION_FILES + SIDECARS;

/** The two projects that share one slug directory. */
const COLLIDING_A = "/seed/collide/a-b";
const COLLIDING_B = "/seed/collide/a/b";
const COLLIDING_A_FILES = 3;
const COLLIDING_B_FILES = 2;

/** Files big enough that reading a second page would be measurable. */
const BIG_FILE_COUNT = 4;
const BIG_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The three fixture-side facts, and where in the corpus they live.
 *
 * All three sit in directories the seeding loop was going to create anyway, so
 * the counts above — 1,686 directories, 1,854 sessions, 10 sidecars — are
 * untouched by them. The two indices are both ≥ `doubled` (798), so each of
 * those directories holds exactly one session and a `?project=` filter over it
 * answers with a single row.
 */
const POISON_DIR_INDEX = 900;
/** The poisoned session's real project, named by its line 1. */
const POISON_CWD = "/seed/poison/real";
/** The project named by its line 2, which nothing may ever report. */
const POISON_IMPOSTOR_CWD = "/seed/poison/impostor";
/** The project named by the poisoned SIDECAR's line 2. Also unreportable. */
const SIDECAR_POISON_CWD = "/seed/poison/sidecar";

const SPARSE_DIR_INDEX = 901;
const SPARSE_CWD = "/seed/sparse/work";
/**
 * Eight gibibytes of hole.
 *
 * Above Bun's 4 GiB Buffer ceiling on purpose: `Buffer.allocUnsafe(size)` for a
 * file this big throws `RangeError` outright rather than reserving eight
 * gigabytes, so a reader that sizes its buffer to the file fails instantly and
 * safely instead of taking the machine down with it.
 */
const SPARSE_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const BUN_MAX_BUFFER_BYTES = 4 * 1024 * 1024 * 1024;

const HEADER_PAGE_BYTES = 4096;
const MAX_LIMIT = 500;

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before anything is appended. The agent
 * directory therefore lives directly under /tmp with a short name.
 */
const cleanup: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

const children: Bun.Subprocess[] = [];

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value as T;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

/** Claim a free loopback port: the CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/**
 * The slug the draht binary would build for a cwd.
 *
 * Reimplemented here from `coding-agent/src/core/session-manager.ts`'s
 * `getDefaultSessionDirPath` so the fixture puts files exactly where the binary
 * would — including the collision, which is a property of THIS function and is
 * the reason project identity may not be read back out of a directory name.
 */
function slugFor(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

interface SeededSession {
	id: string;
	cwd: string;
	path: string;
	/** Creation index. Also the sort position: index 0 is the newest file. */
	order: number;
}

const seeded: SeededSession[] = [];
/** The session whose line 2 is a second, later session header. */
let poisoned: SeededSession;
/** The id line 2 of that file carries. It names no session and must never appear. */
let poisonImpostorId: string;
/** The checkpoint sidecar whose line 2 is a well-formed session header. */
let poisonedSidecarPath: string;
/** The id THAT line carries. A header scanner reports it; a line-1 reader cannot. */
let sidecarPoisonId: string;
/** The 8 GiB sparse session. */
let sparse: SeededSession;
let agentDir: string;
let sessionsDir: string;
let home: string;
let httpBase: string;
let daemonStderr: { text: string };
/** Set to the mtime the touch test's new file gets, so it sorts first. */
let mtimeBase: number;

interface Counters {
	directoriesScanned: number;
	directoriesRead: number;
	filesSeen: number;
	fileStats: number;
	directoryStats: number;
	headerReads: number;
	bytesRead: number;
	maxFileBytesRead: number;
	headersParsed: number;
	nonSessionFiles: number;
}

interface HistoryBody {
	type: string;
	total: number;
	nextCursor: string | null;
	sessions: { id: string; cwd: string; startedAt: string; path: string }[];
	counters: Counters;
}

async function historyResponse(query = "", headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) {
	return fetch(`${httpBase}/history${query}`, { headers });
}

async function history(query = ""): Promise<HistoryBody> {
	const response = await historyResponse(query);
	if (response.status !== 200) throw new Error(`GET /history${query} -> ${response.status} ${await response.text()}`);
	return (await response.json()) as HistoryBody;
}

/** One session JSONL: an immutable header line, then body lines that are never read. */
function writeSession(
	dir: string,
	cwd: string,
	order: number,
	options: { big?: boolean; parent?: boolean; poison?: boolean; sparse?: boolean } = {},
): void {
	const id = randomUUID();
	const stamp = new Date(Date.UTC(2026, 0, 1) + order * 1000).toISOString();
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		timestamp: stamp,
		cwd,
	};
	// 109 of the 1,854 real files carry this. It must not change how a row reads.
	if (options.parent) header.parentSession = randomUUID();

	const lines = [JSON.stringify(header)];

	// THE POISON. A second, LATER, entirely well-formed session header, naming a
	// different id and a different project, one line below the real one. It is
	// not corruption a reader has to survive — it is bait: nothing that reports
	// only line 1 can see it, and anything that lets a later record win, or that
	// harvests every session record in the file, answers with the impostor.
	if (options.poison) {
		poisonImpostorId = randomUUID();
		lines.push(
			JSON.stringify({
				type: "session",
				version: 3,
				id: poisonImpostorId,
				timestamp: new Date(Date.UTC(2027, 0, 1)).toISOString(),
				cwd: POISON_IMPOSTOR_CWD,
			}),
		);
	}

	if (options.big) {
		// One enormous body line. A reader that takes a second page pays for it,
		// and a reader that scans for a header past line 1 pays a lot more.
		lines.push(JSON.stringify({ type: "message", role: "assistant", content: "x".repeat(BIG_FILE_BYTES) }));
	} else {
		lines.push(JSON.stringify({ type: "message", role: "user", content: `prompt ${order}` }));
		lines.push(JSON.stringify({ type: "message", role: "assistant", content: `reply ${order}` }));
	}

	const path = join(dir, `${stamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);

	// THE HOLE. `truncate(2)` past the end of a file allocates nothing: the
	// result claims eight gibibytes and occupies one page. A reader that never
	// looks past line 1 cannot tell this file from any other; a reader that sizes
	// itself to the file, or walks it to EOF, meets eight gigabytes it has to
	// account for.
	if (options.sparse) truncateSync(path, SPARSE_FILE_BYTES);

	const session: SeededSession = { id, cwd, path, order };
	seeded.push(session);
	if (options.poison) poisoned = session;
	if (options.sparse) sparse = session;
}

/**
 * A checkpoint sidecar.
 *
 * `<session>.jsonl.checkpoints.jsonl` — it ends in `.jsonl`, it lives beside the
 * sessions, and its first line is a checkpoint record. There is no session
 * header anywhere in it. This is the file that makes a suffix filter wrong.
 */
function writeSidecar(sessionPath: string, options: { poison?: boolean } = {}): void {
	const lines = [
		JSON.stringify({ type: "checkpoint", version: 1, sha: randomUUID(), timestamp: new Date().toISOString() }),
	];

	// THE SHARPEST OF THE THREE. One sidecar gets a well-formed session header on
	// line 2. The kernel's own `readSessionHeader` scans up to 1 MB for the FIRST
	// line that parses as a header — so a faithful port of it walks past this
	// file's checkpoint record, finds this line, and enumerates a checkpoint
	// sidecar as the 1,855th session of a project that does not exist. The rule
	// this surface actually holds — line 1 or nothing — rejects the file.
	if (options.poison) {
		sidecarPoisonId = randomUUID();
		lines.push(
			JSON.stringify({
				type: "session",
				version: 3,
				id: sidecarPoisonId,
				timestamp: new Date(Date.UTC(2027, 0, 2)).toISOString(),
				cwd: SIDECAR_POISON_CWD,
			}),
		);
	}

	const path = `${sessionPath}.checkpoints.jsonl`;
	writeFileSync(path, `${lines.join("\n")}\n`);
	if (options.poison) poisonedSidecarPath = path;
}

/** Give every seeded file a distinct mtime so the newest-first order is total. */
function stampMtimes(): void {
	mtimeBase = Math.floor(Date.now() / 1000);
	for (const session of seeded) {
		const when = mtimeBase - session.order;
		utimesSync(session.path, when, when);
	}
}

function seedCorpus(): void {
	// Directory 0 is the collision: two genuinely different projects whose cwds
	// slugify to one directory name, exactly as the real binary would file them.
	const collideDir = join(sessionsDir, slugFor(COLLIDING_A));
	expect(slugFor(COLLIDING_A)).toBe(slugFor(COLLIDING_B));
	mkdirSync(collideDir, { recursive: true });

	let order = 0;
	for (let i = 0; i < COLLIDING_A_FILES; i++) writeSession(collideDir, COLLIDING_A, order++);
	for (let i = 0; i < COLLIDING_B_FILES; i++) writeSession(collideDir, COLLIDING_B, order++);

	const remainingFiles = SESSION_FILES - (COLLIDING_A_FILES + COLLIDING_B_FILES);
	const remainingDirs = NON_EMPTY_DIRS - 1;
	// Every remaining non-empty directory gets one file; the surplus gives a
	// second one to the first `doubled` of them, so the store is not uniform.
	const doubled = remainingFiles - remainingDirs;
	const bigAt = new Set<number>();
	for (let i = 0; i < BIG_FILE_COUNT; i++) bigAt.add(Math.floor((remainingDirs / BIG_FILE_COUNT) * i));

	// Both special files land on directories past `doubled`, so each holds exactly
	// one session and neither is one of the four `big` ones. Nothing about the
	// corpus's shape changes: still 1,051 directories, still 1,849 files.
	expect(POISON_DIR_INDEX).toBeGreaterThanOrEqual(doubled);
	expect(SPARSE_DIR_INDEX).toBeGreaterThanOrEqual(doubled);
	expect(bigAt.has(POISON_DIR_INDEX)).toBe(false);
	expect(bigAt.has(SPARSE_DIR_INDEX)).toBe(false);

	const sessionDirs: string[] = [collideDir];
	for (let d = 0; d < remainingDirs; d++) {
		const cwd = d === POISON_DIR_INDEX ? POISON_CWD : d === SPARSE_DIR_INDEX ? SPARSE_CWD : `/seed/project-${d}/work`;
		const dir = join(sessionsDir, slugFor(cwd));
		mkdirSync(dir, { recursive: true });
		sessionDirs.push(dir);
		writeSession(dir, cwd, order++, {
			big: bigAt.has(d),
			parent: d % 17 === 0,
			poison: d === POISON_DIR_INDEX,
			sparse: d === SPARSE_DIR_INDEX,
		});
		if (d < doubled) writeSession(dir, cwd, order++, { parent: d % 23 === 0 });
	}

	// The 634 empty slug directories. They exist on the real store (a project
	// opened and never used) and a directory-mtime cache must skip them without
	// ever listing them.
	for (let d = 0; d < SLUG_DIRS - NON_EMPTY_DIRS; d++) {
		mkdirSync(join(sessionsDir, slugFor(`/seed/empty-${d}/work`)), { recursive: true });
	}

	// Ten sidecars, spread over ten different directories. One of them is poisoned.
	for (let i = 0; i < SIDECARS; i++) {
		const host = sessionDirs[i + 1];
		const victim = seeded.find((s) => dirname(s.path) === host);
		if (victim === undefined) throw new Error(`no session to attach a sidecar to in ${host}`);
		writeSidecar(victim.path, { poison: i === 0 });
	}

	stampMtimes();
}

/** Everything on disk that a suffix filter would call a session. */
function walkJsonl(root: string): { files: string[]; bytes: number } {
	const files: string[] = [];
	let bytes = 0;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			files.push(path);
			bytes += statSync(path).size;
		}
	}
	return { files, bytes };
}

let onDisk: { files: string[]; bytes: number };
let cold: HistoryBody;
let coldMs: number;
let warm: HistoryBody;

beforeAll(async () => {
	agentDir = tempDir("gh-");
	home = tempDir("ghh-");
	sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	seedCorpus();
	onDisk = walkJsonl(sessionsDir);

	const port = freeLoopbackPort();
	daemonStderr = { text: "" };
	// `DRAHT_PERMISSION_MODE` is unset deliberately: this shell exports it and it
	// has silently invalidated probes in this repo before.
	const { DRAHT_PERMISSION_MODE: _permissionMode, ...inherited } = process.env;
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: { ...inherited, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(daemon);
	collect(daemon.stderr as ReadableStream<Uint8Array>, daemonStderr);
	await until(() => daemonStderr.text.includes("draht-gateway listening"), "the daemon to report a bound port");

	httpBase = `http://127.0.0.1:${port}`;

	// The FIRST enumeration this daemon ever performs. Measured here, once,
	// because there is exactly one cold scan per process and a test that ran
	// second would be measuring a warm one.
	const started = Bun.nanoseconds();
	cold = await history("?limit=1");
	coldMs = (Bun.nanoseconds() - started) / 1e6;
	warm = await history("?limit=1");
}, 300_000);

afterAll(() => {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("the fixture is the corpus it claims to be", () => {
	test("1,686 slug directories, 1,864 files ending .jsonl, and real megabytes on disk", () => {
		expect(readdirSync(sessionsDir).length).toBe(SLUG_DIRS);
		expect(onDisk.files.length).toBe(NAIVE_FILE_COUNT);
		expect(onDisk.bytes).toBeGreaterThan(BIG_FILE_COUNT * BIG_FILE_BYTES);
	});

	test("two different projects really do share one slug directory", () => {
		const a = seeded.filter((s) => s.cwd === COLLIDING_A);
		const b = seeded.filter((s) => s.cwd === COLLIDING_B);
		expect(a).toHaveLength(COLLIDING_A_FILES);
		expect(b).toHaveLength(COLLIDING_B_FILES);
		expect(new Set([...a, ...b].map((s) => dirname(s.path))).size).toBe(1);
	});

	test("one session's line 2 is a second, later, well-formed session header", () => {
		const [first, second] = readFileSync(poisoned.path, "utf8").split("\n");
		const header = JSON.parse(first as string);
		const bait = JSON.parse(second as string);

		expect(header).toMatchObject({ type: "session", id: poisoned.id, cwd: POISON_CWD });
		// Not malformed, not truncated, not a near-miss: by every rule that
		// accepts line 1, line 2 is a session header too.
		expect(bait).toMatchObject({ type: "session", id: poisonImpostorId, cwd: POISON_IMPOSTOR_CWD });
		expect(bait.id).not.toBe(header.id);
		expect(new Date(bait.timestamp).getTime()).toBeGreaterThan(new Date(header.timestamp).getTime());
	});

	test("one checkpoint sidecar's line 2 is a session header, and its line 1 is not", () => {
		const [first, second] = readFileSync(poisonedSidecarPath, "utf8").split("\n");

		expect(poisonedSidecarPath.endsWith(".checkpoints.jsonl")).toBe(true);
		expect(JSON.parse(first as string).type).toBe("checkpoint");
		expect(JSON.parse(second as string)).toMatchObject({
			type: "session",
			id: sidecarPoisonId,
			cwd: SIDECAR_POISON_CWD,
		});
	});

	test("one session claims 8 GiB and occupies one page of real disk", () => {
		const stats = statSync(sparse.path);
		expect(stats.size).toBe(SPARSE_FILE_BYTES);
		// Sparse: the apparent size is the trap, the allocated size is the price.
		expect(stats.blocks * 512).toBeLessThan(64 * 1024);
		// And the trap is set above the ceiling that makes it instant rather than
		// ruinous — see SPARSE_FILE_BYTES.
		expect(SPARSE_FILE_BYTES).toBeGreaterThan(BUN_MAX_BUFFER_BYTES);
	});
});

describe("GET /history (R35-ALWAYS.6)", () => {
	test("is behind the bearer auth the daemon already enforces", async () => {
		expect((await historyResponse("", {})).status).toBe(401);
		expect((await historyResponse("", { Authorization: "Bearer wrong" })).status).toBe(401);
	});

	test("counts 1,854 sessions, not the 1,864 files that end in .jsonl", () => {
		// The whole trap in one assertion: ten of the files on disk are
		// `*.jsonl.checkpoints.jsonl` sidecars with no session header, and the
		// only thing that tells them apart from a session is line 1.
		expect(onDisk.files.length).toBe(1864);
		expect(cold.total).toBe(SESSION_FILES);
		expect(cold.counters.filesSeen).toBe(NAIVE_FILE_COUNT);
		expect(cold.counters.headersParsed).toBe(SESSION_FILES);
		expect(cold.counters.nonSessionFiles).toBe(SIDECARS);
	});

	test("no sidecar is ever reported as a session", async () => {
		const all = await drainAll("");
		expect(all.some((row) => row.path.endsWith(".checkpoints.jsonl"))).toBe(false);
	});

	test("carries raw history rows only — the merge with the live fleet is owned elsewhere", async () => {
		const page = await history("?limit=3");
		expect(page.sessions.length).toBe(3);
		for (const row of page.sessions) {
			expect(Object.keys(row).sort()).toEqual(["cwd", "id", "path", "startedAt"]);
		}
	});
});

describe("the per-file budget: ≤1 open, ≤4,096 bytes, ≤2 stats (R35-ALWAYS.6)", () => {
	test("the cold scan opens each file at most once and reads at most one 4 KB page from it", () => {
		expect(cold.counters.filesSeen).toBe(NAIVE_FILE_COUNT);
		expect(cold.counters.headerReads).toBeLessThanOrEqual(cold.counters.filesSeen);
		expect(cold.counters.fileStats).toBeLessThanOrEqual(2 * cold.counters.filesSeen);
		expect(cold.counters.maxFileBytesRead).toBeLessThanOrEqual(HEADER_PAGE_BYTES);
		expect(cold.counters.bytesRead).toBeLessThanOrEqual(HEADER_PAGE_BYTES * cold.counters.headerReads);
	});

	test("a multi-megabyte session costs exactly one page, and the whole store costs under a megabyte", () => {
		// A full page was read from something — the 2 MB files — so the ceiling is
		// being touched rather than merely not reached by small files.
		expect(cold.counters.maxFileBytesRead).toBe(HEADER_PAGE_BYTES);
		// Eight gibibytes on paper; under 1 MB read. Note what this pair of numbers
		// is and is not: `bytesRead` is the reader's own account of itself, and a
		// reader that moved all eight gibibytes while reporting `min(n, 4096)`
		// satisfies it. What forbids that is the corpus, three describes below.
		expect(onDisk.bytes).toBeGreaterThan(SPARSE_FILE_BYTES);
		expect(cold.counters.bytesRead).toBeLessThan(1024 * 1024);
	});

	test("a re-enumeration re-reads nothing at all", () => {
		expect(warm.total).toBe(SESSION_FILES);
		expect(warm.counters.directoriesRead).toBe(0);
		expect(warm.counters.headerReads).toBe(0);
		expect(warm.counters.bytesRead).toBe(0);
		// Still walked, though: a store that were skipped wholesale could not
		// notice a new project directory appearing.
		expect(warm.counters.directoriesScanned).toBe(SLUG_DIRS);
		expect(warm.counters.filesSeen).toBe(NAIVE_FILE_COUNT);
	});

	test("the cold scan listed every directory, including the 634 empty ones", () => {
		expect(cold.counters.directoriesScanned).toBe(SLUG_DIRS);
		expect(cold.counters.directoriesRead).toBe(SLUG_DIRS);
	});

	test("wall clock, as a smoke alarm only: cold ≤ 2 s, warm ≤ 250 ms, one page ≤ 50 ms", async () => {
		expect(coldMs).toBeLessThanOrEqual(2000);
		expect(await bestOf(5, () => history("?limit=1"))).toBeLessThanOrEqual(250);
		expect(await bestOf(5, () => history(`?limit=${MAX_LIMIT}`))).toBeLessThanOrEqual(50);
	});
});

describe("project identity comes from the header cwd, never from the slug", () => {
	test("two projects sharing one slug directory are not merged", async () => {
		const a = await history(`?project=${encodeURIComponent(COLLIDING_A)}`);
		const b = await history(`?project=${encodeURIComponent(COLLIDING_B)}`);

		expect(a.total).toBe(COLLIDING_A_FILES);
		expect(b.total).toBe(COLLIDING_B_FILES);
		expect(a.sessions.every((row) => row.cwd === COLLIDING_A)).toBe(true);
		expect(b.sessions.every((row) => row.cwd === COLLIDING_B)).toBe(true);

		// And they really were in one directory, so this could only have been got
		// right by reading each header.
		const dirs = new Set([...a.sessions, ...b.sessions].map((row) => dirname(row.path)));
		expect(dirs.size).toBe(1);
		expect(a.total + b.total).toBe(COLLIDING_A_FILES + COLLIDING_B_FILES);
	});

	test("an ordinary project filter returns exactly that project's sessions", async () => {
		const cwd = "/seed/project-7/work";
		const expected = seeded.filter((s) => s.cwd === cwd);
		expect(expected.length).toBeGreaterThan(0);

		const page = await history(`?project=${encodeURIComponent(cwd)}`);
		expect(page.total).toBe(expected.length);
		expect(page.sessions.map((row) => row.id).sort()).toEqual(expected.map((s) => s.id).sort());
	});

	test("a relative project is refused rather than resolved against the daemon's cwd", async () => {
		expect((await historyResponse("?project=work")).status).toBe(400);
	});

	test("an unknown project is an empty list, not an error", async () => {
		const page = await history("?project=/seed/nothing/here");
		expect(page.total).toBe(0);
		expect(page.sessions).toEqual([]);
	});
});

describe("paging", () => {
	test("walks the whole store exactly once, newest file first", async () => {
		const rows = await drainAll("?limit=250");
		expect(rows).toHaveLength(SESSION_FILES);
		expect(new Set(rows.map((row) => row.id)).size).toBe(SESSION_FILES);

		// The fixture stamped a distinct mtime per file, newest first in creation
		// order, so the expected order is total and independent of the reader.
		const expected = [...seeded].sort((l, r) => l.order - r.order).map((s) => s.id);
		expect(rows.map((row) => row.id)).toEqual(expected);
	});

	test("pages do not overlap or skip when the page size does not divide the total", async () => {
		const rows = await drainAll("?limit=97");
		expect(rows).toHaveLength(SESSION_FILES);
		expect(new Set(rows.map((row) => row.id)).size).toBe(SESSION_FILES);
	});

	test("a filtered walk pages the same way", async () => {
		const rows = await drainAll(`?limit=2&project=${encodeURIComponent(COLLIDING_A)}`);
		expect(rows).toHaveLength(COLLIDING_A_FILES);
		expect(rows.every((row) => row.cwd === COLLIDING_A)).toBe(true);
	});

	test("limit is clamped, and a nonsense limit or cursor is refused", async () => {
		const page = await history("?limit=100000");
		expect(page.sessions).toHaveLength(MAX_LIMIT);
		expect(page.total).toBe(SESSION_FILES);
		expect((await historyResponse("?limit=0")).status).toBe(400);
		expect((await historyResponse("?limit=nope")).status).toBe(400);
		expect((await historyResponse("?cursor=not-a-cursor")).status).toBe(400);
	});

	test("the last page carries no cursor", async () => {
		let page = await history(`?limit=${MAX_LIMIT}&project=${encodeURIComponent(COLLIDING_B)}`);
		expect(page.nextCursor).toBeNull();
		page = await history("?limit=1");
		expect(page.nextCursor).not.toBeNull();
	});
});

/**
 * The half of R35-ALWAYS.6's acceptance that does not take the code's word for it.
 *
 * Every assertion in the budget block above reads a number the enumerator
 * computed about itself. Every assertion here reads the ANSWER — which rows came
 * back, and under which project — against bytes the fixture wrote and the
 * enumerator cannot edit. A reader that reports `min(bytesRead, 4096)` while
 * moving the whole file passes the block above and dies here.
 */
describe("no history file is read past its first line — proved by the corpus, not the counters", () => {
	test("the poisoned session is reported as line 1 says, and line 2's session exists nowhere", async () => {
		const real = await history(`?project=${encodeURIComponent(POISON_CWD)}`);
		expect(real.total).toBe(1);
		expect(real.sessions[0]?.id).toBe(poisoned.id);
		expect(real.sessions[0]?.path).toBe(poisoned.path);

		// Line 2 names a project of its own. No counter takes part in this answer:
		// either those bytes reached the index or they did not.
		const impostor = await history(`?project=${encodeURIComponent(POISON_IMPOSTOR_CWD)}`);
		expect(impostor.total).toBe(0);
		expect(impostor.sessions).toEqual([]);

		const all = await drainAll("?limit=500");
		expect(all.some((row) => row.id === poisonImpostorId)).toBe(false);
	});

	test("the poisoned sidecar is still not a session, though its line 2 says otherwise", async () => {
		// A reader that scans for the first parsable header — which is what the
		// kernel's own reader does — finds line 2 here and reports 1,855.
		expect(cold.total).toBe(SESSION_FILES);
		expect(cold.counters.nonSessionFiles).toBe(SIDECARS);

		const ghost = await history(`?project=${encodeURIComponent(SIDECAR_POISON_CWD)}`);
		expect(ghost.total).toBe(0);

		const all = await drainAll("?limit=500");
		expect(all.some((row) => row.id === sidecarPoisonId)).toBe(false);
		expect(all.some((row) => row.path === poisonedSidecarPath)).toBe(false);
	});

	test("the 8 GiB session enumerates like any other, which no whole-file reader can manage", async () => {
		const page = await history(`?project=${encodeURIComponent(SPARSE_CWD)}`);
		expect(page.total).toBe(1);
		expect(page.sessions[0]?.id).toBe(sparse.id);
		expect(page.sessions[0]?.path).toBe(sparse.path);

		// It is in the corpus the cold scan already walked, and that scan parsed
		// every session header there is. A reader that sized a buffer to this file
		// threw; one that walked it to EOF is still walking.
		expect(onDisk.files).toContain(sparse.path);
		expect(cold.counters.headersParsed).toBe(SESSION_FILES);
	});
});

/**
 * Deliberately LAST in the file: it adds a session to the store, so every count
 * asserted above would move under it.
 */
describe("invalidation", () => {
	test("touching one directory re-reads that directory and nothing else", async () => {
		// Warm the caches, so what follows is measured against a settled index.
		const before = await history("?limit=1");
		expect(before.counters.directoriesRead).toBe(0);
		expect(before.counters.headerReads).toBe(0);

		const cwd = "/seed/project-11/work";
		const dir = join(sessionsDir, slugFor(cwd));
		const id = randomUUID();
		const path = join(dir, `2026-08-22T00-00-00-000Z_${id}.jsonl`);
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
		);
		// Newer than every seeded file, so it must sort to the very front.
		utimesSync(path, mtimeBase + 60, mtimeBase + 60);

		const after = await history("?limit=1");
		expect(after.counters.directoriesRead).toBe(1);
		expect(after.counters.headerReads).toBe(1);
		expect(after.counters.bytesRead).toBeLessThanOrEqual(HEADER_PAGE_BYTES);
		expect(after.total).toBe(SESSION_FILES + 1);
		expect(after.sessions[0]?.id).toBe(id);

		// And the directory settles again: no second read for the same change.
		const settled = await history("?limit=1");
		expect(settled.counters.directoriesRead).toBe(0);
		expect(settled.counters.headerReads).toBe(0);
		expect(settled.total).toBe(SESSION_FILES + 1);
	});
});

/** Every row `query` matches, walked one page at a time through the cursor. */
async function drainAll(query: string): Promise<HistoryBody["sessions"]> {
	const rows: HistoryBody["sessions"] = [];
	const separator = query.startsWith("?") ? "&" : "?";
	let cursor: string | null = null;
	for (let guard = 0; guard < 200; guard++) {
		const page: HistoryBody = await history(
			cursor === null ? query : `${query}${separator}cursor=${encodeURIComponent(cursor)}`,
		);
		rows.push(...page.sessions);
		cursor = page.nextCursor;
		if (cursor === null) return rows;
	}
	throw new Error(`paging did not terminate for ${query}`);
}

/**
 * The fastest of `attempts` runs, in milliseconds.
 *
 * Best-of rather than a single shot on purpose: these ceilings are a smoke
 * alarm for an accidental whole-file read, and this suite runs beside four other
 * agents on one laptop. A single sample measures the machine's mood; the
 * minimum measures the code.
 */
async function bestOf(attempts: number, run: () => Promise<unknown>): Promise<number> {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < attempts; i++) {
		const started = Bun.nanoseconds();
		await run();
		best = Math.min(best, (Bun.nanoseconds() - started) / 1e6);
	}
	return best;
}
