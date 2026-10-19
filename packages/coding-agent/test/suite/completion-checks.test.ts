import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import completionChecksBuiltin from "../../src/core/builtins/completion-checks.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import * as childProcess from "../../src/utils/child-process.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("automatic project checks", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup(script?: string, cache = false, laterExtensions: ExtensionFactory[] = []): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [
				{ factory: completionChecksBuiltin, path: "builtin:completion-checks" },
				...laterExtensions,
			],
		});
		harnesses.push(harness);
		if (script) {
			mkdirSync(join(harness.tempDir, ".draht"));
			writeFileSync(join(harness.tempDir, "check.cjs"), script);
			writeFileSync(
				join(harness.tempDir, ".draht", "checks.json"),
				JSON.stringify({
					checks: [
						{
							name: "acceptance",
							command: [process.execPath, "check.cjs"],
							inputs: ["source.py", "check.cjs"],
							cache,
						},
					],
				}),
			);
		}
		return harness;
	}

	function reports(harness: Harness): string[] {
		return harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "project-checks" ? [getMessageText(entry)] : [],
			);
	}

	it("does no automatic checks in an unconfigured project", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("explain this code");
		expect(harness.faux.state.callCount).toBe(1);
		expect(reports(harness)).toEqual([]);
	});

	it("never executes project commands before trust is granted", async () => {
		const harness = await setup("require('node:fs').writeFileSync('executed', '')");
		harness.settingsManager.setProjectTrusted(false);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("inspect");
		expect(existsSync(join(harness.tempDir, "executed"))).toBe(false);
		expect(reports(harness)).toEqual([]);
	});

	it("checks before settlement and gives the model real failure diagnostics to repair", async () => {
		const harness = await setup(
			"if (!require('node:fs').existsSync('fixed')) { console.error('expected 42, received 0'); process.exit(1); }",
		);
		harness.setResponses([
			fauxAssistantMessage("implemented"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("expected 42, received 0");
				writeFileSync(join(harness.tempDir, "fixed"), "");
				return fauxAssistantMessage("corrected");
			},
		]);
		await harness.session.prompt("implement");
		expect(harness.faux.state.callCount).toBe(2);
		expect(reports(harness)[0]).toContain("repair 1/3");
		expect(reports(harness)[1]).toContain("Project checks passed");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("aborts after three failed repairs and leaves a visible failure instead of success", async () => {
		const harness = await setup("process.exit(1)");
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("implement");
		expect(harness.faux.state.callCount).toBe(4);
		expect(reports(harness)).toHaveLength(4);
		expect(reports(harness).at(-1)).toContain("Automatic repair stopped; this work is not verified");
		expect(reports(harness).some((report) => report.includes("Project checks passed"))).toBe(false);
		expect(harness.session.isIdle).toBe(true);
	});

	it("records synchronous runner launch failures and enforces the repair cap", async () => {
		const harness = await setup("process.exit(0)");
		vi.spyOn(childProcess, "spawnProcess").mockImplementation(() => {
			throw new Error("fixture runner unavailable");
		});
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("implement");
		expect(harness.faux.state.callCount).toBe(4);
		expect(reports(harness)).toHaveLength(4);
		expect(reports(harness).at(-1)).toContain("fixture runner unavailable");
		expect(reports(harness).at(-1)).toContain("this work is not verified");
		expect(harness.session.isIdle).toBe(true);
	});

	it("checks edits from later registered settlement handlers before accepting completion", async () => {
		const harness = await setup(
			"if (require('node:fs').readFileSync('source.py', 'utf8') !== 'valid') process.exit(1)",
			false,
			[
				(pi) => {
					pi.on("agent_before_settle", (_event, ctx) => {
						writeFileSync(join(ctx.cwd, "source.py"), "broken");
					});
				},
			],
		);
		writeFileSync(join(harness.tempDir, "source.py"), "valid");
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("implement");
		expect(harness.faux.state.callCount).toBe(4);
		expect(reports(harness).some((report) => report.includes("Project checks passed"))).toBe(false);
		expect(reports(harness).at(-1)).toContain("this work is not verified");
	});

	it("preserves other settlement entries and continuation requests", async () => {
		let boundaries = 0;
		const harness = await setup("process.exit(0)", false, [
			(pi) => {
				pi.on("agent_before_settle", (event) => {
					if (boundaries++ > 0) return;
					return {
						entries: [
							...event.entries,
							{
								type: "custom_message",
								customType: "other-check",
								content: "Review the additional finding",
								display: true,
							},
						],
						continue: true,
					};
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("implemented"), fauxAssistantMessage("reviewed")]);
		await harness.session.prompt("implement");
		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "other-check"),
		).toBe(true);
	});

	it("cancels running checks promptly and starts the next request with a fresh signal", async () => {
		const harness = await setup("require('node:fs').writeFileSync('started', ''); setInterval(() => {}, 1000);");
		harness.setResponses([fauxAssistantMessage("implemented")]);
		const prompt = harness.session.prompt("implement");
		await vi.waitFor(() => expect(existsSync(join(harness.tempDir, "started"))).toBe(true));
		const cancelledAt = Date.now();
		await harness.session.abort();
		await prompt;
		expect(Date.now() - cancelledAt).toBeLessThan(2000);
		expect(harness.faux.state.callCount).toBe(1);
		expect(reports(harness).at(-1)).toContain("Project checks were cancelled");

		writeFileSync(join(harness.tempDir, "check.cjs"), "process.exit(0)");
		harness.setResponses([fauxAssistantMessage("corrected")]);
		await harness.session.prompt("verify again");
		expect(reports(harness).at(-1)).toContain("Project checks passed");
	});

	it("reuses valid evidence then reruns checks after a committed non-JavaScript change", async () => {
		const harness = await setup(
			"const fs = require('node:fs'); fs.appendFileSync('runs', 'x'); if (fs.readFileSync('source.py', 'utf8') !== 'valid') process.exit(1);",
			true,
		);
		execFileSync("git", ["init", "--quiet"], { cwd: harness.tempDir });
		writeFileSync(join(harness.tempDir, "source.py"), "valid");
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("implement");
		await harness.session.prompt("summarize");
		expect(readFileSync(join(harness.tempDir, "runs"), "utf8")).toBe("x");
		expect(reports(harness).at(-1)).toContain("1 reused");

		writeFileSync(join(harness.tempDir, "source.py"), "broken");
		execFileSync("git", ["add", "source.py"], { cwd: harness.tempDir });
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"],
			{ cwd: harness.tempDir },
		);
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("verify");
		expect(readFileSync(join(harness.tempDir, "runs"), "utf8")).toBe("xxxxx");
		expect(reports(harness).at(-1)).toContain("this work is not verified");
	});
});
