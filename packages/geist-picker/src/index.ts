/**
 * geist's element picker (spec §10, §6: "IIFE picker"). Injected into
 * target pages to describe whatever element the ray/cursor is over. Zero
 * ACP/harness knowledge — composing the full situation prompt from this
 * descriptor is `geist-core`'s job (spec §9.3's `ElementContext`, M2).
 */

export interface ElementBoundingRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ElementDescriptor {
	/** Lower-cased tag name, e.g. `"button"`. */
	readonly tagName: string;
	/** A short, reasonably stable CSS selector for the element. */
	readonly selector: string;
	/** Viewport-relative bounding rect at description time. */
	readonly boundingRect: ElementBoundingRect;
}

/**
 * Builds a short CSS selector for `element` by walking up the DOM tree,
 * preferring `#id` on the element itself or an ancestor, and otherwise
 * falling back to `tag` or `tag:nth-of-type(n)` segments joined with `>`.
 */
function buildSelector(element: Element): string {
	if (element.id) {
		return `#${CSS.escape(element.id)}`;
	}

	const segments: string[] = [];
	let current: Element | null = element;

	while (current) {
		if (current.id) {
			segments.unshift(`#${CSS.escape(current.id)}`);
			break;
		}

		const tag = current.tagName.toLowerCase();
		const parent: Element | null = current.parentElement;

		if (!parent) {
			segments.unshift(tag);
			break;
		}

		const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
		const index = sameTagSiblings.indexOf(current);
		const segment = sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag;

		segments.unshift(segment);
		current = parent;
	}

	return segments.join(" > ");
}

/**
 * Describes a DOM element for geist's element-pointing flow: tag name, a
 * CSS selector, and its current viewport-relative bounding rect.
 */
export function describeElement(element: Element): ElementDescriptor {
	const rect = element.getBoundingClientRect();

	return {
		tagName: element.tagName.toLowerCase(),
		selector: buildSelector(element),
		boundingRect: {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		},
	};
}
