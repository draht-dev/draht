import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@draht/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

/**
 * End-to-end proof that a real session — built the exact way main.ts builds
 * one, with zero extra wiring — actually consults the permission gate before
 * a tool runs. This is the mechanism the CLI's own Agent loop invokes
 * (agent-session.ts's `_installAgentToolHooks`), exercised directly here
 * instead of through a live LLM call.
 */
describe("regression: permission gate is live on a real session, not just unit-tested in isolation", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-gate-live-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createRealSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		return session;
	}

	it("blocks a denied bash command via a project .draht/permissions.yml, with no extension configured by the caller", async () => {
		mkdirSync(join(tempDir, ".draht"), { recursive: true });
		writeFileSync(
			join(tempDir, ".draht", "permissions.yml"),
			'rules:\n  - tool: bash\n    pattern: "rm -rf *"\n    action: deny\n',
		);

		const session = await createRealSession();
		try {
			const decision = await session.agent.beforeToolCall?.({
				toolCall: { name: "bash", id: "t1" },
				args: { command: "rm -rf /" },
			} as never);

			expect(decision).toMatchObject({ block: true });
			expect((decision as { reason?: string })?.reason).toContain("deny");
		} finally {
			session.dispose();
		}
	});

	it("does not block an undenied bash command under the same project rules", async () => {
		mkdirSync(join(tempDir, ".draht"), { recursive: true });
		writeFileSync(
			join(tempDir, ".draht", "permissions.yml"),
			'rules:\n  - tool: bash\n    pattern: "rm -rf *"\n    action: deny\n  - tool: bash\n    pattern: "npm test"\n    action: allow\n',
		);

		const session = await createRealSession();
		try {
			const decision = await session.agent.beforeToolCall?.({
				toolCall: { name: "bash", id: "t2" },
				args: { command: "npm test" },
			} as never);

			expect(decision).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("bypass attempts that fooled the pre-review implementation stay blocked (sudo, chaining, command substitution)", async () => {
		mkdirSync(join(tempDir, ".draht"), { recursive: true });
		writeFileSync(
			join(tempDir, ".draht", "permissions.yml"),
			'rules:\n  - tool: bash\n    pattern: "rm -rf *"\n    action: deny\n',
		);

		const session = await createRealSession();
		try {
			for (const command of ["sudo rm -rf /", "echo hi && rm -rf /", 'bash -c "rm -rf /"', "$(echo rm -rf /)"]) {
				const decision = await session.agent.beforeToolCall?.({
					toolCall: { name: "bash", id: "t3" },
					args: { command },
				} as never);
				expect(decision, `expected "${command}" to be blocked`).toMatchObject({ block: true });
			}
		} finally {
			session.dispose();
		}
	});
});
