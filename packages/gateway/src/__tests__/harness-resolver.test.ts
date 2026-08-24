/** R36-SPAWN.2/.3 — two ids from a phone become a canonical executable and a canonical directory, or a refusal. */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GeistConfig } from "@draht/geist-protocol";
import {
	HarnessResolutionError,
	registryProjection,
	resolveHarnessLaunch,
	userRegistryProvider,
} from "../session/harness-resolver.js";

const cleanup: string[] = [];
const TEMP_ROOT = realpathSync(tmpdir());

/** Use the platform's canonical temporary root so ownership checks see the real path. */
function tempRoot(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(TEMP_ROOT, prefix)));
	cleanup.push(dir);
	return dir;
}

/** Name the same path through a root-owned platform link, as operators and service managers commonly do. */
function viaRootOwnedLink(canonical: string): string {
	const linked = process.platform === "darwin" ? canonical.replace(/^\/private\//, "/") : `/proc/1/root${canonical}`;
	expect(linked).not.toBe(canonical);
	expect(realpathSync(linked)).toBe(canonical);
	return linked;
}

function program(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

function directory(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

function registry(cmd: string, root: string, overrides: Partial<GeistConfig> = {}): GeistConfig {
	return {
		harness: { default: "draht", agents: { draht: { cmd } } },
		projects: { fr3n: { root } },
		...overrides,
	};
}

function refusal(attempt: () => unknown): HarnessResolutionError {
	try {
		attempt();
	} catch (error) {
		if (error instanceof HarnessResolutionError) return error;
		throw error;
	}
	throw new Error("expected a HarnessResolutionError, and the call returned normally");
}

afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("a clean registry resolves", () => {
	test("both ids, with the spec's own args and credentials", () => {
		const base = tempRoot("hr-ok-");
		const cmd = program(join(base, "bin", "agent"));
		const root = directory(join(base, "work", "fr3n"));
		const config = registry(cmd, root);
		config.harness.agents.draht = { cmd, args: ["--acp"], credentialEnv: ["ANTHROPIC_API_KEY"] };

		const launch = resolveHarnessLaunch("draht", "fr3n", { registry: () => config });

		expect(launch).toEqual({
			harnessId: "draht",
			projectId: "fr3n",
			executable: cmd,
			leadingArgs: ["--acp"],
			projectRoot: root,
			credentialEnv: ["ANTHROPIC_API_KEY"],
		});
	});

	test("the ownership walk runs as the uid the caller names", () => {
		const base = tempRoot("hr-uid-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")));

		expect(
			refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config, uid: 65534 })).message,
		).toContain("not owned by this user");
	});

	test("a harness with no credentialEnv receives none", () => {
		const base = tempRoot("hr-cred-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")));

		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => config }).credentialEnv).toEqual([]);
	});

	test("a script target becomes the interpreter, the script, then the spec's args", () => {
		const base = tempRoot("hr-js-");
		const root = directory(join(base, "work"));

		for (const name of ["agent.js", "agent.mjs", "agent.cjs", "agent.ts"]) {
			const script = program(join(base, "bin", name));
			const config = registry(script, root);
			config.harness.agents.draht = { cmd: script, args: ["--acp", "--mode", "rpc"] };

			const launch = resolveHarnessLaunch("draht", "fr3n", { registry: () => config });

			expect(launch.executable).toBe(realpathSync(process.execPath));
			expect(launch.leadingArgs).toEqual([script, "--acp", "--mode", "rpc"]);
		}
	});
});

describe("an id that is not declared is not resolved", () => {
	test("an unknown harness id", () => {
		const base = tempRoot("hr-uh-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")));

		expect(refusal(() => resolveHarnessLaunch("codex", "fr3n", { registry: () => config })).code).toBe(
			"unknown_harness",
		);
	});

	test("an unknown project id", () => {
		const base = tempRoot("hr-up-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")));

		expect(refusal(() => resolveHarnessLaunch("draht", "kintura", { registry: () => config })).code).toBe(
			"unknown_project",
		);
	});

	test("an inherited property name is not a declaration", () => {
		const base = tempRoot("hr-proto-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")));

		expect(refusal(() => resolveHarnessLaunch("constructor", "fr3n", { registry: () => config })).code).toBe(
			"unknown_harness",
		);
		expect(refusal(() => resolveHarnessLaunch("draht", "toString", { registry: () => config })).code).toBe(
			"unknown_project",
		);
	});

	test("a declared harness outside spawnableHarnessIds", () => {
		const base = tempRoot("hr-spawnable-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")));

		expect(
			refusal(() =>
				resolveHarnessLaunch("draht", "fr3n", { registry: () => config, spawnableHarnessIds: ["claude"] }),
			).code,
		).toBe("unknown_harness");
		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => config, spawnableHarnessIds: [] }).harnessId).toBe(
			"draht",
		);
	});
});

