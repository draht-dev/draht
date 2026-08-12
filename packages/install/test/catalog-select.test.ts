import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogComponentSchema, KNOWN_KINDS, loadCatalog } from "../src/catalog.ts";
import { detect } from "../src/detect.ts";
import { UsageError } from "../src/errors.ts";
import { resolveHome, resolveInstallRoot } from "../src/paths.ts";
import { resolveSelection } from "../src/select.ts";
import { tempRoot } from "./helpers/cli.ts";

const catalog = loadCatalog();

function stubBin(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
}

describe("shipped component catalog", () => {
	it("ships exactly the four adjudicated components", () => {
		expect(catalog.map((component) => component.id).sort()).toEqual([
			"claude-plugin",
			"codex-plugin",
			"coding-agent",
			"installer",
		]);
	});

	it("validates every entry against the zod schema", () => {
		for (const component of catalog) {
			expect(CatalogComponentSchema.safeParse(component).success).toBe(true);
		}
	});

	it("keys adapters by kind, never by package name", () => {
		const byId = new Map(catalog.map((component) => [component.id, component]));
		expect(byId.get("claude-plugin")?.kind).toBe("claude-plugin");
		expect(byId.get("codex-plugin")?.kind).toBe("codex-plugin");
		expect(byId.get("coding-agent")?.kind).toBe("global-cli");
		expect(byId.get("installer")?.kind).toBe("global-cli");
	});

	it("only advertises the latest channel", () => {
		for (const component of catalog) {
			expect(component.channels).toEqual(["latest"]);
		}
	});

	it("rejects a malformed component id at schema level", () => {
		const bad = { ...catalog[0], id: "../escape" };
		expect(CatalogComponentSchema.safeParse(bad).success).toBe(false);
	});

	it("accepts an unknown kind at schema level so a future kind is pure data", () => {
		const future = { ...catalog[0], id: "future-thing", kind: "some-future-kind" };
		expect(CatalogComponentSchema.safeParse(future).success).toBe(true);
		expect(KNOWN_KINDS).not.toContain("some-future-kind");
	});
});

describe("selection", () => {
	const hostsPresent =
		(...present: string[]) =>
		(host: string) =>
			present.includes(host);

	it("defaults to the installer plus plugin payloads for hosts that are actually present", () => {
		const selection = resolveSelection({
			catalog,
			mode: "default",
			selectors: [],
			hostPresent: hostsPresent("claude", "npm"),
		});

		expect(selection.components.map((c) => c.id)).toEqual(["claude-plugin", "installer"]);
		expect(selection.mode).toBe("default");
	});

	it("omits every plugin payload when no host CLI is present", () => {
		const selection = resolveSelection({ catalog, mode: "default", selectors: [], hostPresent: hostsPresent("npm") });

		expect(selection.components.map((c) => c.id)).toEqual(["installer"]);
		expect(selection.skipped.map((s) => s.id).sort()).toEqual(["claude-plugin", "codex-plugin"]);
		expect(selection.skipped.every((s) => s.reason === "host-absent")).toBe(true);
	});

	it("resolves to nothing at all when even npm is absent, which is what --fail-on-empty guards", () => {
		const selection = resolveSelection({ catalog, mode: "default", selectors: [], hostPresent: hostsPresent() });

		expect(selection.components).toEqual([]);
		expect(selection.skipped.map((s) => s.id).sort()).toEqual(["claude-plugin", "codex-plugin", "installer"]);
	});

	it("never includes the coding agent by default", () => {
		const selection = resolveSelection({
			catalog,
			mode: "default",
			selectors: [],
			hostPresent: hostsPresent("claude", "codex"),
		});

		expect(selection.components.map((c) => c.id)).not.toContain("coding-agent");
	});

	it("--full selects every catalog component regardless of host presence", () => {
		const selection = resolveSelection({ catalog, mode: "full", selectors: [], hostPresent: hostsPresent() });

		expect(selection.components.map((c) => c.id).sort()).toEqual([
			"claude-plugin",
			"codex-plugin",
			"coding-agent",
			"installer",
		]);
	});

	it("explicit selectors replace the default set entirely", () => {
		const selection = resolveSelection({
			catalog,
			mode: "explicit",
			selectors: ["coding-agent"],
			hostPresent: hostsPresent("claude", "codex"),
		});

		expect(selection.components.map((c) => c.id)).toEqual(["coding-agent"]);
	});

	it("honours an explicit selector even when its host is absent, and says so", () => {
		const selection = resolveSelection({
			catalog,
			mode: "explicit",
			selectors: ["claude-plugin"],
			hostPresent: hostsPresent(),
		});

		expect(selection.components.map((c) => c.id)).toEqual(["claude-plugin"]);
		expect(selection.hostMissing.map((h) => h.id)).toEqual(["claude-plugin"]);
	});

	it("fails closed on an unknown selector", () => {
		expect(() =>
			resolveSelection({ catalog, mode: "explicit", selectors: ["nope"], hostPresent: hostsPresent() }),
		).toThrow(UsageError);
	});

	it("fails closed when a selected component has an unknown kind", () => {
		const poisoned = [{ ...catalog[0], id: "weird", kind: "not-a-kind" }];
		expect(() =>
			resolveSelection({ catalog: poisoned, mode: "explicit", selectors: ["weird"], hostPresent: hostsPresent() }),
		).toThrow(/not-a-kind/);
	});

	it("does not fail on an unknown kind that is never selected", () => {
		const poisoned = [...catalog, { ...catalog[0], id: "weird", kind: "not-a-kind", defaultProfile: false }];
		const selection = resolveSelection({
			catalog: poisoned,
			mode: "explicit",
			selectors: ["installer"],
			hostPresent: hostsPresent(),
		});

		expect(selection.components.map((c) => c.id)).toEqual(["installer"]);
	});

	it("keeps duplicate selectors deterministic", () => {
		const selection = resolveSelection({
			catalog,
			mode: "explicit",
			selectors: ["installer", "coding-agent", "installer"],
			hostPresent: hostsPresent(),
		});

		expect(selection.components.map((c) => c.id)).toEqual(["installer", "coding-agent"]);
	});

	it("reports an empty resolved selection so --fail-on-empty can be enforced mechanically", () => {
		const selection = resolveSelection({
			catalog: catalog.filter((c) => c.id !== "installer"),
			mode: "default",
			selectors: [],
			hostPresent: hostsPresent(),
		});

		expect(selection.components).toEqual([]);
	});

	it("keeps the coding agent out of the default set even with every host present", () => {
		const selection = resolveSelection({
			catalog,
			mode: "default",
			selectors: [],
			hostPresent: () => true,
		});

		expect(selection.components.map((c) => c.id)).toEqual(["claude-plugin", "codex-plugin", "installer"]);
	});
});

