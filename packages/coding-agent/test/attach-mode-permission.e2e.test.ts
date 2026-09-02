/**
 * R34-PERM.2 — `draht --attach` is the third renderer, and it must both RENDER a permission ask
 * and ANSWER it.
 *
 * This is the surface that used to SWALLOW answers. `rl.on("line")` forwarded every typed line as
 * an `input` frame, and `input` goes straight to `session.prompt(...)` — so a human typing "Yes"
 * at a dialog the session had raised did not answer it. The word arrived as a queued chat message
 * while the agent sat parked inside `beforeToolCall`, waiting for a decision that could not reach
 * it. Nothing about that failure was visible: the operator saw their word accepted and the agent
 * stayed silent forever.
 *
 * EVIDENCE CLASS 3. Two (three, here) EMITTED BINARIES talking over the real Unix socket wire:
 *
 *   • one `node dist/cli.js --attachable --mode rpc` session, keyless stub provider, scripted to
 *     issue one real `bash` tool call that writes a marker file — so "was it approved?" is
 *     answered by the FILE SYSTEM, not by a frame the test itself decoded;
 *   • two `node dist/cli.js --attach <id>` clients, driven through their real stdin/stdout.
 *
 * Nothing in the SPAWNED tests imports `attach-mode.ts`, `socket-client.ts` or anything else under
 * test. A package-level test that constructed a `SocketClient` in-process could pass while the
 * shipped `--attach` binary still swallowed every answer, which is precisely the state this task
 * inherited.
 *
 * The one deliberate exception is the last block in this file: `matchPermissionAnswer` is exported
 * with the note "Exported for the option-matching tests", and until now there were none — a
 * mutation that reduced it to label matching, deleting BOTH the id branch and the ordinal branch,
 * left this suite green while the renderer went on printing "Type the number, the label or the id
 * to answer." to every operator. Those unit tests are a SUPPLEMENT and never a substitute: the
 * spawned test below types `1` and `approve` at the emitted binary, so the wiring from a typed line
 * to a released tool call is still proved by a file on disk, and the unit tests only pin down the
 * corners (case folding, out-of-range ordinals, the id-beats-ordinal precedence) that would cost a
 * whole extra session each to drive through a socket.
 *
 * WHY `--mode rpc` AND NOT `-p`: with no TTY, print mode runs its prompt and exits at startup —
 * the tool call would be gated before any client could attach, and `hasUI` would be false, so the
 * gate would hard-block with "no UI available" and no ask would ever be raised. Under `--mode rpc`
 * the session stays up, and the prompt is delivered THROUGH THE ATTACH CLIENT'S OWN STDIN, which
 * is also the strongest possible statement of the bug being fixed: the same channel carries a
 * prompt when nothing is pending and an ANSWER when something is.
 *
 * Harness hygiene, each item paid for by a probe that passed while proving nothing:
 *  - `DRAHT_PERMISSION_MODE` is DELETED from the child env (the env is BUILT, not inherited). This
 *    repo's interactive shell exports `auto`, under which the scripted `bash` call is auto-allowed
 *    and NO ask is ever raised.
 *  - Every temp dir sits directly under `/tmp` with a short name: a Unix socket path over ~104
 *    bytes fails to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { matchPermissionAnswer } from "../src/cli/attach-mode.ts";

const PKG_ROOT = path.resolve(__dirname, "..");
const EMITTED_CLI = path.join(PKG_ROOT, "dist", "cli.js");

const WAIT_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 120_000;

/**
 * A line that names NO option the ask offered.
 *
 * Deliberately unmistakable: the test proves this string reached neither the session's prompt
 * queue nor its permission registry by searching the session's own RPC stdout for it, and a word
 * like "maybe" could plausibly appear in unrelated model or tool output.
 */
const NON_OFFERED_ANSWER = "banana-is-not-an-offered-option";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join("/tmp", prefix));
	tempDirs.push(dir);
	return dir;
}

function buildEmittedBinary(): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("bun", ["run", "build"], {
			cwd: PKG_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build failed:\n${out}`))));
	});
}

beforeAll(async () => {
	await buildEmittedBinary();
}, 300_000);

afterAll(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `probe` is true, then return.
 *
 * `what` is quoted verbatim in the failure, along with whatever the caller wants to show, because
 * a timeout in a three-process test is unreadable without the children's own output.
 */
async function until(probe: () => boolean, what: string, describe: () => string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (probe()) return;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${what}\n${describe()}`);
}

