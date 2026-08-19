import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isAttachNotice, isFatalAttachError, resolveAttachSocketPath } from "../src/cli/attach-mode.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeResult } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { discoverSocketSessions, makeSessionAttachable, SocketClient } from "../src/core/socket-server/index.ts";

const tsxPath = createRequire(__filename).resolve("tsx");
const fixturePath = path.resolve(__dirname, "fixtures/attachable-signal-session.ts");

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dsock-life-"));
	tempDirs.push(dir);
	return dir;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for: ${message}`);
}

function createFakeSession(sessionId: string, onPrompt?: (text: string) => void | Promise<void>): AgentSession {
	return {
		sessionManager: {
			getHeader: () => ({ id: sessionId }),
			getCwd: () => process.cwd(),
			getSessionDir: () => process.cwd(),
			isPersisted: () => false,
		},
		sessionFile: undefined,
		extensionRunner: { hasHandlers: () => false },
		dispose: () => {},
		subscribe: () => () => {},
		prompt: async (text: string) => {
			await onPrompt?.(text);
		},
	} as unknown as AgentSession;
}

async function withAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previous;
		}
	}
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("attachable session input safety", () => {
	test("a rejecting prompt reports an error frame and keeps the agent alive", async () => {
		const agentDir = await createTempDir();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const handle = await withAgentDir(agentDir, () =>
				makeSessionAttachable({
					session: createFakeSession("rejects", () => {
						throw new Error("Agent is already processing. Specify streamingBehavior");
					}),
					enabled: true,
					cwd: agentDir,
					log: () => {},
				}),
			);

			const socketPath = handle.socketPath;
			expect(socketPath).not.toBeNull();

			const errors: string[] = [];
			const client = new SocketClient({ socketPath: socketPath as string, clientId: "c1" });
			client.onError((message) => errors.push(message));
			await client.connect();

			client.sendInput("first\n");
			await waitFor(() => errors.length === 1, "error frame for the failed prompt");
			expect(errors[0]).toContain("Agent is already processing");

			// The session survived: a second input still reaches it and still reports back.
			client.sendInput("second\n");
			await waitFor(() => errors.length === 2, "error frame for the second failed prompt");

			client.disconnect();
			await handle.stop();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(unhandled).toEqual([]);
	});
});

describe("attachable session follows session replacement", () => {
	test("rebind moves the socket to the replacement session and stops feeding the disposed one", async () => {
		const agentDir = await createTempDir();
		const socketDir = path.join(agentDir, "sockets");
		const firstPrompts: string[] = [];
		const secondPrompts: string[] = [];

		const handle = await withAgentDir(agentDir, () =>
			makeSessionAttachable({
				session: createFakeSession("first", (text) => {
					firstPrompts.push(text);
				}),
				enabled: true,
				cwd: agentDir,
				log: () => {},
			}),
		);

		expect(existsSync(path.join(socketDir, "first.sock"))).toBe(true);

		await withAgentDir(agentDir, async () => {
			await handle.rebind(
				createFakeSession("second", (text) => {
					secondPrompts.push(text);
				}),
				agentDir,
			);
		});

		expect(handle.sessionId).toBe("second");
		expect(existsSync(path.join(socketDir, "first.sock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "first.lock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "second.sock"))).toBe(true);
		expect((await discoverSocketSessions(socketDir)).map((s) => s.sessionId)).toEqual(["second"]);

		const client = new SocketClient({ socketPath: path.join(socketDir, "second.sock"), clientId: "c1" });
		await client.connect();
		client.sendInput("after switch\n");
		await waitFor(() => secondPrompts.length === 1, "input routed to the replacement session");
		expect(firstPrompts).toEqual([]);

		client.disconnect();
		await handle.stop();
		expect(existsSync(path.join(socketDir, "second.sock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "second.lock"))).toBe(false);
	});

	test("AgentSessionRuntime notifies session-replaced listeners with the new session", async () => {
		const cwd = await createTempDir();
		const first = createFakeSession("runtime-first");
		const second = createFakeSession("runtime-second");
		const services = { cwd, agentDir: cwd } as unknown as AgentSessionServices;

		const runtime = new AgentSessionRuntime(
			first,
			services,
			async () =>
				({
					session: second,
					services,
					diagnostics: [],
				}) as unknown as CreateAgentSessionRuntimeResult,
		);

		const replaced: AgentSession[] = [];
		const unsubscribe = runtime.addSessionReplacedListener((session) => {
			replaced.push(session);
		});

		await runtime.newSession();
		expect(replaced).toEqual([second]);
		expect(runtime.session).toBe(second);

		unsubscribe();
		await runtime.newSession();
		expect(replaced).toEqual([second]);
	});
});

describe("attachable session cleanup on signals", () => {
	async function runFixture(mode: "sole-owner" | "foreign-handler"): Promise<{
		agentDir: string;
		sessionId: string;
		code: number | null;
		signal: NodeJS.Signals | null;
	}> {
		const agentDir = await createTempDir();
		const sessionId = `sig-${mode}`;
		const child = spawn(process.execPath, ["--import", tsxPath, fixturePath], {
			cwd: path.dirname(__dirname),
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				ATTACHABLE_FIXTURE_SESSION_ID: sessionId,
				ATTACHABLE_FIXTURE_MODE: mode === "foreign-handler" ? "foreign-handler" : "",
				TSX_TSCONFIG_PATH: path.resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code, signal) => resolve({ code, signal }));
		});

		try {
			await waitFor(() => stdout.includes("READY"), `fixture startup (stderr: ${stderr})`, 20000);
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		}

		const socketDir = path.join(agentDir, "sockets");
		expect(existsSync(path.join(socketDir, `${sessionId}.sock`))).toBe(true);
		expect(existsSync(path.join(socketDir, `${sessionId}.lock`))).toBe(true);

		child.kill("SIGTERM");
		const result = await exited;
		return { agentDir, sessionId, ...result };
	}

	test("SIGTERM removes the socket and lock when nothing else owns the signal", async () => {
		const { agentDir, sessionId, signal } = await runFixture("sole-owner");
		const socketDir = path.join(agentDir, "sockets");

		expect(existsSync(path.join(socketDir, `${sessionId}.sock`))).toBe(false);
		expect(existsSync(path.join(socketDir, `${sessionId}.lock`))).toBe(false);
		// The signal is re-raised, so the process still dies from SIGTERM.
		expect(signal).toBe("SIGTERM");
	}, 40000);

	test("SIGTERM removes the socket and lock when the mode owns the signal and exits", async () => {
		const { agentDir, sessionId, code } = await runFixture("foreign-handler");
		const socketDir = path.join(agentDir, "sockets");

		expect(existsSync(path.join(socketDir, `${sessionId}.sock`))).toBe(false);
		expect(existsSync(path.join(socketDir, `${sessionId}.lock`))).toBe(false);
		expect(code).toBe(0);
	}, 40000);
});

describe("--attach session id validation", () => {
	test("rejects ids that would escape the socket directory", () => {
		expect(() => resolveAttachSocketPath("../../etc/passwd", "/tmp/sockets")).toThrow(/Session id/);
		expect(() => resolveAttachSocketPath("a/b", "/tmp/sockets")).toThrow(/Session id/);
		expect(() => resolveAttachSocketPath("..", "/tmp/sockets")).toThrow(/Session id/);
		expect(() => resolveAttachSocketPath(".hidden", "/tmp/sockets")).toThrow(/Session id/);
		expect(() => resolveAttachSocketPath("", "/tmp/sockets")).toThrow(/Session id/);
	});

	test("accepts a normal session id", () => {
		expect(resolveAttachSocketPath("01a01639-9024-7f4e", "/tmp/sockets")).toBe(
			"/tmp/sockets/01a01639-9024-7f4e.sock",
		);
	});
});

describe("attach client error frame handling", () => {
	test("the frames round-2 added are non-fatal, unknown frames stay fatal", () => {
		// Both are recoverable: the session is still there and still attached.
		expect(isFatalAttachError("PROMPT_FAILED")).toBe(false);
		expect(isFatalAttachError("SESSION_REPLACED")).toBe(false);
		// R32-FLEET.7: a prompt sent mid-turn is queued and the sender is told so.
		// That notice rides the same coded error channel, and it must not end the
		// attached client - the prompt it describes is about to run.
		expect(isFatalAttachError("PROMPT_QUEUED")).toBe(false);
		// Anything else - protocol errors, rejected attaches - still ends the client.
		expect(isFatalAttachError(undefined)).toBe(true);
		expect(isFatalAttachError("MAX_CLIENTS")).toBe(true);
	});

	test("the queued-prompt notice is a notice, not a failure", () => {
		// It rides the `error` channel because the socket wire has only one, but
		// it reports success - rendering it as an error would say the opposite of
		// what happened.
		expect(isAttachNotice("PROMPT_QUEUED")).toBe(true);
		expect(isAttachNotice("PROMPT_FAILED")).toBe(false);
		expect(isAttachNotice("SESSION_REPLACED")).toBe(false);
		expect(isAttachNotice(undefined)).toBe(false);
	});

	test("a failed prompt reaches the client as a non-fatal coded frame", async () => {
		const agentDir = await createTempDir();
		const handle = await withAgentDir(agentDir, () =>
			makeSessionAttachable({
				session: createFakeSession("coded", () => {
					throw new Error("Agent is already processing");
				}),
				enabled: true,
				cwd: agentDir,
				log: () => {},
			}),
		);

		const frames: Array<{ message: string; code?: string }> = [];
		const client = new SocketClient({ socketPath: handle.socketPath as string, clientId: "c1" });
		client.onError((message, code) => frames.push({ message, code }));
		await client.connect();

		client.sendInput("go\n");
		await waitFor(() => frames.length === 1, "prompt failure frame");
		expect(frames[0].code).toBe("PROMPT_FAILED");
		expect(isFatalAttachError(frames[0].code)).toBe(false);

		client.disconnect();
		await handle.stop();
	});
});

describe("server-side session id validation", () => {
	test("refuses a session file whose id would escape the socket directory", async () => {
		for (const evil of ["../../evil", "a/b", "..", ".hidden"]) {
			const agentDir = await createTempDir();
			await expect(
				withAgentDir(agentDir, () =>
					makeSessionAttachable({
						session: createFakeSession(evil),
						enabled: true,
						cwd: agentDir,
						log: () => {},
					}),
				),
			).rejects.toThrow(/Session id/);
			// Nothing was created anywhere, inside the socket dir or outside it.
			expect(existsSync(path.join(agentDir, "sockets"))).toBe(false);
			expect(existsSync(path.resolve(agentDir, "../evil.sock"))).toBe(false);
		}
	});
});
