/**
 * Orchestration engine — executes sub-tasks in dependency order via Claude.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type {
	ExecutionResult,
	OrchestratorState,
	ProgressCallback,
	SubTask,
	SubTaskResult,
	TaskPlan,
} from "./types.js";

const AGENT_PROMPTS: Record<string, string> = {
	research: `You are a research agent. Your job is to gather information, analyze requirements, and provide findings.
Be thorough but concise. Output your findings as structured text.`,

	implement: `You are an implementation agent. Your job is to write code and create files.
Follow the project conventions. Output the code you would write, with file paths clearly marked.`,

	test: `You are a testing agent. Your job is to write tests and verify behavior.
Cover happy paths, edge cases, and error scenarios. Output test code with clear descriptions.`,

	review: `You are a code review agent. Your job is to review work quality and check conventions.
Be constructive. Flag issues by severity. Output a structured review with findings.`,
};

export class OrchestratorEngine {
	private client: Anthropic;
	private model: string;
	private stateDir: string;

	constructor(apiKey: string, model = "claude-sonnet-4-20250514", stateDir = ".orchestrator") {
		this.client = new Anthropic({ apiKey });
		this.model = model;
		this.stateDir = stateDir;
	}

	async execute(plan: TaskPlan, onProgress?: ProgressCallback): Promise<ExecutionResult> {
		const startTime = Date.now();
		const ordered = this.topologicalSort(plan.subTasks);
		const results = new Map<string, SubTaskResult>();
		const completed: SubTask[] = [];
		const failed: SubTask[] = [];

		// Initialize state
		const state: OrchestratorState = {
			plan,
			currentSubTaskId: null,
			completedSubTaskIds: [],
			failedSubTaskIds: [],
			startedAt: startTime,
		};
		this.saveState(state);

		for (const subTask of ordered) {
			// Check dependencies
			const depsOk = subTask.dependsOn.every((depId) => results.has(depId));
			if (!depsOk) {
				subTask.status = "skipped";
				failed.push(subTask);
				continue;
			}

			state.currentSubTaskId = subTask.id;
			subTask.status = "running";
			onProgress?.({ type: "subtask_start", subTask });

			// Build context from completed dependencies
			const depContext = subTask.dependsOn
				.map((depId) => {
					const result = results.get(depId);
					const depTask = plan.subTasks.find((t) => t.id === depId);
					return result ? `### ${depTask?.title ?? depId}\n${result.output}` : "";
				})
				.filter(Boolean)
				.join("\n\n");

			try {
				const result = await this.executeSubTask(subTask, depContext);
				subTask.status = "completed";
				subTask.result = result;
				results.set(subTask.id, result);
				completed.push(subTask);
				state.completedSubTaskIds.push(subTask.id);
				onProgress?.({ type: "subtask_complete", subTask, result });
			} catch (_error) {
				// Retry once
				try {
					const result = await this.executeSubTask(subTask, depContext);
					subTask.status = "completed";
					subTask.result = result;
					results.set(subTask.id, result);
					completed.push(subTask);
					state.completedSubTaskIds.push(subTask.id);
					onProgress?.({ type: "subtask_complete", subTask, result });
				} catch (retryError) {
					const errorMsg = retryError instanceof Error ? retryError.message : String(retryError);
					subTask.status = "failed";
					subTask.result = { output: "", duration: 0, error: errorMsg };
					failed.push(subTask);
					state.failedSubTaskIds.push(subTask.id);
					onProgress?.({ type: "subtask_failed", subTask, error: errorMsg });
				}
			}

			this.saveState(state);
		}

		// Synthesize results
		onProgress?.({ type: "synthesis_start" });
		const synthesized = await this.synthesize(completed);

		const executionResult: ExecutionResult = {
			taskId: plan.taskId,
			plan,
			completedSubTasks: completed,
			failedSubTasks: failed,
			synthesizedResult: synthesized,
			totalDuration: Date.now() - startTime,
		};

		onProgress?.({ type: "complete", result: executionResult });
		this.cleanState();

		return executionResult;
	}

	private async executeSubTask(subTask: SubTask, dependencyContext: string): Promise<SubTaskResult> {
		const startTime = Date.now();
		const systemPrompt = AGENT_PROMPTS[subTask.agentType] ?? AGENT_PROMPTS.implement;

		const userMessage = dependencyContext
			? `## Task: ${subTask.title}\n\n${subTask.description}\n\n## Context from previous steps:\n${dependencyContext}`
			: `## Task: ${subTask.title}\n\n${subTask.description}`;

		const message = await this.client.messages.create({
			model: this.model,
			max_tokens: 8192,
			system: systemPrompt,
			messages: [{ role: "user", content: userMessage }],
		});

		const output = message.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");

		return {
			output,
			duration: Date.now() - startTime,
		};
	}

	async synthesize(completedTasks: SubTask[]): Promise<string> {
		if (completedTasks.length === 0) return "No tasks completed.";

		const taskOutputs = completedTasks
			.map((t) => `### ${t.title} (${t.agentType})\n${t.result?.output ?? "No output"}`)
			.join("\n\n---\n\n");

		const message = await this.client.messages.create({
			model: this.model,
			max_tokens: 4096,
			system:
				"You synthesize results from multiple agent sub-tasks into a coherent summary. Be concise and actionable.",
			messages: [
				{
					role: "user",
					content: `Synthesize these sub-task results into a coherent summary:\n\n${taskOutputs}`,
				},
			],
		});

		return message.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");
	}

	private topologicalSort(subTasks: SubTask[]): SubTask[] {
		const taskMap = new Map(subTasks.map((t) => [t.id, t]));
		const visited = new Set<string>();
		const result: SubTask[] = [];

		const visit = (id: string) => {
			if (visited.has(id)) return;
			visited.add(id);
			const task = taskMap.get(id);
			if (!task) return;
			for (const dep of task.dependsOn) {
				visit(dep);
			}
			result.push(task);
		};

		for (const task of subTasks) {
			visit(task.id);
		}

		return result;
	}

	private saveState(state: OrchestratorState): void {
		if (!fs.existsSync(this.stateDir)) {
			fs.mkdirSync(this.stateDir, { recursive: true });
		}
		fs.writeFileSync(path.join(this.stateDir, "state.json"), JSON.stringify(state, null, 2));
	}

	private cleanState(): void {
		const statePath = path.join(this.stateDir, "state.json");
		if (fs.existsSync(statePath)) {
			fs.unlinkSync(statePath);
		}
	}

	loadState(): OrchestratorState | null {
		const statePath = path.join(this.stateDir, "state.json");
		if (!fs.existsSync(statePath)) return null;
		try {
			return JSON.parse(fs.readFileSync(statePath, "utf-8"));
		} catch {
			return null;
		}
	}
}
