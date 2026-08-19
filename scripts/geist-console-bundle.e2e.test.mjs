/**
 * R32-FLEET.10 — the one daemon-served bundle, proven in a real browser.
 *
 * Decision record: `.planning/specs/2026-08-19-geist-served-surface-decision.md`.
 *
 * Three real processes, none of them imported:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) with
 *     `--attachable` against the in-repo keyless stub provider, so it publishes a
 *     real `<id>.sock` + `.lock` and answers real prompts with real streamed text;
 *   • the daemon its own bin starts (`bun packages/gateway/src/cli.ts`) on an
 *     ephemeral loopback port, serving the bundle at `/ui`;
 *   • headless Chromium, through `scripts/browser-harness.mjs` (R32-FLEET.12).
 *
 * Every assertion below is a DOM assertion against bytes the running daemon
 * served. Nothing here reads `packages/geist-console/bundle/` off disk to check
 * what the page "should" contain, and nothing constructs a gateway in-process — a
 * package-level test that did could pass while `/ui` 404ed (the Phase 42/44
 * failure mode).
 *
 * The whole flow runs twice, once per viewport, because "responsive from day one"
 * is a claim about the phone, and a desktop-only run would not test it.
 *
 * Run: node --test scripts/geist-console-bundle.e2e.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, VIEWPORTS, waitForServer, waitForText } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages/gateway/src/cli.ts");
const DECISION_RECORD = "2026-08-19-geist-served-surface-decision.md";

/**
 * A token carrying `+`, `/` and `=` on purpose.
 *
 * The bundle hands the credential to the WebSocket as a `Sec-WebSocket-Protocol`
 * value, and Chromium refuses a subprotocol containing any of these three before
 * a byte leaves the browser ("The subprotocol '…' is invalid"). A token made only
 * of hex would let that regression ship.
 */
const TOKEN = "aGVsbG8+d29ybGQ/Cg==";

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended, so
 * every directory here lives directly under /tmp.
 */
const tempDirs = [];
function tempDir(prefix) {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	tempDirs.push(dir);
	return dir;
}

const children = [];
function track(child) {
	children.push(child);
	return child;
}

/** Collect a child's stderr so a failure carries its diagnostics. */
function collect(stream, sink) {
	stream.on("data", (chunk) => {
		sink.text += String(chunk);
	});
}

