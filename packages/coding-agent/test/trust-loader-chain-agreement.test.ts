import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { discoverAgents } from "../src/core/builtins/subagent.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf-8" }).status === 0;

describe("ancestor .agents/skills: the gate's chain is the loader's chain", () => {
	let root: string;
	let agentDir: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		root = join(tmpdir(), `chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		root = realpathSync(root);
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(root, { recursive: true, force: true });
	});

	function writeSkill(skillsDir: string, name: string): void {
		mkdirSync(join(skillsDir, name), { recursive: true });
		writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\ncontent`);
	}

	function writeAgent(dir: string, name: string): void {
		const agentsDir = join(dir, CONFIG_DIR_NAME, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\nprompt`);
	}

	async function loadSkills(cwd: string, projectTrusted: boolean) {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		return loader.getSkills().skills;
	}

	async function loadedSkillNames(cwd: string, projectTrusted: boolean): Promise<string[]> {
		return (await loadSkills(cwd, projectTrusted)).map((skill) => skill.name);
	}

	function loadedProjectAgentNames(cwd: string, projectTrusted: boolean): string[] {
		return discoverAgents(cwd, "both", projectTrusted)
			.filter((agent) => agent.source === "project")
			.map((agent) => agent.name);
	}

	it("does not load skills from a lexical ancestor the gate never walked", async () => {
		mkdirSync(join(root, "a", "b"), { recursive: true });
		mkdirSync(join(root, "x"), { recursive: true });
		symlinkSync(join(root, "a", "b"), join(root, "x", "link"));
		writeSkill(join(root, "x", ".agents", "skills"), "lexical-only-skill");
		const cwd = join(root, "x", "link");

		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		expect(await loadedSkillNames(cwd, true)).not.toContain("lexical-only-skill");
	});

	it("loads skills from a real ancestor the gate walked", async () => {
		mkdirSync(join(root, "a", "b"), { recursive: true });
		mkdirSync(join(root, "x"), { recursive: true });
		symlinkSync(join(root, "a", "b"), join(root, "x", "link"));
		writeSkill(join(root, "a", ".agents", "skills"), "real-ancestor-skill");
		const cwd = join(root, "x", "link");

		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(await loadedSkillNames(cwd, true)).toContain("real-ancestor-skill");
	});

	it("keeps the user's own ~/.agents/skills out of the project scope when HOME is a symlink", async () => {
		const realHome = join(root, "realhome");
		mkdirSync(join(realHome, "proj"), { recursive: true });
		symlinkSync(realHome, join(root, "home"));
		writeSkill(join(realHome, ".agents", "skills"), "user-home-skill");
		const cwd = join(realHome, "proj");
		process.env.HOME = join(root, "home");

		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		const scopes = (await loadSkills(cwd, true))
			.filter((skill) => skill.sourceInfo.path.endsWith(join("user-home-skill", "SKILL.md")))
			.map((skill) => skill.sourceInfo.scope);
		expect(scopes).not.toContain("project");
	});

	it("still gates and still loads an ordinary project's ancestor skills", async () => {
		const project = join(root, "proj");
		mkdirSync(join(project, "sub"), { recursive: true });
		writeSkill(join(project, ".agents", "skills"), "ordinary-skill");
		const cwd = join(project, "sub");

		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(await loadedSkillNames(cwd, true)).toContain("ordinary-skill");
		expect(await loadedSkillNames(cwd, false)).not.toContain("ordinary-skill");
	});

	it("still gates and still loads an ordinary project's ancestor agents", () => {
		const project = join(root, "proj");
		mkdirSync(join(project, "sub"), { recursive: true });
		writeAgent(project, "ordinary-agent");
		const cwd = join(project, "sub");

		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(loadedProjectAgentNames(cwd, true)).toContain("ordinary-agent");
		expect(loadedProjectAgentNames(cwd, false)).not.toContain("ordinary-agent");
	});
});

/**
 * The three spellings every previous round mis-resolved, asserted against both loaders
 * at once. A round that changes one chain and not the other fails here.
 */
describe("gate and loaders answer the same chain for spellings realpath gets wrong", () => {
	let root: string;
	let agentDir: string;
	let trusted: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		root = realpathSync(mkdirSyncTemp());
		agentDir = join(root, "agent");
		trusted = join(root, "trusted");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(root, "home"), { recursive: true });
		mkdirSync(join(trusted, "sub"), { recursive: true });
		// The attacker's tree, reachable only by a spelling the gate must refuse.
		writeSkillAt(join(root, "attacker", ".agents", "skills"), "attacker-skill");
		writeAgentAt(join(root, "attacker"), "attacker-agent");
		process.env.HOME = join(root, "home");
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(root, { recursive: true, force: true });
	});

	function mkdirSyncTemp(): string {
		const dir = join(tmpdir(), `chain-attack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function writeSkillAt(skillsDir: string, name: string): void {
		mkdirSync(join(skillsDir, name), { recursive: true });
		writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\ncontent`);
	}

	function writeAgentAt(dir: string, name: string): void {
		const agentsDir = join(dir, CONFIG_DIR_NAME, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\nprompt`);
	}

	async function skillNames(cwd: string, projectTrusted: boolean): Promise<string[]> {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		return loader.getSkills().skills.map((skill) => skill.name);
	}

	async function projectScopedSkillNames(cwd: string, projectTrusted: boolean): Promise<string[]> {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		return loader
			.getSkills()
			.skills.filter((skill) => skill.sourceInfo.scope === "project")
			.map((skill) => skill.name);
	}

	function projectAgentNames(cwd: string, projectTrusted: boolean): string[] {
		return discoverAgents(cwd, "both", projectTrusted)
			.filter((agent) => agent.source === "project")
			.map((agent) => agent.name);
	}

	/** The gate refuses, and — even if the user then trusts — neither loader reaches the tree. */
	async function expectGatedAndEmpty(cwd: string): Promise<void> {
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(await skillNames(cwd, true)).not.toContain("attacker-skill");
		expect(projectAgentNames(cwd, true)).not.toContain("attacker-agent");
	}

	it("refuses a symlink named through a backslash", async () => {
		symlinkSync(join(root, "attacker"), join(trusted, "a\\b"));
		await expectGatedAndEmpty(join(trusted, "a\\b"));
	});

	it("refuses a symlink reached through a backslash-named ancestor", async () => {
		mkdirSync(join(trusted, "c\\d"), { recursive: true });
		symlinkSync(join(root, "attacker"), join(trusted, "c\\d", "link"));
		await expectGatedAndEmpty(join(trusted, "c\\d", "link"));
	});

	it("resolves `..` across a symlink physically, not lexically", async () => {
		mkdirSync(join(root, "attacker", "deep"), { recursive: true });
		symlinkSync(join(root, "attacker", "deep"), join(trusted, "L"));
		// Lexically `<trusted>/sub`; physically `<attacker>/sub`, which does not exist.
		await expectGatedAndEmpty(`${trusted}/L/../sub`);
	});

	it("does not load a lexical ancestor's resources when `..` crossed a symlink out of it", async () => {
		// `<trusted>/O` -> `<root>/out/x`, so `<trusted>/O/../y` is `<root>/out/y`, whose
		// ancestors carry nothing. `path.resolve` would say `<trusted>/y` and hand the
		// loaders the whole trusted tree; the gate would then answer for a chain neither
		// loader walks. This is R2's shape with the symlink one level up.
		mkdirSync(join(root, "out", "x"), { recursive: true });
		mkdirSync(join(root, "out", "y"), { recursive: true });
		mkdirSync(join(trusted, "y"), { recursive: true });
		symlinkSync(join(root, "out", "x"), join(trusted, "O"));
		writeSkillAt(join(trusted, ".agents", "skills"), "lexical-ancestor-skill");
		writeAgentAt(trusted, "lexical-ancestor-agent");
		const cwd = `${trusted}/O/../y`;

		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		expect(await projectScopedSkillNames(cwd, true)).not.toContain("lexical-ancestor-skill");
		expect(projectAgentNames(cwd, true)).not.toContain("lexical-ancestor-agent");
	});

	it("still gates the cwd's own config dir, which the loaders reach lexically", async () => {
		mkdirSync(join(root, "out", "x"), { recursive: true });
		mkdirSync(join(root, "out", "y"), { recursive: true });
		symlinkSync(join(root, "out", "x"), join(trusted, "O"));
		writeSkillAt(join(trusted, "y", CONFIG_DIR_NAME, "skills"), "own-config-skill");
		const cwd = `${trusted}/O/../y`;

		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(await projectScopedSkillNames(cwd, true)).toContain("own-config-skill");
		expect(await projectScopedSkillNames(cwd, false)).not.toContain("own-config-skill");
	});

	it("loads nothing for a cwd it could not resolve", async () => {
		const cwd = `${trusted}/nope/deeper`;
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(await projectScopedSkillNames(cwd, true)).toEqual([]);
		expect(projectAgentNames(cwd, true)).toEqual([]);
	});

	it("keeps a backslash-named real directory keyed to itself, not to the nested pair", async () => {
		mkdirSync(join(trusted, "e\\f"), { recursive: true });
		writeSkillAt(join(root, "attacker", ".agents", "skills"), "attacker-skill");
		mkdirSync(join(trusted, "e"), { recursive: true });
		symlinkSync(join(root, "attacker"), join(trusted, "e", "f"));
		// `<trusted>/e\f` is an ordinary directory. bun's realpath answers `<trusted>/e/f`,
		// which is the attacker's tree; the segment walk must stay on the real one.
		const cwd = join(trusted, "e\\f");
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		expect(await skillNames(cwd, true)).not.toContain("attacker-skill");
		expect(projectAgentNames(cwd, true)).not.toContain("attacker-agent");
	});

	it("leaves an ordinary trusted project loading exactly what it did before", async () => {
		writeSkillAt(join(trusted, ".agents", "skills"), "ours");
		writeAgentAt(trusted, "our-agent");
		const cwd = join(trusted, "sub");
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect(await skillNames(cwd, true)).toContain("ours");
		expect(projectAgentNames(cwd, true)).toContain("our-agent");
		expect(await skillNames(cwd, false)).not.toContain("ours");
		expect(projectAgentNames(cwd, false)).not.toContain("our-agent");
	});

	it.skipIf(!bunAvailable)("gives the same gate answers under bun, the runtime that ships", () => {
		mkdirSync(join(trusted, "c\\d"), { recursive: true });
		symlinkSync(join(root, "attacker"), join(trusted, "a\\b"));
		symlinkSync(join(root, "attacker"), join(trusted, "c\\d", "link"));
		mkdirSync(join(root, "attacker", "deep"), { recursive: true });
		symlinkSync(join(root, "attacker", "deep"), join(trusted, "L"));
		mkdirSync(join(trusted, "g\\h"), { recursive: true });
		mkdirSync(join(trusted, "g"), { recursive: true });
		symlinkSync(join(root, "attacker"), join(trusted, "g", "h"));

		const cwds = [
			join(trusted, "a\\b"),
			join(trusted, "c\\d", "link"),
			`${trusted}/L/../sub`,
			`${trusted}/nope/deeper`,
			join(trusted, "g\\h"),
			join(trusted, "sub"),
		];
		const expected = [true, true, true, true, false, false];
		expect(measureGateUnderBun(cwds)).toEqual(expected);
		expect(cwds.map((cwd) => hasTrustRequiringProjectResources(cwd))).toEqual(expected);
	});

	function measureGateUnderBun(cwds: string[]): boolean[] {
		const probe = join(root, "probe.ts");
		const trustManagerPath = new URL("../src/core/trust-manager.ts", import.meta.url).pathname;
		writeFileSync(
			probe,
			`const { hasTrustRequiringProjectResources } = await import(process.argv[2]);\n` +
				`process.stdout.write("\\nMARK" + JSON.stringify(JSON.parse(process.argv[3]).map(hasTrustRequiringProjectResources)) + "\\n");\n`,
		);
		const run = spawnSync("bun", [probe, trustManagerPath, JSON.stringify(cwds)], {
			cwd: new URL("..", import.meta.url).pathname,
			encoding: "utf-8",
			env: process.env,
		});
		const marked = run.stdout?.split("\n").find((line) => line.startsWith("MARK"));
		if (marked === undefined) throw new Error(`bun probe produced no result: ${run.stdout ?? ""}${run.stderr ?? ""}`);
		return JSON.parse(marked.slice(4));
	}
});
