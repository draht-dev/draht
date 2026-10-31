/** R36-SPAWN.2/.3 — two ids from a phone become a canonical executable and a canonical directory, or a refusal. */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeistConfig } from "@draht/geist-protocol";
import {
	HarnessResolutionError,
	registryProjection,
	resolveHarnessLaunch,
	userRegistry,
} from "../session/harness-resolver.js";
import { canonicalTempRoot } from "./helpers/temp-root.js";

const cleanup: string[] = [];
const TEMP_ROOT = canonicalTempRoot();

/** Use the platform's canonical temporary root so ownership checks see the real path. */
function tempRoot(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(TEMP_ROOT, prefix)));
	cleanup.push(dir);
	return dir;
}

/** Name the same path through a root-owned platform link, as operators and service managers commonly do. */
function viaRootOwnedLink(canonical: string): string {
	const linked =
		process.platform === "darwin"
			? canonical.replace(/^\/private\//, "/")
			: canonical.replace(/^\/run\//, "/var/run/");
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

const VALID_REGISTRY = "harness:\n  default: draht\n  agents:\n    draht: { cmd: /bin/sh }\n";

function registryFile(dir: string, mode: number, body = VALID_REGISTRY, name = "config.yaml"): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, mode);
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
});

describe("a harness executable inside a declared project is project-controlled code", () => {
	const inside = (project: string, root: string) =>
		`the "draht" harness executable is inside project "${project}" (${root}); a project's own files cannot be the harness`;

	test("one inside the requested project's root is refused, and the same file with the project elsewhere resolves", () => {
		const base = tempRoot("hr-inproj-");
		const root = directory(join(base, "work", "fr3n"));
		const cmd = program(join(root, "node_modules", ".bin", "draht"));

		const refused = refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => registry(cmd, root) }));
		expect(refused.code).toBe("refused");
		expect(refused.message).toContain(inside("fr3n", root));

		const moved = directory(join(base, "work", "moved"));
		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => registry(cmd, moved) }).executable).toBe(cmd);
	});

	test("one inside ANOTHER declared project's root is refused, and resolves once that project is not declared", () => {
		const base = tempRoot("hr-otherproj-");
		const work = directory(join(base, "work", "fr3n"));
		const other = directory(join(base, "work", "other"));
		const cmd = program(join(other, "bin", "agent"));
		const both = registry(cmd, work, { projects: { fr3n: { root: work }, other: { root: other } } });
		const only = registry(cmd, work);

		const refused = refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => both }));
		expect(refused.code).toBe("refused");
		expect(refused.message).toContain(inside("other", other));
		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => only }).executable).toBe(cmd);
	});

	test("a script harness inside a declared project is refused before it becomes an interpreter launch", () => {
		const base = tempRoot("hr-scriptproj-");
		const root = directory(join(base, "work", "fr3n"));
		const script = program(join(root, "tools", "agent.js"));

		expect(
			refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: () => registry(script, root) })).message,
		).toContain(inside("fr3n", root));
	});

	test("a forbidden root the caller supplied keeps its own message and names no project", () => {
		const base = tempRoot("hr-callerroot-");
		const cmd = program(join(base, "bin", "agent"));
		const config = registry(cmd, directory(join(base, "work", "fr3n")));

		const refused = refusal(() =>
			resolveHarnessLaunch("draht", "fr3n", { registry: () => config, forbiddenRoots: [join(base, "bin")] }),
		);

		expect(refused.code).toBe("refused");
		expect(refused.message).toContain(`the "draht" harness executable is inside a forbidden root: ${cmd}`);
		expect(refused.message).not.toContain("inside project");
	});

	test("a project root that is not absolute elsewhere in the registry does not refuse every harness", () => {
		const base = tempRoot("hr-strayproj-");
		const work = directory(join(base, "work", "fr3n"));
		const cmd = program(join(base, "bin", "agent"));
		const config = registry(cmd, work, { projects: { fr3n: { root: work }, stray: { root: "src" } } });

		expect(resolveHarnessLaunch("draht", "fr3n", { registry: () => config }).executable).toBe(cmd);
	});
});

