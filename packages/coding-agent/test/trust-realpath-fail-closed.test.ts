import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

// macOS needs more than MAXSYMLINKS (32) hops for realpath to fail with ELOOP.
const SYMLINK_HOPS = 60;

let homeDirOverride: string | undefined;
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => homeDirOverride ?? actual.homedir() };
});

describe("trust gate on cwd spellings realpathSync resolves wrongly", () => {
	let root: string;
	let tn: string;
	let agentDir: string;
	let originalHome: string | undefined;

	const realProject = () => join(tn, "a", "b", "p");
	const viaReadableSymlink = () => join(tn, "L", "p");
	const viaTooManySymlinkHops = () => join(tn, "S0", "p");
	const viaDotDotAcrossSymlink = () => `${tn}/L/../q`;
	const viaDotDotAcrossSymlinkWithUnresolvableSuffix = () => `${tn}/L/../q/nope/..`;
	const viaDotDotOutOfSkillsSubtree = () => `${tn}/a/O/../y`;

	beforeEach(() => {
		originalHome = process.env.HOME;
		root = realpathSync(mkdtempSync(join(tmpdir(), "trust-fail-closed-")));
		tn = join(root, "tn");
		agentDir = join(root, "agent");
		mkdirSync(join(tn, "a", ".agents", "skills"), { recursive: true });
		mkdirSync(join(tn, "a", "b", "p"), { recursive: true });
		mkdirSync(join(tn, "a", "q"), { recursive: true });
		mkdirSync(join(tn, "a", "y"), { recursive: true });
		mkdirSync(join(tn, "q"), { recursive: true });
		mkdirSync(join(root, "out", "x"), { recursive: true });
		mkdirSync(join(root, "out", "y"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(join(tn, "a", "b"), join(tn, "L"));
		symlinkSync(join(root, "out", "x"), join(tn, "a", "O"));

		let target = join(tn, "a", "b");
		for (let hop = SYMLINK_HOPS; hop >= 0; hop--) {
			symlinkSync(target, join(tn, `S${hop}`));
			target = join(tn, `S${hop}`);
		}

		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [tn]: false }));
		process.env.HOME = root;
	});

	afterEach(() => {
		homeDirOverride = undefined;
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function projectSkillNames(cwd: string): Promise<string[]> {
		// Imported here, not at module scope: the loader's module graph reads `homedir()`
		// while loading, and this file mocks it with a binding that is not live yet.
		const { DefaultResourceLoader } = await import("../src/core/resource-loader.ts");
		const { SettingsManager } = await import("../src/core/settings-manager.ts");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		return loader
			.getSkills()
			.skills.filter((skill) => skill.sourceInfo.scope === "project")
			.map((skill) => skill.name);
	}

	function resolveTrusted(cwd: string): Promise<boolean> {
		return resolveProjectTrusted({
			cwd,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "always",
			projectTrustContext: { cwd, mode: "print", hasUI: false, ui: {} as ProjectTrustContext["ui"] },
		});
	}

	it("gates a cwd whose real path cannot be resolved", () => {
		expect(hasTrustRequiringProjectResources(viaTooManySymlinkHops())).toBe(true);
	});

	it("honors a saved 'do not trust' decision that the lexical ancestor chain would skip", async () => {
		expect(await resolveTrusted(realProject())).toBe(false);
		expect(await resolveTrusted(viaTooManySymlinkHops())).toBe(false);
	});

	it("gates a `..` that crosses a symlink instead of trusting the collapsed decoy", async () => {
		expect(realpathSync(viaDotDotAcrossSymlink())).toBe(join(tn, "q"));
		expect(hasTrustRequiringProjectResources(viaDotDotAcrossSymlink())).toBe(true);
		expect(await resolveTrusted(viaDotDotAcrossSymlink())).toBe(false);
	});

	it("reads the trust decision for the real cwd, not for the collapsed decoy", async () => {
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [join(tn, "q")]: true, [join(tn, "a")]: false }));
		expect(await resolveTrusted(viaDotDotAcrossSymlink())).toBe(false);
	});

	it("reads the trust decision for the real cwd when an unresolvable suffix spells the same directory", async () => {
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [join(tn, "q")]: true, [join(tn, "a")]: false }));
		expect(hasTrustRequiringProjectResources(viaDotDotAcrossSymlinkWithUnresolvableSuffix())).toBe(true);
		expect(await resolveTrusted(viaDotDotAcrossSymlinkWithUnresolvableSuffix())).toBe(false);
	});

	it("does not gate a `..` that physically leaves the skills subtree, because no loader walks it", async () => {
		// `<tn>/a/O` is a symlink out of the tree, so `<tn>/a/O/../y` is `<root>/out/y` and
		// `<tn>/a/.agents/skills` is not an ancestor of it. R3/R4 gated this because the
		// skill loader collapsed `..` lexically and did walk there; it no longer does, and
		// the assertion is now that both sides agree rather than that the gate over-covers.
		const cwd = viaDotDotOutOfSkillsSubtree();
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		expect(await projectSkillNames(cwd)).toEqual([]);
	});

	it("still resolves a readable symlinked cwd instead of refusing it", async () => {
		expect(hasTrustRequiringProjectResources(viaReadableSymlink())).toBe(true);
		expect(await resolveTrusted(viaReadableSymlink())).toBe(false);
	});

	it("leaves ordinary projects untouched", async () => {
		const plain = join(root, "plain", "project");
		mkdirSync(plain, { recursive: true });
		symlinkSync(join(root, "plain"), join(root, "plain-link"));

		expect(hasTrustRequiringProjectResources(plain)).toBe(false);
		expect(hasTrustRequiringProjectResources(join(root, "plain-link", "project"))).toBe(false);
		expect(hasTrustRequiringProjectResources(`${plain}/../project`)).toBe(false);
		expect(await resolveTrusted(plain)).toBe(true);
		expect(await resolveTrusted(join(root, "plain-link", "project"))).toBe(true);
		expect(await resolveTrusted(`${plain}/../project`)).toBe(true);
	});

	it("gates a `~` cwd whose `..` climbs above a symlinked home directory", () => {
		mkdirSync(join(root, "hb", "deep", "home"), { recursive: true });
		mkdirSync(join(root, "hb", "deep", "evil", ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "hb", "evil"), { recursive: true });
		symlinkSync(join(root, "hb", "deep", "home"), join(root, "hb", "home"));
		homeDirOverride = join(root, "hb", "home");

		expect(hasTrustRequiringProjectResources("~/../evil")).toBe(true);
	});

	it("still ignores the user's own skills dir", () => {
		const userHome = join(root, "home");
		mkdirSync(join(userHome, ".agents", "skills"), { recursive: true });
		process.env.HOME = userHome;
		expect(hasTrustRequiringProjectResources(userHome)).toBe(false);
	});
});

