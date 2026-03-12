import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { loadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GSD_COMMANDS_PATH = path.join(REPO_ROOT, "templates", "project", ".draht", "extensions", "gsd-commands.ts");

const PLANNING_COMMAND_NAMES = ["create-plan", "commit-task", "create-domain-model", "map-codebase"];
const WORKFLOW_COMMAND_NAMES = [
	"discuss",
	"plan",
	"execute",
	"verify",
	"review",
	"fix",
	"quick",
	"resume",
	"status",
	"new-project",
	"init-project",
];

type Notification = {
	message: string;
	type: "info" | "warning" | "error" | undefined;
};

function createMockUI(notifications: Notification[], baseUI: ExtensionUIContext): ExtensionUIContext {
	return {
		...baseUI,
		notify: (message, type) => {
			notifications.push({ message, type });
		},
	};
}

describe("gsd extension runtime loading", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gsd-extension-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function loadGsdRunner() {
		const result = await loadExtensions([GSD_COMMANDS_PATH], tempDir);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = new ModelRegistry(AuthStorage.create(path.join(tempDir, "auth.json")));
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		return { result, runner };
	}

	it("loads the shipped gsd extension without errors and registers expected commands", async () => {
		const { result, runner } = await loadGsdRunner();

		expect(result.errors).toEqual([]);

		const registeredCommandNames = runner.getRegisteredCommands().map((command) => command.name);
		expect(registeredCommandNames).toEqual(expect.arrayContaining(PLANNING_COMMAND_NAMES));
		expect(registeredCommandNames).toEqual(expect.arrayContaining(WORKFLOW_COMMAND_NAMES));
	});

	it("looks up loaded commands by name and returns undefined for unknown names", async () => {
		const { runner } = await loadGsdRunner();

		expect(runner.getCommand("create-plan")).toBeDefined();
		expect(runner.getCommand("commit-task")).toBeDefined();
		expect(runner.getCommand("execute")).toBeDefined();
		expect(runner.getCommand("does-not-exist")).toBeUndefined();
	});

	it("invokes create-plan and warns about usage when args are empty", async () => {
		const { runner } = await loadGsdRunner();
		const notifications: Notification[] = [];
		runner.setUIContext(createMockUI(notifications, runner.getUIContext()));

		const createPlanCommand = runner.getCommand("create-plan");
		expect(createPlanCommand).toBeDefined();

		await createPlanCommand?.handler("", runner.createCommandContext());

		expect(notifications).toContainEqual({
			message: "Usage: /create-plan <phase> <plan> [title]",
			type: "warning",
		});
	});
});
