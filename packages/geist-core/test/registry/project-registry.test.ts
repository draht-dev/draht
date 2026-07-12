import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../src/project.js";
import { ProjectRegistry } from "../../src/registry/project-registry.js";
import { InMemoryRecentsStore } from "../../src/registry/recents-store.js";

let workspaceRoot: string;

beforeEach(() => {
	workspaceRoot = mkdtempSync(join(tmpdir(), "project-registry-test-"));
});

afterEach(() => {
	rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Creates a real git-marker subdirectory under `workspaceRoot`, returning its absolute path. */
function makeRepoDir(name: string): string {
	const dir = join(workspaceRoot, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	return dir;
}

describe("ProjectRegistry — yaml source only", () => {
	test("lists projects declared in config.projects", () => {
		const registry = new ProjectRegistry({
			config: {
				projects: {
					fr3n: { root: "/dev/fr3n" },
					kintura: { root: "/dev/kintura", name: "Kintura" },
				},
			},
		});

		expect(registry.list()).toEqual([
			{ slug: "fr3n", name: "fr3n", root: "/dev/fr3n" },
			{ slug: "kintura", name: "Kintura", root: "/dev/kintura" },
		]);
	});

	test("name defaults to the slug when the yaml entry omits it", () => {
		const registry = new ProjectRegistry({ config: { projects: { draht: { root: "/dev/draht" } } } });

		expect(registry.get("draht")).toEqual({ slug: "draht", name: "draht", root: "/dev/draht" });
	});

	test("empty registry when no config and no recents are given", () => {
		expect(new ProjectRegistry().list()).toEqual([]);
	});
});

describe("ProjectRegistry — workspaceRoots discovery only", () => {
	test("lists projects discovered under configured workspaceRoots", () => {
		const fr3nDir = makeRepoDir("fr3n");
		makeRepoDir("kintura");

		const registry = new ProjectRegistry({ config: { workspaceRoots: [workspaceRoot] } });

		expect(registry.list()).toEqual([
			{ slug: "fr3n", name: "fr3n", root: fr3nDir },
			{ slug: "kintura", name: "kintura", root: join(workspaceRoot, "kintura") },
		]);
	});
});

describe("ProjectRegistry — recents source only", () => {
	test("lists projects loaded from the injected RecentsStore", () => {
		const recentsStore = new InMemoryRecentsStore();
		recentsStore.save([{ slug: "fr3n", name: "fr3n", root: "/dev/fr3n" }]);

		const registry = new ProjectRegistry({ recentsStore });

		expect(registry.list()).toEqual([{ slug: "fr3n", name: "fr3n", root: "/dev/fr3n" }]);
	});

	test("touchRecent() records a project via the store, reflected on the next list()", () => {
		const recentsStore = new InMemoryRecentsStore();
		const registry = new ProjectRegistry({ recentsStore });
		const fr3n: Project = { slug: "fr3n", name: "fr3n", root: "/dev/fr3n" };

		registry.touchRecent(fr3n);

		expect(registry.list()).toEqual([fr3n]);
		expect(recentsStore.load()).toEqual([fr3n]);
	});
});

describe("ProjectRegistry — merged, with dedup", () => {
	test("merges all three sources when slugs are disjoint", () => {
		makeRepoDir("discovered-only");
		const recentsStore = new InMemoryRecentsStore();
		recentsStore.save([{ slug: "recent-only", name: "recent-only", root: "/dev/recent-only" }]);

		const registry = new ProjectRegistry({
			config: {
				projects: { "yaml-only": { root: "/dev/yaml-only" } },
				workspaceRoots: [workspaceRoot],
			},
			recentsStore,
		});

		expect(registry.list().map((p) => p.slug)).toEqual(["discovered-only", "recent-only", "yaml-only"]);
	});

	test("a project appearing in multiple sources is deduplicated to a single entry, and yaml wins on conflict", () => {
		const discoveredDir = makeRepoDir("fr3n"); // discovery would name it "fr3n" too, root = discoveredDir
		const recentsStore = new InMemoryRecentsStore();
		recentsStore.save([{ slug: "fr3n", name: "stale recent name", root: "/stale/recents/root" }]);

		const registry = new ProjectRegistry({
			config: {
				// yaml declares the SAME slug with a different root/name — yaml must win.
				projects: { fr3n: { root: "/authoritative/yaml/root", name: "fr3n (yaml)" } },
				workspaceRoots: [workspaceRoot],
			},
			recentsStore,
		});

		const list = registry.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toEqual({ slug: "fr3n", name: "fr3n (yaml)", root: "/authoritative/yaml/root" });
		// Sanity: prove the discovered root really was different, so this is a genuine conflict, not a coincidence.
		expect(discoveredDir).not.toBe("/authoritative/yaml/root");
	});

	test("discovery wins over a stale recents entry when yaml doesn't declare the slug", () => {
		const discoveredDir = makeRepoDir("kintura");
		const recentsStore = new InMemoryRecentsStore();
		recentsStore.save([{ slug: "kintura", name: "stale", root: "/stale/root" }]);

		const registry = new ProjectRegistry({ config: { workspaceRoots: [workspaceRoot] }, recentsStore });

		expect(registry.get("kintura")).toEqual({ slug: "kintura", name: "kintura", root: discoveredDir });
	});

	test("list() is sorted by slug regardless of source ordering", () => {
		makeRepoDir("bbb");
		const registry = new ProjectRegistry({
			config: {
				projects: { zzz: { root: "/dev/zzz" }, aaa: { root: "/dev/aaa" } },
				workspaceRoots: [workspaceRoot],
			},
		});

		expect(registry.list().map((p) => p.slug)).toEqual(["aaa", "bbb", "zzz"]);
	});
});

describe("ProjectRegistry.get", () => {
	test("returns undefined for an unknown slug", () => {
		const registry = new ProjectRegistry({ config: { projects: { fr3n: { root: "/dev/fr3n" } } } });
		expect(registry.get("nonexistent")).toBeUndefined();
	});
});
