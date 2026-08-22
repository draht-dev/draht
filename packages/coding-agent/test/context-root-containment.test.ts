/**
 * R36-SPAWN.6 / GSEC-13 — automatically-read project context is a NO-FOLLOW regular file
 * that is canonically contained under an approved root.
 *
 * Project context (AGENTS.md / CLAUDE.md) is read without anyone asking, and its bytes land
 * verbatim inside `buildSystemPrompt` and therefore inside the very first provider request.
 * That makes it attacker-reachable input on any repository a session is pointed at, so the
 * loader owes three properties: symlinks are refused rather than followed, special files are
 * skipped rather than read, and the ancestor walk stops at the project root instead of
 * running to `/`.
 *
 * EVERY containment assertion here pairs "the out-of-root canary is absent" with "the in-root
 * canary IS present". Without the positive half a loader that returns nothing at all passes
 * this file forever.
 *
 * ## What the containment cases below can and cannot witness (MEASURED, not reasoned)
 *
 * `resource-loader.ts` enforces containment TWICE — a walk break at the top of the ancestor
 * loop, and a per-file `realpathSync` check inside `loadContextFileFromDir` — and the second
 * one's refusal branch IS UNREACHABLE through this module's exported surface. Proof, by
 * tripwire: with `process.stderr.write` on both branches, five shapes were driven through
 * `loadProjectContextFiles` (a symlinked cwd, a symlinked directory component walked from
 * below, a hardlink into the root, a self-referential symlink whose `realpath` fails, and a
 * root reached through a symlinked prefix). The walk break fired every time; the per-file
 * branch fired NEVER. It cannot: the walk break tests `realpath(dir)` and the per-file check
 * tests `realpath(dir/AGENTS.md)`, the leaf is never itself a symlink (that is refused one
 * check earlier), so the second is implied by the first.
 *
 * So the two are not two layers. `the ancestor walk stops at the context root` below witnesses
 * the walk break ALONE — by asserting nothing above the root was ever inspected, which the
 * per-file check cannot make true — and the per-file check is left deliberately unwitnessed
 * rather than covered by a case that would pass with it deleted. See the report accompanying
 * this change for the source change that would make it independently reachable.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "../src/core/resource-loader.ts";
import {
	createStubProvider,
	STUB_MODEL_ID,
	STUB_PROVIDER_ENV,
	STUB_PROVIDER_ID,
	STUB_PROVIDER_RECORD_CONTEXT_ENV,
} from "../src/extensions/stub-provider/provider.ts";

const OUT_OF_ROOT_CANARY = "OUT-OF-ROOT-CANARY-4f1a9c";
const IN_ROOT_CANARY = "IN-ROOT-CANARY-7b23de";

/**
 * The CLI entry as SOURCE, run under bun.
 *
 * Deliberately not `dist/cli.js`: a test that asserts the flag is wired would otherwise be
 * asserting it about whatever was last built, and would stay green against a `main.ts` in
 * this checkout that no longer passes it.
 */
const CLI_SOURCE_ENTRY = resolve(__dirname, "..", "src", "cli.ts");

let tmp: string;
let agentDir: string;

/** Concatenated content of everything the loader decided to hand to the system prompt. */
function contentOf(files: Array<{ path: string; content: string }>): string {
	return files.map((f) => f.content).join("\n");
}

