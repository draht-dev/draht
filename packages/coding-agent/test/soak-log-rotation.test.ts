/**
 * R35-ALWAYS.11 (writer half) — the rotating soak JSONL keeps every record it is
 * handed, across concurrent processes, across rotation, and across a torn tail.
 *
 * EVIDENCE CLASS 2 BY DESIGN, and recorded as such so it is not mistaken for a
 * gap: this file proves the WRITER'S GUARANTEES. The Class-3 half — the emitted
 * binary actually recording at the nine instrumented seams — belongs to the task
 * that owns those hook sites (T9), and nothing here can stand in for it. Until
 * T9 lands, no shipped code path calls this writer at all.
 *
 * The guarantees under test are the ones that were MEASURED to fail under a
 * naive implementation, not the ones that are easy to assert:
 *
 *  1. CONCURRENT APPEND. Eight separate PROCESSES — not eight promises in one
 *     process, which would prove nothing about O_APPEND — write 1,500 records
 *     each. All 12,000 must be readable, with correct per-writer counts and no
 *     duplicated sequence number. In-process concurrency would pass against a
 *     writer that held one fd and serialized on it, which is exactly the design
 *     the fd gauge forbids.
 *
 *  2. ROTATION UNDER THAT SAME CONCURRENCY. A two-slot `rename(f, f.1)` scheme
 *     under 8 writers lost 11,148 of 12,000 records when measured. The
 *     lock-guarded, inode-re-checked, unique-generation scheme lost zero. So the
 *     assertion is not "rotation happened" but "rotation happened MANY TIMES and
 *     the count is still 12,000, and every generation name is distinct and still
 *     on disk" — a name that repeats is a generation that was clobbered.
 *
 *  3. TORN TAIL. The writer deliberately does not fsync (4.0–4.7 ms per record
 *     under Node against 0.017–0.025 ms under Bun, on seams that fire per attach
 *     and per prompt). The price is an unterminated final line after a hard cut,
 *     and the reader must pay it by dropping one line, never the file.
 *
 *  4. RETENTION FLOOR BEATS THE BYTE CAP. A byte-only cap sized for a quiet week
 *     silently rotates away the first days of a busy one, and a multi-week soak
 *     verdict would destroy its own evidence. The floor must refuse a prune the
 *     byte cap is asking for.
 *
 *  5. THE STALE-LOCK REAP, BOTH WAYS. A session SIGKILLed mid-rotation leaves
 *     `session.rotate.lock` behind with no owner. A fresh lock must be respected
 *     (another writer may be rotating right now); the same lock aged past the
 *     stale window must be reaped. Without the reap, rotation wedges FOREVER —
 *     and since pruning only runs inside a rotation, the byte cap stops applying
 *     and the active file grows unbounded for the rest of the soak.
 *
 *  6. THE FD GAUGE MOVES. "Greater than 2" cannot tell the gauge from a
 *     constant, and a no-leak verdict read off a constant is worse than no
 *     verdict. Descriptors are opened, the gauge sampled, closed, sampled again,
 *     and the DIRECTION of the change asserted — in the log, not just in memory.
 *
 *  7. THE CONTRACT'S FIELDS CANNOT BE SHADOWED. `record()` promises a new event
 *     or field needs no edit to soak-log.ts, so a call site may pass any name —
 *     including `pid`, which is entirely plausible at a socket seam. The
 *     writer's values must win, because a record carrying a caller's `pid` or
 *     `wall` is one the reader drops as malformed.
 *
 *  8. SILENCE. The children's stdout and stderr must be byte-empty. The TUI owns
 *     the terminal, and a later task asserts a default-on session's streams are
 *     byte-identical to a feature-off run; one stray line from here breaks it and
 *     the failure would look like someone else's bug.
 *
 * HARNESS NOTES, each paid for by a probe that proved nothing:
 *  - soak dirs go DIRECTLY under /tmp with a short name (the sockets dir the
 *    gauges read lives beside them, and a Unix socket path over ~104 bytes fails
 *    to bind with EINVAL).
 *  - every child is spawned with DRAHT_PERMISSION_MODE deleted and a BUILT env,
 *    not an inherited one.
 *  - the child writer script is generated into the temp dir rather than committed,
 *    so this task adds no fourth file to its declared set.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fdGauge, listGenerationFiles, SOAK_EVENTS, SoakLog } from "../src/core/soak/soak-log.ts";
import { listSoakFiles, readSoakLog } from "../src/core/soak/soak-reader.ts";

const PKG_ROOT = path.resolve(__dirname, "..");
const SOAK_LOG_MODULE = path.join(PKG_ROOT, "src", "core", "soak", "soak-log.ts");

/** Short, directly under /tmp — see the harness note in the header. */
const ROOT = "/tmp/p35t5";