/** One spawned binary plus everything it has written so far. */
interface Child {
	proc: ChildProcessWithoutNullStreams;
	stdout: () => string;
	stderr: () => string;
	type: (line: string) => void;
}

function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv): Child {
	const proc = spawn("node", [EMITTED_CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	children.push(proc);
	let out = "";
	let err = "";
	proc.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	proc.stderr.on("data", (chunk) => {
		err += String(chunk);
	});
	return {
		proc,
		stdout: () => out,
		stderr: () => err,
		type: (line: string) => {
			proc.stdin.write(`${line}\n`);
		},
	};
}

function socketIds(socketDir: string): string[] {
	try {
		return readdirSync(socketDir)
			.filter((entry) => entry.endsWith(".sock"))
			.map((entry) => entry.slice(0, -".sock".length));
	} catch {
		return [];
	}
}

/** Every line of `text`, trimmed of the trailing whitespace readline leaves behind. */
function lines(text: string): string[] {
	return text.split("\n").map((line) => line.trimEnd());
}

/** How many times a whole line equal to `value` (after trimming) appears. */
function countLines(text: string, value: string): number {
	return lines(text).filter((line) => line.trim() === value).length;
}

test(
	"draht --attach renders a permission ask from its typed fields and answers it, and a non-offered line is neither an answer nor a prompt",
	async () => {
		const agentDir = await createTempDir("amp-a-");
		const home = await createTempDir("amp-h-");
		// The gate canonicalizes the cwd it puts on the wire, so the expected string must be the
		// real path — on macOS /tmp is a symlink to /private/tmp and the raw path would never match.
		const cwd = realpathSync(await createTempDir("amp-c-"));
		const marker = path.join(cwd, "attach-approved.txt");
		const command = `echo approved > ${marker}`;
		const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);

		// BUILT, never inherited: `DRAHT_PERMISSION_MODE=auto` from this repo's shell auto-allows the
		// scripted call, and the whole test would go green having raised no ask at all.
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			DRAHT_STUB_PROVIDER: "1",
			DRAHT_STUB_TOOL_CALLS: script,
		};

		const socketDir = path.join(agentDir, "sockets");
		const session = launch(
			["--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
			cwd,
			env,
		);

		try {
			await until(
				() => socketIds(socketDir).length > 0,
				"the attachable session to publish its socket",
				() => `session stderr:\n${session.stderr()}`,
			);
			const sessionId = socketIds(socketDir)[0];

			// ── the deciding surface ────────────────────────────────────────────────────────────
			const attached = launch(["--attach", sessionId], cwd, env);
			await until(
				() => attached.stdout().includes("Connected to session"),
				"the first --attach client to connect",
				() => `attach stdout:\n${attached.stdout()}\nattach stderr:\n${attached.stderr()}`,
			);

			// The prompt goes in on the SAME stdin that will later carry the answer. Nothing is
			// pending, so this line is forwarded as input — which is the behaviour that must survive.
			attached.type("run it");

			await until(
				() => attached.stdout().includes("Permission required"),
				"the attach client to render the permission ask",
				() => `attach stdout:\n${attached.stdout()}\nsession stderr:\n${session.stderr()}`,
			);

			const ask = attached.stdout();

			// RENDERED FROM THE TYPED FIELDS, each on its own line. The `Directory:` line is the
			// decisive one: the legacy summary sentence is `${toolName}: ${reason}` and contains no
			// cwd at all, so a renderer that printed only `title`/`message` could not produce it.
			expect(lines(ask)).toContain("  Tool: bash");
			expect(lines(ask)).toContain(`  Directory: ${cwd}`);
			expect(lines(ask)).toContain(`  Command: ${command}`);

			// …and a NUMBERED list of exactly the options the ask offered.
			expect(lines(ask)).toContain("  1) Yes [approve]");
			expect(lines(ask)).toContain("  2) No [deny]");

			// Not spliced into the output stream: the ask is its own block, printed once.
			expect(countLines(ask, "Permission required")).toBe(1);

			// ── a second surface attaches mid-ask: the replay renders exactly once ──────────────
			const watcher = launch(["--attach", sessionId], cwd, env);
			await until(
				() => watcher.stdout().includes("Permission required"),
				"the replayed ask to reach a client that attached after it was raised",
				() => `watcher stdout:\n${watcher.stdout()}\nwatcher stderr:\n${watcher.stderr()}`,
			);
			expect(lines(watcher.stdout())).toContain(`  Command: ${command}`);
			expect(countLines(watcher.stdout(), "Permission required")).toBe(1);

			// ── a line that names no offered option ─────────────────────────────────────────────
			const beforeNonOffered = attached.stdout().length;
			attached.type(NON_OFFERED_ANSWER);
			await until(
				() => attached.stdout().slice(beforeNonOffered).includes("Not one of the offered answers"),
				"the attach client to refuse a non-offered answer locally",
				() => `attach stdout:\n${attached.stdout()}`,
			);

			// It decided nothing: the tool has not run.
			expect(existsSync(marker)).toBe(false);
			// And it was not forwarded as a prompt either. The session's own RPC stdout carries every
			// user message it accepts, so the absence of the word there is the proof that the
			// swallow-an-answer-as-a-prompt path is gone.
			await sleep(1000);
			expect(session.stdout()).not.toContain(NON_OFFERED_ANSWER);
			// The ask is still up: answer mode ends on `permission_resolved`, not on a typed line.
			expect(attached.stdout()).not.toContain("Permission approved");

			// ── the offered answer, spelled the way a human spells it ───────────────────────────
			// "Yes" is the LABEL — literally the word that used to become a queued chat prompt.
			//
			// TWICE, IN ONE WRITE, and that is deliberate: both lines reach readline in the same
			// chunk and are handled in the same tick, so the second answer goes out while the
			// client is still — correctly — in answer mode, long before the resolution can round
			// trip. The session refuses it with a `PERMISSION_*` code, which is the only way to
			// exercise those codes end to end from this surface, and the assertions below are what
			// make "a refusal is not a dead session" falsifiable: a fatal classification exits the
			// client with code 1 and no resolution line is ever printed.
			attached.proc.stdin.write("Yes\nYes\n");
			await until(
				() => existsSync(marker),
				"the approved bash call to run",
				() => `attach stdout:\n${attached.stdout()}\nsession stderr:\n${session.stderr()}`,
			);

			// The echo names the deciding surface, on BOTH surfaces — the one that answered and the
			// one that lost. A surface left holding a dialog somebody else already decided is the
			// failure this echo exists to prevent.
			for (const client of [attached, watcher]) {
				await until(
					() => client.stdout().includes("answered on"),
					"the resolution echo to reach both attached surfaces",
					() => `client stdout:\n${client.stdout()}`,
				);
				const resolution = lines(client.stdout()).find((line) => line.includes("answered on"));
				expect(resolution).toBeDefined();
				expect(resolution).toContain("Permission approved [approve]");
				expect(resolution).toContain("answered on attach");
			}

			// The refused second answer arrived, was reported, and was NOT fatal: the client is
			// still running and still attached.
			await until(
				() =>
					attached.stdout().includes("was already resolved by") ||
					attached.stderr().includes("was already resolved by"),
				"the session to refuse the duplicate answer",
				() => `attach stdout:\n${attached.stdout()}\nattach stderr:\n${attached.stderr()}`,
			);
			await sleep(500);
			expect(attached.proc.exitCode).toBeNull();
			expect(watcher.proc.exitCode).toBeNull();
		} finally {
			for (const child of children.splice(0)) child.kill("SIGKILL");
		}
	},
	TEST_TIMEOUT_MS,
);

/**
 * Every resolution echo printed so far, in order, trimmed of the blank lines around each one.
 *
 * `Permission required` is excluded by the `answered on` clause and the local
 * `Answered "Yes" — waiting…` acknowledgement by the leading word, so what comes back is exactly
 * the lines {@link renderPermissionResolution} produced.
 */
function resolutionEchoes(text: string): string[] {
	return lines(text)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("Permission ") && line.includes("answered on"));
}

