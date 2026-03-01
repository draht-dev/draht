/**
 * Subagent Tool for Draht — adapted from the pi subagent example
 *
 * Spawns isolated draht processes for delegated tasks.
 * Agents are defined in .draht/agents/*.md (project) or ~/.draht/agent/agents/*.md (global).
 *
 * Modes:
 *   single   — { agent, task }
 *   parallel — { tasks: [{ agent, task }] }  (max 8, concurrency 4)
 *   chain    — { chain: [{ agent, task }] }  (sequential, {previous} placeholder)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@draht/ai";
import { StringEnum } from "@draht/ai";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@draht/coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
const DRAHT_BIN = "/home/openclaw/.local/bin/draht";

// ─── Agent discovery ────────────────────────────────────────────────────────

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		try {
			const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name || !frontmatter.description) continue;
			const tools = frontmatter.tools?.split(",").map((t: string) => t.trim()).filter(Boolean);
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: tools?.length ? tools : undefined,
				model: frontmatter.model,
				systemPrompt: body,
				source,
			});
		} catch {
			continue;
		}
	}
	return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".draht", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

type AgentScope = "user" | "project" | "both";

function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findProjectAgentsDir(cwd);
	const userAgents = scope !== "project" ? loadAgentsFromDir(userDir, "user") : [];
	const projectAgents = scope !== "user" && projectDir ? loadAgentsFromDir(projectDir, "project") : [];
	const map = new Map<string, AgentConfig>();
	for (const a of userAgents) map.set(a.name, a);
	for (const a of projectAgents) map.set(a.name, a); // project overrides global
	return Array.from(map.values());
}

// ─── Runner ─────────────────────────────────────────────────────────────────

interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	step?: number;
}

function writeTemp(name: string, content: string): { file: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-subagent-"));
	const file = path.join(dir, `${name.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
	return { file, dir };
}

function cleanTemp(file: string, dir: string) {
	try { fs.unlinkSync(file); } catch {}
	try { fs.rmdirSync(dir); } catch {}
}

function getFinalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

async function runAgent(
	cwd: string,
	agent: AgentConfig,
	task: string,
	signal?: AbortSignal,
	step?: number,
): Promise<RunResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpFile: string | null = null;
	let tmpDir: string | null = null;

	if (agent.systemPrompt.trim()) {
		const tmp = writeTemp(agent.name, agent.systemPrompt);
		tmpFile = tmp.file;
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmpFile);
	}

	args.push(`Task: ${task}`);

	const messages: Message[] = [];
	let stderr = "";

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(DRAHT_BIN, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
						messages.push(event.message as Message);
					}
				} catch {}
			};

			proc.stdout.on("data", (d) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const l of lines) processLine(l);
			});
			proc.stderr.on("data", (d) => { stderr += d.toString(); });
			proc.on("close", (code) => {
				if (buf.trim()) processLine(buf);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		return { agent: agent.name, task, exitCode, output: getFinalText(messages), stderr, step };
	} finally {
		if (tmpFile && tmpDir) cleanTemp(tmpFile, tmpDir);
	}
}

async function runParallel<T>(
	items: T[],
	concurrency: number,
	fn: (item: T, i: number) => Promise<T extends unknown ? RunResult : never>,
): Promise<RunResult[]> {
	const results: RunResult[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await (fn as (item: T, i: number) => Promise<RunResult>)(items[i], i);
			}
		}),
	);
	return results;
}

// ─── Extension ──────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task description" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task, optionally using {previous} placeholder" }),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Chained tasks" })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, { default: "both" }),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate to specialized agents. single: {agent,task} | parallel: {tasks:[]} | chain: {chain:[]} with {previous} placeholder. agentScope: 'both' (default) uses project .draht/agents/ + global.",
		parameters: Params,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope: AgentScope = (params.agentScope as AgentScope) ?? "both";
			const agents = discoverAgents(ctx.cwd, scope);
			const available = agents.map((a) => a.name).join(", ") || "none";

			const find = (name: string) => agents.find((a) => a.name === name);
			const notFound = (name: string) => ({
				content: [{ type: "text" as const, text: `Unknown agent "${name}". Available: ${available}` }],
				isError: true,
			});

			// ── Chain mode ──
			if (params.chain?.length) {
				let previous = "";
				const results: RunResult[] = [];
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const agent = find(step.agent);
					if (!agent) return notFound(step.agent);
					const task = step.task.replace(/\{previous\}/g, previous);
					const result = await runAgent(ctx.cwd, agent, task, signal, i + 1);
					results.push(result);
					if (result.exitCode !== 0) {
						return {
							content: [{ type: "text" as const, text: `Chain failed at step ${i + 1} (${step.agent}):\n${result.output || result.stderr}` }],
							isError: true,
						};
					}
					previous = result.output;
				}
				return { content: [{ type: "text" as const, text: results[results.length - 1].output || "(no output)" }] };
			}

			// ── Parallel mode ──
			if (params.tasks?.length) {
				if (params.tasks.length > MAX_PARALLEL) {
					return { content: [{ type: "text" as const, text: `Too many tasks (max ${MAX_PARALLEL})` }], isError: true };
				}
				for (const t of params.tasks) { if (!find(t.agent)) return notFound(t.agent); }

				const results = await runParallel(params.tasks, MAX_CONCURRENCY, async (t, i) => {
					return runAgent(ctx.cwd, find(t.agent)!, t.task, signal);
				});

				const ok = results.filter((r) => r.exitCode === 0).length;
				const summary = results
					.map((r) => `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"} ${r.output.slice(0, 200)}`)
					.join("\n\n");
				return { content: [{ type: "text" as const, text: `Parallel: ${ok}/${results.length} succeeded\n\n${summary}` }] };
			}

			// ── Single mode ──
			if (params.agent && params.task) {
				const agent = find(params.agent);
				if (!agent) return notFound(params.agent);
				const result = await runAgent(ctx.cwd, agent, params.task, signal);
				const isError = result.exitCode !== 0;
				return {
					content: [{ type: "text" as const, text: result.output || result.stderr || "(no output)" }],
					...(isError ? { isError: true } : {}),
				};
			}

			return { content: [{ type: "text" as const, text: `Provide exactly one mode. Available agents: ${available}` }], isError: true };
		},
	});
}
