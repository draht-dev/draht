/**
 * `/rewind` input gating.
 *
 * `showRewindSelector` calls `done()` — which tears the selector down and hands
 * focus back to the editor — and only then awaits `runRewind`. Without a gate
 * the user can submit a new prompt while the working tree is still being
 * rewritten, and the agent starts a turn against a half-restored tree.
 */

import { describe, expect, it, vi } from "vitest";
import type { CheckpointManager } from "../src/core/checkpoints/checkpoint-manager.ts";
import type { RewindScope } from "../src/core/checkpoints/rewind.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitHandler = (text: string) => Promise<void>;

type RewindContext = {
	isRewindRunning: boolean;
	defaultEditor: { onSubmit?: SubmitHandler };
	editor: {
		setText: (text: string) => void;
		getText: () => string;
		addToHistory?: (text: string) => void;
	};
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		isBashRunning: boolean;
		extensionRunner: { hasHandlers: (event: string) => boolean };
		navigateTree: (targetId: string, options: { summarize: boolean }) => Promise<{ cancelled: boolean }>;
	};
	sessionManager: { getLeafId: () => string | null };
	chatContainer: { clear: () => void };
	renderInitialMessages: () => void;
	flushCompactionQueue: (options: { willRetry: boolean }) => Promise<void>;
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	setupEditorSubmitHandler(this: RewindContext): void;
	runRewind(
		this: RewindContext,
		targetEntryId: string,
		scope: RewindScope,
		manager: CheckpointManager | undefined,
	): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(overrides: Partial<RewindContext> = {}): RewindContext {
	return {
		isRewindRunning: false,
		defaultEditor: {},
		editor: { setText: vi.fn(), getText: () => "", addToHistory: vi.fn() },
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			extensionRunner: { hasHandlers: () => false },
			navigateTree: async () => ({ cancelled: false }),
		},
		sessionManager: { getLeafId: () => "leaf-current" },
		chatContainer: { clear: vi.fn() },
		renderInitialMessages: vi.fn(),
		flushCompactionQueue: async () => {},
		flushPendingBashComponents: vi.fn(),
		onInputCallback: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		ui: { requestRender: vi.fn() },
		...overrides,
	};
}

describe("InteractiveMode /rewind input gate", () => {
	it("refuses a submission while a rewind is restoring, keeping the text in the editor", async () => {
		const context = createContext({ isRewindRunning: true });
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("write me a haiku");

		expect(context.showWarning).toHaveBeenCalledWith("A rewind is restoring your files. Wait for it to finish.");
		expect(context.editor.setText).toHaveBeenCalledWith("write me a haiku");
		expect(context.onInputCallback).not.toHaveBeenCalled();
	});

	it("gates submissions for the whole restore and releases them afterwards", async () => {
		const context = createContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		let gatedDuringRestore: boolean | undefined;

		// Stands in for `CheckpointManager.rewind`: the window in which the
		// working tree is being written.
		const manager = {
			rewind: async (options: { navigate: () => Promise<void> }) => {
				await context.defaultEditor.onSubmit?.("prompt sent mid-restore");
				gatedDuringRestore = (context.showWarning as ReturnType<typeof vi.fn>).mock.calls.length > 0;
				await options.navigate();
				return { restore: { status: "restored", restored: ["a.txt"], deleted: [] }, navigated: true };
			},
		} as unknown as CheckpointManager;

		await interactiveModePrototype.runRewind.call(context, "leaf-target", "conversation-and-files", manager);

		// Mid-restore submission was refused, not queued into the agent.
		expect(gatedDuringRestore).toBe(true);
		expect(context.onInputCallback).not.toHaveBeenCalledWith("prompt sent mid-restore");
		expect(context.editor.setText).toHaveBeenCalledWith("prompt sent mid-restore");

		// And the gate lifts once the restore is done.
		expect(context.isRewindRunning).toBe(false);
		await context.defaultEditor.onSubmit?.("prompt sent afterwards");
		expect(context.onInputCallback).toHaveBeenCalledWith("prompt sent afterwards");
	});

	it("releases the gate when the rewind throws", async () => {
		const context = createContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const manager = {
			rewind: async () => {
				throw new Error("git exploded");
			},
		} as unknown as CheckpointManager;

		// `performRewind` never throws, but the gate must not depend on that.
		await expect(
			interactiveModePrototype.runRewind.call(context, "leaf-target", "conversation-and-files", manager),
		).rejects.toThrow("git exploded");
		expect(context.isRewindRunning).toBe(false);
	});
});
