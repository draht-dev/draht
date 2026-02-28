/**
 * Ticket decomposer — breaks high-level tasks into agent-sized sub-tasks.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AgentType, SubTask, TaskPlan } from "./types.js";

const DECOMPOSE_SYSTEM = `You are a task decomposer for a multi-agent system. Break down the given task into atomic sub-tasks.

Each sub-task should be:
- Small enough for a single focused agent
- Clear about what needs to be done
- Tagged with the right agent type

Agent types:
- "research": gather information, analyze requirements, investigate options
- "implement": write code, create files, make changes
- "test": write tests, verify behavior, check edge cases
- "review": review code quality, check conventions, validate against requirements

Respond with a JSON object:
{
  "subTasks": [
    {
      "id": "unique-short-id",
      "title": "brief title",
      "description": "detailed description of what this agent should do",
      "agentType": "research|implement|test|review",
      "dependsOn": ["ids of sub-tasks that must complete first"]
    }
  ]
}

Order sub-tasks logically: research → implement → test → review.
Only return the JSON, no other text.`;

export class TicketDecomposer {
	private client: Anthropic;
	private model: string;

	constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
		this.client = new Anthropic({ apiKey });
		this.model = model;
	}

	async decompose(ticket: string, projectContext?: string): Promise<TaskPlan> {
		const systemPrompt = projectContext
			? `${DECOMPOSE_SYSTEM}\n\n<project_context>\n${projectContext}\n</project_context>`
			: DECOMPOSE_SYSTEM;

		const message = await this.client.messages.create({
			model: this.model,
			max_tokens: 4096,
			system: systemPrompt,
			messages: [{ role: "user", content: `Decompose this task:\n\n${ticket}` }],
		});

		const text = message.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");

		return this.parseResponse(text, ticket);
	}

	private parseResponse(text: string, originalTicket: string): TaskPlan {
		try {
			const jsonMatch = text.match(/\{[\s\S]*\}/);
			if (!jsonMatch) throw new Error("No JSON found in response");

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed.subTasks)) throw new Error("No subTasks array");

			const subTasks: SubTask[] = parsed.subTasks.map((st: Record<string, unknown>) => ({
				id: String(st.id || randomUUID().slice(0, 8)),
				title: String(st.title || "Untitled"),
				description: String(st.description || ""),
				agentType: validateAgentType(st.agentType),
				dependsOn: Array.isArray(st.dependsOn) ? st.dependsOn.map(String) : [],
				status: "pending" as const,
			}));

			return {
				taskId: randomUUID().slice(0, 12),
				description: originalTicket,
				subTasks,
				createdAt: Date.now(),
			};
		} catch (error) {
			throw new Error(`Failed to parse decomposition: ${error instanceof Error ? error.message : error}`);
		}
	}
}

function validateAgentType(value: unknown): AgentType {
	const valid: AgentType[] = ["research", "implement", "test", "review"];
	if (typeof value === "string" && valid.includes(value as AgentType)) {
		return value as AgentType;
	}
	return "implement";
}