describe("approvedRoots bound what may be reached", () => {
	test("the same executable is refused inside no approved root and allowed with none declared", () => {
		const base = tempRoot("hr-roots-");
		const cmd = program(join(base, "elsewhere", "agent"));
		const root = directory(join(base, "approved", "fr3n"));

		const constrained = registry(cmd, root, { approvedRoots: [join(base, "approved")] });
		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => constrained })).code).toBe(
			"refused",
		);

		const unconstrained = registry(cmd, root);
		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => unconstrained }).executable).toBe(cmd);
	});

	test("a sibling whose name merely starts with an approved root is outside it", () => {
		const base = tempRoot("hr-sep-");
		const approved = directory(join(base, "projects"));
		const evil = directory(join(base, "projects-evil"));

		const outsideExecutable = registry(program(join(evil, "agent")), directory(join(approved, "fr3n")), {
			approvedRoots: [approved],
		});
		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => outsideExecutable })).code).toBe(
			"refused",
		);

		const outsideProject = registry(program(join(approved, "agent")), evil, { approvedRoots: [approved] });
		expect(
			refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => outsideProject })).message,
		).toContain("project root");
	});

	test("a forbidden root wins over the registry's own approval, for the executable and for the project", () => {
		const base = tempRoot("hr-forbid-");
		const cmd = program(join(base, "bin", "agent"));
		const work = directory(join(base, "work"));
		const config = registry(cmd, work, { approvedRoots: [base] });

		expect(
			refusal(() =>
				resolveHarnessLaunch("draht", "fr3n", { registry: () => config, forbiddenRoots: [join(base, "bin")] }),
			).message,
		).toContain("harness executable");
		expect(
			refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config, forbiddenRoots: [work] }))
				.message,
		).toContain("project root");
	});

	test("a relative containment root is refused rather than resolved against the current directory", () => {
		const base = tempRoot("hr-relroot-");
		const bin = directory(join(base, "bin"));
		// The executable is inside the first root, so the relative one is only ever reached while placing the PROJECT.
		const config = registry(program(join(bin, "agent")), directory(join(base, "work")), {
			approvedRoots: [bin, "approved"],
		});

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).message).toContain(
			"containment root must be an absolute path",
		);
	});
});

describe("a symbolic link decides at exec time which file it names", () => {
	test("a link on the way to the executable is refused", () => {
		const base = tempRoot("hr-exelink-");
		const cmd = program(join(base, "real", "agent"));
		symlinkSync(join(base, "real"), join(base, "link"));
		const config = registry(join(base, "link", "agent"), directory(join(base, "work")));

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).message).toContain(
			"symlink",
		);
		expect(
			resolveHarnessLaunch("draht", "fr3n", { registry: () => registry(cmd, join(base, "work")) }).executable,
		).toBe(cmd);
	});

	test("a project root reached through a link is refused", () => {
		const base = tempRoot("hr-rootlink-");
		const real = directory(join(base, "work", "fr3n"));
		symlinkSync(real, join(base, "linked"));
		const config = registry(program(join(base, "bin", "agent")), join(base, "linked"));

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).message).toContain(
			"symlink",
		);
		expect(
			resolveHarnessLaunch("draht", "fr3n", { registry: () => registry(config.harness.agents.draht.cmd, real) })
				.projectRoot,
		).toBe(real);
	});

	test("a project root that is not a directory is refused", () => {
		const base = tempRoot("hr-notdir-");
		const config = registry(program(join(base, "bin", "agent")), program(join(base, "work", "file")));

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).message).toContain(
			"not a directory",
		);
	});
});

