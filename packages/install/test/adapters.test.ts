import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapterFor, KNOWN_ADAPTER_KINDS } from "../src/adapters/index.ts";
import type { AdapterContext } from "../src/adapters/types.ts";
import { CliError } from "../src/errors.ts";
import { tempRoot } from "./helpers/cli.ts";
import { createStubHost } from "./helpers/stub-host.ts";

const CLAUDE_MARKETPLACE_REGISTERED = JSON.stringify([{ name: "draht" }]);
const CLAUDE_MARKETPLACE_EMPTY = JSON.stringify([]);
const CLAUDE_PLUGIN_INSTALLED = JSON.stringify([{ name: "draht", marketplace: "draht", enabled: true }]);
const CLAUDE_PLUGIN_DISABLED = JSON.stringify([{ name: "draht", marketplace: "draht", enabled: false }]);
const CLAUDE_PLUGIN_ABSENT = JSON.stringify([]);
const CODEX_MARKETPLACE_EMPTY = JSON.stringify({ marketplaces: [] });
const CODEX_MARKETPLACE_REGISTERED = JSON.stringify({ marketplaces: [{ name: "draht" }] });
const CODEX_PLUGIN_ABSENT = JSON.stringify({ installed: [] });
const CODEX_PLUGIN_INSTALLED = JSON.stringify({ installed: [{ name: "draht", marketplace: "draht" }] });

function makeContext(
	home: string,
	runner: AdapterContext["runHost"],
	hosts: Record<string, string> = {},
): AdapterContext {
	return {
		root: join(home, ".draht", "install"),
		home,
		env: { HOME: home, PATH: "/nonexistent" },
		runHost: runner,
		hostPath: (name) => hosts[name] ?? null,
	};
}

const claudeComponent = { id: "claude-plugin", kind: "claude-plugin", npmName: "draht-claude" };
const codexComponent = { id: "codex-plugin", kind: "codex-plugin", npmName: "draht-codex" };
const cliComponent = { id: "coding-agent", kind: "global-cli", npmName: "@draht/coding-agent" };

describe("adapter registry", () => {
	it("keys adapters by kind", () => {
		expect(KNOWN_ADAPTER_KINDS.slice().sort()).toEqual(["claude-plugin", "codex-plugin", "global-cli"]);
		expect(adapterFor("claude-plugin").kind).toBe("claude-plugin");
	});

	it("fails closed on an unknown kind", () => {
		expect(() => adapterFor("not-a-kind")).toThrow(CliError);
	});
});

