// The OS process table, read with `ps`: the oracle for process-level claims, since the daemon's own bookkeeping is not.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/** One row of `ps -A -ww -o pid=,ppid=,pgid=,stat=,command=`. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	stat: string;
	command: string;
	raw: string;
}

export class ProcessTableError extends Error {
	override readonly name = "ProcessTableError";
}

export class EnvironmentNotVisibleError extends Error {
	override readonly name = "EnvironmentNotVisibleError";
}

export class PositiveControlMissingError extends Error {
	override readonly name = "PositiveControlMissingError";
}

const ROW = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+(?<stat>\S+)\s*(?<command>.*)$/;

/**
 * `-A` is mandatory: without it `ps` lists only processes sharing the caller's controlling terminal, and everything
 * spawned `detached: true` has none, so such a child reads as absent. `-ww` keeps a long argv from being truncated.
 */
export const PS_ROWS_COMMAND = ["ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,command="] as const;

export function psRows(): ProcessRow[] {
	const out = Bun.spawnSync([...PS_ROWS_COMMAND]);
	if (!out.success) {
		throw new ProcessTableError(`ps -A exited ${out.exitCode}: ${out.stderr.toString().trim()}`);
	}
	const text = out.stdout.toString();
	const rows: ProcessRow[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim().length === 0) continue;
		const match = ROW.exec(raw);
		if (!match?.groups) throw new ProcessTableError(`unparseable ps row: ${JSON.stringify(raw)}`);
		rows.push({
			pid: Number(match.groups.pid),
			ppid: Number(match.groups.ppid),
			pgid: Number(match.groups.pgid),
			stat: match.groups.stat,
			command: match.groups.command,
			raw,
		});
	}
	if (rows.length === 0) throw new ProcessTableError("ps -A returned no rows at all");
	return rows;
}

export function rowFor(pid: number, rows: ProcessRow[] = psRows()): ProcessRow | undefined {
	return rows.find((row) => row.pid === pid);
}

export function isZombie(row: ProcessRow): boolean {
	return row.stat.includes("Z");
}

export function groupMembers(pgid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
	return rows.filter((row) => row.pgid === pgid);
}

/**
 * After `killpg` the leader stays in the table as `Z <defunct>`, keeping its pid, ppid and pgid, until its parent
 * reaps it — so an unfiltered group is non-empty for as long as the spawner has not got round to reaping.
 */
export function liveGroupMembers(pgid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
	return groupMembers(pgid, rows).filter((row) => !isZombie(row));
}

/**
 * Every transitive child of `pid`, zombies included. Sound as a race-free scope for a negative because `detached: true`
 * does not reparent on darwin: a detached child gets its own session and `pgid == pid` but keeps `ppid = spawner`.
 */
export function descendantsOf(pid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const siblings = byParent.get(row.ppid);
		if (siblings) siblings.push(row);
		else byParent.set(row.ppid, [row]);
	}
	const found: ProcessRow[] = [];
	const seen = new Set<number>([pid]);
	const queue = [pid];
	while (queue.length > 0) {
		for (const child of byParent.get(queue.shift() as number) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			found.push(child);
			queue.push(child.pid);
		}
	}
	return found;
}

/** Replaces `kill(pid, 0)`, which succeeds on a zombie and so reports a process that has already exited as alive. */
export function isProcessAlive(pid: number, rows: ProcessRow[] = psRows()): boolean {
	const row = rowFor(pid, rows);
	return row !== undefined && !isZombie(row);
}

export async function waitForProcessesGone(pids: readonly number[], timeoutMs = 30_000): Promise<void> {
	await waitForTable(
		(rows) => pids.every((pid) => !isProcessAlive(pid, rows)),
		() => `pids ${pids.join(", ")} to stop running`,
		timeoutMs,
	);
}

export async function waitForGroupGone(pgid: number, timeoutMs = 30_000): Promise<void> {
	await waitForTable(
		(rows) => liveGroupMembers(pgid, rows).length === 0,
		(rows) => `process group ${pgid} to stop running (still: ${describeRows(liveGroupMembers(pgid, rows))})`,
		timeoutMs,
	);
}

