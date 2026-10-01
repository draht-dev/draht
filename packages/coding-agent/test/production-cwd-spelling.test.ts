import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("the cwd spelling the production entry points hand the resource loader", () => {
	let root: string;
	let agentDir: string;
	let trusted: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "prod-spelling-")));
		agentDir = join(root, "agent");
		trusted = join(root, "trusted");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(root, "home"), { recursive: true });
		mkdirSync(join(root, "out", "x"), { recursive: true });
		mkdirSync(join(root, "out", "y"), { recursive: true });
		mkdirSync(join(trusted, "y"), { recursive: true });
		mkdirSync(join(trusted, "sub"), { recursive: true });
		symlinkSync(join(root, "out", "x"), join(trusted, "O"));
		writeSkill(join(trusted, ".agents", "skills"), "lexical-ancestor-skill");
		process.env.HOME = join(root, "home");
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

	function projectSkillNames(resourceLoader: ResourceLoader): string[] {
		return resourceLoader
			.getSkills()
			.skills.filter((skill) => skill.sourceInfo.scope === "project")
			.map((skill) => skill.name);
	}

	function trustedSettings(cwd: string): SettingsManager {
		return SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	}

	async function skillsViaServices(cwd: string): Promise<string[]> {
		const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: trustedSettings(cwd) });
		return projectSkillNames(services.resourceLoader);
	}

	async function skillsViaSdk(cwd: string): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager: trustedSettings(cwd),
			sessionManager: SessionManager.inMemory(cwd),
		});
		return projectSkillNames(session.resourceLoader);
	}

	// `<trusted>/O` -> `<root>/out/x`, so `<trusted>/O/../y` is `<root>/out/y`. `path.resolve`
	// says `<trusted>/y` and hands the ancestor skill walk the whole trusted tree.
	const escapedCwd = () => `${trusted}/O/../y`;

	it("does not let createAgentSessionServices load a lexical ancestor's skills", async () => {
		expect(await skillsViaServices(escapedCwd())).not.toContain("lexical-ancestor-skill");
	});

	it("does not let createAgentSession load a lexical ancestor's skills", async () => {
		expect(await skillsViaSdk(escapedCwd())).not.toContain("lexical-ancestor-skill");
	});

	it("still loads an ordinary trusted project's ancestor skills through both entry points", async () => {
		const cwd = join(trusted, "sub");
		expect(await skillsViaServices(cwd)).toContain("lexical-ancestor-skill");
		expect(await skillsViaSdk(cwd)).toContain("lexical-ancestor-skill");
	});

	it("still loads them for a `..` that crossed no symlink, where lexical and physical agree", async () => {
		const cwd = `${trusted}/sub/../y`;
		expect(await skillsViaServices(cwd)).toContain("lexical-ancestor-skill");
		expect(await skillsViaSdk(cwd)).toContain("lexical-ancestor-skill");
	});
});