const TRUST_MANAGER_PATH = fileURLToPath(new URL("../src/core/trust-manager.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]$/, "");
const PROBE_MARKER = "__TRUST_PROBE__";
const PROBE_SOURCE = `
const { hasTrustRequiringProjectResources, ProjectTrustStore } = await import(process.argv[2]);
const store = new ProjectTrustStore(process.argv[3]);
const measured = JSON.parse(process.argv[4]).map((cwd) => ({
	gate: hasTrustRequiringProjectResources(cwd),
	decision: store.get(cwd),
}));
process.stdout.write("\\n${PROBE_MARKER}" + JSON.stringify(measured) + "\\n");
`;
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf-8" }).status === 0;

interface TrustAnswer {
	gate: boolean;
	decision: boolean | null;
}

describe("a cloned repo shipping a symlink out of the trusted workspace", () => {
	let root: string;
	let agentDir: string;
	let repo: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.HOME;
		root = realpathSync(mkdtempSync(join(tmpdir(), "trust-escape-")));
		agentDir = join(root, "agent");
		repo = join(root, "work", "repo");
		mkdirSync(repo, { recursive: true });
		mkdirSync(join(root, "evil", ".agents", "skills", "evil-skill"), { recursive: true });
		mkdirSync(join(root, "home"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(join(root, "evil"), join(repo, "link"));
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [join(root, "work")]: true }));
		process.env.HOME = join(root, "home");
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const escapes = (): string[] => [
		`${repo}/link/nope/..`,
		`${repo}/link/../nope`,
		`${repo}/nope/../link`,
		`${repo}/nope/../link/..`,
		`${repo}/link/nope`,
		`${repo}//link//nope//..`,
		`${repo}/./link/./nope/./..`,
		`${repo}/link/nope/../`,
		`${repo}/a/b/../../link/x/..`,
		`${repo}/link/nope/../../../work/repo/link/nope/..`,
	];

	function measure(cwds: string[]): TrustAnswer[] {
		const store = new ProjectTrustStore(agentDir);
		return cwds.map((cwd) => ({ gate: hasTrustRequiringProjectResources(cwd), decision: store.get(cwd) }));
	}

	function measureUnderBun(cwds: string[]): TrustAnswer[] {
		const probe = join(root, "probe.ts");
		writeFileSync(probe, PROBE_SOURCE);
		const run = spawnSync("bun", [probe, TRUST_MANAGER_PATH, agentDir, JSON.stringify(cwds)], {
			cwd: PACKAGE_DIR,
			encoding: "utf-8",
			env: process.env,
		});
		const marked = run.stdout?.split("\n").find((line) => line.startsWith(PROBE_MARKER));
		if (marked === undefined) {
			throw new Error(`bun probe produced no result: ${run.stdout ?? ""}${run.stderr ?? ""}`);
		}
		return JSON.parse(marked.slice(PROBE_MARKER.length));
	}

	const denied = (cwds: string[]): TrustAnswer[] => cwds.map(() => ({ gate: true, decision: null }));

	it("never keys an unresolvable spelling back onto the trusted workspace", () => {
		expect(measure(escapes())).toEqual(denied(escapes()));
	});

	it.skipIf(!bunAvailable)("never keys an unresolvable spelling back onto the trusted workspace under bun", () => {
		expect(measureUnderBun(escapes())).toEqual(denied(escapes()));
	});

	it("still trusts the workspace the user actually trusted", () => {
		const spellings = [repo, `${repo}/../repo`, `${repo}/./`];
		const trusted: TrustAnswer[] = spellings.map(() => ({ gate: false, decision: true }));
		expect(measure(spellings)).toEqual(trusted);
		if (bunAvailable) {
			expect(measureUnderBun(spellings)).toEqual(trusted);
		}
	});
});

describe("this package's own cwd", () => {
	it("answers the same whether or not the spelling contains a `..`, and only the monorepo's own agents dir gates it", () => {
		const gated = existsSync(join(PACKAGE_DIR, "..", "..", ".draht", "agents"));
		expect(hasTrustRequiringProjectResources(PACKAGE_DIR)).toBe(gated);
		expect(hasTrustRequiringProjectResources(`${PACKAGE_DIR}/../coding-agent`)).toBe(gated);
	});
});