async function waitForTable(
	done: (rows: ProcessRow[]) => boolean,
	what: (rows: ProcessRow[]) => string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let rows = psRows();
	for (;;) {
		if (done(rows)) return;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what(rows)}`);
		await Bun.sleep(50);
		rows = psRows();
	}
}

export function describeRows(rows: readonly ProcessRow[]): string {
	if (rows.length === 0) return "(none)";
	return rows.map((row) => `${row.pid} [${row.stat}] ${row.command}`).join(" | ");
}

/** Either an environment or an explicit statement that none was visible; deliberately no empty-map third answer. */
export type ProcessEnvironment =
	| { visible: true; env: Map<string, string>; raw: string }
	| { visible: false; reason: string; raw: string };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * macOS appends the environment to the argv with no delimiter, so the split is a heuristic: a token matching `NAME=`
 * starts a variable, any other token continues the previous value (values legitimately contain spaces).
 */
export function envOf(pid: number): ProcessEnvironment {
	if (process.platform === "linux") return linuxEnvOf(pid);

	const out = Bun.spawnSync(["ps", "-Eww", "-o", "command=", "-p", String(pid)]);
	const raw = out.stdout.toString();
	if (!out.success || raw.trim().length === 0) {
		throw new ProcessTableError(
			`ps -E found no process ${pid} (exit ${out.exitCode}): ${out.stderr.toString().trim()}`,
		);
	}

	const env = new Map<string, string>();
	let current: string | undefined;
	for (const token of raw.trim().split(/\s+/)) {
		if (ASSIGNMENT.test(token)) {
			const split = token.indexOf("=");
			current = token.slice(0, split);
			env.set(current, token.slice(split + 1));
		} else if (current !== undefined) {
			env.set(current, `${env.get(current)} ${token}`);
		}
	}

	if (env.size === 0) {
		return {
			visible: false,
			reason:
				`ps -E showed no environment for pid ${pid}. On this platform that means either a SIP-protected ` +
				"platform binary (/bin/sh, /bin/bash, /bin/sleep — argv only, zero environment bytes) or a process " +
				"with a genuinely empty environment. These are indistinguishable from outside, so no absence may be " +
				"concluded from this result",
			raw,
		};
	}
	return { visible: true, env, raw };
}

function linuxEnvOf(pid: number): ProcessEnvironment {
	const path = `/proc/${pid}/environ`;
	let raw: string;
	try {
		raw = readFileSync(path).toString();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ESRCH") {
			throw new ProcessTableError(`${path} names no running process`);
		}
		return {
			visible: false,
			reason: `${path} could not be read: ${(error as Error).message}`,
			raw: "",
		};
	}

	const env = new Map<string, string>();
	for (const assignment of raw.split("\0")) {
		const split = assignment.indexOf("=");
		if (split <= 0) continue;
		env.set(assignment.slice(0, split), assignment.slice(split + 1));
	}
	if (env.size === 0) {
		return {
			visible: false,
			reason: `${path} was readable but held no environment assignments, so no absence may be concluded`,
			raw,
		};
	}
	return { visible: true, env, raw };
}

/** A name the harness DID declare, used to prove the oracle can see anything at all. */
export interface PositiveControl {
	name: string;
	value?: string;
}

/**
 * Assert that no canary reached `pid`'s environment, once `positiveControl` proves that environment can be read at all.
 * Given a `name → value` table the VALUES are also searched raw, catching a leak that arrived under another name.
 */
export function assertEnvAbsent(
	pid: number,
	canaries: readonly string[] | Record<string, string>,
	positiveControl: PositiveControl,
): Map<string, string> {
	const seen = envOf(pid);
	if (!seen.visible) throw new EnvironmentNotVisibleError(seen.reason);

	const control = seen.env.get(positiveControl.name);
	if (control === undefined) {
		throw new PositiveControlMissingError(
			`the positive control ${positiveControl.name} is not visible in pid ${pid}'s environment, so nothing ` +
				`can be concluded about what is absent from it. Saw: ${[...seen.env.keys()].sort().join(", ")}`,
		);
	}
	if (positiveControl.value !== undefined && control !== positiveControl.value) {
		throw new PositiveControlMissingError(
			`the positive control ${positiveControl.name} reads ${JSON.stringify(control)} in pid ${pid}, not ` +
				`${JSON.stringify(positiveControl.value)}, so this ps output is not describing the process under test`,
		);
	}

	const names = Array.isArray(canaries) ? canaries : Object.keys(canaries);
	for (const name of names) {
		if (seen.env.has(name)) {
			throw new Error(`pid ${pid} carries ${name}=${JSON.stringify(seen.env.get(name))}, which never crossed`);
		}
	}
	if (!Array.isArray(canaries)) {
		for (const [name, value] of Object.entries(canaries as Record<string, string>)) {
			// A canary shorter than 8 characters matches almost every process's bytes.
			if (value.length >= 8 && seen.raw.includes(value)) {
				throw new Error(`pid ${pid}'s environment contains the value planted as ${name}: ${JSON.stringify(value)}`);
			}
		}
	}
	return seen.env;
}

/**
 * Recorded pgids only — never `pkill -f` on a pattern: several agents run draht e2es on this machine at once.
 * Failures are swallowed because ESRCH is the usual outcome and a throwing teardown hides the assertion behind it.
 */
export function reapPgids(pgids: Iterable<number>): void {
	for (const pgid of pgids) {
		if (!Number.isInteger(pgid) || pgid <= 1) continue;
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {}
	}
}

/** Nothing else on this box can be carrying it, so a scan for the literal is scoped to this run. */
export function uniqueMarker(label: string): string {
	return `${label}-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}