const WRITERS = 8;
const RECORDS_PER_WRITER = 1_500;
const TOTAL_RECORDS = WRITERS * RECORDS_PER_WRITER;

/** Padding that brings a probe record to roughly the ~210 bytes the real events weigh. */
const PAYLOAD = "x".repeat(96);

const CHILD_SOURCE = `
import { SoakLog } from ${JSON.stringify(SOAK_LOG_MODULE)};

const [dir, writer, count, maxFileBytes, maxTotalBytes, retentionFloorMs, payload] = process.argv.slice(2);

const log = new SoakLog({
	dir,
	maxFileBytes: Number(maxFileBytes),
	maxTotalBytes: Number(maxTotalBytes),
	retentionFloorMs: Number(retentionFloorMs),
	sessionId: "sess-" + writer,
});

for (let seq = 0; seq < Number(count); seq++) {
	log.record("probe", { writer, seq, payload });
}
`;

interface ChildResult {
	code: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

let childScript = "";

function freshDir(name: string): string {
	const dir = path.join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function runChild(args: string[]): Promise<ChildResult> {
	// A BUILT env, never an inherited one: this shell exports DRAHT_PERMISSION_MODE
	// and inherited env has silently invalidated probes in this repo before.
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? ROOT,
		NODE_ENV: "test",
	};
	const options: SpawnOptions = { cwd: PKG_ROOT, env, stdio: ["ignore", "pipe", "pipe"] };
	return new Promise((resolve, reject) => {
		const child = spawn("bun", [childScript, ...args], options);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
		});
	});
}

/** Starts all writers at once — serialized writers would prove nothing about concurrent append. */
async function runWriters(dir: string, maxFileBytes: number, maxTotalBytes: number, floorMs: number) {
	const pending: Promise<ChildResult>[] = [];
	for (let writer = 0; writer < WRITERS; writer++) {
		pending.push(
			runChild([
				dir,
				String(writer),
				String(RECORDS_PER_WRITER),
				String(maxFileBytes),
				String(maxTotalBytes),
				String(floorMs),
				PAYLOAD,
			]),
		);
	}
	return Promise.all(pending);
}

