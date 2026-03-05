import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GSD_COMMANDS_PATH = path.join(
	__dirname,
	"..",
	"..",
	"..",
	"templates",
	"project",
	".draht",
	"extensions",
	"gsd-commands.ts",
);

describe("gsd-commands.ts extension structure", () => {
	let source: string;

	beforeAll(() => {
		source = fs.readFileSync(GSD_COMMANDS_PATH, "utf-8");
	});

	it("registers /create-plan command", () => {
		expect(source).toContain('registerCommand("create-plan"');
	});

	it("registers /commit-task command", () => {
		expect(source).toContain('registerCommand("commit-task"');
	});

	it("registers /create-domain-model command", () => {
		expect(source).toContain('registerCommand("create-domain-model"');
	});

	it("registers /map-codebase command", () => {
		expect(source).toContain('registerCommand("map-codebase"');
	});

	it("imports createPlan from @draht/coding-agent", () => {
		expect(source).toContain("createPlan");
		expect(source).toContain("@draht/coding-agent");
	});

	it("references draht-pre-execute hook for /execute handler", () => {
		expect(source).toContain("draht-pre-execute");
	});
});
