/**
 * R36-SPAWN.6 / GSEC-13 — automatically-read project context is a NO-FOLLOW regular file
 * canonically contained under an approved root. Its bytes land verbatim in the system prompt.
 *
 * Every containment assertion pairs "the out-of-root canary is absent" with "the in-root canary
 * IS present". Without the positive half a loader that returns nothing at all passes forever.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/** SOURCE, not `dist/cli.js`: a dist entry asserts about whatever was last built. */
const CLI_SOURCE_ENTRY = resolve(__dirname, "..", "src", "cli.ts");
const TEMP_ROOT = realpathSync(tmpdir());

let tmp: string;
let agentDir: string;

function contentOf(files: Array<{ path: string; content: string }>): string {
	return files.map((f) => f.content).join("\n");
}

beforeEach(() => {
	tmp = mkdtempSync(join(TEMP_ROOT, "ctx-root-"));
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
		expect(text).toContain(IN_ROOT_CANARY);
		expect(files.map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
	});

	it("STOPS at the root rather than walking to / and filtering — nothing above it is inspected", () => {
		// Deleting the walk break leaves CONTENT identical — the per-file check refuses each
		// ancestor — so the only witness is the missing warning about a path above the root.
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

		expect(files.map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
		expect(contentOf(files)).toContain(IN_ROOT_CANARY);

		expect(warnings.join("\n")).not.toContain(join(above, "AGENTS.md"));
	});

	it("treats a sibling directory whose name merely prefixes the root as outside it", () => {
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

	it("keeps the root's own context file when cwd and root are spelled through a symlinked prefix", () => {
		// Why the walk break must keep CANONICALIZING `currentDir`: compared lexically against
		// the realpath'd root, `alias/root` is not inside `real/root`.
		const real = join(tmp, "real");
		const root = join(real, "root");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(real, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);
		symlinkSync(real, join(tmp, "alias"));
		const aliasRoot = join(tmp, "alias", "root");

		const text = contentOf(loadProjectContextFiles({ cwd: aliasRoot, agentDir, contextRoot: aliasRoot }));

		expect(text).not.toContain(OUT_OF_ROOT_CANARY);
		expect(text).toContain(IN_ROOT_CANARY);
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

		expect(files.map((f) => f.path)).toEqual([
			join(tmp, "AGENTS.md"),
			join(above, "AGENTS.md"),
			join(root, "AGENTS.md"),
		]);
	});

	it("loads no project context at all when the configured root cannot be resolved", () => {
		const root = join(tmp, "root");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		// An unresolvable root contains nothing. Reading it as "no constraint" — which is
		// what `undefined` means to the walk — would load the whole ancestor chain instead.
		const files = loadProjectContextFiles({ cwd: root, agentDir, contextRoot: join(tmp, "no-such-root") });

		expect(contentOf(files)).not.toContain(IN_ROOT_CANARY);
		expect(files.map((f) => f.path)).toEqual([]);
	});

	it("still loads everything under a root that does resolve", () => {
		const root = join(tmp, "root");
		mkdirSync(join(root, "sub"), { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		const files = loadProjectContextFiles({ cwd: join(root, "sub"), agentDir, contextRoot: root });

		expect(contentOf(files)).toContain(IN_ROOT_CANARY);
	});

	it("keeps the agent-dir global context file, which is a user resource, exempt from the root", () => {
		const root = join(tmp, "root");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);
		writeFileSync(join(agentDir, "AGENTS.md"), "global-user-context\n");

		const files = loadProjectContextFiles({ cwd: root, agentDir, contextRoot: root });

		expect(files.map((f) => f.path)).toEqual([join(agentDir, "AGENTS.md"), join(root, "AGENTS.md")]);
	});
});

describe("the walk break fails closed on a directory whose real path cannot be determined", () => {
	// Driven under BUN, which draht ships as: bun's realpath is realpath(3)-shaped and wants
	// read permission on the directory, node's walks it with lstat and succeeds. Where
	// `realpath(dir)` THROWS, the walk break used to fall back to the lexical spelling and
	// walk into the directory anyway; it now ends the walk, so both runtimes stop here.
	const WITNESS_SCRIPT = (loaderPath: string) => `
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectContextFiles } from ${JSON.stringify(loaderPath)};

const [cwd, agentDir, root, outPath] = process.argv.slice(2);

const threw = (fn) => { try { fn(); return false; } catch { return true; } };
const asymmetry = threw(() => realpathSync(cwd)) && !threw(() => realpathSync(join(cwd, "AGENTS.md")));

const warnings = [];
const realError = console.error;
console.error = (...args) => warnings.push(args.map(String).join(" "));
let files;
try {
	files = loadProjectContextFiles({ cwd, agentDir, contextRoot: root });
} finally {
	console.error = realError;
}
writeFileSync(outPath, JSON.stringify({
	asymmetry,
	paths: files.map((f) => f.path),
	content: files.map((f) => f.content).join("\\n"),
	warnings,
}));
`;

	it("ends the walk instead of falling back to the lexical spelling", () => {
		const root = join(tmp, "root");
		const outside = join(tmp, "xonly");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);
		const link = join(root, "link");
		symlinkSync(outside, link);
		// Execute-only: `realpath` of the directory is refused under bun while its contents
		// stay reachable by name. The lexical `root/link` IS inside the root, so a fail-open
		// walk break would have walked straight into `outside`.
		chmodSync(outside, 0o111);

		const scriptPath = join(tmp, "witness.mjs");
		const outPath = join(tmp, "witness.json");
		writeFileSync(scriptPath, WITNESS_SCRIPT(resolve(__dirname, "..", "src", "core", "resource-loader.ts")));

		const env = { ...process.env } as NodeJS.ProcessEnv;
		delete env.DRAHT_PERMISSION_MODE;
		let spawned: ReturnType<typeof spawnSync>;
		try {
			spawned = spawnSync("bun", [scriptPath, link, agentDir, root, outPath], {
				encoding: "utf-8",
				env,
				timeout: 60_000,
			});
		} finally {
			// Before afterEach tries to remove it.
			chmodSync(outside, 0o755);
		}
		if (spawned.error) throw spawned.error;
		expect(spawned.status, `bun exited ${spawned.status}\n${spawned.stdout}\n${spawned.stderr}`).toBe(0);

		const result = JSON.parse(readFileSync(outPath, "utf-8")) as {
			asymmetry: boolean;
			paths: string[];
			content: string;
			warnings: string[];
		};

		expect(result.content).not.toContain(OUT_OF_ROOT_CANARY);

		if (process.platform === "darwin") {
			expect(result.asymmetry, "bun no longer refuses realpath() on an execute-only directory").toBe(true);
		}
		if (!result.asymmetry) return;

		// node reaches the same end state by resolving `link` to `outside` and finding it
		// out of root; bun by not resolving it at all. Neither enters the directory, and
		// neither continues to `root` above a cwd it could not place.
		expect(result.paths).not.toContain(join(link, "AGENTS.md"));
		expect(result.content).not.toContain(IN_ROOT_CANARY);
		expect(result.paths).toEqual([]);
	}, 120_000);
});

describe("the --context-root flag reaches the loader", () => {
	it("accepts an absolute path and refuses a relative one instead of resolving it", () => {
		const absoluteContextRoot = join(tmp, "whatever");
		expect(parseArgs(["--context-root", absoluteContextRoot]).contextRoot).toBe(absoluteContextRoot);

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

		const unconfined = new DefaultResourceLoader({ cwd: root, agentDir });
		await unconfined.reload();
		expect(contentOf(unconfined.getAgentsFiles().agentsFiles)).toContain(OUT_OF_ROOT_CANARY);
	});

	// The flag's one wire is `contextRoot: parsed.contextRoot` in `main.ts`; deleting it leaves
	// every other case here green, because they all construct the loader themselves.
	it("reaches a REAL `draht --context-root` run: the ancestor's bytes never reach the provider", () => {
		const above = join(tmp, "above");
		const root = join(above, "root");
		const deep = join(root, "packages", "thing");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(above, "AGENTS.md"), `${OUT_OF_ROOT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);

		function run(extraArgs: string[], recordPath: string): string {
			const env = { ...process.env } as NodeJS.ProcessEnv;
			// This repo's interactive shell exports `auto`; never inherit it.
			delete env.DRAHT_PERMISSION_MODE;
			env[STUB_PROVIDER_ENV] = "1";
			env[STUB_PROVIDER_RECORD_CONTEXT_ENV] = recordPath;
			env.DRAHT_CODING_AGENT_DIR = agentDir;
			// HOME too, not only the agent dir: draht reads user-level resources from it, and
			// the developer's own skills were landing in the recorded prompt.
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
			expect(result.status, `draht exited ${result.status}\n${result.stdout}\n${result.stderr}`).toBe(0);
			return readFileSync(recordPath, "utf-8");
		}

		const confined = run(["--context-root", root], join(tmp, "cli-confined.txt"));
		expect(confined).toContain(IN_ROOT_CANARY);
		expect(confined).not.toContain(OUT_OF_ROOT_CANARY);

		const unconfined = run([], join(tmp, "cli-unconfined.txt"));
		expect(unconfined).toContain(IN_ROOT_CANARY);
		expect(unconfined).toContain(OUT_OF_ROOT_CANARY);
	}, 120_000);
});

describe("the stub provider context recording seam", () => {
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
		expect(recorded).not.toContain(OUT_OF_ROOT_CANARY);
	});

	// Deleting the `recordContextPath &&` guard is behaviourally inert and unwitnessable: the
	// factory's `catch {}` swallows the resulting throw. This covers the reachable property.
	it("records where the env it was GIVEN says, and never where the ambient process env says", async () => {
		const recordPath = join(tmp, "opt-in-context.txt");

		// (1) A path this provider DOES write, so "absent" below is about the opt-in.
		await driveOnce({ [STUB_PROVIDER_RECORD_CONTEXT_ENV]: recordPath }, `told ${IN_ROOT_CANARY}`);
		expect(readFileSync(recordPath, "utf-8")).toContain(IN_ROOT_CANARY);
		rmSync(recordPath);

		// (2) Same path, but only in the AMBIENT env, with `{}` handed to the provider.
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
