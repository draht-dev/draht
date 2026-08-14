import type { Api, Model } from "@draht/ai";
import { describe, expect, it } from "vitest";
import {
	advanceDuetTurn,
	buildDuetSystemPrompt,
	combineDuetUsage,
	createDuetTeammateAgent,
	type DuetState,
	parseDuetParticipantSpecs,
	restoreDuetTurnFromBranch,
} from "../../src/core/builtins/duet.ts";
import { PermissionGate } from "../../src/core/multi-agent/permission-gate.ts";

function makeModel(provider: string, id: string, reasoning = true): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

const availableModels = [
	makeModel("openai", "lead-model"),
	makeModel("anthropic", "review-model"),
	makeModel("google", "test-model"),
	makeModel("openrouter", "123-model"),
];

describe("duet participant configuration", () => {
	it("resolves named models and thinking levels", () => {
		const participants = parseDuetParticipantSpecs(
			"lead=openai/lead-model:high,reviewer=anthropic/review-model",
			availableModels,
		);

		expect(participants.map((participant) => participant.role)).toEqual(["lead", "reviewer"]);
		expect(participants.map((participant) => participant.modelRef)).toEqual([
			"openai/lead-model",
			"anthropic/review-model",
		]);
		expect(participants[0].thinkingLevel).toBe("high");
	});

	it("derives stable role names when aliases are omitted", () => {
		const participants = parseDuetParticipantSpecs("openai/lead-model,anthropic/review-model", availableModels);

		expect(participants.map((participant) => participant.role)).toEqual(["lead-model", "review-model"]);
	});

	it("generates restorable roles for model ids that start with numbers", () => {
		const participants = parseDuetParticipantSpecs("openai/lead-model,openrouter/123-model", availableModels);

		expect(participants[1].role).toBe("model-123-model");
		expect(() =>
			parseDuetParticipantSpecs(
				participants.map((participant) => `${participant.role}=${participant.modelRef}`).join(","),
				availableModels,
			),
		).not.toThrow();
	});

	it("requires distinct models and roles", () => {
		expect(() =>
			parseDuetParticipantSpecs("lead=openai/lead-model,review=openai/lead-model", availableModels),
		).toThrow("selected more than once");
		expect(() =>
			parseDuetParticipantSpecs("worker=openai/lead-model,worker=anthropic/review-model", availableModels),
		).toThrow('role "worker" was selected more than once');
	});

	it("rejects configurations with fewer than two models", () => {
		expect(() => parseDuetParticipantSpecs("openai/lead-model", availableModels)).toThrow(
			"requires at least two models",
		);
	});
});

describe("duet turn taking", () => {
	it("rotates participants and wraps around", () => {
		const state: DuetState = {
			strategy: "turns",
			participants: parseDuetParticipantSpecs(
				"lead=openai/lead-model,reviewer=anthropic/review-model",
				availableModels,
			),
			nextIndex: 0,
		};

		expect(advanceDuetTurn(state).role).toBe("lead");
		expect(advanceDuetTurn(state).role).toBe("reviewer");
		expect(advanceDuetTurn(state).role).toBe("lead");
	});

	it("restores the next participant from assistant messages on the active branch", () => {
		const state: DuetState = {
			strategy: "turns",
			participants: parseDuetParticipantSpecs(
				"lead=openai/lead-model,reviewer=anthropic/review-model",
				availableModels,
			),
			nextIndex: 0,
		};

		restoreDuetTurnFromBranch(state, [
			{
				type: "custom",
				customType: "duet-state",
				id: "duet-state-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: {},
			},
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "openai-responses",
					provider: "openai",
					model: "lead-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
		]);

		expect(state.nextIndex).toBe(1);
	});

	it("ignores matching assistant messages from before the latest duet configuration", () => {
		const state: DuetState = {
			strategy: "turns",
			participants: parseDuetParticipantSpecs(
				"lead=openai/lead-model,reviewer=anthropic/review-model",
				availableModels,
			),
			nextIndex: 0,
		};

		restoreDuetTurnFromBranch(state, [
			{
				type: "message",
				id: "old-assistant",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "openai-responses",
					provider: "openai",
					model: "lead-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
			{
				type: "custom",
				customType: "duet-state",
				id: "duet-state-entry",
				parentId: "old-assistant",
				timestamp: new Date().toISOString(),
				data: {},
			},
		]);

		expect(state.nextIndex).toBe(0);
	});

	it("creates read-only triage teammates", () => {
		const [lead, teammate] = parseDuetParticipantSpecs(
			"lead=openai/lead-model,reviewer=anthropic/review-model",
			availableModels,
		);

		expect(lead.role).toBe("lead");
		expect(createDuetTeammateAgent(teammate)).toMatchObject({
			tools: ["read", "grep", "find", "ls"],
			disableExtensions: true,
		});
		expect(new PermissionGate().evaluate("duet_delegate").action).toBe("approve");
	});

	it("aggregates billable teammate usage", () => {
		const usage = combineDuetUsage([
			{
				agent: "reviewer",
				task: "review",
				exitCode: 0,
				output: "ok",
				stderr: "",
				usage: {
					input: 10,
					output: 2,
					cacheRead: 3,
					cacheWrite: 4,
					totalTokens: 19,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
			},
			{
				agent: "tester",
				task: "test",
				exitCode: 0,
				output: "ok",
				stderr: "",
				usage: {
					input: 20,
					output: 5,
					cacheRead: 6,
					cacheWrite: 7,
					totalTokens: 38,
					cost: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 },
				},
			},
		]);

		expect(usage).toMatchObject({ input: 30, output: 7, totalTokens: 57, cost: { total: 24 } });
	});

	it("tells a triage lead which teammates can receive work", () => {
		const state: DuetState = {
			strategy: "triage",
			participants: parseDuetParticipantSpecs(
				"lead=openai/lead-model,reviewer=anthropic/review-model,tester=google/test-model",
				availableModels,
			),
			nextIndex: 0,
		};

		const prompt = buildDuetSystemPrompt(state);
		expect(prompt).toContain("lead=openai/lead-model");
		expect(prompt).toContain("reviewer=anthropic/review-model");
		expect(prompt).toContain("tester=google/test-model");
		expect(prompt).toContain("duet_delegate");
		expect(prompt).toContain("cannot modify files");
	});
});
