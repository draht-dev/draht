import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/App.js";

describe("App", () => {
	test("renders without throwing (M1 scope: a bare room-glass panel)", () => {
		expect(() => renderToStaticMarkup(<App />)).not.toThrow();
	});

	test("renders the geist wordmark styled exclusively from tokens.css custom properties", () => {
		const markup = renderToStaticMarkup(<App />);

		expect(markup).toContain("geist");
		// room-glass: smoke-900 @ ~78% alpha (spec §13)
		expect(markup).toContain("var(--smoke-900)");
		// wordmark color
		expect(markup).toContain("var(--ink)");
		// no hardcoded hex/rgb color literal snuck in alongside the token references
		expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/);
	});
});