describe("claude-plugin adapter", () => {
	it("targets the local claude marketplace directory under the resolved home", () => {
		const adapter = adapterFor("claude-plugin");
		const ctx = makeContext("/home/tester", createStubHost().runner);

		expect(adapter.targetDir(ctx, claudeComponent)).toBe("/home/tester/.draht/claude-marketplace");
	});

	it("stages the payload under plugins/draht and writes the marketplace manifest", async () => {
		const tmp = tempRoot("claude-stage");
		try {
			const payload = join(tmp.path, "payload");
			mkdirSync(payload, { recursive: true });
			writeFileSync(
				join(payload, "package.json"),
				JSON.stringify({ name: "draht-claude", version: "9.9.9", description: "Test payload" }),
			);
			writeFileSync(join(payload, "SKILL.md"), "content");
			const staging = join(tmp.path, "staging");

			const adapter = adapterFor("claude-plugin");
			await adapter.stage(makeContext(tmp.path, createStubHost().runner), claudeComponent, payload, staging);

			expect(readFileSync(join(staging, "plugins", "draht", "SKILL.md"), "utf8")).toBe("content");
			const manifest = JSON.parse(readFileSync(join(staging, ".claude-plugin", "marketplace.json"), "utf8"));
			expect(manifest.name).toBe("draht");
			expect(manifest.plugins[0].name).toBe("draht");
			expect(manifest.plugins[0].source).toBe("./plugins/draht");
		} finally {
			tmp.dispose();
		}
	});

	it("drives the pinned first-install call sequence, skipping the redundant enable", async () => {
		// `claude plugin install` leaves a freshly installed plugin enabled as a
		// side effect (CLAUDE_PLUGIN_INSTALLED here), so the explicit enable call
		// that used to always follow it is now skipped — the real `claude` CLI
		// rejects a redundant enable on an already-enabled plugin instead of
		// treating it as a no-op.
		const stub = createStubHost([
			{ match: "plugin marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_EMPTY } },
			// Absent when probed, installed (and already enabled) once checked after
			// the install call.
			{
				match: "plugin list --json",
				respond: [{ stdout: CLAUDE_PLUGIN_ABSENT }, { stdout: CLAUDE_PLUGIN_INSTALLED }],
			},
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });
		const target = "/home/tester/.draht/claude-marketplace";

		const outcome = await adapterFor("claude-plugin").register(ctx, claudeComponent, target);

		expect(stub.commandLines()).toEqual([
			"/usr/bin/claude plugin marketplace list --json",
			"/usr/bin/claude plugin list --json",
			`/usr/bin/claude plugin validate ${target}/plugins/draht`,
			`/usr/bin/claude plugin marketplace add ${target}`,
			"/usr/bin/claude plugin install draht@draht --scope user",
			"/usr/bin/claude plugin list --json",
			"/usr/bin/claude plugin list --json",
		]);
		expect(outcome.registered).toBe(true);
		expect(outcome.effectiveness).toBe("restart-required");
	});

	it("calls disable when a reinstall genuinely leaves a previously-disabled plugin re-enabled", async () => {
		// The install step's auto-enable side effect means restoring a previously
		// *disabled* plugin is never redundant — the post-install state (enabled)
		// always differs from the target state (disabled), so the explicit
		// disable call still fires.
		const stub = createStubHost([
			{ match: "plugin marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_REGISTERED } },
			{
				match: "plugin list --json",
				respond: [
					{ stdout: CLAUDE_PLUGIN_DISABLED },
					{ stdout: CLAUDE_PLUGIN_INSTALLED },
					{ stdout: CLAUDE_PLUGIN_DISABLED },
				],
			},
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });
		const target = "/home/tester/.draht/claude-marketplace";

		const outcome = await adapterFor("claude-plugin").register(ctx, claudeComponent, target);

		expect(stub.commandLines()).toEqual([
			"/usr/bin/claude plugin marketplace list --json",
			"/usr/bin/claude plugin list --json",
			`/usr/bin/claude plugin validate ${target}/plugins/draht`,
			"/usr/bin/claude plugin marketplace update draht",
			"/usr/bin/claude plugin uninstall draht@draht",
			"/usr/bin/claude plugin install draht@draht --scope user",
			"/usr/bin/claude plugin list --json",
			"/usr/bin/claude plugin disable draht@draht",
			"/usr/bin/claude plugin list --json",
		]);
		expect(outcome.notes).toContain("preserved the previously disabled plugin state");
	});

	it("updates an already-registered marketplace and re-installs an already-installed plugin", async () => {
		const stub = createStubHost([
			{ match: "plugin marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_REGISTERED } },
			{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_INSTALLED } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });
		const target = "/home/tester/.draht/claude-marketplace";

		await adapterFor("claude-plugin").register(ctx, claudeComponent, target);

		expect(stub.commandLines()).toEqual([
			"/usr/bin/claude plugin marketplace list --json",
			"/usr/bin/claude plugin list --json",
			`/usr/bin/claude plugin validate ${target}/plugins/draht`,
			"/usr/bin/claude plugin marketplace update draht",
			"/usr/bin/claude plugin uninstall draht@draht",
			"/usr/bin/claude plugin install draht@draht --scope user",
			"/usr/bin/claude plugin list --json",
			"/usr/bin/claude plugin list --json",
		]);
	});

	it("passes the resolved home through to every host call and never uses a shell", async () => {
		const stub = createStubHost([
			{ match: "marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_EMPTY } },
			{
				match: "plugin list --json",
				respond: [{ stdout: CLAUDE_PLUGIN_ABSENT }, { stdout: CLAUDE_PLUGIN_INSTALLED }],
			},
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });

		await adapterFor("claude-plugin").register(ctx, claudeComponent, "/home/tester/.draht/claude-marketplace");

		for (const call of stub.calls) {
			expect(call.env?.HOME).toBe("/home/tester");
			expect(call.cwd).toBe("/home/tester");
			// argv is an array; nothing is ever concatenated into one string.
			expect(Array.isArray(call.args)).toBe(true);
		}
	});

	it("fails when the one hard call — plugin install — fails", async () => {
		const stub = createStubHost([
			{ match: "marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_EMPTY } },
			{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_ABSENT } },
			{ match: "plugin install draht@draht", respond: { status: 1, stderr: "boom" } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });

		await expect(
			adapterFor("claude-plugin").register(ctx, claudeComponent, "/home/tester/.draht/claude-marketplace"),
		).rejects.toThrow(/plugin install/);
	});

	it("fails when the host CLI is not present at all", async () => {
		const ctx = makeContext("/home/tester", createStubHost().runner, {});

		await expect(
			adapterFor("claude-plugin").register(ctx, claudeComponent, "/home/tester/.draht/claude-marketplace"),
		).rejects.toThrow(/claude/);
	});

	it("fails when the host returns unparseable JSON rather than guessing state", async () => {
		const stub = createStubHost([{ match: "marketplace list --json", respond: { stdout: "not json" } }]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });

		await expect(
			adapterFor("claude-plugin").register(ctx, claudeComponent, "/home/tester/.draht/claude-marketplace"),
		).rejects.toThrow(/JSON/i);
	});

	it("deregisters in the pinned order and verifies before reporting success", async () => {
		const stub = createStubHost([
			{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_ABSENT } },
			{ match: "marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_EMPTY } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });

		const outcome = await adapterFor("claude-plugin").deregister(
			ctx,
			claudeComponent,
			"/home/tester/.draht/claude-marketplace",
		);

		expect(stub.commandLines()).toEqual([
			"/usr/bin/claude plugin disable draht@draht",
			"/usr/bin/claude plugin uninstall draht@draht",
			"/usr/bin/claude plugin marketplace remove draht",
			"/usr/bin/claude plugin list --json",
			"/usr/bin/claude plugin marketplace list --json",
		]);
		expect(outcome.deregistered).toBe(true);
	});

	it("reports deregistration as incomplete when the host still lists the plugin", async () => {
		const stub = createStubHost([
			{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_INSTALLED } },
			{ match: "marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_EMPTY } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });

		const outcome = await adapterFor("claude-plugin").deregister(
			ctx,
			claudeComponent,
			"/home/tester/.draht/claude-marketplace",
		);

		expect(outcome.deregistered).toBe(false);
		expect(outcome.notes.join(" ")).toMatch(/still/i);
	});

	it("reports deregistration as incomplete when the marketplace is still registered", async () => {
		const stub = createStubHost([
			{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_ABSENT } },
			{ match: "marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_REGISTERED } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { claude: "/usr/bin/claude" });

		const outcome = await adapterFor("claude-plugin").deregister(
			ctx,
			claudeComponent,
			"/home/tester/.draht/claude-marketplace",
		);

		expect(outcome.deregistered).toBe(false);
	});

	it("treats an absent host on uninstall as nothing left to deregister", async () => {
		const stub = createStubHost();
		const ctx = makeContext("/home/tester", stub.runner, {});

		const outcome = await adapterFor("claude-plugin").deregister(
			ctx,
			claudeComponent,
			"/home/tester/.draht/claude-marketplace",
		);

		expect(outcome.deregistered).toBe(true);
		expect(stub.calls).toEqual([]);
		expect(outcome.notes.join(" ")).toMatch(/not installed|not present|not found/i);
	});
});

describe("codex-plugin adapter", () => {
	it("stages the payload and writes the codex marketplace manifest", async () => {
		const tmp = tempRoot("codex-stage");
		try {
			const payload = join(tmp.path, "payload");
			mkdirSync(payload, { recursive: true });
			writeFileSync(join(payload, "package.json"), JSON.stringify({ name: "draht-codex", version: "9.9.9" }));
			const staging = join(tmp.path, "staging");

			await adapterFor("codex-plugin").stage(
				makeContext(tmp.path, createStubHost().runner),
				codexComponent,
				payload,
				staging,
			);

			const manifest = JSON.parse(readFileSync(join(staging, ".agents", "plugins", "marketplace.json"), "utf8"));
			expect(manifest.name).toBe("draht");
			expect(manifest.plugins[0].source).toEqual({ source: "local", path: "./plugins/draht" });
			expect(existsSync(join(staging, "plugins", "draht", "package.json"))).toBe(true);
		} finally {
			tmp.dispose();
		}
	});

	it("drives the pinned codex install sequence", async () => {
		const stub = createStubHost([
			{ match: "plugin marketplace list --json", respond: { stdout: CODEX_MARKETPLACE_EMPTY } },
			{
				match: "plugin list --json",
				respond: [{ stdout: CODEX_PLUGIN_ABSENT }, { stdout: CODEX_PLUGIN_INSTALLED }],
			},
		]);
		const ctx = makeContext("/home/tester", stub.runner, { codex: "/usr/bin/codex" });
		const target = "/home/tester/.draht/codex-marketplace";

		const outcome = await adapterFor("codex-plugin").register(ctx, codexComponent, target);

		expect(stub.commandLines()).toEqual([
			"/usr/bin/codex plugin marketplace list --json",
			"/usr/bin/codex plugin list --json",
			`/usr/bin/codex plugin marketplace add ${target}`,
			"/usr/bin/codex plugin add draht@draht",
			"/usr/bin/codex plugin list --json",
		]);
		// Codex reload semantics are unverified — the adapter must not claim more.
		expect(outcome.effectiveness).toBe("unknown");
	});

	it("removes a previously installed codex plugin before re-adding it", async () => {
		const stub = createStubHost([
			{ match: "plugin marketplace list --json", respond: { stdout: CODEX_MARKETPLACE_REGISTERED } },
			{ match: "plugin list --json", respond: { stdout: CODEX_PLUGIN_INSTALLED } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { codex: "/usr/bin/codex" });
		const target = "/home/tester/.draht/codex-marketplace";

		await adapterFor("codex-plugin").register(ctx, codexComponent, target);

		expect(stub.commandLines()).toContain("/usr/bin/codex plugin remove draht@draht");
		expect(stub.commandLines().indexOf("/usr/bin/codex plugin remove draht@draht")).toBeLessThan(
			stub.commandLines().indexOf("/usr/bin/codex plugin add draht@draht"),
		);
	});

	it("deregisters codex in the pinned order", async () => {
		const stub = createStubHost([
			{ match: "plugin list --json", respond: { stdout: CODEX_PLUGIN_ABSENT } },
			{ match: "marketplace list --json", respond: { stdout: CODEX_MARKETPLACE_EMPTY } },
		]);
		const ctx = makeContext("/home/tester", stub.runner, { codex: "/usr/bin/codex" });

		const outcome = await adapterFor("codex-plugin").deregister(
			ctx,
			codexComponent,
			"/home/tester/.draht/codex-marketplace",
		);

		expect(stub.commandLines()).toEqual([
			"/usr/bin/codex plugin remove draht@draht",
			"/usr/bin/codex plugin marketplace remove draht",
			"/usr/bin/codex plugin list --json",
			"/usr/bin/codex plugin marketplace list --json",
		]);
		expect(outcome.deregistered).toBe(true);
	});
});

describe("global-cli adapter", () => {
	it("has no engine-owned target directory", () => {
		const adapter = adapterFor("global-cli");
		expect(adapter.payload).toBe("delegated");
		expect(adapter.targetDir(makeContext("/home/tester", createStubHost().runner), cliComponent)).toBeNull();
	});

	it("delegates install to npm with an exact argv", async () => {
		const stub = createStubHost();
		const ctx = makeContext("/home/tester", stub.runner, { npm: "/usr/bin/npm" });

		const outcome = await adapterFor("global-cli").delegateInstall?.(ctx, cliComponent, "2026.8.1-1");

		expect(stub.commandLines()).toEqual(["/usr/bin/npm install --global @draht/coding-agent@2026.8.1-1"]);
		expect(outcome?.method).toBe("npm-global");
		expect(outcome?.packageName).toBe("@draht/coding-agent");
	});

	it("delegates uninstall to npm with an exact argv", async () => {
		const stub = createStubHost();
		const ctx = makeContext("/home/tester", stub.runner, { npm: "/usr/bin/npm" });

		await adapterFor("global-cli").delegateUninstall?.(ctx, cliComponent);

		expect(stub.commandLines()).toEqual(["/usr/bin/npm uninstall --global @draht/coding-agent"]);
	});

	it("reports a delegated failure honestly instead of claiming a rollback", async () => {
		const stub = createStubHost([{ match: "install --global", respond: { status: 1, stderr: "EACCES" } }]);
		const ctx = makeContext("/home/tester", stub.runner, { npm: "/usr/bin/npm" });

		await expect(adapterFor("global-cli").delegateInstall?.(ctx, cliComponent, "1.0.0")).rejects.toThrow(/EACCES/);
	});

	it("fails when no package manager is available", async () => {
		const ctx = makeContext("/home/tester", createStubHost().runner, {});

		await expect(adapterFor("global-cli").delegateInstall?.(ctx, cliComponent, "1.0.0")).rejects.toThrow(/npm/);
	});

	it("classifies effect as next-session, since a running process keeps its old binary", async () => {
		const stub = createStubHost();
		const ctx = makeContext("/home/tester", stub.runner, { npm: "/usr/bin/npm" });

		const outcome = await adapterFor("global-cli").delegateInstall?.(ctx, cliComponent, "1.0.0");
		expect(outcome?.effectiveness).toBe("next-session");
	});
});