/** The full shape of a resolution echo, so a captured group can be re-used as an expectation. */
const RESOLUTION_ECHO = /^Permission (approved|denied) \[([a-z-]+)\] — answered on ([a-z-]+) \(([^)]+)\)$/;

test(
	"draht --attach honours every answer form its own dialog advertises — the ordinal and the id — and No really denies",
	async () => {
		const agentDir = await createTempDir("amp2-a-");
		const home = await createTempDir("amp2-h-");
		const cwd = realpathSync(await createTempDir("amp2-c-"));

		// Three scripted `bash` calls, three asks, three DIFFERENT files. Each marker is written by
		// its own call and by nothing else, so "which answer released which call" is a question the
		// file system answers: the previous test could only ever prove that SOMETHING was approved.
		const markers = {
			ordinal: path.join(cwd, "answered-by-ordinal.txt"),
			id: path.join(cwd, "answered-by-id.txt"),
			denied: path.join(cwd, "must-never-exist.txt"),
		};
		const commands = [
			`echo ordinal > ${markers.ordinal}`,
			`echo id > ${markers.id}`,
			`echo denied > ${markers.denied}`,
		];
		const script = JSON.stringify(
			commands.map((command, index) => ({
				toolCalls: [{ id: `call-${index + 1}`, name: "bash", arguments: { command } }],
			})),
		);

		// BUILT, never inherited — see the first test.
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			DRAHT_STUB_PROVIDER: "1",
			DRAHT_STUB_TOOL_CALLS: script,
		};

		const socketDir = path.join(agentDir, "sockets");
		const session = launch(
			["--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
			cwd,
			env,
		);

		try {
			await until(
				() => socketIds(socketDir).length > 0,
				"the attachable session to publish its socket",
				() => `session stderr:\n${session.stderr()}`,
			);
			const sessionId = socketIds(socketDir)[0];

			const attached = launch(["--attach", sessionId], cwd, env);
			await until(
				() => attached.stdout().includes("Connected to session"),
				"the --attach client to connect",
				() => `attach stdout:\n${attached.stdout()}\nattach stderr:\n${attached.stderr()}`,
			);

			/** Wait for the nth ask (1-based) and prove it is the one gating `command`. */
			const askFor = async (ordinal: number, command: string): Promise<void> => {
				await until(
					() =>
						countLines(attached.stdout(), "Permission required") === ordinal &&
						lines(attached.stdout()).includes(`  Command: ${command}`),
					`ask #${ordinal}, gating ${JSON.stringify(command)}`,
					() => `attach stdout:\n${attached.stdout()}\nsession stderr:\n${session.stderr()}`,
				);
			};

			/** Wait for the nth resolution echo (1-based) and return it. */
			const echoFor = async (ordinal: number): Promise<string> => {
				await until(
					() => resolutionEchoes(attached.stdout()).length === ordinal,
					`resolution echo #${ordinal}`,
					() => `attach stdout:\n${attached.stdout()}\nsession stderr:\n${session.stderr()}`,
				);
				return resolutionEchoes(attached.stdout())[ordinal - 1];
			};

			attached.type("run the scripted tools");
			await askFor(1, commands[0]);

			// The dialog makes a PROMISE, in these words, to every operator who sees it. The three
			// answers below are that promise, tested: a renderer may not offer a spelling the
			// matcher does not accept.
			expect(attached.stdout()).toContain("Type the number, the label or the id to answer.");

			// ── the ORDINAL: the number the list itself printed ─────────────────────────────────
			attached.type("1");
			await until(
				() => existsSync(markers.ordinal),
				"the call approved by typing its ordinal to run",
				() => `attach stdout:\n${attached.stdout()}\nsession stderr:\n${session.stderr()}`,
			);
			const first = await echoFor(1);
			const parsed = RESOLUTION_ECHO.exec(first);
			expect(parsed, `resolution echo did not have the documented shape: ${JSON.stringify(first)}`).not.toBeNull();
			const clientId = (parsed as RegExpExecArray)[4];
			// EXACT, not a substring: every field of the frame has to reach the line, in its place.
			// A `renderPermissionResolution` replaced by a constant string cannot satisfy this
			// assertion AND the denial's below, because the two differ in three of four fields.
			expect(first).toBe(`Permission approved [approve] — answered on attach (${clientId})`);

			// ── the ID: the word in brackets, which is NOT the label ────────────────────────────
			await askFor(2, commands[1]);
			expect(existsSync(markers.id)).toBe(false);
			attached.type("approve");
			await until(
				() => existsSync(markers.id),
				"the call approved by typing its option id to run",
				() => `attach stdout:\n${attached.stdout()}\nsession stderr:\n${session.stderr()}`,
			);
			// Same surface, same connection: the client id is the one that answered, not a constant
			// and not the session's.
			expect(await echoFor(2)).toBe(`Permission approved [approve] — answered on attach (${clientId})`);

			// ── and No, which has to mean no ────────────────────────────────────────────────────
			await askFor(3, commands[2]);
			attached.type("deny");
			const denial = await echoFor(3);

			// THE ORACLE, and it is checked BEFORE the wording: the denied command writes a file,
			// and the file is not there — after long enough that both approved siblings had already
			// written theirs by this point in their own round trip. This is the assertion that
			// distinguishes "No was rendered" from "No denied": a client that sent the FIRST
			// option's id whatever the human typed passes every string assertion in this file and
			// fails right here.
			await sleep(2000);
			expect(existsSync(markers.denied)).toBe(false);
			// …and the contrast is inside this same run: the two approvals did land.
			expect(existsSync(markers.ordinal)).toBe(true);
			expect(existsSync(markers.id)).toBe(true);

			// Same renderer, different everything: this is the second decision the resolution
			// renderer has ever been asked to print, and the first one it can get wrong quietly.
			expect(denial).toBe(`Permission denied [deny] — answered on attach (${clientId})`);

			// A denial is not a dead client either: it is still attached, still running.
			expect(attached.proc.exitCode).toBeNull();
		} finally {
			for (const child of children.splice(0)) child.kill("SIGKILL");
		}
	},
	TEST_TIMEOUT_MS,
);

