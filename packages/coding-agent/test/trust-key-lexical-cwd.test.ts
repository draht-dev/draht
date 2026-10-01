import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";
import { trustKeyPath } from "../src/utils/canonical-path.ts";

let root: string;
let agentDir: string;
let trusted: string;
let attacker: string;
const originalHome = process.env.HOME;

function plantProjectConfig(dir: string): void {
	mkdirSync(join(dir, ".draht", "extensions"), { recursive: true });
	writeFileSync(join(dir, ".draht", "extensions", "e.js"), "export default function () { return { name: 'e' }; }\n");
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "trust-key-lexical-")));
	agentDir = join(root, "agent");
	trusted = join(root, "trusted");
	attacker = join(root, "attacker");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	mkdirSync(join(trusted, "sub"), { recursive: true });
	mkdirSync(attacker, { recursive: true });
	plantProjectConfig(trusted);
	plantProjectConfig(attacker);
	// `<attacker>/O/..` is lexically `<attacker>`, physically `<trusted>`.
	symlinkSync(join(trusted, "sub"), join(attacker, "O"));
	symlinkSync(trusted, join(root, "link"));
	process.env.HOME = join(root, "home");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(root, { recursive: true, force: true });
});

function store(): ProjectTrustStore {
	return new ProjectTrustStore(agentDir);
}

function resolveTrusted(cwd: string): Promise<boolean> {
	return resolveProjectTrusted({
		cwd,
		trustStore: store(),
		projectTrustContext: { cwd, mode: "print", hasUI: false, ui: {} as ProjectTrustContext["ui"] },
	});
}

describe("a trust key that does not name the directory whose project config loads", () => {
	it("does not lend a trusted directory's decision to the spelling's own config dir", async () => {
		store().set(trusted, true);
		expect(trustKeyPath(`${attacker}/O/..`)).toBe(trusted);
		expect(hasTrustRequiringProjectResources(`${attacker}/O/..`)).toBe(true);
		expect(store().get(`${attacker}/O/..`)).toBe(null);
		expect(await resolveTrusted(`${attacker}/O/..`)).toBe(false);
	});

	it("still lets a refusal recorded anywhere up the resolved chain bind", async () => {
		store().set(root, false);
		expect(store().get(`${attacker}/O/..`)).toBe(false);
	});

	it("keeps trusting an ordinary cwd", async () => {
		store().set(trusted, true);
		expect(store().get(trusted)).toBe(true);
		expect(await resolveTrusted(trusted)).toBe(true);
		expect(await resolveTrusted(join(trusted, "sub"))).toBe(true);
	});

	it("keeps trusting a plain symlinked cwd whose target is trusted", async () => {
		store().set(trusted, true);
		expect(store().get(join(root, "link"))).toBe(true);
		expect(await resolveTrusted(join(root, "link"))).toBe(true);
	});

	it("keeps trusting a `..` that crossed no symlink", async () => {
		store().set(trusted, true);
		expect(store().get(`${trusted}/sub/..`)).toBe(true);
		expect(await resolveTrusted(`${trusted}/sub/..`)).toBe(true);
	});

	it("keeps trusting a divergent spelling whose own directory holds no project config", async () => {
		mkdirSync(join(root, "bare"), { recursive: true });
		symlinkSync(join(trusted, "sub"), join(root, "bare", "O"));
		store().set(trusted, true);
		expect(store().get(`${root}/bare/O/..`)).toBe(true);
	});
});