describe("the user registry is an object with a path, a presence check and a loader", () => {
	test("its path is fixed once: an explicit one wins, otherwise the home's .geist/config.yaml", () => {
		expect(userRegistry({ explicit: "/x/registry.yaml", home: "/h" }).path).toBe("/x/registry.yaml");
		expect(userRegistry({ home: "/h" }).path).toBe("/h/.geist/config.yaml");
	});

	test("nothing there is not present: no file, no directory above it, and a file where a directory should be", () => {
		const home = tempRoot("hr-absent-");
		const file = registryFile(home, 0o600);

		expect(userRegistry({ explicit: join(home, "missing.yaml") }).present()).toBe(false);
		expect(userRegistry({ explicit: join(home, "no-such-dir", "config.yaml") }).present()).toBe(false);
		expect(userRegistry({ explicit: join(file, "config.yaml") }).present()).toBe(false);
	});

	test("a dangling link, a file the loader will refuse and a directory are all present", () => {
		const home = tempRoot("hr-present-");
		const dangling = join(home, "dangling.yaml");
		symlinkSync(join(home, "nowhere.yaml"), dangling);

		expect(userRegistry({ explicit: dangling }).present()).toBe(true);
		expect(userRegistry({ explicit: registryFile(home, 0o644) }).present()).toBe(true);
		expect(userRegistry({ explicit: directory(join(home, "a-directory")) }).present()).toBe(true);
	});

	test.skipIf(process.getuid?.() === 0)("a path under a directory that cannot be searched is present", () => {
		const home = tempRoot("hr-sealed-");
		const sealed = directory(join(home, "sealed"));
		const path = registryFile(sealed, 0o600);
		chmodSync(sealed, 0o000);

		try {
			expect(userRegistry({ explicit: path }).present()).toBe(true);
		} finally {
			chmodSync(sealed, 0o700);
		}
	});

	test("a file the loader refuses is a refusal that names the rule, from load and from the resolver", () => {
		const home = tempRoot("hr-mode-");
		const path = registryFile(home, 0o644);
		const { load } = userRegistry({ explicit: path });

		const direct = refusal(() => load());
		expect(direct.code).toBe("refused");
		expect(direct.message).toContain(`(mode on file ${path})`);

		const resolved = refusal(() => resolveHarnessLaunch("draht", "fr3n", { registry: load }));
		expect(resolved.code).toBe("refused");
		expect(resolved.message).toContain(`(mode on file ${path})`);
	});

	test("a file that has gone since it was offered is refused, not a fault", () => {
		const home = tempRoot("hr-gone-");
		const path = registryFile(home, 0o600);
		const registryObject = userRegistry({ explicit: path });
		expect(registryObject.present()).toBe(true);

		rmSync(path);

		const error = refusal(() => registryObject.load());
		expect(error.code).toBe("refused");
		expect(error.message).toContain(`(missing on file ${path})`);
	});

	test("invalid yaml is refused with the loader's own words", () => {
		const home = tempRoot("hr-yaml-");
		const path = registryFile(home, 0o600, "harness: [unclosed\n");

		const error = refusal(() => userRegistry({ explicit: path }).load());

		expect(error.code).toBe("refused");
		expect(error.message).toContain(`Invalid geist config at ${path}`);
	});

	test("a private file is re-read on every load, and the change is seen", () => {
		const home = tempRoot("hr-reread-");
		const path = registryFile(home, 0o600);
		const { load } = userRegistry({ explicit: path });
		expect(load().harness.default).toBe("draht");

		registryFile(home, 0o600, "harness:\n  default: claude\n  agents:\n    claude: { cmd: /bin/sh }\n");

		expect(load().harness.default).toBe("claude");
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
