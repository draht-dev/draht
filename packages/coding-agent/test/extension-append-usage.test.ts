/**
 * Focused test for `ExtensionAPI.appendUsage`: extensions can record
 * model-attributed usage that is not tied to an assistant message, exactly like the cache
 * warmer's internal `SessionManager.appendUsage` call, and it reaches the session's live events
 * and usage totals.
 */

import type { Usage } from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageEntry } from "../src/core/session-manager.ts";
import { getUsageCostBreakdown } from "../src/core/usage-totals.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const USAGE: Usage = {
	input: 100,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

function usageEntries(harness: Harness): UsageEntry[] {
	return harness.sessionManager.getBranch().filter((entry): entry is UsageEntry => entry.type === "usage");
}

describe("ExtensionAPI.appendUsage", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("appends a usage entry, emits entry_appended, and feeds the cost breakdown", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.appendUsage("polyphase", "anthropic", "claude-x", USAGE, "/demo agent#1");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });

		const entries = usageEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "polyphase",
			provider: "anthropic",
			model: "claude-x",
			usage: USAGE,
			note: "/demo agent#1",
		});

		const appended = harness.eventsOfType("entry_appended").filter((event) => event.entry.type === "usage");
		expect(appended).toHaveLength(1);
		expect(appended[0]?.entry).toBe(entries[0]);

		expect(getUsageCostBreakdown(harness.sessionManager.getBranch())).toEqual([
			{ key: "anthropic/claude-x", cost: 3, tokens: 150 },
		]);
	});

	it("rejects malformed usage at the API boundary and appends nothing", async () => {
		const errors: string[] = [];
		const attempt = (append: () => void) => {
			try {
				append();
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						attempt(() => pi.appendUsage("polyphase", "anthropic", "claude-x", { ...USAGE, input: Number.NaN }));
						attempt(() =>
							pi.appendUsage("polyphase", "anthropic", "claude-x", {
								...USAGE,
								cost: undefined,
							} as unknown as Usage),
						);
						attempt(() => pi.appendUsage("", "anthropic", "claude-x", USAGE));
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });

		expect(errors).toHaveLength(3);
		expect(errors[0]).toContain("usage must carry finite token counts");
		expect(errors[2]).toContain("kind must be a non-empty string");
		expect(usageEntries(harness)).toHaveLength(0);
	});

	it("omits the note field when none is given", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.appendUsage("cache_warm", "anthropic", "claude-x", USAGE);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });

		const entries = usageEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.note).toBeUndefined();
	});
});
