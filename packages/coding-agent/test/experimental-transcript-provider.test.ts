import type { AgentLane, EventListener, HarnessEvent, LaneSnapshot, WatchHandle } from "@draht/agent-core";
import { replicatedState } from "@draht/chord";
import { BACKGROUND_CONTEXT } from "@draht/chord/context";
import { describe, expect, test, vi } from "vitest";
import { createTranscriptService } from "../src/experimental/services/transcript-provider.ts";

function laneSnapshot(tipId: string | null = null): LaneSnapshot {
	return {
		lane: "main",
		transcript: [],
		tipId,
		configuration: {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			activeToolNames: [],
		},
		stats: {
			messageCount: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		operation: null,
		queues: [],
		faulted: false,
	};
}

describe("Transcript service", () => {
	test("publishes ordered reducer events and a snapshot after navigation", async () => {
		let listener: EventListener | undefined;
		const replacement = laneSnapshot("replacement-tip");
		const resnapshot = vi.fn(async () => replacement);
		const unsubscribe = vi.fn();
		const handle: WatchHandle<LaneSnapshot> = {
			snapshot: laneSnapshot(),
			start(next) {
				listener = next;
			},
			resnapshot,
			unsubscribe,
		};
		const lane = { watch: async () => handle } as unknown as AgentLane;
		const runtime = createTranscriptService(lane, replicatedState);
		const updates: Array<{ type: string; revision: number }> = [];
		runtime.service.updates.subscribe((update) => {
			if (update !== null) updates.push({ type: update.type, revision: update.revision });
		});
		await runtime.activate();

		expect(await runtime.service.snapshot(BACKGROUND_CONTEXT)).toMatchObject({
			revision: 0,
			snapshot: { lane: "main", operation: null },
		});
		await listener?.({ type: "run_start", lane: "main", runId: "run-1", startedAt: 1 }, BACKGROUND_CONTEXT);
		expect(updates).toEqual([{ type: "event", revision: 1 }]);
		expect(await runtime.service.snapshot(BACKGROUND_CONTEXT)).toMatchObject({
			revision: 1,
			snapshot: { operation: { id: "run-1" } },
		});

		const navigation: HarnessEvent = {
			type: "navigation_end",
			lane: "main",
			runId: "navigation-1",
			status: "completed",
			fromTipId: null,
			tipId: "replacement-tip",
			endedAt: 2,
		};
		await listener?.(navigation, BACKGROUND_CONTEXT);
		await vi.waitFor(() =>
			expect(updates).toEqual([
				{ type: "event", revision: 1 },
				{ type: "event", revision: 2 },
				{ type: "snapshot", revision: 3 },
			]),
		);
		expect(await runtime.service.snapshot(BACKGROUND_CONTEXT)).toMatchObject({
			revision: 3,
			snapshot: { tipId: "replacement-tip" },
		});
		expect(resnapshot).toHaveBeenCalledOnce();

		await runtime.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
