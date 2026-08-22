import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

// macOS needs more than MAXSYMLINKS (32) hops for realpath to fail with ELOOP.
const SYMLINK_HOPS = 60;

describe("trust gate with an unresolvable cwd", () => {
	let root: string;
	let tn: string;
	let agentDir: string;
	let originalHome: string | undefined;

	const realProject = () => join(tn, "a", "b", "p");
	const viaReadableSymlink = () => join(tn, "L", "p");
	const viaSymlinkLoop = () => join(tn, "S0", "p");

	beforeEach(() => {
		originalHome = process.env.HOME;
		root = realpathSync(mkdtempSync(join(tmpdir(), "trust-fail-closed-")));
		tn = join(root, "tn");
		agentDir = join(root, "agent");
		mkdirSync(join(tn, "a", ".agents", "skills"), { recursive: true });
		mkdirSync(join(tn, "a", "b", "p"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(join(tn, "a", "b"), join(tn, "L"));

		let target = join(tn, "a", "b");
		for (let hop = SYMLINK_HOPS; hop >= 0; hop--) {
			symlinkSync(target, join(tn, `S${hop}`));
			target = join(tn, `S${hop}`);
		}

		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [tn]: false }));
		process.env.HOME = root;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(root, { recursive: true, force: true });
	});

	function resolveTrusted(cwd: string): Promise<boolean> {
		return resolveProjectTrusted({
			cwd,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "always",
			projectTrustContext: { cwd, mode: "print", hasUI: false, ui: {} as ProjectTrustContext["ui"] },
		});
	}

	it("gates a cwd whose real path cannot be resolved", () => {
		expect(hasTrustRequiringProjectResources(viaSymlinkLoop())).toBe(true);
	});

	it("honors a saved 'do not trust' decision that the lexical ancestor chain would skip", async () => {
		expect(await resolveTrusted(realProject())).toBe(false);
		expect(await resolveTrusted(viaSymlinkLoop())).toBe(false);
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
		expect(await resolveTrusted(plain)).toBe(true);
		expect(await resolveTrusted(join(root, "plain-link", "project"))).toBe(true);
	});

	it("still ignores the user's own skills dir", () => {
		const userHome = join(root, "home");
		mkdirSync(join(userHome, ".agents", "skills"), { recursive: true });
		process.env.HOME = userHome;
		expect(hasTrustRequiringProjectResources(userHome)).toBe(false);
	});
});
