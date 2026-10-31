/**
 * The emitted daemon as a process, and the fixtures a class-3 spawn suite puts around it: a short temp base, a registry
 * file the loader accepts, tripwire harnesses, and a renderer connection that keeps every frame it was sent.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistConfig,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";
import { descendantsOf, isZombie, rowFor } from "./process-table.js";

const GATEWAY_CLI = resolve(import.meta.dir, "..", "..", "cli.ts");

/**
 * A session socket is `<agent dir>/sockets/<uuid>.sock`, 50 bytes past the agent dir, and a unix socket path binds
 * only up to 103 bytes on macOS. 40 leaves room for `/agent` and a margin.
 */
const MAX_BASE_LENGTH = 40;

/** Moves `shortBase` off `/tmp`, for a host whose container runtime cannot see this process's private `/tmp`. */
export const SHORT_ROOT_ENV = "DRAHT_TEST_SHORT_ROOT";

/** A canonical `mkdtemp` directory (mode 0700) under `/tmp`, short enough that a session socket inside it can bind. */
export function shortBase(prefix: string): string {
	const base = realpathSync(mkdtempSync(join(process.env[SHORT_ROOT_ENV] || "/tmp", prefix)));
	if (base.length > MAX_BASE_LENGTH) {
		rmSync(base, { recursive: true, force: true });
		throw new Error(
			`shortBase(${JSON.stringify(prefix)}) made ${base} (${base.length} bytes); over ${MAX_BASE_LENGTH} a session socket under it cannot bind`,
		);
	}
	return base;
}

/**
 * Write `config` where the daemon's loader will read it. JSON is valid YAML.
 *
 * A missing parent is created 0700; an existing one is never touched, so `/tmp` can be the parent of a registry that
 * the loader must refuse. The file arrives by `rename`, because a daemon may read the path mid-write and a truncate
 * then write would show it an empty registry.
 */
export function writeRegistry(path: string, config: GeistConfig, mode = 0o600): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const staging = join(parent, `.${basename(path)}.${randomBytes(4).toString("hex")}`);
	writeFileSync(staging, JSON.stringify(config), { mode });
	chmodSync(staging, mode);
	renameSync(staging, path);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * An executable that appends one line (its own path and arguments) to `marker` as its first act and exits 0.
 * `echo`, redirection and `exit` only: a spawned child's PATH may hold no coreutils at all.
 */
