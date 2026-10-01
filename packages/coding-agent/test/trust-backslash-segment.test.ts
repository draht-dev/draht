import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

const TRUST_MANAGER_PATH = fileURLToPath(new URL("../src/core/trust-manager.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PROBE_MARKER = "__BACKSLASH_TRUST_PROBE__";
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

describe("a directory whose name contains a backslash", () => {
	let root: string;
	let repo: string;
	let odd: string;
	let agentDir: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.HOME;
		root = realpathSync(mkdtempSync(join(tmpdir(), "trust-backslash-")));
		repo = join(root, "work", "repo");
		odd = join(repo, "odd");
		agentDir = join(root, "agent");
		mkdirSync(join(odd, "a\\b"), { recursive: true });
		mkdirSync(join(odd, "c\\.."), { recursive: true });
		mkdirSync(join(root, "evil", ".agents", "skills", "evil-skill"), { recursive: true });
		writeFileSync(
			join(root, "evil", ".agents", "skills", "evil-skill", "SKILL.md"),
			"---\nname: evil-skill\ndescription: evil\n---\npayload\n",
		);
		mkdirSync(join(root, "home"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(join(root, "evil"), join(odd, "a\\b", "link"));
		symlinkSync(join(root, "evil"), join(odd, "c\\..", "link2"));
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
		`${odd}/a\\b/link`,
		`${odd}/a\\b/link/`,
		`${odd}/a\\b/./link`,
		`${odd}/a\\b/nope/../link`,
		`${odd}/a\\b/../a\\b/link`,
		`${odd}/c\\../link2`,
		`${repo}/odd/a\\b/link/nope/..`,
		`${repo}/../repo/odd/a\\b/link`,
		`${odd}//a\\b//link`,
		`${odd}/a\\b/link/../link`,
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

	const resolveTrusted = (cwd: string): Promise<boolean> =>
		resolveProjectTrusted({
			cwd,
			trustStore: new ProjectTrustStore(agentDir),
			projectTrustContext: { cwd, mode: "print", hasUI: false, ui: {} as ProjectTrustContext["ui"] },
		});

	async function loadedSkillNames(cwd: string, projectTrusted: boolean): Promise<string[]> {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		return loader.getSkills().skills.map((skill) => skill.name);
	}

	it("never keys a backslash segment onto the trusted workspace", () => {
		const denied: TrustAnswer[] = escapes().map(() => ({ gate: true, decision: null }));
		expect(measure(escapes())).toEqual(denied);
	});

	it.skipIf(!bunAvailable)("never keys a backslash segment onto the trusted workspace under bun", () => {
		const denied: TrustAnswer[] = escapes().map(() => ({ gate: true, decision: null }));
		expect(measureUnderBun(escapes())).toEqual(denied);
	});

	it("never grants an ancestor's trust to a spelling it could not resolve", () => {
		const unresolvable = [`${repo}/nope/deeper`, `${repo}/nope/..`];
		const denied: TrustAnswer[] = unresolvable.map(() => ({ gate: true, decision: null }));
		expect(measure(unresolvable)).toEqual(denied);
		if (bunAvailable) {
			expect(measureUnderBun(unresolvable)).toEqual(denied);
		}
	});

	it("refuses the symlink target and loads none of its skills", async () => {
		const cwd = `${odd}/a\\b/link`;
		expect(await resolveTrusted(cwd)).toBe(false);
		expect(await loadedSkillNames(cwd, await resolveTrusted(cwd))).not.toContain("evil-skill");
	});

	it("keeps a saved refusal for a backslash directory instead of an ancestor's trust", () => {
		const store = new ProjectTrustStore(agentDir);
		store.set(join(odd, "a\\b"), false);
		expect(store.getEntry(join(odd, "a\\b"))).toEqual({ path: join(odd, "a\\b"), decision: false });
	});

	it.skipIf(!bunAvailable)("keeps a saved refusal for a backslash directory under bun", () => {
		new ProjectTrustStore(agentDir).set(join(odd, "a\\b"), false);
		expect(measureUnderBun([join(odd, "a\\b")])).toEqual([{ gate: false, decision: false }]);
	});

	it("still trusts a backslash directory the user's ancestor decision covers", () => {
		expect(measure([join(odd, "a\\b")])).toEqual([{ gate: false, decision: true }]);
		if (bunAvailable) {
			expect(measureUnderBun([join(odd, "a\\b")])).toEqual([{ gate: false, decision: true }]);
		}
	});

	it("keeps a backslash directory distinct from the nested pair spelling it", () => {
		mkdirSync(join(odd, "a", "b"), { recursive: true });
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [join(odd, "a", "b")]: true }));
		const answers: TrustAnswer[] = [
			{ gate: false, decision: true },
			{ gate: false, decision: null },
		];
		expect(measure([join(odd, "a", "b"), join(odd, "a\\b")])).toEqual(answers);
		if (bunAvailable) {
			expect(measureUnderBun([join(odd, "a", "b"), join(odd, "a\\b")])).toEqual(answers);
		}
	});

	it("keys every backslash spelling to itself", () => {
		const oddNames = ["x\\", "\\x", "a\\\\b", "\\", "d\\e\\f"];
		const store = new ProjectTrustStore(agentDir);
		for (const name of oddNames) {
			mkdirSync(join(odd, name), { recursive: true });
			store.set(join(odd, name), false);
		}
		for (const name of oddNames) {
			expect(store.getEntry(join(odd, name))).toEqual({ path: join(odd, name), decision: false });
		}
		if (bunAvailable) {
			expect(measureUnderBun(oddNames.map((name) => join(odd, name)))).toEqual(
				oddNames.map(() => ({ gate: false, decision: false })),
			);
		}
	});

	it("leaves an ordinary project untouched", async () => {
		expect(measure([repo, `${repo}/../repo`, `${repo}/./`])).toEqual([
			{ gate: false, decision: true },
			{ gate: false, decision: true },
			{ gate: false, decision: true },
		]);
		expect(await resolveTrusted(repo)).toBe(true);
	});

	it("still loads a trusted project's own skills", async () => {
		mkdirSync(join(repo, ".agents", "skills", "ours"), { recursive: true });
		writeFileSync(
			join(repo, ".agents", "skills", "ours", "SKILL.md"),
			"---\nname: ours\ndescription: ours\n---\ncontent\n",
		);
		expect(hasTrustRequiringProjectResources(repo)).toBe(true);
		expect(await resolveTrusted(repo)).toBe(true);
		expect(await loadedSkillNames(repo, true)).toContain("ours");
	});
});