function totalBytes(dir: string): number {
	let bytes = 0;
	for (const file of listSoakFiles(dir)) {
		try {
			bytes += statSync(file).size;
		} catch {
			/* pruned underneath us */
		}
	}
	return bytes;
}

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true, mode: 0o700 });
	childScript = path.join(ROOT, "writer.ts");
	writeFileSync(childScript, CHILD_SOURCE, { mode: 0o600 });
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("soak log: concurrent append across processes", () => {
	const dir = path.join(ROOT, "append");
	let results: ChildResult[] = [];

	beforeAll(async () => {
		freshDir("append");
		// A cap far above the volume these writers produce: this case isolates
		// concurrent append from rotation, which the next describe drives hard.
		results = await runWriters(dir, 1024 * 1024 * 1024, 1024 * 1024 * 1024, 0);
	}, 120_000);

	test("every child exits clean with byte-empty stdout AND stderr", () => {
		for (const result of results) {
			expect(result.code).toBe(0);
			// Byte-empty, not "no warnings": the TUI owns the terminal.
			expect(result.stdout.length).toBe(0);
			expect(result.stderr.length).toBe(0);
		}
	});

	test("all 12,000 records survive, with zero unparsable lines", () => {
		const read = readSoakLog({ dir });
		expect(read.malformed).toEqual([]);
		expect(read.torn).toEqual([]);
		const probes = read.records.filter((record) => record.event === "probe");
		expect(probes.length).toBe(TOTAL_RECORDS);
	});

	test("per-writer counts are exact and no sequence number is duplicated", () => {
		const read = readSoakLog({ dir, events: ["probe"] });
		const perWriter = new Map<string, number>();
		const seen = new Set<string>();
		for (const record of read.records) {
			const writer = String(record.writer);
			perWriter.set(writer, (perWriter.get(writer) ?? 0) + 1);
			seen.add(`${writer}:${String(record.seq)}`);
			expect(record.sessionId).toBe(`sess-${writer}`);
		}
		expect(perWriter.size).toBe(WRITERS);
		for (let writer = 0; writer < WRITERS; writer++) {
			expect(perWriter.get(String(writer))).toBe(RECORDS_PER_WRITER);
		}
		expect(seen.size).toBe(TOTAL_RECORDS);
	});

	test("every record carries the contract's mandatory fields", () => {
		const read = readSoakLog({ dir, events: ["probe"] });
		for (const record of read.records.slice(0, 200)) {
			expect(record.level).toBe("info");
			expect(typeof record.timestamp).toBe("string");
			expect(record.v).toBe(1);
			expect(typeof record.wall).toBe("number");
			expect(typeof record.mono).toBe("number");
			expect(typeof record.uptimeMs).toBe("number");
			expect(typeof record.pid).toBe("number");
			// R39-RESIL.6 needs RSS and a startup delta; edge events alone cannot
			// answer "did memory grow over seven days".
			expect(typeof record.rss).toBe("number");
			expect(record.rss as number).toBeGreaterThan(0);
		}
	});

	test("the log's files are 0600 — it retains session ids and cwds for weeks", () => {
		// Files only. The DIRECTORY mode is not measurable here: freshDir() created
		// this path with mode 0700 before any writer ran, so #ensureDir()'s mkdir is
		// a no-op and its mode argument is never exercised. The directory half has
		// its own case below, on a path nothing but the writer creates.
		for (const file of listSoakFiles(dir)) {
			expect(statSync(file).mode & 0o777).toBe(0o600);
		}
	});
});

