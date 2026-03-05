import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlan, discoverPlans, readPlan, updateState, verifyPhase, writeSummary } from "../src/gsd/planning.js";

describe("gsd planning", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-planning-test-"));
		// Minimal .planning/ structure
		fs.mkdirSync(path.join(tempDir, ".planning", "phases"), { recursive: true });
		// Minimal ROADMAP.md so getPhaseSlug works
		fs.writeFileSync(
			path.join(tempDir, ".planning", "ROADMAP.md"),
			"## Phase 19: GSD CLI Integration — `pending`\n",
			"utf-8",
		);
		// Minimal STATE.md for updateState
		fs.writeFileSync(
			path.join(tempDir, ".planning", "STATE.md"),
			"# State\n\n## Last Activity: 2026-01-01 00:00:00\n",
			"utf-8",
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("createPlan", () => {
		it("creates a PLAN.md file in the correct phase directory", () => {
			const planFile = createPlan(tempDir, 19, 1, "My Plan");
			expect(fs.existsSync(planFile)).toBe(true);
			expect(planFile).toContain("19-gsd-cli-integration");
			expect(planFile).toContain("19-01-PLAN.md");
		});

		it("includes frontmatter with phase and plan numbers", () => {
			createPlan(tempDir, 19, 1, "My Plan");
			const content = fs.readFileSync(
				path.join(tempDir, ".planning", "phases", "19-gsd-cli-integration", "19-01-PLAN.md"),
				"utf-8",
			);
			expect(content).toContain("phase: 19");
			expect(content).toContain("plan: 1");
		});

		it("includes the title in the plan heading", () => {
			createPlan(tempDir, 19, 1, "My Plan");
			const content = fs.readFileSync(
				path.join(tempDir, ".planning", "phases", "19-gsd-cli-integration", "19-01-PLAN.md"),
				"utf-8",
			);
			expect(content).toContain("My Plan");
		});

		it('includes a <task type="auto"> element', () => {
			createPlan(tempDir, 19, 1, "My Plan");
			const content = fs.readFileSync(
				path.join(tempDir, ".planning", "phases", "19-gsd-cli-integration", "19-01-PLAN.md"),
				"utf-8",
			);
			expect(content).toContain('<task type="auto">');
		});

		it("uses 'Plan N' as default title when title is omitted", () => {
			createPlan(tempDir, 19, 2);
			const content = fs.readFileSync(
				path.join(tempDir, ".planning", "phases", "19-gsd-cli-integration", "19-02-PLAN.md"),
				"utf-8",
			);
			expect(content).toContain("Plan 2");
		});
	});

	describe("discoverPlans", () => {
		it("returns empty lists when no plans exist", () => {
			// Create phase dir without plans
			fs.mkdirSync(path.join(tempDir, ".planning", "phases", "19-gsd-cli-integration"), {
				recursive: true,
			});
			const result = discoverPlans(tempDir, 19);
			expect(result.plans).toHaveLength(0);
			expect(result.incomplete).toHaveLength(0);
			expect(result.fixPlans).toHaveLength(0);
		});

		it("returns 1 plan after createPlan", () => {
			createPlan(tempDir, 19, 1, "Test Plan");
			const result = discoverPlans(tempDir, 19);
			expect(result.plans).toHaveLength(1);
			expect(result.incomplete).toHaveLength(1);
			expect(result.fixPlans).toHaveLength(0);
		});

		it("marks plan as complete when summary exists", () => {
			createPlan(tempDir, 19, 1, "Test Plan");
			writeSummary(tempDir, 19, 1);
			const result = discoverPlans(tempDir, 19);
			expect(result.plans).toHaveLength(1);
			expect(result.incomplete).toHaveLength(0);
		});

		it("throws when phase directory does not exist", () => {
			expect(() => discoverPlans(tempDir, 99)).toThrow("Phase 99 directory not found");
		});
	});

	describe("readPlan", () => {
		it("returns the plan file content", () => {
			createPlan(tempDir, 19, 1, "Read Me");
			const content = readPlan(tempDir, 19, 1);
			expect(content).toContain("phase: 19");
			expect(content).toContain("Read Me");
		});

		it("throws when plan file does not exist", () => {
			createPlan(tempDir, 19, 1, "Exists");
			expect(() => readPlan(tempDir, 19, 2)).toThrow();
		});
	});

	describe("writeSummary", () => {
		it("creates a SUMMARY.md file in the phase dir", () => {
			createPlan(tempDir, 19, 1, "Plan");
			const summaryPath = writeSummary(tempDir, 19, 1);
			expect(fs.existsSync(summaryPath)).toBe(true);
			expect(summaryPath).toContain("19-01-SUMMARY.md");
		});

		it("summary contains required sections", () => {
			createPlan(tempDir, 19, 1, "Plan");
			const summaryPath = writeSummary(tempDir, 19, 1);
			const content = fs.readFileSync(summaryPath, "utf-8");
			expect(content).toContain("## Completed Tasks");
			expect(content).toContain("## Files Changed");
		});
	});

	describe("verifyPhase", () => {
		it("returns complete=false when summaries < plans", () => {
			createPlan(tempDir, 19, 1, "Plan");
			const result = verifyPhase(tempDir, 19);
			expect(result.plans).toBe(1);
			expect(result.summaries).toBe(0);
			expect(result.complete).toBe(false);
		});

		it("returns complete=true when all plans have summaries", () => {
			createPlan(tempDir, 19, 1, "Plan");
			writeSummary(tempDir, 19, 1);
			const result = verifyPhase(tempDir, 19);
			expect(result.plans).toBe(1);
			expect(result.summaries).toBe(1);
			expect(result.complete).toBe(true);
		});

		it("creates VERIFICATION.md when complete", () => {
			createPlan(tempDir, 19, 1, "Plan");
			writeSummary(tempDir, 19, 1);
			verifyPhase(tempDir, 19);
			const verPath = path.join(tempDir, ".planning", "phases", "19-gsd-cli-integration", "19-VERIFICATION.md");
			expect(fs.existsSync(verPath)).toBe(true);
		});
	});

	describe("updateState", () => {
		it("updates the Last Activity line in STATE.md", () => {
			const before = fs.readFileSync(path.join(tempDir, ".planning", "STATE.md"), "utf-8");
			expect(before).toContain("2026-01-01 00:00:00");

			updateState(tempDir);

			const after = fs.readFileSync(path.join(tempDir, ".planning", "STATE.md"), "utf-8");
			expect(after).not.toContain("2026-01-01 00:00:00");
			expect(after).toContain("## Last Activity:");
		});

		it("throws when STATE.md does not exist", () => {
			const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-empty-"));
			try {
				expect(() => updateState(emptyDir)).toThrow("No STATE.md found");
			} finally {
				fs.rmSync(emptyDir, { recursive: true, force: true });
			}
		});
	});
});
