import { describe, expect, test } from "bun:test";
import { describeElement } from "../src/index.js";

/**
 * `describeElement`/`buildSelector` only ever touch a handful of real DOM
 * members (`id`, `tagName`, `parentElement`, `children`, `getBoundingClientRect`).
 * This sandbox's `bun test` runtime has no browser DOM and this package takes
 * on no DOM-library dependency for one small test file — so these fakes
 * implement exactly that subset and are cast to `Element` at the call site,
 * a standard pattern for testing DOM-touching pure functions without a real
 * DOM. `CSS.escape` is polyfilled below since it's a browser-only global.
 */

if (typeof (globalThis as { CSS?: unknown }).CSS === "undefined") {
	(globalThis as { CSS: { escape(value: string): string } }).CSS = {
		// Real CSS.escape is more thorough; this is sufficient for the plain
		// alphanumeric ids these tests use.
		escape: (value: string) => value.replace(/([^\w-])/g, "\\$1"),
	};
}

interface FakeElementInit {
	tagName: string;
	id?: string;
	rect?: { x: number; y: number; width: number; height: number };
	children?: FakeElement[];
}

class FakeElement {
	readonly tagName: string;
	readonly id: string;
	parentElement: FakeElement | null = null;
	readonly children: FakeElement[];
	private readonly rect: { x: number; y: number; width: number; height: number };

	constructor(init: FakeElementInit) {
		this.tagName = init.tagName.toUpperCase();
		this.id = init.id ?? "";
		this.rect = init.rect ?? { x: 0, y: 0, width: 0, height: 0 };
		this.children = init.children ?? [];
		for (const child of this.children) {
			child.parentElement = this;
		}
	}

	getBoundingClientRect() {
		return this.rect;
	}
}

function asElement(fake: FakeElement): Element {
	return fake as unknown as Element;
}

describe("describeElement", () => {
	test("a root element with an id resolves the selector directly to #id", () => {
		const el = new FakeElement({
			tagName: "button",
			id: "submit-btn",
			rect: { x: 10, y: 20, width: 80, height: 32 },
		});

		const result = describeElement(asElement(el));

		expect(result).toEqual({
			tagName: "button",
			selector: "#submit-btn",
			boundingRect: { x: 10, y: 20, width: 80, height: 32 },
		});
	});

	test("an element with no id and no siblings of the same tag walks up by bare tag names", () => {
		const grandparent = new FakeElement({ tagName: "main" });
		const parent = new FakeElement({ tagName: "section", children: [] });
		const target = new FakeElement({ tagName: "p" });
		parent.children.push(target);
		target.parentElement = parent;
		grandparent.children.push(parent);
		parent.parentElement = grandparent;

		const result = describeElement(asElement(target));

		expect(result.tagName).toBe("p");
		expect(result.selector).toBe("main > section > p");
	});

	test("an ancestor's id short-circuits the walk — deeper unstyled ancestors are not included", () => {
		const root = new FakeElement({ tagName: "html" });
		const container = new FakeElement({ tagName: "div", id: "app" });
		const target = new FakeElement({ tagName: "span" });
		root.children.push(container);
		container.parentElement = root;
		container.children.push(target);
		target.parentElement = container;

		const result = describeElement(asElement(target));

		expect(result.selector).toBe("#app > span");
	});

	test("multiple same-tag siblings under one parent get nth-of-type disambiguation", () => {
		const parent = new FakeElement({ tagName: "ul" });
		const first = new FakeElement({ tagName: "li" });
		const second = new FakeElement({ tagName: "li" });
		const third = new FakeElement({ tagName: "li" });
		parent.children.push(first, second, third);
		for (const child of [first, second, third]) {
			child.parentElement = parent;
		}

		expect(describeElement(asElement(first)).selector).toBe("ul > li:nth-of-type(1)");
		expect(describeElement(asElement(second)).selector).toBe("ul > li:nth-of-type(2)");
		expect(describeElement(asElement(third)).selector).toBe("ul > li:nth-of-type(3)");
	});

	test("only same-tagName siblings count toward the nth-of-type index", () => {
		const parent = new FakeElement({ tagName: "div" });
		const label = new FakeElement({ tagName: "label" });
		const inputA = new FakeElement({ tagName: "input" });
		const inputB = new FakeElement({ tagName: "input" });
		parent.children.push(label, inputA, inputB);
		for (const child of [label, inputA, inputB]) {
			child.parentElement = parent;
		}

		// label is the only "label" among its siblings -> no nth-of-type suffix
		expect(describeElement(asElement(label)).selector).toBe("div > label");
		// inputA/inputB are both "input" -> disambiguated by position among inputs
		expect(describeElement(asElement(inputA)).selector).toBe("div > input:nth-of-type(1)");
		expect(describeElement(asElement(inputB)).selector).toBe("div > input:nth-of-type(2)");
	});

	test("tagName on the descriptor is always lower-cased regardless of DOM casing", () => {
		const el = new FakeElement({ tagName: "DIV", id: "x" });

		expect(describeElement(asElement(el)).tagName).toBe("div");
	});

	test("boundingRect reflects exactly what getBoundingClientRect returns at call time", () => {
		const el = new FakeElement({ tagName: "img", id: "hero", rect: { x: 1.5, y: -3, width: 640, height: 360.25 } });

		expect(describeElement(asElement(el)).boundingRect).toEqual({ x: 1.5, y: -3, width: 640, height: 360.25 });
	});
});