describe("soak log: the writer's own mkdir is 0700", () => {
	const parent = path.join(ROOT, "mkmode");
	const dir = path.join(parent, "soak");

	beforeAll(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	test("a directory only the writer creates comes out 0700, parents included", () => {
		// The whole point of the case: nothing has created this path, so
		// #ensureDir()'s mkdir is the ONLY thing that can set its mode. Asserting on
		// a directory the harness itself made with mode 0700 measures the harness.
		expect(existsSync(dir)).toBe(false);

		const log = new SoakLog({ dir, sessionId: "mkmode" });
		log.record("probe", { seq: 0 });

		// 0700 and not 0755: this log retains session ids and cwd paths for weeks,
		// on a multi-user host, outside the session store's own protections.
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		// The recursive mkdir creates the parent on the way; a 0755 parent exposes
		// the file names, which carry pids and rotation stamps.
		expect(statSync(parent).mode & 0o777).toBe(0o700);
		const files = listSoakFiles(dir);
		expect(files.length).toBe(1);
		for (const file of files) {
			expect(statSync(file).mode & 0o777).toBe(0o600);
		}
	});
});

describe("soak log: a call site cannot shadow the contract's fields", () => {
	test("caller fields named like contract fields are overwritten, not honoured", () => {
		const dir = freshDir("shadow");
		const log = new SoakLog({ dir, sessionId: "real-session" });

		// `record()` promises a new event or field needs no edit to soak-log.ts, so
		// every call site is free to pick a field name — and `pid` is not a
		// hypothetical at the socket seam, where the `.lock` files already carry one.
		// Spread the wrong way round, this line is written with the CALLER's
		// event/wall/pid and readSoakLog then rejects it as malformed and drops it:
		// the seam that reported the event vanishes from the evidence instead of
		// failing loudly.
		log.record("client_attach", {
			pid: "not-a-pid",
			wall: null,
			event: "something_else",
			sessionId: "spoofed",
			level: "error",
			timestamp: "whenever",
			v: 99,
			mono: "no",
			uptimeMs: "no",
			rss: "no",
			// An unreserved field still arrives intact — the promise is kept.
			socketPath: "/tmp/s.sock",
		});

		const read = readSoakLog({ dir });
		expect(read.malformed).toEqual([]);
		expect(read.torn).toEqual([]);
		expect(read.records.length).toBe(1);

		const record = read.records[0];
		expect(record.event).toBe("client_attach");
		expect(record.pid).toBe(process.pid);
		expect(record.level).toBe("info");
		expect(record.v).toBe(1);
		expect(typeof record.wall).toBe("number");
		expect(typeof record.mono).toBe("number");
		expect(typeof record.uptimeMs).toBe("number");
		expect(typeof record.rss).toBe("number");
		expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(record.sessionId).toBe("real-session");
		expect(record.socketPath).toBe("/tmp/s.sock");
	});

	test("the heartbeat's measured gauges outrank a caller field of the same name", () => {
		const dir = freshDir("shadow-hb");
		const socketsDir = freshDir("shadow-hb-sockets");
		writeFileSync(path.join(socketsDir, "a.sock"), "");
		writeFileSync(path.join(socketsDir, "a.lock"), "");

		const log = new SoakLog({ dir, socketsDir, clientCount: () => 3 });
		log.heartbeat({ fdGauge: -7, sockCount: 999, lockCount: 999, clientCount: 999, note: "kept" });

		const records = readSoakLog({ dir, events: [SOAK_EVENTS.HEARTBEAT] }).records;
		expect(records.length).toBe(1);
		const hb = records[0];
		expect(hb.fdGauge as number).toBeGreaterThan(2);
		expect(hb.sockCount).toBe(1);
		expect(hb.lockCount).toBe(1);
		expect(hb.clientCount).toBe(3);
		expect(hb.note).toBe("kept");
	});

	test("a writer with no sessionId of its own keeps the caller's", () => {
		// The daemon half writes about sessions it does not belong to, so a caller
		// sessionId is honoured exactly when the writer has none to stamp.
		const dir = freshDir("shadow-daemon");
		const log = new SoakLog({ dir });
		log.record("client_attach", { sessionId: "sess-from-caller" });

		const records = readSoakLog({ dir }).records;
		expect(records.length).toBe(1);
		expect(records[0].sessionId).toBe("sess-from-caller");
	});
});

describe("soak log: the rotation lock is reaped when stale, and only then", () => {
	test("a fresh orphan lock blocks rotation; the same lock, aged, is reaped and rotation resumes", () => {
		const dir = freshDir("stale");
		const lockPath = path.join(dir, "session.rotate.lock");
		// Exactly what a session SIGKILLed mid-rotation leaves behind: a lock file
		// with no living owner. Nothing in the system removes it but this reap.
		writeFileSync(lockPath, "999999\nleft-by-a-dead-process\n", { mode: 0o600 });

		const log = new SoakLog({ dir, maxFileBytes: 200, retentionFloorMs: 0 });

		// DIRECTION 1 — fresh. The lock may belong to a writer that is rotating
		// right now, so it is respected: rotation declines and the lock is left
		// alone. A reap that ignores the stale window renames a file another
		// process is mid-rotation on.
		log.record("probe", { seq: 0, payload: PAYLOAD });
		expect(statSync(path.join(dir, "session.jsonl")).size).toBeGreaterThan(200);
		expect(listGenerationFiles(dir, "session")).toEqual([]);
		expect(existsSync(lockPath)).toBe(true);

		// Age it past LOCK_STALE_MS (30 s) — the only difference between the two
		// directions.
		const aged = (Date.now() - 120_000) / 1000;
		utimesSync(lockPath, aged, aged);

		// DIRECTION 2 — stale. Without the reap this wedges FOREVER: rotation never
		// runs again, and since #prune() only runs inside #rotate(), the byte cap
		// stops applying too and the active file grows unbounded for the whole soak.
		log.record("probe", { seq: 1, payload: PAYLOAD });
		expect(listGenerationFiles(dir, "session").length).toBe(1);
		// Reaped and then released, not reaped and then leaked.
		expect(existsSync(lockPath)).toBe(false);

		const read = readSoakLog({ dir });
		expect(read.malformed).toEqual([]);
		// Both records survived the wedge and the reap.
		expect(read.records.filter((record) => record.event === "probe").length).toBe(2);
		expect(read.records.filter((record) => record.event === SOAK_EVENTS.ROTATION).length).toBe(1);
	});
});

describe("soak log: rotation under that same concurrency", () => {
	const dir = path.join(ROOT, "rotate");
	let results: ChildResult[] = [];

	beforeAll(async () => {
		freshDir("rotate");
		// 256 KiB per generation against ~2.5 MB of records: rotation fires ten-ish
		// times, every one of them contended by eight processes.
		results = await runWriters(dir, 256 * 1024, 1024 * 1024 * 1024, 0);
	}, 120_000);

	test("rotation actually fired, repeatedly", () => {
		for (const result of results) expect(result.code).toBe(0);
		const generations = listGenerationFiles(dir, "session");
		expect(generations.length).toBeGreaterThanOrEqual(4);
	});

	test("rotation loses ZERO records", () => {
		const read = readSoakLog({ dir });
		expect(read.malformed).toEqual([]);
		const probes = read.records.filter((record) => record.event === "probe");
		expect(probes.length).toBe(TOTAL_RECORDS);
		const seen = new Set(probes.map((record) => `${String(record.writer)}:${String(record.seq)}`));
		expect(seen.size).toBe(TOTAL_RECORDS);
	});

	test("generation names are unique and every closed generation still exists", () => {
		const generations = listGenerationFiles(dir, "session");
		const names = generations.map((generation) => generation.name);
		expect(new Set(names).size).toBe(names.length);

		const rotations = readSoakLog({ dir, events: [SOAK_EVENTS.ROTATION] }).records;
		expect(rotations.length).toBe(generations.length);
		const rotatedTo = rotations.map((record) => String(record.rotatedTo));
		// A repeated target name is a clobbered generation — the naive two-slot
		// scheme's signature, and how it lost 11,148 of 12,000 records.
		expect(new Set(rotatedTo).size).toBe(rotatedTo.length);
		for (const name of rotatedTo) {
			expect(names).toContain(name);
		}
	});

	test("no rotation pruned anything: the byte cap was never reached", () => {
		for (const record of readSoakLog({ dir, events: [SOAK_EVENTS.ROTATION] }).records) {
			expect(record.pruned).toEqual([]);
		}
	});
});

describe("soak log: rotation refuses to close a generation it did not fill", () => {
	const dir = path.join(ROOT, "inode");

	beforeAll(() => {
		freshDir("inode");
	});

	test("a rotation that loses the race to another writer rotates NOTHING", () => {
		const active = path.join(dir, "session.jsonl");
		const marker = `{"event":"foreign","pad":"${"y".repeat(400)}"}\n`;
		let raced = false;

		const log = new SoakLog({
			dir,
			// Below one record, so every append is over the cap and the size guard
			// alone can never decline a rotation. What is left is the inode check.
			maxFileBytes: 200,
			retentionFloorMs: 0,
			// Stand in for another process that won the lock first: rename the file
			// this record landed in out of the way and leave a FRESH, already-oversized
			// active file in its place.
			onRotateWindow: () => {
				if (raced) return;
				raced = true;
				renameSync(active, path.join(dir, "session-20000101T000000000Z-1-0.jsonl"));
				writeFileSync(active, marker, { mode: 0o600 });
			},
		});

		log.record("probe", { seq: 0, payload: PAYLOAD });
		expect(raced).toBe(true);

		// The foreign writer's fresh file is untouched: still the active file, still
		// carrying its bytes. A rotator that skips the inode check renames it into a
		// generation and writes a rotation record about a file it never filled.
		expect(readFileSync(active, "utf8")).toBe(marker);
		expect(readSoakLog({ dir, events: [SOAK_EVENTS.ROTATION] }).records).toEqual([]);
		expect(listGenerationFiles(dir, "session").map((generation) => generation.name)).toEqual([
			"session-20000101T000000000Z-1-0.jsonl",
		]);
	});
});

describe("soak log: rotation is guarded by an exclusive lock", () => {
	const dir = path.join(ROOT, "lock");

	beforeAll(() => {
		freshDir("lock");
	});

	test("a second writer entering the window declines to rotate, and the lock is released after", () => {
		const lockPath = path.join(dir, "session.rotate.lock");
		let entered = false;
		let lockHeldInWindow: boolean | undefined;
		let generationsInWindow: number | undefined;

		const log = new SoakLog({
			dir,
			maxFileBytes: 200,
			retentionFloorMs: 0,
			onRotateWindow: () => {
				if (entered) return;
				entered = true;
				lockHeldInWindow = existsSync(lockPath);
				// A second writer whose own append is already over the cap. With the
				// lock it must decline; without it, it rotates inside our window.
				const other = new SoakLog({ dir, maxFileBytes: 200, retentionFloorMs: 0 });
				other.record("probe", { from: "other", payload: PAYLOAD });
				generationsInWindow = listGenerationFiles(dir, "session").length;
			},
		});

		log.record("probe", { from: "first", payload: PAYLOAD });

		// Captured, not asserted inside the hook: the writer swallows everything a
		// callback throws, so an assertion raised in there would vanish silently.
		expect(entered).toBe(true);
		expect(lockHeldInWindow).toBe(true);
		expect(generationsInWindow).toBe(0);
		// Released, not leaked — a leaked lock stops rotation forever until it ages
		// past the stale window.
		expect(existsSync(lockPath)).toBe(false);

		const read = readSoakLog({ dir, events: ["probe"] });
		expect(read.records.length).toBe(2);
		expect(read.malformed).toEqual([]);
	});
});

describe("soak log: the reader tolerates a torn tail", () => {
	const dir = path.join(ROOT, "torn");

	beforeAll(() => {
		freshDir("torn");
		const log = new SoakLog({ dir, sessionId: "torn-session" });
		for (let seq = 0; seq < 20; seq++) log.record("probe", { seq });
	});

	test("an unterminated final line costs one line, never the file", () => {
		const active = path.join(dir, "session.jsonl");
		// Exactly what a hard cut mid-append leaves behind: a truncated record with
		// no trailing newline.
		appendFileSync(active, '{"level":"info","timestamp":"2026-08-22T00:00:00.000Z","event":"pro');

		const read = readSoakLog({ dir });
		expect(read.records.length).toBe(20);
		expect(read.torn).toEqual([active]);
		expect(read.tornTails[active]).toContain('"event":"pro');
		expect(read.malformed).toEqual([]);
	});

	test("corruption in the MIDDLE is reported, not silently dropped and not thrown", () => {
		const active = path.join(dir, "session.jsonl");
		const raw = readFileSync(active, "utf8");
		const lines = raw.split("\n");
		lines.splice(5, 0, "{not json at all");
		writeFileSync(active, lines.join("\n"), { mode: 0o600 });

		const read = readSoakLog({ dir });
		expect(read.malformed.length).toBe(1);
		expect(read.malformed[0].raw).toBe("{not json at all");
		expect(read.records.length).toBe(20);
	});
});

describe("soak log: the retention floor beats the byte cap", () => {
	const dir = path.join(ROOT, "retain");

	beforeAll(() => {
		freshDir("retain");
	});

	test("a generation younger than the floor is NOT pruned even when the cap says prune", () => {
		const log = new SoakLog({
			dir,
			maxFileBytes: 2 * 1024,
			// A cap deliberately far below what this run writes, so every rotation
			// after the first is asking to prune.
			maxTotalBytes: 4 * 1024,
			retentionFloorMs: 14 * 24 * 60 * 60 * 1000,
		});
		for (let seq = 0; seq < 400; seq++) log.record("probe", { seq, payload: PAYLOAD });

		// FIRST, because it is the whole point of the floor: nothing written inside
		// the retention window was destroyed to satisfy the byte cap.
		const read = readSoakLog({ dir, events: ["probe"] });
		expect(read.records.length).toBe(400);
		expect(read.malformed).toEqual([]);

		// The floor was genuinely under pressure: the byte cap was exceeded, many
		// times over, and the floor is the only thing that held these generations.
		expect(totalBytes(dir)).toBeGreaterThan(4 * 1024);
		const rotations = readSoakLog({ dir, events: [SOAK_EVENTS.ROTATION] }).records;
		expect(rotations.length).toBeGreaterThanOrEqual(3);
		for (const record of rotations) {
			expect(record.pruned).toEqual([]);
		}
		const last = rotations[rotations.length - 1];
		expect(last.retainedByFloor as number).toBeGreaterThan(0);
	});

	test("with the floor lowered, the same byte cap does prune — and names what it pruned", () => {
		const before = listGenerationFiles(dir, "session").map((generation) => generation.name);
		expect(before.length).toBeGreaterThanOrEqual(3);

		const log = new SoakLog({
			dir,
			maxFileBytes: 2 * 1024,
			maxTotalBytes: 4 * 1024,
			retentionFloorMs: 0,
		});
		for (let seq = 0; seq < 200; seq++) log.record("probe", { seq, payload: PAYLOAD });

		const after = listGenerationFiles(dir, "session").map((generation) => generation.name);
		const gone = before.filter((name) => !after.includes(name));
		expect(gone.length).toBeGreaterThan(0);
		expect(totalBytes(dir)).toBeLessThan(16 * 1024);

		// The gap must be VISIBLE: a prune is never silent at the moment it happens —
		// the rotation record written into the surviving file names what it destroyed.
		//
		// HONEST LIMIT, and it is a property of the format rather than a weakness of
		// this assertion: under a cap this aggressive the record that names a prune
		// can itself be pruned later, so the surviving stream is not a complete
		// history of every prune that ever ran. What it does guarantee is that every
		// prune it still remembers is accurate, and that prunes are recorded at all.
		const named = new Set<string>();
		for (const record of readSoakLog({ dir, events: [SOAK_EVENTS.ROTATION] }).records) {
			for (const name of (record.pruned as string[] | undefined) ?? []) named.add(name);
		}
		expect(named.size).toBeGreaterThan(0);
		// Every generation the log says it pruned is genuinely gone from disk. (The
		// set is not identical to `gone`: generations both created and pruned inside
		// the second run were never in `before`.)
		for (const name of named) expect(after).not.toContain(name);
	});
});

describe("soak log: the gauges and the heartbeat", () => {
	const dir = path.join(ROOT, "gauge");

	beforeAll(() => {
		freshDir("gauge");
	});

	test("a heartbeat carries the metrics no edge event can supply", () => {
		const socketsDir = path.join(ROOT, "gauge-sockets");
		rmSync(socketsDir, { recursive: true, force: true });
		mkdirSync(socketsDir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(socketsDir, "a.sock"), "");
		writeFileSync(path.join(socketsDir, "a.lock"), "");
		writeFileSync(path.join(socketsDir, "b.lock"), "");

		const log = new SoakLog({ dir, socketsDir, sessionId: "hb", clientCount: () => 3 });
		log.heartbeat();

		const records = readSoakLog({ dir, events: [SOAK_EVENTS.HEARTBEAT] }).records;
		expect(records.length).toBe(1);
		const hb = records[0];
		expect(hb.sessionId).toBe("hb");
		expect(hb.sockCount).toBe(1);
		expect(hb.lockCount).toBe(2);
		expect(hb.clientCount).toBe(3);
		expect(hb.fdGauge as number).toBeGreaterThan(2);
		expect(hb.rss as number).toBeGreaterThan(0);
		expect(hb.uptimeMs as number).toBeGreaterThan(0);
	});

	test("the fd gauge MOVES with the descriptor count, in both directions", () => {
		// The gauge is the lowest free descriptor POSIX hands back, so holding N
		// more must push it up by at least N and releasing them must bring it back
		// down. Asserting only that it is "greater than 2" cannot tell the gauge
		// from a constant — and a leaked-fd verdict read off a constant is worse
		// than no verdict, because it reads as evidence of no leak.
		const gaugeDir = freshDir("fdgauge");
		const log = new SoakLog({ dir: gaugeDir, sessionId: "fd" });
		const HELD = 8;

		const before = fdGauge();
		const held: number[] = [];
		try {
			for (let i = 0; i < HELD; i++) held.push(openSync("/dev/null", "r"));
			const busy = fdGauge();
			log.heartbeat({ phase: "busy" });
			expect(busy).toBeGreaterThanOrEqual(before + HELD);
		} finally {
			for (const fd of held) closeSync(fd);
		}
		const after = fdGauge();
		log.heartbeat({ phase: "idle" });
		expect(after).toBeLessThanOrEqual(before);

		// And the number the LOG carries moves with it — the seven-day question is
		// "did fds grow", answered from the file weeks later, not from this process.
		const beats = readSoakLog({ dir: gaugeDir, events: [SOAK_EVENTS.HEARTBEAT] }).records;
		const busyBeat = beats.find((record) => record.phase === "busy");
		const idleBeat = beats.find((record) => record.phase === "idle");
		expect(busyBeat).toBeDefined();
		expect(idleBeat).toBeDefined();
		expect((busyBeat?.fdGauge as number) - (idleBeat?.fdGauge as number)).toBeGreaterThanOrEqual(HELD);
	});

	test("the heartbeat timer is unref'd, so it cannot hold a process open", async () => {
		const log = new SoakLog({ dir, sessionId: "hb", heartbeatMs: 10 });
		log.startHeartbeat();
		log.startHeartbeat(); // idempotent
		await new Promise((resolve) => setTimeout(resolve, 60));
		log.stopHeartbeat();
		const beats = readSoakLog({ dir, events: [SOAK_EVENTS.HEARTBEAT] }).records.length;
		expect(beats).toBeGreaterThan(1);

		// An unref'd interval still fires but does not keep the loop alive. Proved by
		// a child that starts one and exits on its own.
		const script = path.join(ROOT, "unref.ts");
		writeFileSync(
			script,
			`import { SoakLog } from ${JSON.stringify(SOAK_LOG_MODULE)};\n` +
				`const log = new SoakLog({ dir: ${JSON.stringify(path.join(ROOT, "unref"))}, heartbeatMs: 5 });\n` +
				`log.startHeartbeat();\n`,
			{ mode: 0o600 },
		);
		const result = await new Promise<ChildResult>((resolve, reject) => {
			const child = spawn("bun", [script], {
				cwd: PKG_ROOT,
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? ROOT },
				stdio: ["ignore", "pipe", "pipe"],
			});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
			const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(kill);
				resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
			});
		});
		expect(result.code).toBe(0);
		expect(result.stdout.length).toBe(0);
		expect(result.stderr.length).toBe(0);
	}, 30_000);

	test("the writer never throws into a caller, even when the directory is unusable", () => {
		// A file where the directory must be: mkdir fails, every append fails.
		const blocked = path.join(ROOT, "blocked");
		rmSync(blocked, { recursive: true, force: true });
		writeFileSync(blocked, "not a directory", { mode: 0o600 });
		const log = new SoakLog({ dir: blocked, sessionId: "doomed" });
		expect(() => log.record("probe", { seq: 1 })).not.toThrow();
		expect(() => log.heartbeat()).not.toThrow();
		expect(log.lastError).toBeDefined();
	});
});