beforeEach(() => {
	// /private/tmp, not /tmp: /tmp is a symlink on macOS and every containment comparison
	// here is against canonical paths.
	tmp = mkdtempSync("/private/tmp/ctx-root-");
	agentDir = join(tmp, "agent");
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("project context files are no-follow", () => {
	it("refuses an AGENTS.md that is a symlink to a file outside the root, and still loads the real one beside it", () => {
		const outside = join(tmp, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.md"), `${OUT_OF_ROOT_CANARY}\n`);

		const project = join(tmp, "project");
		mkdirSync(project, { recursive: true });
		symlinkSync(join(outside, "secret.md"), join(project, "AGENTS.md"));
		writeFileSync(join(project, "CLAUDE.md"), `${IN_ROOT_CANARY}\n`);

		const files = loadProjectContextFiles({ cwd: project, agentDir, contextRoot: project });
		const text = contentOf(files);

		expect(text).not.toContain(OUT_OF_ROOT_CANARY);
		// POSITIVE CONTROL: a loader that returned nothing would satisfy the line above.
		expect(text).toContain(IN_ROOT_CANARY);
		expect(files.map((f) => f.path)).not.toContain(join(project, "AGENTS.md"));
	});

	it("refuses a symlinked AGENTS.md even with no context root configured", () => {
		const outside = join(tmp, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.md"), `${OUT_OF_ROOT_CANARY}\n`);

		const project = join(tmp, "project");
		mkdirSync(project, { recursive: true });
		symlinkSync(join(outside, "secret.md"), join(project, "AGENTS.md"));
		writeFileSync(join(project, "CLAUDE.md"), `${IN_ROOT_CANARY}\n`);

		const text = contentOf(loadProjectContextFiles({ cwd: project, agentDir }));

		expect(text).not.toContain(OUT_OF_ROOT_CANARY);
		expect(text).toContain(IN_ROOT_CANARY);
	});

	it("skips a fifo, a directory and a symlink to a device without hanging", () => {
		const fifoDir = join(tmp, "fifo-project");
		mkdirSync(fifoDir, { recursive: true });
		execFileSync("mkfifo", [join(fifoDir, "AGENTS.md")]);
		writeFileSync(join(fifoDir, "CLAUDE.md"), `${IN_ROOT_CANARY}\n`);

		const dirDir = join(tmp, "dir-project");
		mkdirSync(join(dirDir, "AGENTS.md"), { recursive: true });
		writeFileSync(join(dirDir, "CLAUDE.md"), `${IN_ROOT_CANARY}\n`);

		const devDir = join(tmp, "dev-project");
		mkdirSync(devDir, { recursive: true });
		symlinkSync("/dev/zero", join(devDir, "AGENTS.md"));
		writeFileSync(join(devDir, "CLAUDE.md"), `${IN_ROOT_CANARY}\n`);

		for (const dir of [fifoDir, dirDir, devDir]) {
			const files = loadProjectContextFiles({ cwd: dir, agentDir, contextRoot: dir });
			expect(files.map((f) => f.path)).toEqual([join(dir, "CLAUDE.md")]);
			expect(contentOf(files)).toContain(IN_ROOT_CANARY);
		}
	});
});

describe("the ancestor walk stops at the context root", () => {
	it("does not load an AGENTS.md above the root, and does load the one inside it", () => {
		const above = join(tmp, "above");
		const root = join(above, "root");
		const deep = join(root, "packages", "thing");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(above, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		const files = loadProjectContextFiles({ cwd: deep, agentDir, contextRoot: root });
		const text = contentOf(files);

		expect(text).not.toContain(OUT_OF_ROOT_CANARY);
		// POSITIVE CONTROL and the BOUNDARY CHOICE: the root is the PROJECT root, not the
		// session cwd, so a subdirectory session still inherits the repo-root AGENTS.md.
		expect(text).toContain(IN_ROOT_CANARY);
		expect(files.map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
	});

	it("STOPS at the root rather than walking to / and filtering — nothing above it is inspected", () => {
		// THE INDEPENDENT WITNESS FOR THE WALK BREAK (resource-loader.ts, top of the ancestor
		// loop). Every other containment case here is satisfied by EITHER enforcement point,
		// so deleting the break alone leaves them all green: the walk runs on to `/` and the
		// per-file check refuses each ancestor, and the CONTENT is identical.
		//
		// What is not identical is whether anything above the root was looked at. The break
		// means the loader never lstats, never realpaths and never reports a path outside the
		// project — the per-file check cannot make that true, because it only runs after a
		// candidate has been stat'd. So the assertion is on the loader's own warnings: with
		// the break in place there is NO complaint about the ancestor, because the ancestor
		// was never reached; with it deleted, `Ignoring context file …: outside context root`
		// names it.
		const above = join(tmp, "above");
		const root = join(above, "root");
		const deep = join(root, "packages", "thing");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(above, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		const warnings: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		let files: Array<{ path: string; content: string }>;
		try {
			files = loadProjectContextFiles({ cwd: deep, agentDir, contextRoot: root });
		} finally {
			spy.mockRestore();
		}

		// POSITIVE CONTROL: the walk really ran and really loaded the in-root file, so
		// "nothing was said about the ancestor" is not "nothing happened".
		expect(files.map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
		expect(contentOf(files)).toContain(IN_ROOT_CANARY);

		expect(warnings.join("\n")).not.toContain(join(above, "AGENTS.md"));
	});

	it("treats a sibling directory whose name merely prefixes the root as outside it", () => {
		// `startsWith(root)` without a separator boundary counts `/x/root-evil` as inside
		// `/x/root`. Contained-with-a-boundary does not.
		const root = join(tmp, "root");
		const evil = join(tmp, "root-evil");
		mkdirSync(root, { recursive: true });
		mkdirSync(evil, { recursive: true });
		writeFileSync(join(evil, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		expect(contentOf(loadProjectContextFiles({ cwd: evil, agentDir, contextRoot: root }))).not.toContain(
			OUT_OF_ROOT_CANARY,
		);
		expect(contentOf(loadProjectContextFiles({ cwd: root, agentDir, contextRoot: root }))).toContain(IN_ROOT_CANARY);
	});

	it("still walks past the project root to distant ancestors when no root is configured", () => {
		const above = join(tmp, "above");
		const root = join(above, "root");
		const deep = join(root, "packages", "thing");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(tmp, "AGENTS.md"), "top\n");
		writeFileSync(join(above, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		const files = loadProjectContextFiles({ cwd: deep, agentDir });

		// Unchanged behaviour for every discovered session: outermost first, all the way up.
		expect(files.map((f) => f.path)).toEqual([
			join(tmp, "AGENTS.md"),
			join(above, "AGENTS.md"),
			join(root, "AGENTS.md"),
		]);
	});

	it("keeps the agent-dir global context file, which is a user resource, exempt from the root", () => {
		const root = join(tmp, "root");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);
		// agentDir is a sibling of root, i.e. outside it.
		writeFileSync(join(agentDir, "AGENTS.md"), "global-user-context\n");

		const files = loadProjectContextFiles({ cwd: root, agentDir, contextRoot: root });

		expect(files.map((f) => f.path)).toEqual([join(agentDir, "AGENTS.md"), join(root, "AGENTS.md")]);
	});
});

describe("the --context-root flag reaches the loader", () => {
	it("accepts an absolute path and refuses a relative one instead of resolving it", () => {
		expect(parseArgs(["--context-root", "/private/tmp/whatever"]).contextRoot).toBe("/private/tmp/whatever");

		const relative = parseArgs(["--context-root", "packages/thing"]);
		expect(relative.contextRoot).toBeUndefined();
		expect(relative.diagnostics.map((d) => d.message).join("\n")).toContain(
			"--context-root requires an absolute path",
		);

		const missing = parseArgs(["--context-root"]);
		expect(missing.contextRoot).toBeUndefined();
		expect(missing.diagnostics.map((d) => d.message).join("\n")).toContain("--context-root requires a value");
	});

	it("confines DefaultResourceLoader's discovered context files to the root it was given", async () => {
		const above = join(tmp, "above");
		const root = join(above, "root");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(above, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		const confined = new DefaultResourceLoader({ cwd: root, agentDir, contextRoot: root });
		await confined.reload();
		const confinedText = contentOf(confined.getAgentsFiles().agentsFiles);
		expect(confinedText).not.toContain(OUT_OF_ROOT_CANARY);
		expect(confinedText).toContain(IN_ROOT_CANARY);

		// POSITIVE CONTROL for the plumbing itself: without the option the same tree yields
		// the ancestor, so the assertion above is about the root and not about an empty loader.
		const unconfined = new DefaultResourceLoader({ cwd: root, agentDir });
		await unconfined.reload();
		expect(contentOf(unconfined.getAgentsFiles().agentsFiles)).toContain(OUT_OF_ROOT_CANARY);
	});

	/**
	 * THE FLAG'S ONE WIRE, driven through the real CLI.
	 *
	 * `parseArgs` produces `contextRoot` and `DefaultResourceLoader` consumes it; between
	 * them sits ONE line in `main.ts` — `contextRoot: parsed.contextRoot` in the
	 * `resourceLoaderOptions` handed to `createAgentSessionServices`. Deleting that line
	 * makes the whole flag a no-op and left every other case in this file green, because
	 * every other case constructs the loader itself.
	 *
	 * So this runs `src/cli.ts` — the SOURCE entry, under bun, so the assertion is about
	 * the code in this checkout and not about whatever `dist/` was last built from — with
	 * `--context-root` and the keyless stub provider's recording seam, and reads what
	 * actually reached the provider off disk.
	 *
	 * Print mode, not `--mode rpc`: the first provider request is all this needs and `-p`
	 * makes it in ~300 ms, with no socket and no second process.
	 */
	it("reaches a REAL `draht --context-root` run: the ancestor's bytes never reach the provider", () => {
		const above = join(tmp, "above");
		const root = join(above, "root");
		const deep = join(root, "packages", "thing");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(above, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		function run(extraArgs: string[], recordPath: string): string {
			const env = { ...process.env } as NodeJS.ProcessEnv;
			// This repo's interactive shell exports `auto`; a spawned draht must never
			// inherit a permission mode from whoever happened to launch the test.
			delete env.DRAHT_PERMISSION_MODE;
			env[STUB_PROVIDER_ENV] = "1";
			env[STUB_PROVIDER_RECORD_CONTEXT_ENV] = recordPath;
			env.DRAHT_CODING_AGENT_DIR = agentDir;
			// HOME too, and not only the agent dir: a draht run reads user-level resources
			// from the home directory, and the developer's own skills and agents were landing
			// in the recorded prompt. Noise there is not neutral — it is other people's text
			// in the assertion surface.
			env.HOME = tmp;

			const result = spawnSync(
				"bun",
				[
					CLI_SOURCE_ENTRY,
					"-p",
					"hi",
					"--provider",
					STUB_PROVIDER_ID,
					"--model",
					STUB_MODEL_ID,
					"--no-session",
					...extraArgs,
				],
				{ cwd: deep, env, encoding: "utf-8", timeout: 60_000 },
			);
			if (result.error) throw result.error;
			// A skip here would delete the assertion, and this repo builds with bun already.
			expect(result.status, `draht exited ${result.status}\n${result.stdout}\n${result.stderr}`).toBe(0);
			return readFileSync(recordPath, "utf-8");
		}

		const confined = run(["--context-root", root], join(tmp, "cli-confined.txt"));
		expect(confined).toContain(IN_ROOT_CANARY);
		expect(confined).not.toContain(OUT_OF_ROOT_CANARY);

		// POSITIVE CONTROL on the SAME tree and the SAME binary: without the flag the
		// ancestor's bytes DO reach the provider. Without it, a run that loaded no context
		// at all — or a recording seam that recorded nothing — would satisfy the line above.
		const unconfined = run([], join(tmp, "cli-unconfined.txt"));
		expect(unconfined).toContain(IN_ROOT_CANARY);
		expect(unconfined).toContain(OUT_OF_ROOT_CANARY);
	}, 120_000);
});

describe("the stub provider context recording seam", () => {
	/** Drive one turn and return the assistant's answer, so "unchanged behaviour" is assertable. */
	async function driveOnce(env: NodeJS.ProcessEnv, systemPrompt: string): Promise<string> {
		const provider = createStubProvider(env);
		const model = provider.getModels().find((m) => m.id === STUB_MODEL_ID);
		if (!model) throw new Error("stub model missing");
		const message = await provider
			.stream(model, { systemPrompt, messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, undefined)
			.result();
		return JSON.stringify(message.content);
	}

	it("writes the first request's systemPrompt exactly once, and only when the env var is set", async () => {
		const recordPath = join(tmp, "recorded-context.txt");
		const provider = createStubProvider({ [STUB_PROVIDER_RECORD_CONTEXT_ENV]: recordPath });
		const model = provider.getModels().find((m) => m.id === STUB_MODEL_ID);
		if (!model) throw new Error("stub model missing");

		await provider
			.stream(
				model,
				{
					systemPrompt: `first ${IN_ROOT_CANARY}`,
					messages: [{ role: "user", content: "a", timestamp: Date.now() }],
				},
				undefined,
			)
			.result();
		await provider
			.stream(
				model,
				{
					systemPrompt: `second ${OUT_OF_ROOT_CANARY}`,
					messages: [{ role: "user", content: "b", timestamp: Date.now() }],
				},
				undefined,
			)
			.result();

		const recorded = readFileSync(recordPath, "utf-8");
		expect(recorded).toContain(IN_ROOT_CANARY);
		// FIRST call only: a per-turn recorder would have overwritten the evidence the
		// acceptance depends on with a later, post-tool-call prompt.
		expect(recorded).not.toContain(OUT_OF_ROOT_CANARY);
	});

	/**
	 * Replaces a case that could not fail: it drove the provider with `env = {}` and then
	 * asserted `readFileSync(join(tmp, "unset-context.txt"))` threw — a path the provider had
	 * never been told about and that no implementation would ever pick, so the assertion held
	 * for a recorder that wrote everywhere. Deleting the `recordContextPath &&` guard outright
	 * left it green.
	 *
	 * The reachable property is the one that costs something to get wrong: the seam records
	 * where THE ENV IT WAS HANDED says, and nowhere else. `createStubProvider`'s parameter
	 * defaults to `process.env`, so `env[X] ?? process.env[X]` is a one-character change that
	 * turns a spawned-child seam into one that fires in-process for every test that happens to
	 * run with the variable exported — and it survived the old case.
	 *
	 * MEASURED, and reported rather than papered over: deleting the `recordContextPath &&`
	 * guard itself is BEHAVIOURALLY INERT and cannot be witnessed by any test. With the guard
	 * gone `writeFileSync(undefined, …)` throws, and the factory's `catch {}` — which exists so
	 * a broken recorder cannot change what the provider answers — swallows it. Nothing is
	 * written either way. That is a property of the code, not a gap in this file.
	 */
	it("records where the env it was GIVEN says, and never where the ambient process env says", async () => {
		const recordPath = join(tmp, "opt-in-context.txt");

		// (1) The path is one this provider DOES write, so "absent" below is about the opt-in
		// and not about a path nobody would ever choose.
		await driveOnce({ [STUB_PROVIDER_RECORD_CONTEXT_ENV]: recordPath }, `told ${IN_ROOT_CANARY}`);
		expect(readFileSync(recordPath, "utf-8")).toContain(IN_ROOT_CANARY);
		rmSync(recordPath);

		// (2) The same path, advertised in the AMBIENT process env, with `{}` handed to the
		// provider. The seam must honour its argument.
		const previous = process.env[STUB_PROVIDER_RECORD_CONTEXT_ENV];
		process.env[STUB_PROVIDER_RECORD_CONTEXT_ENV] = recordPath;
		let answer: string;
		try {
			answer = await driveOnce({}, `untold ${OUT_OF_ROOT_CANARY}`);
		} finally {
			if (previous === undefined) delete process.env[STUB_PROVIDER_RECORD_CONTEXT_ENV];
			else process.env[STUB_PROVIDER_RECORD_CONTEXT_ENV] = previous;
		}

		expect(existsSync(recordPath)).toBe(false);
		// POSITIVE CONTROL: the un-instrumented run still answered, so "nothing was written"
		// is not "nothing ran".
		expect(answer).toContain("hi");
	});

	it("does not change the provider's answer when the record path is unwritable", async () => {
		const provider = createStubProvider({
			[STUB_PROVIDER_RECORD_CONTEXT_ENV]: join(tmp, "no", "such", "dir", "out.txt"),
		});
		const model = provider.getModels().find((m) => m.id === STUB_MODEL_ID);
		if (!model) throw new Error("stub model missing");
		const message = await provider
			.stream(
				model,
				{ systemPrompt: "sys", messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				undefined,
			)
			.result();
		expect(message.stopReason).toBe("stop");
		expect(JSON.stringify(message.content)).toContain("hello");
	});
});