async function until(probe, what, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) {
			// `what` may be a thunk so a failure can quote a log that only filled up
			// while this loop was spinning.
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${typeof what === "function" ? what() : what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Claim a free loopback port: the gateway CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function sockets(socketDir) {
	try {
		return readdirSync(socketDir).filter((entry) => entry.endsWith(".sock"));
	} catch {
		return [];
	}
}

let harness;
let origin;
let sessionId;
let sessionCwd;
let daemonStderr;
let drahtStderr;
/** The attachable draht session under test. The last suite kills it on purpose. */
let drahtSession;

before(async () => {
	if (!existsSync(DRAHT_CLI)) {
		const build = spawnSync("npm", ["run", "build"], {
			cwd: join(REPO_ROOT, "packages/coding-agent"),
			encoding: "utf8",
		});
		if (build.status !== 0) throw new Error(`draht build failed:\n${build.stderr}`);
	}

	const agentDir = tempDir("gcb-agent-");
	const home = tempDir("gcb-home-");
	sessionCwd = realpathSync(tempDir("gcb-cwd-"));

	drahtStderr = { text: "" };
	const draht = track(
		spawn("node", [DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"], {
			cwd: sessionCwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
				DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND: "60",
			},
			stdio: ["pipe", "ignore", "pipe"],
		}),
	);
	collect(draht.stderr, drahtStderr);
	drahtSession = draht;

	const socketDir = join(agentDir, "sockets");
	const socketFile = await until(
		() => sockets(socketDir)[0],
		() => `draht to publish its socket (stderr: ${drahtStderr.text})`,
	);
	sessionId = socketFile.slice(0, -".sock".length);

	const port = await freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemon = track(
		spawn("bun", [GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
			env: { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "ignore", "pipe"],
		}),
	);
	collect(daemon.stderr, daemonStderr);
	await until(() => daemonStderr.text.includes("draht-gateway listening"), "the daemon to report a bound port");

	origin = `http://127.0.0.1:${port}`;
	await waitForServer(`${origin}/health`);
	harness = await launchHeadlessBrowser();
}, { timeout: 300_000 });

after(async () => {
	await harness?.close();
	for (const child of children) child.kill("SIGKILL");
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("the served bundle's exposure (R32-FLEET.10)", () => {
	it("serves the bundle without a credential — a browser cannot header-auth a navigation", async () => {
		for (const path of ["/ui", "/ui/", "/ui/console.css", "/ui/console.js", "/ui/tokens.css", "/ui/protocol.json"]) {
			const response = await fetch(`${origin}${path}`);
			assert.equal(response.status, 200, `${path} should be served unauthenticated`);
		}
	});

	it("does not open the data surface by serving the page", async () => {
		assert.equal((await fetch(`${origin}/fleet`)).status, 401);
		// A plain GET: auth runs on the upgrade *request*, so the refusal happens
		// before there is a WebSocket at all (R32-FLEET.3).
		assert.equal((await fetch(`${origin}/attach`)).status, 401);
	});

	it("ships on tokens.css — the served stylesheet is geist-glass, not a copy", async () => {
		const tokens = await (await fetch(`${origin}/ui/tokens.css`)).text();
		assert.match(tokens, /--smoke-900:\s*#0b0d10/);
		assert.match(tokens, /--ink:/);

		// Every colour in the bundle's own stylesheet resolves through a token.
		const css = await (await fetch(`${origin}/ui/console.css`)).text();
		// `(?![\w-])` so an id selector whose name happens to start with hex
		// characters (#back, #decision-record) is not mistaken for a colour.
		const hardcoded = css.match(/#[0-9a-fA-F]{3,8}(?![\w-])/g) ?? [];
		assert.deepEqual(hardcoded, [], `console.css must carry no literal colours, found: ${hardcoded.join(", ")}`);
	});
});

/**
 * The whole product sentence, in a browser, at one viewport: list the live
 * sessions, open one, send a prompt, see the assistant's streamed text.
 */
function describeViewport(name, viewport) {
	describe(`the bundle at ${name} (${viewport.width}x${viewport.height})`, () => {
		let page;
		let errors;
		let close;
		const prompt = `hello from the ${name} viewport`;

		before(async () => {
			({ page, errors, close } = await harness.newPage(viewport));
			await page.goto(`${origin}/ui#token=${encodeURIComponent(TOKEN)}`);
		});

		after(async () => {
			await close?.();
		});

		it("takes the credential from the fragment and strips it from the address bar", async () => {
			await waitForText(page, "#status", "connected");
			assert.equal(page.url().includes("token"), false, `token still in the URL: ${page.url()}`);
		});

		it("lists the live session with its real id and cwd", async () => {
			const row = page.locator(`#fleet [data-session-id="${sessionId}"]`);
			await row.waitFor({ timeout: 15_000 });
			assert.match(await row.innerText(), new RegExp(sessionCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});

		it("opens the session when the row is clicked", async () => {
			await page.click(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd);
			assert.equal(await page.getAttribute("body", "data-view"), "session");
		});

		it("sends a typed prompt and renders the assistant's streamed reply", async () => {
			await page.fill("#prompt", prompt);
			await page.click("#send");

			// The sender's own line, echoed back by the session over the wire.
			await waitForText(page, "#transcript", prompt, { timeout: 20_000 });
			// The assistant's answer, streamed frame by frame from the stub provider.
			await waitForText(page, "#transcript", `stub: ${prompt}`, { timeout: 30_000 });
		});

		it("paints geist-glass — the tokens are resolved, not merely served", async () => {
			// `var(--smoke-900)` with no tokens.css is an invalid value, so these two
			// numbers are the difference between "the stylesheet exists" and "the
			// page is on the design system from its first pixel".
			const painted = await page.evaluate(() => ({
				background: getComputedStyle(document.body).backgroundColor,
				footer: getComputedStyle(document.getElementById("decision-record")).color,
			}));
			assert.equal(painted.background, "rgb(11, 13, 16)", "body must paint --smoke-900 (#0b0d10)");
			assert.equal(painted.footer, "rgb(154, 163, 175)", "muted text must paint --ink-dim (#9aa3af)");
		});

		it("names the decision record that produced it", async () => {
			assert.match(await page.locator("#decision-record").innerText(), new RegExp(DECISION_RECORD));
		});

		it("renders with no console or page errors", async () => {
			assert.deepEqual(errors, []);
		});
	});
}

describeViewport("desktop", VIEWPORTS.desktop);
describeViewport("mobile", VIEWPORTS.mobile);

describe("one document, two layouts (R32-FLEET.10)", () => {
	/** Open a session at a viewport and report what the layout actually did. */
	async function layoutAt(viewport) {
		const { page, close } = await harness.newPage(viewport);
		try {
			await page.goto(`${origin}/ui#token=${encodeURIComponent(TOKEN)}`);
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
			await page.click(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd);
			return {
				rail: await page.locator("#rail").boundingBox(),
				session: await page.locator("#session").boundingBox(),
				documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
				backVisible: await page.locator("#back").isVisible(),
			};
		} finally {
			await close();
		}
	}

	it("lays the fleet rail beside the session on desktop", async () => {
		const { rail, session, documentWidth } = await layoutAt(VIEWPORTS.desktop);
		assert.ok(rail, "the fleet rail must stay visible while a session is open on desktop");
		assert.ok(session, "the session pane must be visible");
		assert.ok(
			session.x >= rail.x + rail.width - 1,
			`expected side-by-side, got rail x=${rail.x} w=${rail.width}, session x=${session.x}`,
		);
		assert.ok(documentWidth <= VIEWPORTS.desktop.width, `horizontal overflow: ${documentWidth}px`);
	});

	it("replaces the fleet with the session on a 390px phone, with no horizontal overflow", async () => {
		const { rail, session, documentWidth, backVisible } = await layoutAt(VIEWPORTS.mobile);
		assert.equal(rail, null, "the fleet rail must be off-screen once a session is open on a phone");
		assert.ok(session, "the session pane must be visible");
		assert.ok(session.width > VIEWPORTS.mobile.width - 2, `session pane is not full-bleed: ${session.width}px`);
		assert.equal(backVisible, true, "a phone needs a way back to the fleet");
		assert.ok(
			documentWidth <= VIEWPORTS.mobile.width,
			`horizontal overflow at 390px: document is ${documentWidth}px wide`,
		);
	});
});

/**
 * Runs LAST, and kills the session every suite above attaches to.
 *
 * A page whose session has died reconnects, is greeted by the daemon, and is
 * then refused its `attach` with `unknown_session` — and the refusal arrives
 * AFTER the greeting. A retry counter cleared on the greeting is therefore
 * never allowed to reach its ceiling, and the page hammers the daemon forever.
 * The bound is only real if it survives that ordering, which is why this is a
 * browser assertion about socket count rather than a unit test about a counter.
 */
describe("a session that goes away (R32-FLEET.10)", () => {
	it("stops reconnecting after a bounded number of attempts and says so", async () => {
		const { page, close } = await harness.newPage(VIEWPORTS.desktop);
		try {
			// Count every WebSocket the page constructs, installed before its first
			// script runs so the bundle's own `new WebSocket` is the thing counted.
			await page.addInitScript(() => {
				window.__socketsOpened = 0;
				const Native = window.WebSocket;
				window.WebSocket = new Proxy(Native, {
					construct(target, args) {
						window.__socketsOpened += 1;
						return new target(...args);
					},
				});
			});
			await page.goto(`${origin}/ui#token=${encodeURIComponent(TOKEN)}`);
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });

			// The session dies while the page still lists it, so every attach from
			// here on is refused — exactly the state the unbounded loop lived in.
			drahtSession.kill("SIGKILL");
			await page.click(`#fleet [data-session-id="${sessionId}"]`);

			// Six seconds of backoff is 500 + 1000 + 2000 ms of waiting and three
			// reconnects. A counter reset by the greeting never leaves the 500 ms
			// step, so it would be past ten by now.
			await new Promise((resolve) => setTimeout(resolve, 6_000));
			const early = await page.evaluate(() => window.__socketsOpened);
			assert.ok(early <= 6, `the page opened ${early} sockets in six seconds — the backoff is not growing`);

			await waitForText(page, "#status", "reload to reconnect", { timeout: 45_000 });
			const total = await page.evaluate(() => window.__socketsOpened);
			assert.ok(total <= 9, `the page opened ${total} sockets before giving up`);
		} finally {
			await close();
		}
	});
});