export function shTripwire(path: string, marker: string): string {
	writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> ${shellQuote(marker)}\nexit 0\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/** A script the daemon runs on its own bun; for anything that needs a timer or a signal handler. */
export function jsFixture(path: string, source: string): string {
	writeFileSync(path, source, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/** Sorted, zombies included, so two snapshots compare with `toEqual`. */
export function descendantPids(pid: number): number[] {
	return descendantsOf(pid)
		.map((row) => row.pid)
		.sort((a, b) => a - b);
}

export interface EmittedDaemonOptions {
	/** Handed to `--registry` verbatim, relative or not. Absent omits the flag, which leaves the default under `env.HOME`. */
	registry?: string;
	/** The daemon's WHOLE environment. Nothing is inherited, so `HOME` and `DRAHT_CODING_AGENT_DIR` must be named. */
	env: Readonly<Record<string, string>>;
	cwd?: string;
	/** The `--auth` bearer token. Defaults to a random one. */
	token?: string;
	/** How long to wait for the listening line. Default 30000. */
	startupTimeoutMs?: number;
	/** How long `dispose` waits after SIGTERM before SIGKILL. Default 10000. */
	terminateGraceMs?: number;
}

export interface EmittedDaemon {
	pid: number;
	port: number;
	token: string;
	httpBase: string;
	wsBase: string;
	/** Grows as the daemon writes. */
	stderr: { readonly text: string };
	/** Idempotent. Resolves once the daemon is gone from `ps`; rejects if it cannot be made to be. */
	dispose(): Promise<void>;
}

/** The daemon never reached "listening": it exited, or it was killed here after the deadline (`exitCode` is then null). */
export class DaemonStartError extends Error {
	override readonly name = "DaemonStartError";
	readonly pid: number;
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(message: string, detail: { pid: number; exitCode: number | null; stderr: string }) {
		super(message);
		this.pid = detail.pid;
		this.exitCode = detail.exitCode;
		this.stderr = detail.stderr;
	}
}

const REQUIRED_ENV = ["HOME", "DRAHT_CODING_AGENT_DIR"] as const;
const KILL_DEADLINE_MS = 10_000;

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** The port in the daemon's `draht-gateway listening` record, once a whole line of it has arrived. */
function listeningPort(stderr: string): number | undefined {
	for (const line of stderr.split("\n")) {
		if (!line.includes("draht-gateway listening")) continue;
		try {
			const record = JSON.parse(line) as { message?: unknown; port?: unknown };
			if (record.message === "draht-gateway listening" && typeof record.port === "number") return record.port;
		} catch {}
	}
	return undefined;
}

async function exitsWithin(proc: Bun.Subprocess, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((done) => {
		timer = setTimeout(() => done(false), ms);
	});
	try {
		return await Promise.race([proc.exited.then(() => true as const), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}

async function stopDaemon(proc: Bun.Subprocess, drained: Promise<void>, graceMs: number): Promise<void> {
	const pid = proc.pid;
	if (proc.exitCode === null && proc.signalCode === null) {
		proc.kill("SIGTERM");
		if (!(await exitsWithin(proc, graceMs))) {
			proc.kill("SIGKILL");
			if (!(await exitsWithin(proc, KILL_DEADLINE_MS))) {
				throw new Error(`daemon pid ${pid} was still running ${KILL_DEADLINE_MS} ms after SIGKILL`);
			}
		}
	}
	await drained;
	// The command check keeps a pid the kernel has since handed to something else from reading as a leftover daemon.
	const row = rowFor(pid);
	if (row !== undefined && !isZombie(row) && row.command.includes(GATEWAY_CLI)) {
		throw new Error(`daemon pid ${pid} is still in ps after dispose: ${row.raw.trim()}`);
	}
}

/**
 * Run `process.execPath packages/gateway/src/cli.ts --host 127.0.0.1 --port <free> --auth <token> [--registry <path>]`
 * and wait for its "draht-gateway listening" record. The environment is exactly `options.env`.
 *
 * The free port is probed and released before the daemon binds it, so a collision with another process is possible
 * and shows as a {@link DaemonStartError} whose stderr says the port is in use.
 *
 * Sessions the daemon spawns are detached and outlive it: `dispose` stops the daemon only.
 */
export async function startEmittedDaemon(options: EmittedDaemonOptions): Promise<EmittedDaemon> {
	for (const name of REQUIRED_ENV) {
		if (!options.env[name]) {
			throw new Error(
				`startEmittedDaemon: env.${name} is required; the daemon inherits nothing, and without it falls back to the real user's home`,
			);
		}
	}
	const token = options.token ?? `tok-${randomBytes(12).toString("hex")}`;
	const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
	const port = freeLoopbackPort();
	const argv = [
		process.execPath,
		GATEWAY_CLI,
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--auth",
		token,
		...(options.registry === undefined ? [] : ["--registry", options.registry]),
	];
	const proc = Bun.spawn(argv, {
		env: { ...options.env },
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const pid = proc.pid;

	const stderr = { text: "" };
	const drained = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
			stderr.text += decoder.decode(chunk, { stream: true });
		}
	})().catch(() => {});
	const outcome: { exitCode?: number | null } = {};
	void proc.exited.then((code) => {
		outcome.exitCode = code;
	});

	const deadline = Date.now() + startupTimeoutMs;
	for (;;) {
		const bound = listeningPort(stderr.text);
		if (bound !== undefined) {
			if (bound !== port) {
				proc.kill("SIGKILL");
				await proc.exited;
				throw new DaemonStartError(`the daemon bound port ${bound}, not the ${port} it was given`, {
					pid,
					exitCode: null,
					stderr: stderr.text,
				});
			}
			break;
		}
		if (outcome.exitCode !== undefined) {
			await drained;
			throw new DaemonStartError(
				`the daemon (pid ${pid}) exited ${outcome.exitCode} before logging "draht-gateway listening"; stderr: ${stderr.text.trim()}`,
				{ pid, exitCode: outcome.exitCode, stderr: stderr.text },
			);
		}
		if (Date.now() >= deadline) {
			proc.kill("SIGKILL");
			await proc.exited;
			await drained;
			throw new DaemonStartError(
				`timed out after ${startupTimeoutMs} ms waiting for the daemon (pid ${pid}) to log "draht-gateway listening"; stderr: ${stderr.text.trim()}`,
				{ pid, exitCode: null, stderr: stderr.text },
			);
		}
		await Bun.sleep(Math.max(1, Math.min(25, deadline - Date.now())));
	}

	let disposal: Promise<void> | undefined;
	return {
		pid,
		port,
		token,
		httpBase: `http://127.0.0.1:${port}`,
		wsBase: `ws://127.0.0.1:${port}`,
		stderr,
		dispose: () => {
			disposal ??= stopDaemon(proc, drained, options.terminateGraceMs ?? 10_000);
			return disposal;
		},
	};
}

type FrameOf<T extends GeistServerFrame["type"]> = Extract<GeistServerFrame, { type: T }>;

function isFrameOf<T extends GeistServerFrame["type"]>(frame: GeistServerFrame, type: T): frame is FrameOf<T> {
	return frame.type === type;
}

/**
 * One renderer connection to `/attach`. It keeps every frame twice, parsed and as the text that arrived, because a
 * parse strips unknown keys and a test about what never crossed the wire has to search the text.
 *
 * Fails closed: a frame the protocol schema rejects, or a socket that closed, fails the wait that was in progress
 * instead of letting it run to its deadline and read as "the frame never came".
 *
 * Await a wait directly. Under bun test, `await expect(client.waitFor(...)).rejects` stops the socket delivering
 * messages that are already pending, so a wait expected to time out can "pass" with its frame sitting unread.
 */
export class AttachClient {
	readonly frames: GeistServerFrame[] = [];
	/** `raw[i]` is the exact text of `frames[i]`. */
	readonly raw: string[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;
	readonly #rejected: string[] = [];

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			const text = String(event.data);
			try {
				this.frames.push(ServerFrameSchema.parse(JSON.parse(text)));
				this.raw.push(text);
			} catch (error) {
				this.#rejected.push(`${(error as Error).message.slice(0, 200)} in ${text.slice(0, 300)}`);
			}
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	/** `wsBase` is `ws://127.0.0.1:<port>`, the daemon's `wsBase`. */
	static async open(wsBase: string, token: string, timeoutMs = 10_000): Promise<AttachClient> {
		const url = `${wsBase}/attach`;
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(url, { headers: { Authorization: `Bearer ${token}` } });
		const client = new AttachClient(ws);
		await new Promise<void>((resolveOpen, reject) => {
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch {}
				reject(new Error(`timed out after ${timeoutMs} ms waiting for the /attach socket at ${url} to open`));
			}, timeoutMs);
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolveOpen();
			});
			ws.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error(`the daemon refused a socket at ${url}`));
			});
		});
		return client;
	}

	/** Any object: a test may add the keys the protocol forbids. */
	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	/** Send `frame`, then wait for the first `reply` frame that arrives AFTER it. */
	async ask<T extends GeistServerFrame["type"]>(frame: unknown, reply: T, timeoutMs = 10_000): Promise<FrameOf<T>> {
		const from = this.frames.length;
		this.send(frame);
		const found = await this.#waitFrom(from, (candidate) => candidate.type === reply, `a ${reply} frame`, timeoutMs);
		if (!isFrameOf(found, reply)) throw new Error("unreachable: frame narrowing");
		return found;
	}

	hello(clientName = "spawn-e2e", timeoutMs = 10_000): Promise<FrameOf<"server_hello">> {
		return this.ask(
			{
				type: "hello",
				protocol: GEIST_PROTOCOL_FAMILY,
				version: GEIST_PROTOCOL_VERSION,
				client: { name: clientName, version: "0.0.0" },
			},
			"server_hello",
			timeoutMs,
		);
	}

	/** The first matching frame among ALL received so far, or the next one to arrive. */
	waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs = 10_000,
	): Promise<GeistServerFrame> {
		return this.#waitFrom(0, predicate, what, timeoutMs);
	}

	/** The exact text of the latest `type` frame. Throws when none arrived, so a search of it cannot pass vacuously. */
	rawOf(type: GeistServerFrame["type"]): string {
		const index = this.frames.findLastIndex((frame) => frame.type === type);
		const text = this.raw[index];
		if (text === undefined) throw new Error(`no ${type} frame has arrived (saw: ${this.#seen()})`);
		return text;
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {}
	}

	#seen(): string {
		return this.frames.map((frame) => frame.type).join(", ") || "nothing";
	}

	async #waitFrom(
		from: number,
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs: number,
	): Promise<GeistServerFrame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const rejected = this.#rejected[0];
			if (rejected !== undefined) {
				throw new Error(
					`the daemon sent a frame ServerFrameSchema rejects, while waiting for ${what}: ${rejected}`,
				);
			}
			const found = this.frames.slice(from).find(predicate);
			if (found !== undefined) return found;
			if (this.closed !== null) {
				throw new Error(
					`the /attach socket closed (${this.closed.code} ${JSON.stringify(this.closed.reason)}) while waiting for ${what} (saw: ${this.#seen()})`,
				);
			}
			if (Date.now() >= deadline) {
				throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (saw: ${this.#seen()})`);
			}
			await Bun.sleep(10);
		}
	}
}
