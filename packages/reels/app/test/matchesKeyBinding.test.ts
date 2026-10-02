import { describe, expect, test } from "bun:test";
import { DEFAULT_APP_KEYBINDINGS } from "../src/lib/keybindings.js";
import { type KeyEventLike, matchesKeyBinding } from "../src/lib/matchesKeyBinding.js";

function keyEvent(init: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }): KeyEventLike {
	return { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init };
}

describe("matchesKeyBinding", () => {
	test("matches ArrowDown and j for nextReel", () => {
		expect(matchesKeyBinding(keyEvent({ key: "ArrowDown" }), DEFAULT_APP_KEYBINDINGS.nextReel)).toBe(true);
		expect(matchesKeyBinding(keyEvent({ key: "j" }), DEFAULT_APP_KEYBINDINGS.nextReel)).toBe(true);
	});

	test("matches ArrowUp and k for previousReel", () => {
		expect(matchesKeyBinding(keyEvent({ key: "ArrowUp" }), DEFAULT_APP_KEYBINDINGS.previousReel)).toBe(true);
		expect(matchesKeyBinding(keyEvent({ key: "k" }), DEFAULT_APP_KEYBINDINGS.previousReel)).toBe(true);
	});

	test("does not match unrelated keys", () => {
		expect(matchesKeyBinding(keyEvent({ key: "Enter" }), DEFAULT_APP_KEYBINDINGS.nextReel)).toBe(false);
	});

	test("a modified chord does not match the unmodified binding", () => {
		expect(matchesKeyBinding(keyEvent({ key: "j", ctrlKey: true }), DEFAULT_APP_KEYBINDINGS.nextReel)).toBe(false);
	});
});