/**
 * The option-matching tests the export was made for.
 *
 * Driven in-process ON PURPOSE (see the file header): the spawned test above proves the emitted
 * binary really answers by ordinal and by id, and these pin the corners of the rule — which
 * spellings resolve, which deliberately do NOT, and what wins when a label collides with an
 * ordinal — at a cost of microseconds rather than a session apiece.
 */
describe("matchPermissionAnswer", () => {
	const options = [
		{ id: "approve", label: "Yes" },
		{ id: "deny", label: "No" },
	] as const;

	test("resolves an option by its id, case-folded and untrimmed", () => {
		expect(matchPermissionAnswer("approve", options)?.id).toBe("approve");
		expect(matchPermissionAnswer("DENY", options)?.id).toBe("deny");
		expect(matchPermissionAnswer("  approve  ", options)?.id).toBe("approve");
	});

	test("resolves an option by its label, case-folded and untrimmed", () => {
		expect(matchPermissionAnswer("Yes", options)?.id).toBe("approve");
		expect(matchPermissionAnswer("no", options)?.id).toBe("deny");
		expect(matchPermissionAnswer(" NO ", options)?.id).toBe("deny");
	});

	test("resolves an option by its 1-based position in the rendered list", () => {
		expect(matchPermissionAnswer("1", options)?.id).toBe("approve");
		expect(matchPermissionAnswer("2", options)?.id).toBe("deny");
		expect(matchPermissionAnswer(" 2 ", options)?.id).toBe("deny");
	});

	test("an ordinal outside the offered list names nothing", () => {
		// 0 and n+1 are the two an off-by-one produces, and either would answer an ask with an
		// option nobody offered — or, for 0, with `options[-1]`, which is `undefined`.
		expect(matchPermissionAnswer("0", options)).toBeUndefined();
		expect(matchPermissionAnswer("3", options)).toBeUndefined();
		expect(matchPermissionAnswer("-1", options)).toBeUndefined();
	});

	test("invents nothing: no prefix, no y/n, no default, no empty line", () => {
		expect(matchPermissionAnswer("y", options)).toBeUndefined();
		expect(matchPermissionAnswer("ye", options)).toBeUndefined();
		expect(matchPermissionAnswer("n", options)).toBeUndefined();
		expect(matchPermissionAnswer("", options)).toBeUndefined();
		expect(matchPermissionAnswer("   ", options)).toBeUndefined();
		expect(matchPermissionAnswer("banana", options)).toBeUndefined();
		expect(matchPermissionAnswer("1 approve", options)).toBeUndefined();
	});

	test("a named option beats the position it collides with", () => {
		// The documented precedence, and the reason it exists: an ask that offers an option
		// literally called "1" is answered by NAMING it, not by whatever happens to sit first.
		const collide = [
			{ id: "approve", label: "Yes" },
			{ id: "1", label: "Only this once" },
		] as const;
		expect(matchPermissionAnswer("1", collide)?.id).toBe("1");
		// …and with no such collision the same line still means the first option.
		expect(matchPermissionAnswer("1", options)?.id).toBe("approve");
	});

	test("an empty option set resolves nothing, by any spelling", () => {
		expect(matchPermissionAnswer("1", [])).toBeUndefined();
		expect(matchPermissionAnswer("approve", [])).toBeUndefined();
	});
});
