/**
 * The kernel's view of what a process is listening on — for a whole run.
 *
 * Phase 32's loopback proof enumerated a spawned daemon's sockets with a single
 * `lsof` call and treated "no output" as "no listeners". `lsof` produces no
 * output in two very different situations: when the process genuinely has no
 * listening TCP socket, and when `lsof` is not installed, not on `PATH`, or
 * refused the query. Collapsing those two into `[]` turns the strongest
 * assertion in the suite — *this daemon bound nothing but loopback* — into a
 * pass that survives the evidence being unavailable.
 *
 * So enumeration here is total: every outcome is either a parsed listener list
 * or a thrown `ListenerEnumerationError`. There is no third answer, and in
 * particular there is no answer that looks clean because nothing could be
 * measured.
 *
 * `watchListeners` adds the other half. A bind is a property of a run, not of
 * the instant a test happened to sample: a daemon can bind loopback, be sampled,
 * and open a wildcard socket a moment later. The watcher samples on an interval
 * for as long as the caller's `AbortSignal` is unaborted and returns every
 * distinct listener it saw, so the assertion covers the window rather than a
 * point inside it.
 */

import { spawnSync } from "node:child_process";

/** One listening TCP socket the kernel attributes to a pid. */
export interface Listener {
	/** The bound address as `lsof -nP` reports it: `127.0.0.1`, `::1`, `*`. */
	address: string;
	port: number;
	/** The whole `lsof` row, kept so a failure message can show what was seen. */
	raw: string;
}

export interface EnumerateOptions {
	/** Environment for the `lsof` child; defaults to this process's own. */
	env?: Record<string, string | undefined>;
}

export interface WatchOptions extends EnumerateOptions {
	/** Gap between samples. Default 25ms. */
	intervalMs?: number;
	/** Abort to end the window; the watcher takes one final sample and returns. */
	signal: AbortSignal;
}

/**
 * Raised when the listener set could not be determined at all.
 *
 * Distinct from an empty result, which means the process really is listening on
 * nothing. A caller that catches this and continues has re-created the residual
 * this module exists to close.
 */
export class ListenerEnumerationError extends Error {
	override readonly name = "ListenerEnumerationError";

	constructor(reason: string) {
		super(`cannot enumerate listening sockets with lsof: ${reason}`);
	}
}

/** `lsof -nP` renders the bound endpoint as the final `<address>:<port> (LISTEN)`. */
const NAME_FIELD = /(?<address>\[[0-9A-Fa-f:.]+\]|\S+?):(?<port>\d+)\s+\(LISTEN\)\s*$/;

/**
 * `lsof` writes advisory warnings about mount points and processes it could not
 * stat to stderr while still answering the question. Those are not failures; a
 * usage or permission error is.
 */
const ADVISORY = /^(lsof: WARNING:|\s*Output information may be incomplete\.)/;

function fatalStderr(stderr: string): string {
	return stderr
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && !ADVISORY.test(line))
		.join("\n");
}

/**
 * The listening TCP sockets the kernel attributes to `pid`.
 *
 * Returns `[]` only when `lsof` ran and reported no listener. Every other
 * outcome — `lsof` missing, killed, exiting with a usage error, or emitting a
 * row this parser does not understand — throws `ListenerEnumerationError`.
 */
export function listeningSockets(pid: number, options: EnumerateOptions = {}): Listener[] {
	const out = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
		encoding: "utf-8",
		...(options.env ? { env: options.env } : {}),
	});

	if (out.error) throw new ListenerEnumerationError(out.error.message);
	if (out.signal) throw new ListenerEnumerationError(`lsof was killed by ${out.signal}`);

	const stderr = fatalStderr(out.stderr ?? "");
	// `lsof` exits 1 both for "nothing matched the filter" and for usage errors;
	// only the latter says anything on stderr.
	if (out.status === 1 && stderr.length > 0) throw new ListenerEnumerationError(`lsof exited 1: ${stderr}`);
	if (out.status !== 0 && out.status !== 1) {
		throw new ListenerEnumerationError(`lsof exited ${out.status === null ? "without a status" : out.status}`);
	}

	const rows = (out.stdout ?? "").split("\n");
	// A successful run always prints the header; anything else means the output
	// is not the report we are parsing, and must not be read as "no listeners".
	if (out.status === 0 && !rows[0]?.startsWith("COMMAND")) {
		throw new ListenerEnumerationError(`lsof exited 0 without its header row: ${JSON.stringify(rows[0] ?? "")}`);
	}
	if (out.status === 1 && (out.stdout ?? "").trim().length > 0) {
		throw new ListenerEnumerationError(`lsof exited 1 but printed output: ${JSON.stringify(out.stdout)}`);
	}

	const listeners: Listener[] = [];
	for (const row of rows.slice(1)) {
		const raw = row.trim();
		if (raw.length === 0) continue;
		const match = NAME_FIELD.exec(raw);
		// An unreadable row is a hole in the proof exactly like a missing binary.
		if (!match?.groups) throw new ListenerEnumerationError(`unparseable lsof row: ${JSON.stringify(raw)}`);
		listeners.push({
			address: unbracket(match.groups.address),
			port: Number(match.groups.port),
			raw,
		});
	}
	return listeners;
}

/**
 * Sample `pid`'s listeners until `signal` aborts, and return every distinct one
 * observed — so an assertion covers the whole run rather than one instant.
 *
 * Always samples at least once, including when the signal is already aborted,
 * and takes one final sample after the abort so a listener opened late in the
 * window is still seen. A failure to enumerate rejects the returned promise
 * rather than shortening the window to nothing.
 */
export async function watchListeners(pid: number, options: WatchOptions): Promise<Listener[]> {
	const { intervalMs = 25, signal } = options;
	const seen = new Map<string, Listener>();
	for (;;) {
		for (const listener of listeningSockets(pid, options)) seen.set(`${listener.address}:${listener.port}`, listener);
		if (signal.aborted) break;
		await sleepUntilAborted(intervalMs, signal);
	}
	return [...seen.values()];
}

/** True when the listener can only be reached from this host. */
export function isLoopbackListener(listener: Listener): boolean {
	const address = unbracket(listener.address);
	return address === "::1" || address === "localhost" || address.startsWith("127.");
}

/** A one-line rendering for failure messages: `127.0.0.1:8080`. */
export function describeListeners(listeners: Listener[]): string {
	return listeners.length === 0 ? "(none)" : listeners.map((l) => `${l.address}:${l.port}`).join(", ");
}

function unbracket(address: string): string {
	return address.replace(/^\[/, "").replace(/\]$/, "");
}

function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		function finish() {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		}
	});
}
