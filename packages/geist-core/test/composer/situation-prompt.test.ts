import { describe, expect, test } from "bun:test";
import { composeElementContext, type ElementDescriptor } from "../../src/composer/element-context.js";
import { composeSituationPrompt } from "../../src/composer/situation-prompt.js";
import type { HarnessCapabilities } from "../../src/harness-session.js";

const element: ElementDescriptor = {
	tagName: "button",
	selector: "#hero > button:nth-of-type(2)",
	boundingRect: { x: 12, y: 34, width: 120, height: 40 },
};

function capabilities(overrides: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
	return { images: false, commands: false, modes: false, resume: false, ...overrides };
}

function buildContext() {
	return composeElementContext({
		element,
		page: { url: "https://kintura.local/dashboard" },
		sessionId: "session-1",
		instruction: "make this button bigger and use the accent color",
		worktreeRoot: "/repo/.geist/wt/kintura",
		taskId: "fixed-task-id",
	});
}

describe("composeSituationPrompt", () => {
	test("capability on: includes an image content block referencing the crop path", () => {
		const context = buildContext();
		const prompt = composeSituationPrompt(context, capabilities({ images: true }));

		const imageBlocks = prompt.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toEqual({ type: "image", path: context.cropPath });
	});

	test("capability off: no image content block is included", () => {
		const context = buildContext();
		const prompt = composeSituationPrompt(context, capabilities({ images: false }));

		const imageBlocks = prompt.blocks.filter((block) => block.type === "image");
		expect(imageBlocks).toHaveLength(0);
	});

	test("path-reference to the crop file is present unconditionally — capability on", () => {
		const context = buildContext();
		const prompt = composeSituationPrompt(context, capabilities({ images: true }));

		const pathRefs = prompt.blocks.filter((block) => block.type === "path-reference");
		expect(pathRefs).toHaveLength(1);
		expect(pathRefs[0]).toEqual({ type: "path-reference", path: context.cropPath });
	});

	test("path-reference to the crop file is present unconditionally — capability off", () => {
		const context = buildContext();
		const prompt = composeSituationPrompt(context, capabilities({ images: false }));

		const pathRefs = prompt.blocks.filter((block) => block.type === "path-reference");
		expect(pathRefs).toHaveLength(1);
		expect(pathRefs[0]).toEqual({ type: "path-reference", path: context.cropPath });
	});

	test("the text instruction is always present and carries the instruction + element grounding", () => {
		const context = buildContext();
		const prompt = composeSituationPrompt(context, capabilities());

		const textBlocks = prompt.blocks.filter((block) => block.type === "text");
		expect(textBlocks).toHaveLength(1);
		const text = (textBlocks[0] as { type: "text"; text: string }).text;
		expect(text).toContain(context.instruction);
		expect(text).toContain(context.element.selector);
		expect(text).toContain(context.page.url);
	});
});