describe("the registry is a provider asked per call", () => {
	test("every resolve reads it again, and sees what changed", () => {
		const base = tempRoot("hr-perload-");
		const cmd = program(join(base, "bin", "agent"));
		const root = directory(join(base, "work"));
		let reads = 0;
		let declared = true;
		const provider = () => {
			reads += 1;
			const config = registry(cmd, root);
			if (!declared) config.harness.agents = {};
			return config;
		};

		expect(resolveHarnessLaunch("draht", "fr3n", { registry: provider }).executable).toBe(cmd);
		expect(resolveHarnessLaunch("draht", "fr3n", { registry: provider }).executable).toBe(cmd);
		expect(reads).toBe(2);

		declared = false;
		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: provider })).code).toBe("unknown_harness");
		expect(reads).toBe(3);
	});

	test("userRegistryProvider re-reads the user's file, it does not cache its contents", () => {
		const home = tempRoot("hr-file-");
		const path = join(home, "config.yaml");
		const write = (defaultId: string) => {
			writeFileSync(path, `harness:\n  default: ${defaultId}\n  agents:\n    ${defaultId}: { cmd: /bin/sh }\n`);
			chmodSync(path, 0o600);
		};

		write("draht");
		const provider = userRegistryProvider({ explicit: path });
		expect(provider().harness.default).toBe("draht");

		write("claude");
		expect(provider().harness.default).toBe("claude");
	});
});

describe("the declaration is constrained and the interpreter is not", () => {
	test("a script inside an approved root runs on a runtime outside every approved root", () => {
		const base = tempRoot("hr-interp-");
		const approved = directory(join(base, "approved"));
		const script = program(join(approved, "bin", "agent.js"));
		const config = registry(script, directory(join(approved, "work")), { approvedRoots: [approved] });

		const launch = resolveHarnessLaunch("draht", "fr3n", { registry: () => config });

		expect(launch.executable).toBe(realpathSync(process.execPath));
		expect(launch.executable.startsWith(`${approved}/`)).toBe(false);
		expect(launch.leadingArgs).toEqual([script]);
	});

	test("a forbidden root that would cover the runtime does not stop a script harness", () => {
		const base = tempRoot("hr-interpforbid-");
		const script = program(join(base, "bin", "agent.js"));
		const config = registry(script, directory(join(base, "work")));
		const runtime = realpathSync(process.execPath);

		const launch = resolveHarnessLaunch("draht", "fr3n", {
			registry: () => config,
			forbiddenRoots: [dirname(runtime)],
		});

		expect(launch.executable).toBe(runtime);
	});
});

describe("a project root is a declared absolute path", () => {
	test("a relative one is refused, not resolved against the daemon's own directory", () => {
		const base = tempRoot("hr-relroot2-");
		const config = registry(program(join(base, "bin", "agent")), "src");

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).message).toContain(
			"must be an absolute path, got src",
		);
	});

	test("a tilde is refused rather than expanded", () => {
		const base = tempRoot("hr-tilde-");
		const config = registry(program(join(base, "bin", "agent")), "~/dev/fr3n");

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).message).toContain(
			"must be an absolute path, got ~/dev/fr3n",
		);
	});

	test("one reached through a root-owned link resolves to what the link names", () => {
		const base = tempRoot("hr-rootlink2-");
		const work = directory(join(base, "work"));
		const config = registry(program(join(base, "bin", "agent")), viaRootOwnedLink(work));

		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => config }).projectRoot).toBe(work);
	});
});

describe("a containment root is canonicalised before it is compared", () => {
	test("a forbidden root written through a root-owned link still covers the project", () => {
		const base = tempRoot("hr-forbidlink-");
		const work = directory(join(base, "work"));
		const config = registry(program(join(base, "bin", "agent")), work);

		expect(
			refusal(() =>
				resolveHarnessLaunch("draht", "fr3n", {
					registry: () => config,
					forbiddenRoots: [viaRootOwnedLink(work)],
				}),
			).message,
		).toContain("forbidden root");
	});

	test("the filesystem root contains what is under it", () => {
		const base = tempRoot("hr-slashroot-");
		const work = directory(join(base, "work"));
		const config = registry(program(join(base, "bin", "agent")), work, { approvedRoots: ["/"] });

		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => config }).projectRoot).toBe(work);
	});
});

