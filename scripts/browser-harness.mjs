/**
 * Headless browser harness (R32-FLEET.12).
 *
 * The repo had no browser at all before this: `scripts/check-browser-smoke.mjs`
 * is an esbuild bundle-shape check that never opens a page. Every renderer
 * acceptance from Phase 32 on is a DOM assertion against a page a local daemon
 * serves, so those tests need a real browser.
 *
 * Plain ESM under `scripts/`, deliberately, for two reasons:
 *   - any runner can use it — `node --test`, vitest, `bun test` — without the
 *     harness picking a test framework for the phases that come later;
 *   - `scripts/check-geist-boundary.mjs` forbids the six geist packages from
 *     importing any non-geist `@draht/*` package AND from path imports that
 *     escape the package directory. A shared `@draht/browser-harness` workspace
 *     package would therefore be unusable from exactly the packages whose UI
 *     needs testing. Browser acceptances live at repo level (like the existing
 *     `scripts/*.test.mjs` suites root `npm test` runs) and import this file.
 *
 * Browser: Chromium through `playwright-core`. `playwright-core` rather than
 * `playwright` because it ships no postinstall browser download — the binaries
 * are installed explicitly, by the command named in MISSING_BROWSER_HINT, which
 * is what CI runs before the browser tests.
 *
 * Usage:
 *   const harness = await launchHeadlessBrowser();
 *   const { page, errors, close } = await harness.newPage(VIEWPORTS.mobile);
 *   await page.goto(url);            // a full Playwright Page: the whole API is there
 *   await waitForText(page, "#log", "hello");
 *   await close();
 *   await harness.close();
 *
 * Set HEADED=1 to watch a run in a real window while debugging.
 */

import { chromium } from "playwright-core";

const MISSING_BROWSER_HINT = "Chromium is not installed for playwright-core. Run: bunx playwright-core install chromium";

/**
 * Viewports every renderer acceptance runs at. 390x844 is the phone target the
 * roadmap names (iPhone 14/15/16 CSS pixels); the desktop size is an ordinary
 * laptop window.
 */
export const VIEWPORTS = {
	desktop: { width: 1280, height: 800 },
	mobile: { width: 390, height: 844 },
};

/**
 * Launch one headless Chromium. Pages are cheap; the browser is not — share one
 * harness across a suite and open a page per test.
 *
 * @param {{ headed?: boolean, args?: string[] }} [options]
 */
export async function launchHeadlessBrowser(options = {}) {
	const headed = options.headed ?? process.env.HEADED === "1";
	let browser;
	try {
		browser = await chromium.launch({
			headless: !headed,
			args: options.args ?? [],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/Executable doesn't exist|please run|browserType\.launch/i.test(message)) {
			throw new Error(`${MISSING_BROWSER_HINT}\n\n${message}`);
		}
		throw error;
	}

	return {
		/** The raw Playwright Browser, for anything this wrapper does not cover. */
		browser,

		/**
		 * Open an isolated page (own context: own storage, own cookies) at a viewport.
		 *
		 * @param {{ width: number, height: number }} [viewport]
		 * @param {{ isMobile?: boolean, deviceScaleFactor?: number, baseURL?: string }} [contextOptions]
		 * @returns {Promise<{ page: import("playwright-core").Page, errors: string[], context: import("playwright-core").BrowserContext, close: () => Promise<void> }>}
		 */
		async newPage(viewport = VIEWPORTS.desktop, contextOptions = {}) {
			const context = await browser.newContext({ viewport, ...contextOptions });
			const page = await context.newPage();
			// Console errors and uncaught exceptions are collected rather than thrown:
			// a test decides whether a page error is the failure or the subject.
			const errors = [];
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			page.on("pageerror", (error) => errors.push(String(error)));
			return {
				page,
				errors,
				context,
				close: () => context.close(),
			};
		},

		close: () => browser.close(),
	};
}

/** Rendered text of the first match, trimmed. Hidden elements contribute nothing. */
export async function textOf(page, selector) {
	return (await page.locator(selector).first().innerText()).trim();
}

/**
 * Wait until the element's rendered text contains `expected`, then return it.
 * On timeout the error carries the text that was actually there, because "text
 * never appeared" without the actual DOM is the least useful failure there is.
 */
export async function waitForText(page, selector, expected, options = {}) {
	const timeout = options.timeout ?? 5000;
	const locator = page.locator(selector).first();
	const deadline = Date.now() + timeout;
	let actual = "";
	while (Date.now() < deadline) {
		actual = await locator.innerText().catch(() => "");
		if (actual.includes(expected)) return actual.trim();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(
		`Timed out after ${timeout}ms waiting for ${selector} to contain ${JSON.stringify(expected)}. ` +
			`Rendered text was ${JSON.stringify(actual)}`,
	);
}

/** Poll a URL until it answers, so a test can wait for a daemon it just spawned. */
export async function waitForServer(url, options = {}) {
	const timeout = options.timeout ?? 15000;
	const deadline = Date.now() + timeout;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { headers: options.headers });
			if (response.status < 500) return response.status;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out after ${timeout}ms waiting for ${url}${lastError ? `: ${lastError}` : ""}`);
}
