import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";

const POLYPHASE_DEFAULTS: Record<string, string> = {
	"app.polyphase.inspector": "alt+a",
	"app.polyphase.cancelAgent": "x",
	"app.polyphase.cancelRun": "shift+x",
	"app.polyphase.follow": "f",
	"app.polyphase.nextAgent": "tab",
	"app.polyphase.previousAgent": "shift+tab",
};

function defaultKeysOf(id: keyof typeof KEYBINDINGS): string[] {
	const keys = KEYBINDINGS[id].defaultKeys;
	return Array.isArray(keys) ? keys : [keys];
}

describe("polyphase keybindings", () => {
	it("defines the six app.polyphase.* ids with their documented defaults", () => {
		for (const [id, expectedKey] of Object.entries(POLYPHASE_DEFAULTS)) {
			expect(defaultKeysOf(id as keyof typeof KEYBINDINGS)).toEqual([expectedKey]);
		}
	});

	it("does not reuse alt+a as the default for any other keybinding id", () => {
		for (const [id, binding] of Object.entries(KEYBINDINGS)) {
			if (id === "app.polyphase.inspector") continue;
			const keys = Array.isArray(binding.defaultKeys) ? binding.defaultKeys : [binding.defaultKeys];
			expect(keys).not.toContain("alt+a");
		}
	});

	it("mentions app.polyphase.inspector in the /hotkeys handler", () => {
		const interactiveModePath = fileURLToPath(
			new URL("../../src/modes/interactive/interactive-mode.ts", import.meta.url),
		);
		const source = readFileSync(interactiveModePath, "utf-8");
		expect(source).toContain("app.polyphase.inspector");
	});
});