describe("home and install-root resolution", () => {
	it("prefers DRAHT_HOME, then HOME", () => {
		expect(resolveHome({ DRAHT_HOME: "/fake/a", HOME: "/fake/b" })).toBe("/fake/a");
		expect(resolveHome({ HOME: "/fake/b" })).toBe("/fake/b");
	});

	it("derives the install root from the resolved home unless overridden", () => {
		expect(resolveInstallRoot({ HOME: "/fake/b" })).toBe("/fake/b/.draht/install");
		expect(resolveInstallRoot({ HOME: "/fake/b", DRAHT_INSTALL_DIR: "/fake/state" })).toBe("/fake/state");
	});
});

describe("detection", () => {
	it("finds host CLIs only on the PATH it is given", () => {
		const tmp = tempRoot("detect");
		try {
			const binDir = join(tmp.path, "bin");
			stubBin(binDir, "claude");
			const home = join(tmp.path, "home");
			mkdirSync(home, { recursive: true });

			const result = detect({ PATH: binDir, HOME: home });

			expect(result.hosts.claude.present).toBe(true);
			expect(result.hosts.claude.path).toBe(join(binDir, "claude"));
			expect(result.hosts.codex.present).toBe(false);
		} finally {
			tmp.dispose();
		}
	});

	it("reports node and npm availability for doctor", () => {
		const tmp = tempRoot("detect");
		try {
			const binDir = join(tmp.path, "bin");
			stubBin(binDir, "npm");
			const result = detect({ PATH: binDir, HOME: join(tmp.path, "home") });

			expect(result.hosts.npm.present).toBe(true);
			expect(result.hosts.node.present).toBe(false);
		} finally {
			tmp.dispose();
		}
	});

	it("flags the legacy curl clone, the shadowing wrapper and legacy ~/.pi state", () => {
		const tmp = tempRoot("detect");
		try {
			const home = join(tmp.path, "home");
			mkdirSync(join(home, ".draht", ".git"), { recursive: true });
			mkdirSync(join(home, ".local", "bin"), { recursive: true });
			writeFileSync(join(home, ".local", "bin", "draht"), "#!/bin/sh\n");
			mkdirSync(join(home, ".pi"), { recursive: true });

			const result = detect({ PATH: "", HOME: home });
			const ids = result.legacy.map((finding) => finding.id).sort();

			expect(ids).toEqual(["legacy-curl-clone", "legacy-pi-state", "wrapper-shadowing"]);
		} finally {
			tmp.dispose();
		}
	});

	it("reports no legacy findings for a clean home", () => {
		const tmp = tempRoot("detect");
		try {
			const home = join(tmp.path, "home");
			mkdirSync(home, { recursive: true });

			expect(detect({ PATH: "", HOME: home }).legacy).toEqual([]);
		} finally {
			tmp.dispose();
		}
	});
});