describe("a declared path may not climb", () => {
	test("a .. that would erase a symlink component is refused, for the executable and for the project", () => {
		const base = tempRoot("hr-dotdot-");
		const real = directory(join(base, "elsewhere", "real"));
		program(join(real, "agent"));
		symlinkSync(real, join(base, "hop"));
		const work = directory(join(base, "work"));

		const viaExecutable = registry(`${base}/hop/../real/agent`, work);
		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => viaExecutable })).message).toContain(
			"harness executable must not climb",
		);

		const viaProject = registry(program(join(base, "bin", "agent")), `${base}/hop/../work`);
		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => viaProject })).message).toContain(
			"project root must not climb",
		);
	});
});

describe("a registry with no projects block is the first-run shape", () => {
	test("an id resolves to unknown_project, not a fault", () => {
		const base = tempRoot("hr-noproj-");
		const config: GeistConfig = {
			harness: { default: "draht", agents: { draht: { cmd: program(join(base, "bin", "agent")) } } },
		};

		expect(refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).code).toBe(
			"unknown_project",
		);
	});

	test("its projection is the declared harnesses and an empty project list", () => {
		const projection = registryProjection({
			harness: { default: "draht", agents: { draht: { cmd: "/usr/local/bin/draht-acp" } } },
		});

		expect(projection.harnesses).toEqual([{ id: "draht", isDefault: true }]);
		expect(projection.projects).toEqual([]);
	});
});

describe("what the caller is handed is its own", () => {
	test("a fault inside the gate reaches the caller as itself, not relabelled a refusal", () => {
		const base = tempRoot("hr-fault-");
		const config = registry(program(join(base, "bin", "agent")), directory(join(base, "work")), {
			approvedRoots: [7 as unknown as string],
		});

		expect(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => config })).toThrow(TypeError);
	});

	test("the returned arrays are copies, so a caller cannot rewrite a memoised registry", () => {
		const base = tempRoot("hr-alias-");
		const cmd = program(join(base, "bin", "agent"));
		const config = registry(cmd, directory(join(base, "work")));
		config.harness.agents.draht = { cmd, args: ["--acp"], credentialEnv: ["ANTHROPIC_API_KEY"] };
		const memoised = () => config;

		const first = resolveHarnessLaunch("draht", "fr3n", { registry: memoised });
		first.leadingArgs.push("--dangerously-skip-permissions");
		(first.credentialEnv as string[]).push("AWS_SECRET_ACCESS_KEY");

		const second = resolveHarnessLaunch("draht", "fr3n", { registry: memoised });
		expect(second.leadingArgs).toEqual(["--acp"]);
		expect(second.credentialEnv).toEqual(["ANTHROPIC_API_KEY"]);
	});
});

describe("registryProjection is what a phone may see", () => {
	test("ids, the default flag, a name that falls back to the id, and never a cmd", () => {
		const projection = registryProjection({
			harness: {
				default: "draht",
				agents: { draht: { cmd: "/usr/local/bin/draht-acp" }, claude: { cmd: "/usr/local/bin/claude-agent-acp" } },
			},
			projects: { fr3n: { root: "/w/fr3n" }, kintura: { root: "/w/kintura", name: "Kintura" } },
		});

		expect(projection.harnesses).toEqual([
			{ id: "draht", isDefault: true },
			{ id: "claude", isDefault: false },
		]);
		expect(projection.projects).toEqual([
			{ id: "fr3n", name: "fr3n", root: "/w/fr3n" },
			{ id: "kintura", name: "Kintura", root: "/w/kintura" },
		]);
		expect(JSON.stringify(projection)).not.toContain("draht-acp");
	});

	test("an id the resolver would refuse as unspawnable is not offered", () => {
		const config: GeistConfig = {
			harness: {
				default: "draht",
				agents: { draht: { cmd: "/usr/local/bin/draht-acp" }, codex: { cmd: "/usr/local/bin/codex-acp" } },
			},
		};

		expect(registryProjection(config, ["draht"]).harnesses).toEqual([{ id: "draht", isDefault: true }]);
		expect(registryProjection(config, []).harnesses.map((harness) => harness.id)).toEqual(["draht", "codex"]);
		expect(registryProjection(config).harnesses.map((harness) => harness.id)).toEqual(["draht", "codex"]);
	});
});
