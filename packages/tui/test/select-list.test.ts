import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	describe("confirmSelection", () => {
		it("fires onSelect for the current item regardless of the tui.select.confirm binding", () => {
			const originalKeybindings = getKeybindings();
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "tab" }));
			try {
				const items = [
					{ value: "a", label: "a" },
					{ value: "b", label: "b" },
				];
				const list = new SelectList(items, 5, testTheme);
				list.handleInput("\x1b[B"); // down, select "b"
				let selected: string | undefined;
				list.onSelect = (item) => {
					selected = item.value as string;
				};

				list.confirmSelection();

				assert.equal(selected, "b");
			} finally {
				setKeybindings(originalKeybindings);
			}
		});

		it('handleInput("\\r") alone does not confirm once tui.select.confirm is rebound away from enter', () => {
			const originalKeybindings = getKeybindings();
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "tab" }));
			try {
				const items = [{ value: "a", label: "a" }];
				const list = new SelectList(items, 5, testTheme);
				let selected: string | undefined;
				list.onSelect = (item) => {
					selected = item.value as string;
				};

				list.handleInput("\r");

				assert.equal(selected, undefined);
			} finally {
				setKeybindings(originalKeybindings);
			}
		});
	});
});
