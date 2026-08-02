import type { Component, Terminal } from "@draht/tui";
import { Container, isViewportTUI, Text } from "@draht/tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly progressChanges: boolean[] = [];
	readonly startScreens: Array<"main" | "alternate"> = [];
	readonly suspendScreens: Array<"main" | "alternate"> = [];
	readonly resumeScreens: Array<"main" | "alternate"> = [];
	startCount = 0;
	stopCount = 0;
	private progressActive = false;
	private alternateScreen = false;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		this.startScreens.push(this.alternateScreen ? "alternate" : "main");
		super.start(onInput, onResize);
	}

	suspendRenderer(): void {
		this.suspendScreens.push(this.alternateScreen ? "alternate" : "main");
	}

	resumeRenderer(): void {
		this.resumeScreens.push(this.alternateScreen ? "alternate" : "main");
	}

	override write(data: string): void {
		this.writes.push(data);
		if (data.includes("\x1b[?1049h")) this.alternateScreen = true;
		if (data.includes("\x1b[?1049l")) this.alternateScreen = false;
		super.write(data);
	}

	override setProgress(active: boolean): void {
		this.progressActive = active;
		this.progressChanges.push(active);
		super.setProgress(active);
	}

	override stop(): void {
		this.stopCount += 1;
		if (this.progressActive) this.setProgress(false);
		super.stop();
	}
}

function createTui(terminal: Terminal, uiMode: "regular" | "fullscreen" = "regular") {
	return createInteractiveTui({ uiMode, showHardwareCursor: false, logDirectory: "/tmp", terminal });
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		for (const [uiMode, screen] of [
			["regular", "main"],
			["fullscreen", "alternate"],
		] as const) {
			const terminal = new RecordingTerminal();
			const tui = createTui(terminal, uiMode);
			expect(tui.uiMode).toBe(uiMode);
			expect(isViewportTUI(tui)).toBe(uiMode === "fullscreen");
			tui.start();
			await terminal.waitForRender();
			expect(terminal.startScreens).toEqual([screen]);
			expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(uiMode === "fullscreen");
			tui.stop();
		}
	});

	it("switches renderers without restarting the terminal or losing focus", async () => {
		const terminal = new RecordingTerminal(30, 6);
		const tui = createTui(terminal);
		const inputs: string[] = [];
		let text = "regular content";
		const component: Component = {
			render: () => [text],
			handleInput: (data) => inputs.push(data),
			invalidate: () => {},
		};
		tui.addChild(component);
		tui.setFocus(component);
		terminal.write("shell history\r\n");
		tui.start();
		await terminal.waitForRender();
		tui.terminal.setProgress(true);

		const overlay = tui.showOverlay(new Text("overlay", 0, 0));
		expect(tui.setUiMode("fullscreen")).toBe(false);
		overlay.hide();
		expect(tui.setUiMode("fullscreen")).toBe(true);
		await terminal.waitForRender();
		expect(terminal.suspendScreens).toEqual(["main"]);
		expect(terminal.resumeScreens).toEqual(["alternate"]);
		terminal.sendInput("b");

		text = "updated in fullscreen";
		tui.requestRender();
		await terminal.waitForRender();
		expect(tui.setUiMode("regular")).toBe(true);
		await terminal.waitForRender();
		expect([terminal.startCount, terminal.stopCount]).toEqual([1, 0]);
		expect(terminal.progressChanges).toEqual([true]);
		expect(terminal.suspendScreens).toEqual(["main", "alternate"]);
		expect(terminal.resumeScreens).toEqual(["alternate", "main"]);
		expect(terminal.getViewport().some((line) => line.includes(text))).toBe(true);
		expect(terminal.getScrollBuffer().some((line) => line.includes("shell history"))).toBe(true);
		terminal.sendInput("c");
		expect(inputs).toEqual(["b", "c"]);
		tui.stop();
		expect(terminal.stopCount).toBe(1);
	});

	it("restores the main screen once when stopping from fullscreen", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = createTui(terminal);
		let lines = ["header-once", "body-before", "editor"];
		const component: Component = {
			render: () => lines,
			invalidate: () => {},
		};
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		expect(tui.setUiMode("fullscreen")).toBe(true);
		lines = ["header-once", "body-after", "editor"];
		tui.requestRender();
		await terminal.waitForRender();

		tui.stop();
		await terminal.flush();

		const scrollBuffer = terminal.getScrollBuffer();
		expect(scrollBuffer.filter((line) => line.includes("header-once"))).toHaveLength(1);
		expect(scrollBuffer.some((line) => line.includes("body-before"))).toBe(false);
		expect(scrollBuffer.filter((line) => line.includes("body-after"))).toHaveLength(1);
		expect(terminal.suspendScreens).toEqual(["main", "alternate"]);
		expect(terminal.resumeScreens).toEqual(["alternate"]);
		expect(tui.uiMode).toBe("fullscreen");

		terminal.write("\x1b[2J\x1b[Hexternal application");
		tui.start();
		await terminal.waitForRender();
		tui.stop();
		await terminal.flush();
		const viewport = terminal.getViewport();
		expect(viewport.some((line) => line.includes("body-after"))).toBe(true);
		expect(viewport.some((line) => line.includes("external application"))).toBe(false);
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	ui: { uiMode: "regular" | "fullscreen"; getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [uiMode, expectedChildren] of [
			["regular", 1],
			["fullscreen", 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				ui: { uiMode, getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
