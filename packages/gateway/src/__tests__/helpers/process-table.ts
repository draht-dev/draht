// The OS process table, read with `ps`: the oracle for process-level claims, since the daemon's own bookkeeping is not.

import { randomBytes } from "node:crypto";
import {
	linkSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

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

/** `/proc/<pid>/<entry>` read as `read` says, with "no such process" and "unreadable" kept apart: neither may read as an empty answer. */
function procEntry<T>(pid: number, entry: "cmdline" | "exe" | "cwd", read: (path: string) => T): T {
	const path = `/proc/${pid}/${entry}`;
	try {
		return read(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ESRCH") {
			throw new ProcessTableError(
				`${path} names no running process, or a zombie or kernel thread that has no ${entry}`,
			);
		}
		throw new ProcessTableError(`${path} could not be read: ${(error as Error).message}`);
	}
}

function unsupportedPlatform(what: string): ProcessTableError {
	return new ProcessTableError(
		`${what} has a Linux branch and a macOS branch, and this platform is ${process.platform}`,
	);
}

/** `ps -o <field>= -p <pid>`, trimmed. An empty answer means no such process, not an empty value. */
function psField(pid: number, field: "command" | "comm"): string {
	const out = Bun.spawnSync(["ps", "-ww", "-o", `${field}=`, "-p", String(pid)]);
	const text = out.stdout.toString().trim();
	if (!out.success || text.length === 0) {
		throw new ProcessTableError(
			`ps -o ${field}= found no process ${pid} (exit ${out.exitCode}): ${out.stderr.toString().trim()}`,
		);
	}
	return text;
}

/**
 * The argv the process was exec'd with, element by element, argv[0] included.
 *
 * Linux splits `/proc/<pid>/cmdline` on NUL, so empty and spaced elements survive. macOS has only `ps`, which joins the
 * argv with spaces, so the macOS branch (UNEXECUTED on the box this was written on) splits on whitespace and is exact
 * only for an argv whose elements hold none.
 */
export function argvOf(pid: number): string[] {
	if (process.platform === "linux") {
		const raw = procEntry(pid, "cmdline", (path) => readFileSync(path).toString());
		// A zombie and a kernel thread both read as an empty cmdline; an empty argv would pass a "does not contain" check.
		if (raw.length === 0)
			throw new ProcessTableError(`/proc/${pid}/cmdline is empty: a zombie or kernel thread has no argv`);
		const argv = raw.split("\0");
		if (argv[argv.length - 1] === "") argv.pop();
		return argv;
	}
	if (process.platform === "darwin") return psField(pid, "command").split(/\s+/);
	throw unsupportedPlatform("argvOf");
}

/**
 * The file the kernel ran, which is not argv[0]: a process started through a symlink reports the link in its argv and
 * the target here. The macOS branch (UNEXECUTED here) reads `ps -o comm=`, which reports the path `execve` was given,
 * so it is `realpath`'d to reach the same answer.
 */
export function exeOf(pid: number): string {
	if (process.platform === "linux") return procEntry(pid, "exe", (path) => readlinkSync(path, "utf8"));
	if (process.platform === "darwin") {
		const comm = psField(pid, "comm");
		if (!comm.startsWith("/"))
			throw new ProcessTableError(`ps -o comm= reported ${JSON.stringify(comm)} for pid ${pid}, not a path`);
		return realpathSync(comm);
	}
	throw unsupportedPlatform("exeOf");
}

/** The working directory the kernel holds for the process. The macOS branch (UNEXECUTED here) is `lsof -a -d cwd -Fn`. */
export function cwdOf(pid: number): string {
	if (process.platform === "linux") return procEntry(pid, "cwd", (path) => readlinkSync(path, "utf8"));
	if (process.platform === "darwin") {
		const out = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
		const lines = out.stdout.toString().split("\n");
		const field = lines.indexOf("fcwd");
		const path = field === -1 ? undefined : lines[field + 1];
		if (path === undefined || !path.startsWith("n/")) {
			throw new ProcessTableError(
				`lsof found no cwd for pid ${pid} (exit ${out.exitCode}): ${out.stderr.toString().trim() || out.stdout.toString().trim()}`,
			);
		}
		return path.slice(1);
	}
	throw unsupportedPlatform("cwdOf");
}

/** A file this user does not own inside a directory this user does, or the reason none could be made. */
export type ForeignOwnedFile = { path: string } | { unavailable: string };

export class ForeignOwnedFileUnavailableError extends Error {
	override readonly name = "ForeignOwnedFileUnavailableError";
}

const FOREIGN_FILE_NAME = "foreign-owned.yaml";

function isOwnedByAnotherUid(path: string): boolean {
	return lstatSync(path).uid !== process.getuid?.();
}

/**
 * A hard link to an inode somebody else owns: the only way to put a foreign-owned file in a directory we own without
 * privilege. The kernel may refuse (`fs.protected_hardlinks`, a device boundary), so every refusal is kept for the
 * reason, and a link that turns out to be ours is removed rather than returned.
 */
export function hardlinkForeignFile(
	candidates: readonly string[],
	target: string,
): { path: string } | { failures: string[] } {
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			linkSync(candidate, target);
		} catch (error) {
			failures.push(
				`hard link of ${candidate}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
			);
			continue;
		}
		if (isOwnedByAnotherUid(target)) return { path: target };
		rmSync(target, { force: true });
		failures.push(`hard link of ${candidate}: the inode is owned by this user`);
	}
	return { failures };
}

/** `sudo -n install -o 0` creates the file as root in one step; `-n` makes a missing grant a failure instead of a prompt. */
function sudoInstallForeignFile(dir: string, target: string): { path: string } | { failure: string } {
	const staging = join(dir, `.foreign-source-${randomBytes(4).toString("hex")}`);
	try {
		writeFileSync(staging, "", { mode: 0o600 });
	} catch (error) {
		return { failure: `sudo route needs to write ${staging}: ${(error as Error).message}` };
	}
	try {
		const out = Bun.spawnSync(["sudo", "-n", "install", "-o", "0", "-g", "0", "-m", "0600", staging, target], {
			stdin: "ignore",
			timeout: 20_000,
		});
		if (!out.success) {
			const said = out.stderr
				.toString()
				.trim()
				.replace(/\s*\n\s*/g, " ");
			return { failure: `sudo -n install exited ${out.exitCode ?? out.signalCode}: ${said || "no output"}` };
		}
		if (!isOwnedByAnotherUid(target)) {
			rmSync(target, { force: true });
			return { failure: "sudo -n install ran, but the file it made is owned by this user" };
		}
		return { path: target };
	} catch (error) {
		return { failure: `sudo could not be run: ${(error as Error).message}` };
	} finally {
		rmSync(staging, { force: true });
	}
}

/** The image a container route runs, opt-in: a local image, so the route never pulls. */
export const FOREIGN_UID_IMAGE_ENV = "DRAHT_FOREIGN_UID_IMAGE";

/**
 * Container uid 1 is never this user on the host: a rootful runtime keeps it as uid 1, and a rootless one maps it into
 * the subuid range. So a file the container chowns to 1 is foreign-owned without this user holding any privilege.
 */
function containerForeignFile(
	dir: string,
	target: string,
	env: NodeJS.ProcessEnv,
): { path: string } | { failure: string } {
	const image = env[FOREIGN_UID_IMAGE_ENV];
	if (image === undefined || image === "") return { failure: `${FOREIGN_UID_IMAGE_ENV} is not set` };
	const runtime = Bun.which("docker") ?? Bun.which("podman");
	if (runtime === null)
		return { failure: `${FOREIGN_UID_IMAGE_ENV} is set, but neither docker nor podman is on PATH` };
	const script = `umask 077 && : > "$1" && chown 1:1 "$1" && chmod 0600 "$1"`;
	const out = Bun.spawnSync(
		[
			runtime,
			"run",
			"--rm",
			"--network",
			"none",
			"--pull",
			"never",
			"--user",
			"0",
			"-v",
			`${dir}:${dir}`,
			image,
		].concat(["sh", "-c", script, "sh", target]),
		{ stdin: "ignore", timeout: 60_000 },
	);
	if (!out.success) {
		const said = out.stderr
			.toString()
			.trim()
			.replace(/\s*\n\s*/g, " ");
		return { failure: `${runtime} run ${image} exited ${out.exitCode ?? out.signalCode}: ${said || "no output"}` };
	}
	if (!isOwnedByAnotherUid(target)) {
		rmSync(target, { force: true });
		return { failure: `${runtime} run ${image} made a file owned by this user` };
	}
	return { path: target };
}

function linuxForeignOwnedFile(dir: string, target: string, env: NodeJS.ProcessEnv): ForeignOwnedFile {
	const linked = hardlinkForeignFile(["/etc/passwd"], target);
	if ("path" in linked) return linked;
	const installed = sudoInstallForeignFile(dir, target);
	if ("path" in installed) return installed;
	const contained = containerForeignFile(dir, target, env);
	if ("path" in contained) return contained;

	let hardlinks = "unreadable";
	try {
		hardlinks = readFileSync("/proc/sys/fs/protected_hardlinks").toString().trim();
	} catch {}
	return {
		unavailable: `${[...linked.failures, installed.failure, contained.failure].join("; ")} (fs.protected_hardlinks=${hardlinks})`,
	};
}

/** UNEXECUTED on the box this was written on: the plan names `/private/var/db` as the source of a service-owned inode. */
function darwinForeignOwnedFile(target: string): ForeignOwnedFile {
	const root = "/private/var/db";
	let candidates: string[];
	try {
		candidates = readdirSync(root)
			.map((name) => join(root, name))
			.filter((path) => {
				try {
					const stats = lstatSync(path);
					return stats.isFile() && stats.uid !== process.getuid?.();
				} catch {
					return false;
				}
			})
			.slice(0, 25);
	} catch (error) {
		return { unavailable: `${root} could not be listed: ${(error as Error).message}` };
	}
	const linked = hardlinkForeignFile(candidates, target);
	if ("path" in linked) return linked;
	return {
		unavailable:
			linked.failures.length > 0
				? linked.failures.join("; ")
				: `${root} holds no regular file owned by another user that this user can see`,
	};
}

function ciIsSet(env: NodeJS.ProcessEnv): boolean {
	const value = env.CI;
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * `<dir>/foreign-owned.yaml`, owned by a uid that is not ours, in a directory we own.
 *
 * Never a copy or a fake: the file is a root-made one (Linux, through `sudo -n`), one a container chowned to its uid 1
 * (Linux, opt-in through {@link FOREIGN_UID_IMAGE_ENV}), or a hard link to an inode another user owns (macOS; Linux
 * too when the kernel allows), and its owner is re-read with `lstat` before it is returned.
 * With no way to make one the answer is `{unavailable}` and the reason, EXCEPT when `CI` is set: a skip there would
 * leave the foreign-uid refusal unwitnessed, so it throws. Replaces any file already at that name.
 *
 * The macOS route is UNEXECUTED on the box this was written on.
 */
export function foreignOwnedFileIn(dir: string, env: NodeJS.ProcessEnv = process.env): ForeignOwnedFile {
	const target = join(dir, FOREIGN_FILE_NAME);
	rmSync(target, { force: true });
	let result: ForeignOwnedFile;
	if (process.platform === "linux") result = linuxForeignOwnedFile(dir, target, env);
	else if (process.platform === "darwin") result = darwinForeignOwnedFile(target);
	else result = { unavailable: `there is no route to a foreign-owned file on ${process.platform}` };

	if ("unavailable" in result && ciIsSet(env)) {
		throw new ForeignOwnedFileUnavailableError(
			`CI is set, so a foreign-owned file in ${dir} is required and not skippable, and none could be made: ${result.unavailable}`,
		);
	}
	return result;
}
