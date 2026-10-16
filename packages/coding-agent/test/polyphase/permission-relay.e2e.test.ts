/**
 * The permission bridge end to end, against a REAL draht child: the source CLI under tsx (no build
 * step), the keyless stub provider scripting one bash call, and the child's own permission gate
 * deciding it. Nothing here imports the gate or the bridge into the test process — the only way the
 * marker file appears is the child running the command, and the only way the parent hears about it
 * is the child's IPC ask.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { ChildEventReducer } from "../../src/core/polyphase/child-events.ts";
import { type ChildCommand, runChildAgent } from "../../src/core/polyphase/child-process.ts";
import type { AgentRunContext, ChildPermissionRequest, TranscriptItem } from "../../src/core/polyphase/types.ts";
import { NO_UI_APPROVAL_SUFFIX } from "../../src/core/polyphase/types.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const tsxPath = createRequire(__filename).resolve("tsx");
const cliCommand: ChildCommand = { bin: process.execPath, argsPrefix: ["--import", tsxPath, cliPath] };

const RUN_TIMEOUT_MS = 60_000;

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { project: string; agentDir: string; marker: string } {
	const root = mkdtempSync(join(tmpdir(), "draht-relay-e2e-"));
	dirs.push(root);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(project, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { project, agentDir, marker: join(project, "marker.txt") };
}

/**
 * Inherited env minus everything that would let ambient shell state decide the outcome: a
 * developer's exported `DRAHT_PERMISSION_MODE`, or a polyphase depth from an enclosing draht.
 */
function childEnv(agentDir: string, command: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.DRAHT_PERMISSION_MODE;
	delete env.DRAHT_POLYPHASE_DEPTH;
	delete env.DRAHT_POLYPHASE_PERMISSION_BRIDGE;
	return {
		...env,
		DRAHT_STUB_PROVIDER: "1",
		DRAHT_STUB_TOOL_CALLS: JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]),
		[ENV_AGENT_DIR]: agentDir,
		TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json"),
	};
}

async function runWorker(options: { project: string; agentDir: string; command: string; run: AgentRunContext }) {
	const reducer = new ChildEventReducer({
		model: { source: "frontmatter", requested: "draht-stub/stub-1", confirmed: false },
	});
	const result = await runChildAgent({
		cwd: options.project,
		agent: { name: "worker", description: "e2e", systemPrompt: "", source: "user", model: "draht-stub/stub-1" },
		task: "run the scripted command",
		command: cliCommand,
		baseEnv: childEnv(options.agentDir, options.command),
		run: { ...options.run, reducer },
	});
	const tool = reducer.state.transcript.find(
		(item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool" && item.toolCallId === "call-1",
	);
	const notices = reducer.state.transcript.flatMap((item) => (item.kind === "notice" ? [item.text] : []));
	return { result, tool, notices, stderr: reducer.state.stderrTail };
}

describe("permission bridge, real child process", () => {
	it(
		"consumes the bridge marker: the child's own tool subprocesses never see it",
		async () => {
			const { project, agentDir, marker } = workspace();

			const { stderr } = await runWorker({
				project,
				agentDir,
				command: `echo "marker=[$DRAHT_POLYPHASE_PERMISSION_BRIDGE]" > ${marker}`,
				run: {
					env: { DRAHT_PERMISSION_MODE: "default" },
					onPermissionAsk: async () => ({ kind: "approved" }),
				},
			});

			// Approved, so it ran, and the variable the parent set for the child was gone by then.
			expect(readFileSync(marker, "utf8").trim(), stderr).toBe("marker=[]");
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"runs a call the child's gate holds once the parent approves it",
		async () => {
			const { project, agentDir, marker } = workspace();
			const command = `echo relayed > ${marker}`;
			const asks: ChildPermissionRequest[] = [];

			const { result, tool, notices, stderr } = await runWorker({
				project,
				agentDir,
				command,
				run: {
					env: { DRAHT_PERMISSION_MODE: "default" },
					onPermissionAsk: async (request) => {
						asks.push(request);
						return { kind: "approved" };
					},
				},
			});

			expect(asks, stderr).toHaveLength(1);
			expect(asks[0]).toMatchObject({
				toolName: "bash",
				toolCallId: "call-1",
				input: { command },
				via: [],
				cwd: project,
			});
			expect(existsSync(marker), stderr).toBe(true);
			expect(tool?.status).toBe("ok");
			expect(result.exitCode).toBe(0);
			expect(result.blockedToolCalls ?? 0).toBe(0);
			// The agent's own transcript records the ask and how it was answered.
			expect(notices.some((text) => text.startsWith("approval requested: bash"))).toBe(true);
			expect(notices.some((text) => text.startsWith("approved: bash"))).toBe(true);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"does not run a call the parent denies, and tells the child why",
		async () => {
			const { project, agentDir, marker } = workspace();

			const { tool, notices, stderr } = await runWorker({
				project,
				agentDir,
				command: `echo relayed > ${marker}`,
				run: {
					env: { DRAHT_PERMISSION_MODE: "default" },
					onPermissionAsk: async () => ({ kind: "denied", reason: "Denied by the user in the parent session" }),
				},
			});

			expect(notices.some((text) => text.startsWith("denied: bash"))).toBe(true);
			expect(existsSync(marker), stderr).toBe(false);
			expect(tool?.status).toBe("error");
			expect(tool?.resultPreview).toContain("Denied by the user in the parent session");
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"still blocks the call, as before, when the parent offers no bridge",
		async () => {
			const { project, agentDir, marker } = workspace();

			const { result, tool, stderr } = await runWorker({
				project,
				agentDir,
				command: `echo relayed > ${marker}`,
				run: { env: { DRAHT_PERMISSION_MODE: "default" } },
			});

			expect(existsSync(marker), stderr).toBe(false);
			expect(tool?.status).toBe("blocked");
			expect(tool?.blockedReason?.endsWith(NO_UI_APPROVAL_SUFFIX)).toBe(true);
			expect(result.blockedToolCalls).toBe(1);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"never asks when the mode the parent hands down already allows the call",
		async () => {
			const { project, agentDir, marker } = workspace();
			const asks: ChildPermissionRequest[] = [];

			const { stderr } = await runWorker({
				project,
				agentDir,
				command: `echo relayed > ${marker}`,
				run: {
					env: { DRAHT_PERMISSION_MODE: "auto" },
					onPermissionAsk: async (request) => {
						asks.push(request);
						return { kind: "denied", reason: "should not have been asked" };
					},
				},
			});

			expect(asks).toHaveLength(0);
			expect(existsSync(marker), stderr).toBe(true);
		},
		RUN_TIMEOUT_MS,
	);
});
