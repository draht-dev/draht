import { type ChildProcess, fork } from "node:child_process";
import type { SessionWorkerCommand, SessionWorkerEvent } from "./session-worker-process.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ExperimentalSessionWorker {
	readonly sessionId: string;
	readonly pid: number;
	readonly terminated: Promise<Error | undefined>;
	close(): Promise<void>;
}

export interface StartExperimentalSessionWorkerOptions {
	readonly startupTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly workerUrl?: URL;
}

export async function startExperimentalSessionWorker(
	sessionId: string,
	options: StartExperimentalSessionWorkerOptions = {},
): Promise<ExperimentalSessionWorker> {
	const startupTimeoutMs = validateTimeout(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
	const shutdownTimeoutMs = validateTimeout(
		options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
		"shutdownTimeoutMs",
	);
	const workerUrl = options.workerUrl ?? defaultWorkerUrl();
	const child = fork(workerUrl, [sessionId], {
		execArgv: workerExecArgv(workerUrl),
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});

	try {
		const ready = await waitForReady(child, sessionId, startupTimeoutMs);
		return new ChildSessionWorker(child, ready.sessionId, ready.pid, shutdownTimeoutMs);
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await waitForExit(child);
		throw error;
	}
}

function validateTimeout(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
		throw new TypeError(`Session worker ${name} must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return value;
}

function workerExecArgv(workerUrl: URL): string[] {
	return workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : process.execArgv;
}

function defaultWorkerUrl(): URL {
	return new URL(
		import.meta.url.endsWith(".js") ? "session-worker-process.js" : "session-worker-process.ts",
		import.meta.url,
	);
}

class ChildSessionWorker implements ExperimentalSessionWorker {
	readonly terminated: Promise<Error | undefined>;
	readonly sessionId: string;
	readonly pid: number;
	readonly #child: ChildProcess;
	readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	readonly #shutdownTimeoutMs: number;
	#closePromise?: Promise<void>;
	#closeRequested = false;

	constructor(child: ChildProcess, sessionId: string, pid: number, shutdownTimeoutMs: number) {
		this.#child = child;
		this.sessionId = sessionId;
		this.pid = pid;
		this.#shutdownTimeoutMs = shutdownTimeoutMs;
		this.#exit = waitForExit(child);
		this.terminated = this.#exit.then(({ code, signal }) =>
			this.#closeRequested
				? undefined
				: new Error(`Session worker ${sessionId} exited unexpectedly (${signal ?? code ?? "unknown"})`),
		);
	}

	close(): Promise<void> {
		this.#closeRequested = true;
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		if (!this.#child.connected) {
			this.#child.kill("SIGKILL");
		} else {
			this.#child.send({ type: "shutdown" } satisfies SessionWorkerCommand, (error) => {
				if (error) this.#child.kill("SIGKILL");
			});
		}
		const timeout = setTimeout(() => this.#child.kill("SIGKILL"), this.#shutdownTimeoutMs);
		timeout.unref();
		try {
			await this.#exit;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function waitForReady(
	child: ChildProcess,
	expectedSessionId: string,
	startupTimeoutMs: number,
): Promise<Extract<SessionWorkerEvent, { type: "ready" }>> {
	return new Promise((resolve, reject) => {
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const fail = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onMessage = (message: SessionWorkerEvent): void => {
			if (message?.type === "failed") {
				fail(new Error(`Session worker failed: ${message.message}`));
				return;
			}
			if (message?.type !== "ready") return;
			if (message.sessionId !== expectedSessionId || message.pid !== child.pid) {
				fail(new Error("Session worker reported an invalid identity"));
				return;
			}
			cleanup();
			resolve(message);
		};
		const onError = (error: Error): void => fail(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			fail(new Error(`Session worker exited before readiness (${signal ?? code ?? "unknown"})`));
		};
		timeout = setTimeout(
			() => fail(new Error(`Session worker startup timed out after ${startupTimeoutMs}ms`)),
			startupTimeoutMs,
		);
		timeout.unref();
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}
