import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { loadProjectContextFiles, type ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const ANCESTOR_CANARY = "LEXICAL-ANCESTOR-AGENTS-MD";
const PHYSICAL_CANARY = "PHYSICAL-TARGET-AGENTS-MD";
const OPERATING_CANARY = "OPERATING-DIR-AGENTS-MD";
const CONTEXT_CANARY = "CONTEXT-DIR-AGENTS-MD";

let root: string;
let agentDir: string;
let trusted: string;
const originalHome = process.env.HOME;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "hostile-cwd-")));
	agentDir = join(root, "agent");
	trusted = join(root, "trusted");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	mkdirSync(join(root, "out", "x"), { recursive: true });
	mkdirSync(join(root, "out", "y"), { recursive: true });
	mkdirSync(join(trusted, "y"), { recursive: true });
	mkdirSync(join(trusted, "sub"), { recursive: true });
	symlinkSync(join(root, "out", "x"), join(trusted, "O"));
	writeFileSync(join(root, "out", "x", "AGENTS.md"), `${PHYSICAL_CANARY}\n`);
	writeFileSync(join(trusted, "AGENTS.md"), `${ANCESTOR_CANARY}\n`);
	writeFileSync(join(trusted, "y", "AGENTS.md"), `${OPERATING_CANARY}\n`);
	writeFileSync(join(root, "out", "y", "AGENTS.md"), `${CONTEXT_CANARY}\n`);
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

function trustedSettings(cwd: string): SettingsManager {
	return SettingsManager.create(cwd, agentDir, { projectTrusted: true });
}

function contextText(resourceLoader: ResourceLoader): string {
	return resourceLoader
		.getAgentsFiles()
		.agentsFiles.map((file) => file.content)
		.join("\n");
}

function projectSkillNames(resourceLoader: ResourceLoader): string[] {
	return resourceLoader
		.getSkills()
		.skills.filter((skill) => skill.sourceInfo.scope === "project")
		.map((skill) => skill.name);
}

// `<trusted>/O` -> `<root>/out/x`, so `<trusted>/O/../y` is physically `<root>/out/y`.
// `path.resolve` says `<trusted>/y` and hands the walk the whole trusted tree.
const escapedCwd = () => `${trusted}/O/../y`;

describe("the AGENTS.md ancestor walk", () => {
	async function contextViaServices(cwd: string): Promise<string> {
		const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: trustedSettings(cwd) });
		return contextText(services.resourceLoader);
	}

	async function contextViaSdk(cwd: string): Promise<string> {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager: trustedSettings(cwd),
			sessionManager: SessionManager.inMemory(cwd),
		});
		return contextText(session.resourceLoader);
	}

	it("does not reach a lexical ancestor through either entry point", async () => {
		expect(await contextViaServices(escapedCwd())).not.toContain(ANCESTOR_CANARY);
		expect(await contextViaSdk(escapedCwd())).not.toContain(ANCESTOR_CANARY);
	});

	it("still inherits an ordinary project's ancestor context through both entry points", async () => {
		const cwd = join(trusted, "sub");
		expect(await contextViaServices(cwd)).toContain(ANCESTOR_CANARY);
		expect(await contextViaSdk(cwd)).toContain(ANCESTOR_CANARY);
	});

	it("reads the link target's chain for a plain symlinked cwd, with no `..` in the spelling", async () => {
		const cwd = join(trusted, "O");
		expect(await contextViaServices(cwd)).toContain(PHYSICAL_CANARY);
		expect(await contextViaServices(cwd)).not.toContain(ANCESTOR_CANARY);
		expect(await contextViaSdk(cwd)).toContain(PHYSICAL_CANARY);
		expect(await contextViaSdk(cwd)).not.toContain(ANCESTOR_CANARY);
	});

	it("still inherits it for a `..` that crossed no symlink", async () => {
		const cwd = `${trusted}/sub/../y`;
		expect(await contextViaServices(cwd)).toContain(ANCESTOR_CANARY);
		expect(await contextViaSdk(cwd)).toContain(ANCESTOR_CANARY);
	});

	it("loads only the agent-dir global file when the cwd cannot be resolved at all", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "global-user-context\n");
		const files = loadProjectContextFiles({ cwd: join(trusted, "no-such-dir"), agentDir });
		expect(files.map((file) => file.path)).toEqual([join(agentDir, "AGENTS.md")]);
	});
});

describe("a session replaced in place", () => {
	async function runtimeFor(cwd: string) {
		return createAgentSessionRuntime(
			async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					cwd: runtimeCwd,
					agentDir: runtimeAgentDir,
					settingsManager: trustedSettings(runtimeCwd),
				});
				const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
				return { ...created, services, diagnostics: [] };
			},
			{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		);
	}

	it("keeps refusing the lexical ancestor after /new", async () => {
		const runtime = await runtimeFor(escapedCwd());
		expect(projectSkillNames(runtime.services.resourceLoader)).toEqual([]);
		expect(contextText(runtime.services.resourceLoader)).not.toContain(ANCESTOR_CANARY);

		await runtime.newSession();

		expect(projectSkillNames(runtime.services.resourceLoader)).toEqual([]);
		expect(contextText(runtime.services.resourceLoader)).not.toContain(ANCESTOR_CANARY);
	});

	it("keeps refusing the lexical ancestor after a SECOND /new", async () => {
		const runtime = await runtimeFor(escapedCwd());

		await runtime.newSession();
		await runtime.newSession();

		expect(projectSkillNames(runtime.services.resourceLoader)).toEqual([]);
		expect(contextText(runtime.services.resourceLoader)).not.toContain(ANCESTOR_CANARY);
	});

	it("keeps refusing the lexical ancestor after /fork", async () => {
		const runtime = await runtimeFor(escapedCwd());
		const entryId = runtime.session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});

		await runtime.fork(entryId);

		expect(projectSkillNames(runtime.services.resourceLoader)).toEqual([]);
		expect(contextText(runtime.services.resourceLoader)).not.toContain(ANCESTOR_CANARY);
	});

	it("follows the resumed session's cwd when /new comes after /resume", async () => {
		const runtime = await runtimeFor(escapedCwd());
		const sessionFile = join(root, "resumed.jsonl");
		const header = { type: "session", id: "s", timestamp: new Date().toISOString(), cwd: join(trusted, "sub") };
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);

		await runtime.switchSession(sessionFile);
		await runtime.newSession();

		expect(projectSkillNames(runtime.services.resourceLoader)).toContain("lexical-ancestor-skill");
	});

	// The escaped spelling names two real directories at once. Whichever way that is resolved,
	// the session cannot be told only half of it.
	it("says out loud that it operates in one directory and reads its context from another", async () => {
		const runtime = await runtimeFor(escapedCwd());
		const warns = () =>
			runtime.diagnostics.filter(
				(diagnostic) =>
					diagnostic.type === "warning" &&
					diagnostic.message.includes(join(trusted, "y")) &&
					diagnostic.message.includes(join(root, "out", "y")),
			);

		expect(runtime.services.cwd).toBe(join(trusted, "y"));
		expect(contextText(runtime.services.resourceLoader)).toContain(CONTEXT_CANARY);
		expect(contextText(runtime.services.resourceLoader)).not.toContain(OPERATING_CANARY);
		expect(warns()).toHaveLength(1);

		await runtime.newSession();

		expect(warns()).toHaveLength(1);
	});

	it("stays quiet for an ordinary cwd that names exactly one directory", async () => {
		const runtime = await runtimeFor(join(trusted, "sub"));
		expect(runtime.diagnostics.filter((diagnostic) => diagnostic.type === "warning")).toEqual([]);
		await runtime.newSession();
		expect(runtime.diagnostics.filter((diagnostic) => diagnostic.type === "warning")).toEqual([]);
	});

	it("still loads an ordinary project's resources after /new", async () => {
		const runtime = await runtimeFor(join(trusted, "sub"));
		await runtime.newSession();
		expect(projectSkillNames(runtime.services.resourceLoader)).toContain("lexical-ancestor-skill");
		expect(contextText(runtime.services.resourceLoader)).toContain(ANCESTOR_CANARY);
	});
});
