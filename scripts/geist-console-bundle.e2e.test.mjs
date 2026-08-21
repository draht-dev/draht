/**
 * The one daemon-served bundle, proven in a real browser
 * (R32-FLEET.10, R33-REACH.3, R33-REACH.5, R33-REACH.9).
 *
 * Decision record: `.planning/specs/2026-08-19-geist-served-surface-decision.md`.
 *
 * Three real processes, none of them imported into this file:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) with
 *     `--attachable` against the in-repo keyless stub provider, so it publishes a
 *     real `<id>.sock` + `.lock` and answers real prompts with real streamed text;
 *   • a daemon on an ephemeral loopback port, serving the bundle at `/ui`;
 *   • headless Chromium, through `scripts/browser-harness.mjs` (R32-FLEET.12).
 *
 * Every assertion below is a DOM assertion against bytes the running daemon
 * served. Nothing here reads `packages/geist-console/bundle/` off disk to check
 * what the page "should" contain, and nothing constructs a gateway in-process — a
 * package-level test that did could pass while `/ui` 404ed (the Phase 42/44
 * failure mode).
 *
 * ## Why the daemon is not `packages/gateway/src/cli.ts` any more
 *
 * R33-REACH.5 authenticates the console with a *frame*: `pair_device` carrying a
 * bootstrap token on first connect, `authenticate` carrying the rotated device
 * credential on every connect after. `AttachBridge` implements that exchange,
 * and `createFleetRoutes({ devices })` is the port it is handed through — but
 * **nothing in the shipped `draht-gateway` CLI constructs a device store and
 * passes it**, and `DeviceRegistry` (exchange/verify/rotate) does not yet have
 * an adapter onto the bridge's `DeviceAuthenticator` port (pair/authenticate).
 * Both gaps are outside this file's remit and are reported as blockers.
 *
 * So {@link DEVICE_HOST} below is written to a temp file and run with `bun`: it
 * is the *same* `startGateway` the CLI calls, in its own process, serving the
 * real `/ui`, with the ten lines of registry adapter the daemon still owes.
 * It is a stand-in for wiring that has to land in the CLI before any of this
 * reaches an operator — until it does, the bundle's pairing path is exercised
 * only here, and `draht-gateway` still cannot pair a phone.
 *
 * Run: node --test scripts/geist-console-bundle.e2e.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, textOf, VIEWPORTS, waitForServer, waitForText } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");
const DECISION_RECORD = "2026-08-19-geist-served-surface-decision.md";

/** Where the bundle persists `{deviceId, credential}` (R33-REACH.9). */
const DEVICE_KEY = "geist.console.device";

/**
 * The daemon's shared operator token — what `--auth` sets.
 *
 * The console never presents it: since R33-REACH.3 the only credential the page
 * holds is a bootstrap token or a device credential, and both cross the wire as
 * frames. It is here because every route that is *not* `/attach` still sits
 * behind the bearer middleware, and `GET /fleet` being 401 to a browser is one
 * of the things this file asserts.
 */
const OPERATOR_TOKEN = "aGVsbG8+d29ybGQ/Cg==";

/** Bootstrap tokens minted at boot; each is single-use, so every pairing takes a fresh one. */
const BOOTSTRAP_COUNT = 12;

/**
 * A gateway with a device store, in its own process.
 *
 * Two things it adds to `startGateway`, and both are things the shipped CLI
 * still has to grow:
 *
 *  1. a `DeviceAuthenticator` over `DeviceRegistry` — `pair` spends a bootstrap
 *     token, `authenticate` verifies then **rotates**, so the credential a
 *     client presents is dead by the time it is answered (R33-REACH.5);
 *  2. a batch of long-TTL bootstrap tokens on stdout, because the registry's
 *     default TTL is two minutes and this suite runs longer than that.
 *
 * Imports are absolute paths into the repo so the file can live in /tmp and
 * still resolve `hono`, `@draht/geist-core` and friends from the importee's own
 * `node_modules`.
 */
const DEVICE_HOST = `
import { DeviceRegistry } from ${JSON.stringify(join(REPO_ROOT, "packages/geist-core/src/index.ts"))};
import { startGateway } from ${JSON.stringify(join(REPO_ROOT, "packages/gateway/src/gateway/server.ts"))};

const [port, socketDir, devicesPath, authToken, count] = process.argv.slice(2);
const registry = new DeviceRegistry({ path: devicesPath });
const CREDENTIAL_TTL_MS = 3_600_000;
const issue = (deviceId, credential) => ({
	ok: true,
	deviceId,
	credential,
	issuedAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString(),
});

const devices = {
	pair({ bootstrapToken, device }) {
		const exchanged = registry.exchange(bootstrapToken, device);
		if (!exchanged.ok) return { ok: false, reason: exchanged.reason };
		return issue(exchanged.deviceId, exchanged.credential);
	},
	authenticate({ deviceId, credential }) {
		const verified = registry.verify(deviceId, credential);
		if (!verified.ok) return { ok: false, reason: verified.outcome };
		const rotated = registry.rotate(deviceId);
		if (!rotated.ok) return { ok: false, reason: rotated.reason };
		return issue(deviceId, rotated.credential);
	},
};

const bootstraps = [];
for (let i = 0; i < Number(count); i += 1) bootstraps.push(registry.mintBootstrap({ ttlMs: CREDENTIAL_TTL_MS }).token);

const { server } = startGateway({ port: Number(port), host: "127.0.0.1", authToken, socketDir, devices });
process.stdout.write(JSON.stringify({ bootstraps }) + "\\n");
process.stderr.write("draht-gateway listening on " + server.port + "\\n");
`;

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

/** Collect a child's output so a failure carries its diagnostics. */
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

/** Claim a free loopback port: the gateway validates 1..65535 and refuses 0. */
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
/** Unspent bootstrap tokens. Single-use: a page load that pairs consumes one. */
let bootstraps = [];

/** The next unspent bootstrap token, as a `#token=` fragment would carry it. */
function nextBootstrap() {
	const token = bootstraps.shift();
	if (!token) throw new Error(`out of bootstrap tokens — mint more than ${BOOTSTRAP_COUNT}`);
	return token;
}

/** `/ui`, optionally opened the way `geist pair`'s deep link opens it. */
function consoleUrl(bootstrapToken) {
	return bootstrapToken === undefined ? `${origin}/ui` : `${origin}/ui#token=${encodeURIComponent(bootstrapToken)}`;
}

/**
 * Record every WebSocket the page constructs, and every frame it sends.
 *
 * Installed on the *context* so it also covers a tab opened after the first one
 * is closed — which is how "the credential survives a tab restart" is tested.
 * `args[1]` is the subprotocol list: R33-REACH.3 wants it empty, because a
 * credential in `Sec-WebSocket-Protocol` is a credential in a request header.
 */
async function traceSockets(context) {
	await context.addInitScript(() => {
		window.__sockets = [];
		const Native = window.WebSocket;
		window.WebSocket = new Proxy(Native, {
			construct(target, args) {
				// `socket` is kept on the record so a test can drop a *live*
				// connection the way a tunnel, a lock screen or a tailnet blip does.
				// It never leaves the page — {@link sentTypes} projects the record
				// into serialisable fields and {@link dropLiveSocket} only closes it
				// in place.
				const record = { url: args[0], protocols: args[1] ?? null, sent: [], socket: null };
				window.__sockets.push(record);
				const socket = new target(...args);
				record.socket = socket;
				const nativeSend = socket.send.bind(socket);
				socket.send = (data) => {
					record.sent.push(String(data));
					nativeSend(data);
				};
				return socket;
			},
		});
	});
}

/**
 * Drop the page's live connection, unasked, from the peer's side.
 *
 * Needs {@link traceSockets} on the context. Returns how many open sockets were
 * closed, so a caller can assert there was exactly one connection to lose.
 */
function dropLiveSocket(page) {
	return page.evaluate(() => {
		const live = window.__sockets.filter((record) => record.socket?.readyState === WebSocket.OPEN);
		for (const record of live) record.socket.close(4000, "dropped");
		return live.length;
	});
}

/**
 * Wait for a *distinct* `#status` state, by its `data-state` rather than its text.
 *
 * Text matching cannot tell these apart: "disconnected" contains "connected".
 */
function waitForStatusState(page, state, timeout = 20_000) {
	return page.locator(`#status[data-state="${state}"]`).waitFor({ timeout });
}

/**
 * Wait for the fleet row the console is attached to.
 *
 * `aria-current` is set by `markCurrent()` from `session_metadata` and cleared
 * the moment the socket closes, so it is the page's own answer to "am I attached
 * right now" — and, unlike `#session-cwd`, it is not still showing the previous
 * attach while a re-attach is in flight. Attached rather than visible because on
 * a phone the whole fleet rail is off-screen while a session is open.
 */
function currentRow(page, timeout = 20_000) {
	return page
		.locator(`#fleet [aria-current="true"][data-session-id="${sessionId}"]`)
		.waitFor({ state: "attached", timeout });
}

/** The frame types the page has sent, socket by socket. */
function sentTypes(page) {
	return page.evaluate(() =>
		window.__sockets.map((record) => ({
			protocols: record.protocols,
			types: record.sent.map((text) => JSON.parse(text).type),
		})),
	);
}

/** The `{deviceId, credential}` this browser has persisted, or null. */
function storedDevice(page, key) {
	return page.evaluate((storageKey) => {
		const raw = localStorage.getItem(storageKey);
		return raw === null ? null : JSON.parse(raw);
	}, key);
}

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

	const hostDir = tempDir("gcb-host-");
	const hostFile = join(hostDir, "device-gateway.ts");
	writeFileSync(hostFile, DEVICE_HOST, "utf8");

	const port = await freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemonStdout = { text: "" };
	const daemon = track(
		spawn(
			"bun",
			[hostFile, String(port), socketDir, join(hostDir, "devices.json"), OPERATOR_TOKEN, String(BOOTSTRAP_COUNT)],
			{
				env: { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir },
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	);
	collect(daemon.stdout, daemonStdout);
	collect(daemon.stderr, daemonStderr);
	await until(
		() => daemonStderr.text.includes("draht-gateway listening"),
		() => `the daemon to report a bound port (stderr: ${daemonStderr.text})`,
	);
	bootstraps = JSON.parse(daemonStdout.text.trim()).bootstraps;

	origin = `http://127.0.0.1:${port}`;
	await waitForServer(`${origin}/health`);
	harness = await launchHeadlessBrowser();
}, { timeout: 300_000 });

after(async () => {
	await harness?.close();
	for (const child of children) child.kill("SIGKILL");
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("the served bundle's exposure (R32-FLEET.10, R33-REACH.3)", () => {
	it("serves the bundle without a credential — a browser cannot header-auth a navigation", async () => {
		for (const path of ["/ui", "/ui/", "/ui/console.css", "/ui/console.js", "/ui/tokens.css", "/ui/protocol.json"]) {
			const response = await fetch(`${origin}${path}`);
			assert.equal(response.status, 200, `${path} should be served unauthenticated`);
		}
	});

	it("does not open the data surface by serving the page", async () => {
		assert.equal((await fetch(`${origin}/fleet`)).status, 401);
	});

	/**
	 * `/attach` left the bearer middleware in Phase 33: the 101 has to precede
	 * authentication, because the credential *is* a frame and a frame needs a
	 * socket. So the refusal is on the wire, not on the upgrade — and this is the
	 * assertion that says the invariant survived the move. An anonymous peer gets
	 * a greeting and a refusal; it never gets the fleet, which is session data.
	 */
	it("refuses an anonymous peer on the wire, and tells it nothing about the fleet", async () => {
		const { page, close } = await harness.newPage(VIEWPORTS.desktop);
		try {
			await page.goto(`${origin}/ui`);
			const seen = await page.evaluate(async () => {
				const wire = await (await fetch("/ui/protocol.json")).json();
				const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/attach`;
				return await new Promise((resolve) => {
					const frames = [];
					const socket = new WebSocket(url);
					const finish = () => resolve(frames);
					socket.addEventListener("open", () => {
						socket.send(
							JSON.stringify({
								type: "hello",
								protocol: wire.protocol,
								version: wire.version,
								client: { name: "anonymous-probe", version: "0" },
							}),
						);
					});
					socket.addEventListener("message", (event) => {
						const frame = JSON.parse(event.data);
						frames.push({ type: frame.type, code: frame.code });
						if (frame.type === "server_hello") {
							socket.send(
								JSON.stringify({ type: "attach", sessionId: "any", clientId: "anonymous-probe", mode: "read-only" }),
							);
						}
					});
					socket.addEventListener("close", finish);
					setTimeout(finish, 10_000);
				});
			});

			assert.deepEqual(
				seen.map((frame) => frame.type),
				["server_hello", "protocol_error"],
				`an anonymous peer saw ${JSON.stringify(seen)}`,
			);
			assert.equal(seen[1].code, "not_authenticated");
		} finally {
			await close();
		}
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
 * The device exchange, end to end, in the browser (R33-REACH.3/.5/.9).
 *
 * The two tests share one browser context on purpose: a context is one browser
 * profile, so `localStorage` written by the first tab is what the second tab
 * finds — which is the only honest way to ask whether a credential survives a
 * tab close. `sessionStorage` would be empty in that second tab, which is
 * exactly the regression these tests exist to hold down.
 */
describe("pairing and the stored device credential (R33-REACH.5, R33-REACH.9)", () => {
	let context;
	let close;
	let requested;
	/** The credential minted by the pairing exchange, kept so its death can be asserted. */
	let paired;

	before(async () => {
		({ context, close } = await harness.newPage(VIEWPORTS.mobile));
		requested = [];
		context.on("request", (request) => requested.push(new URL(request.url()).pathname));
		await traceSockets(context);
	});

	after(async () => {
		await close?.();
	});

	it("the console pairs from a #token fragment, stores the returned device credential, and after a full page reload attaches again with no fragment and no re-pairing", async () => {
		const first = await context.newPage();
		await first.goto(consoleUrl(nextBootstrap()));
		await waitForText(first, "#status", "connected", { timeout: 20_000 });

		// The bootstrap token never survives the first tick in the address bar.
		assert.equal(first.url().includes("token"), false, `token still in the URL: ${first.url()}`);

		// `pair_device` is the first frame after the handshake — and the socket
		// offered no subprotocol, so no credential rode in a request header.
		const paireds = await sentTypes(first);
		assert.equal(paireds.length, 1, `expected one socket, got ${JSON.stringify(paireds)}`);
		assert.equal(paireds[0].protocols, null, "the credential must not ride on Sec-WebSocket-Protocol");
		assert.deepEqual(paireds[0].types.slice(0, 2), ["hello", "pair_device"]);

		// The fleet arrived on the wire, after authentication — not over HTTP.
		await first.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
		assert.equal(
			requested.includes("/fleet"),
			false,
			`the bundle still reads the fleet over HTTP: ${requested.join(", ")}`,
		);

		paired = await storedDevice(first, DEVICE_KEY);
		assert.ok(paired, `nothing was persisted under ${DEVICE_KEY}`);
		assert.match(paired.deviceId, /^dev_/);
		assert.ok(paired.credential.length > 0, "a stored credential with no credential in it");

		// A *new tab* in the same browser profile, opened at `/ui` with no
		// fragment at all. sessionStorage is empty here by construction.
		await first.close();
		const second = await context.newPage();
		await second.goto(consoleUrl());
		await waitForText(second, "#status", "connected", { timeout: 20_000 });
		await second.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });

		const reconnected = await sentTypes(second);
		assert.deepEqual(reconnected[0].types.slice(0, 2), ["hello", "authenticate"]);
		assert.equal(
			reconnected.some((record) => record.types.includes("pair_device")),
			false,
			"a restored tab must not re-pair — its bootstrap token is spent",
		);

		// Rotation, persisted: same device, a credential the daemon has replaced.
		const rotated = await storedDevice(second, DEVICE_KEY);
		assert.equal(rotated.deviceId, paired.deviceId, "rotation must not mint a second device");
		assert.notEqual(rotated.credential, paired.credential, "the credential must rotate at every exchange");
		await second.close();
	});

	/**
	 * Eviction (R33-REACH.9). The credential put back here is the one the
	 * exchange above rotated away, so this is also the assertion that the
	 * overwrite happened *before* the old value could be used again: if the
	 * bundle had kept the predecessor, this is the state every reconnect would
	 * be in.
	 */
	it("evicts a credential the daemon refuses and asks to be paired again, rather than breaking the page", async () => {
		const page = await context.newPage();
		await page.goto(consoleUrl());
		// Wait for the exchange to finish before writing: a rotation still in
		// flight would overwrite the superseded credential this test plants.
		await waitForText(page, "#status", "connected", { timeout: 20_000 });
		await page.evaluate(([key, value]) => localStorage.setItem(key, value), [DEVICE_KEY, JSON.stringify(paired)]);

		await page.reload();
		await waitForText(page, "#status", "not paired", { timeout: 20_000 });

		assert.equal(await storedDevice(page, DEVICE_KEY), null, "a refused credential must not stay on disk");
		assert.equal(await page.locator("#token-form").isVisible(), true, "the re-bootstrap prompt must be revealed");
		// Not a broken page: the shell is still there and still says what to do.
		assert.equal(await page.locator("#brand").isVisible(), true);
		await page.close();
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
			await page.goto(consoleUrl(nextBootstrap()));
		});

		after(async () => {
			await close?.();
		});

		it("pairs from the fragment and strips the token from the address bar", async () => {
			await waitForText(page, "#status", "connected", { timeout: 20_000 });
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
			await page.goto(consoleUrl(nextBootstrap()));
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
 * The phone with the keyboard up (R33-REACH.10), and the evidence readout the
 * archived device run photographs (R33-REACH.2).
 *
 * `100dvh` is the *layout* viewport, and a virtual keyboard does not always
 * shrink that: Chrome on Android resizes the layout viewport, iOS Safari does
 * not — it shrinks `visualViewport` and leaves the page laid out at full height
 * with its bottom few hundred pixels behind the keyboard. A composer positioned
 * against `dvh` alone is therefore reachable on one of the two browsers this
 * phase has to serve, which is the failure these tests describe.
 *
 * Headless Chromium has no keyboard and no API that shrinks the visual viewport
 * without also shrinking the layout viewport, so {@link raiseVirtualKeyboard}
 * says what iOS says: it makes `visualViewport` report the smaller geometry and
 * fires the `resize`/`scroll` events the platform fires. Every assertion after
 * that is a measurement of the real rendered box.
 */
describe("the phone with the keyboard up (R33-REACH.10)", () => {
	/** What a raised keyboard leaves of a 390x844 phone, in CSS pixels. */
	const KEYBOARD_VIEWPORT = { width: 390, height: 400 };
	/** The smallest comfortable touch target, in CSS pixels. */
	const TOUCH = 44;

	/**
	 * Tell the page what a virtual keyboard tells it, and nothing more.
	 *
	 * `visualViewport.height`/`offsetTop` are prototype getters, so an own
	 * property shadows them for this page only; the events are dispatched on the
	 * real `VisualViewport`, so a listener registered the ordinary way runs
	 * synchronously before this call returns.
	 */
	function raiseVirtualKeyboard(page, { height, offsetTop = 0 }) {
		return page.evaluate(
			([visibleHeight, top]) => {
				const visual = window.visualViewport;
				Object.defineProperty(visual, "height", { configurable: true, get: () => visibleHeight });
				Object.defineProperty(visual, "offsetTop", { configurable: true, get: () => top });
				visual.dispatchEvent(new Event("resize"));
				visual.dispatchEvent(new Event("scroll"));
			},
			[height, offsetTop],
		);
	}

	/** The rendered geometry that decides whether the composer is reachable. */
	function geometryOf(page) {
		return page.evaluate(() => {
			const rect = (selector) => {
				const box = document.querySelector(selector).getBoundingClientRect();
				return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
			};
			const visual = window.visualViewport;
			return {
				visual: visual
					? { top: visual.offsetTop, height: visual.height, width: visual.width }
					: { top: 0, height: window.innerHeight, width: window.innerWidth },
				composer: rect("#composer"),
				prompt: rect("#prompt"),
				send: rect("#send"),
				documentWidth: document.documentElement.scrollWidth,
			};
		});
	}

	/** Pair, open the live session, and leave the page on the composer. */
	async function openSessionOn(page) {
		await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
		await page.click(`#fleet [data-session-id="${sessionId}"]`);
		await waitForText(page, "#session-cwd", sessionCwd);
	}

	it("at 390x400 — the layout a virtual keyboard leaves — the composer stays inside the visual viewport, #prompt and #send are each at least 44 CSS px, and the page has zero horizontal overflow", async () => {
		const { page, close } = await harness.newPage(VIEWPORTS.mobile);
		try {
			await page.goto(consoleUrl(nextBootstrap()));
			await openSessionOn(page);
			await page.focus("#prompt");
			await raiseVirtualKeyboard(page, KEYBOARD_VIEWPORT);

			// The page must have *noticed*: a layout that only answers `dvh` cannot,
			// because `dvh` did not move.
			assert.equal(
				await page.getAttribute("body", "data-keyboard"),
				"up",
				"the page did not notice the visual viewport shrinking",
			);

			const shown = await geometryOf(page);
			const visualBottom = shown.visual.top + shown.visual.height;
			assert.equal(Math.round(shown.visual.height), KEYBOARD_VIEWPORT.height, "the keyboard simulation did not take");
			assert.ok(
				shown.composer.bottom <= visualBottom + 0.5,
				`the composer is behind the keyboard: it ends at ${shown.composer.bottom}px and the visible area ends at ${visualBottom}px`,
			);
			assert.ok(
				shown.composer.bottom >= visualBottom - 8,
				`the composer is not anchored to the visible bottom: it ends at ${shown.composer.bottom}px, ${visualBottom - shown.composer.bottom}px above the keyboard`,
			);
			assert.ok(
				shown.composer.top >= shown.visual.top - 0.5,
				`the composer starts above the visible area: top ${shown.composer.top}px vs ${shown.visual.top}px`,
			);

			for (const [name, box] of [
				["#prompt", shown.prompt],
				["#send", shown.send],
			]) {
				assert.ok(box.width >= TOUCH, `${name} is ${box.width}px wide — a phone target is ${TOUCH} CSS px`);
				assert.ok(box.height >= TOUCH, `${name} is ${box.height}px tall — a phone target is ${TOUCH} CSS px`);
				assert.ok(box.bottom <= visualBottom + 0.5, `${name} is behind the keyboard: it ends at ${box.bottom}px`);
			}

			assert.ok(
				shown.documentWidth <= KEYBOARD_VIEWPORT.width,
				`horizontal overflow with the keyboard up: document is ${shown.documentWidth}px wide`,
			);

			// Second half of the iOS geometry: with the keyboard up the page can be
			// scrolled *under* the layout viewport's origin, and the visible area
			// moves down as well as shrinking.
			await raiseVirtualKeyboard(page, { ...KEYBOARD_VIEWPORT, offsetTop: 24 });
			const scrolled = await geometryOf(page);
			const scrolledBottom = scrolled.visual.top + scrolled.visual.height;
			assert.equal(Math.round(scrolled.visual.top), 24, "the offset simulation did not take");
			assert.ok(
				scrolled.composer.bottom <= scrolledBottom + 0.5 && scrolled.composer.bottom >= scrolledBottom - 8,
				`the composer did not follow visualViewport.offsetTop: it ends at ${scrolled.composer.bottom}px, visible area ends at ${scrolledBottom}px`,
			);
			assert.ok(
				scrolled.documentWidth <= KEYBOARD_VIEWPORT.width,
				`horizontal overflow after the offset: document is ${scrolled.documentWidth}px wide`,
			);
		} finally {
			await close();
		}
	});

	/**
	 * The fallback half of "positioned against `visualViewport` with a `dvh`
	 * fallback": a browser with no `visualViewport` at all must still lay the
	 * composer out inside the viewport it does have, and must not throw doing it.
	 */
	it("falls back to dvh where the browser has no visualViewport, and the composer is still inside a 390x400 layout viewport", async () => {
		const { page, errors, close } = await harness.newPage(KEYBOARD_VIEWPORT);
		try {
			await page.addInitScript(() => {
				Object.defineProperty(window, "visualViewport", { configurable: true, get: () => undefined });
			});
			await page.goto(consoleUrl(nextBootstrap()));
			await openSessionOn(page);

			const shown = await geometryOf(page);
			assert.equal(shown.visual.height, KEYBOARD_VIEWPORT.height, "the visualViewport removal did not take");
			assert.ok(
				shown.composer.bottom <= KEYBOARD_VIEWPORT.height + 0.5,
				`the composer is off-screen without a visualViewport: it ends at ${shown.composer.bottom}px`,
			);
			assert.ok(
				shown.documentWidth <= KEYBOARD_VIEWPORT.width,
				`horizontal overflow at 390x400: document is ${shown.documentWidth}px wide`,
			);
			assert.deepEqual(errors, [], "a browser without visualViewport must not be a page that throws");
		} finally {
			await close();
		}
	});

	/**
	 * Every control the phone can be asked to hit, measured where it is actually
	 * on screen — the token field and its button on the re-bootstrap prompt, the
	 * fleet row on the list, `#back`/`#prompt`/`#send` inside a session.
	 */
	it("gives every interactive control the phone layout offers at least 44 CSS px in both dimensions", async () => {
		const { page, close } = await harness.newPage(VIEWPORTS.mobile);

		/** Undersized visible controls, as `selector WxH`. */
		async function undersized(selectors) {
			return await page.evaluate(
				([wanted, minimum]) => {
					const small = [];
					for (const selector of wanted) {
						const node = document.querySelector(selector);
						if (!node || node.getClientRects().length === 0) continue;
						const box = node.getBoundingClientRect();
						if (box.width < minimum || box.height < minimum) {
							small.push(`${selector} ${box.width.toFixed(1)}x${box.height.toFixed(1)}`);
						}
					}
					return small;
				},
				[selectors, TOUCH],
			);
		}

		try {
			// No fragment: the re-bootstrap prompt is on screen, so its field and
			// button are rendered and measurable.
			await page.goto(consoleUrl());
			await page.locator("#token-form").waitFor({ timeout: 20_000 });
			assert.deepEqual(await undersized(["#refresh", "#token-input", "#token-save"]), []);

			// Pair through that same form — the pasted-token path — and measure the
			// fleet row it produces.
			await page.fill("#token-input", nextBootstrap());
			await page.click("#token-save");
			await waitForText(page, "#status", "connected", { timeout: 20_000 });
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
			assert.deepEqual(await undersized(["#refresh", ".session-row"]), []);

			await page.click(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd);
			assert.deepEqual(await undersized(["#back", "#prompt", "#send"]), []);
		} finally {
			await close();
		}
	});

	/**
	 * One screenshot, the whole pinned-version evidence set (R33-REACH.2).
	 *
	 * The archived device run has to record which browser build loaded the bundle,
	 * which protocol member it spoke, how long the socket survived and how it
	 * died. On a phone there is no devtools to read that out of, so the page
	 * renders it — but only when asked, because an operator's console is not an
	 * evidence sheet.
	 */
	it("renders #diagnostics — UA, protocol family and version, socket uptime and last close code — when the fragment carries diag", async () => {
		const { page, context, close } = await harness.newPage(VIEWPORTS.mobile);
		try {
			await traceSockets(context);

			// Not on screen for an operator who did not ask for it.
			await page.goto(consoleUrl());
			await page.locator("#token-form").waitFor({ timeout: 20_000 });
			assert.equal(await page.locator("#diagnostics").isVisible(), false, "diagnostics must be opt-in");

			// A second tab rather than a second navigation: adding a fragment to the
			// URL the page is already on is a same-document navigation, so the module
			// would never re-run and the bootstrap token would never be read.
			const diag = await context.newPage();
			await diag.goto(`${consoleUrl(nextBootstrap())}&diag=1`);
			await waitForText(diag, "#status", "connected", { timeout: 20_000 });
			await diag.locator("#diagnostics").waitFor({ state: "visible", timeout: 10_000 });

			const wire = await (await fetch(`${origin}/ui/protocol.json`)).json();
			assert.equal(await textOf(diag, "#diag-ua"), await diag.evaluate(() => navigator.userAgent));
			assert.equal(await textOf(diag, "#diag-protocol"), `${wire.protocol}/${wire.version}`);

			// Uptime is a live measurement, not a timestamp: it has to move.
			const uptime = () => textOf(diag, "#diag-uptime").then((text) => Number.parseFloat(text));
			const firstReading = await uptime();
			assert.ok(Number.isFinite(firstReading), `socket uptime is not a number: ${await textOf(diag, "#diag-uptime")}`);
			await until(
				async () => (await uptime()) > firstReading + 0.4,
				async () => `the socket uptime to tick past ${firstReading} (it reads ${await textOf(diag, "#diag-uptime")})`,
				10_000,
			);

			// Nothing has closed yet, and the readout says so rather than guessing.
			assert.equal(await textOf(diag, "#diag-close"), "—");
			assert.equal(await dropLiveSocket(diag), 1, "expected exactly one live socket to drop");
			await waitForText(diag, "#diag-close", "4000", { timeout: 10_000 });
		} finally {
			await close();
		}
	});
});

/**
 * Losing the connection, and getting it back (R33-REACH.9).
 *
 * Two properties, both of which a phone meets within a minute of being used:
 * the screen locks or the tailnet blips, and the socket dies.
 *
 * There is **no server-side scrollback** to lean on. Neither the geist wire nor
 * the session's own protocol (`coding-agent/src/core/socket-server/types.ts`,
 * whose server messages are output / input_echo / joined / left / metadata /
 * error) has any replay concept, and the session streams to whoever is attached
 * at the time. So "the transcript survives" can only mean the page kept what it
 * had rendered and re-attached to the same session — not that anything was
 * fetched again.
 */
describe("a connection that drops and comes back (R33-REACH.9)", () => {
	it("a dropped socket shows an explicit disconnected state, reconnects automatically, and the transcript rendered before the drop is still on screen after the re-attach", async () => {
		// The phone viewport, because that is where the drop happens and because
		// `#back` — the only way to leave a session when the fleet rail is
		// off-screen — exists only here.
		const { page, context, close } = await harness.newPage(VIEWPORTS.mobile);
		try {
			await traceSockets(context);
			await page.goto(consoleUrl(nextBootstrap()));
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
			await page.click(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd);

			// A real turn, so what has to survive is real streamed assistant text
			// and not a string this test typed into the DOM.
			const spoken = "spoken before the gap";
			await page.fill("#prompt", spoken);
			await page.click("#send");
			await waitForText(page, "#transcript", `stub: ${spoken}`, { timeout: 30_000 });
			const before = await page.locator("#transcript .entry").count();
			assert.ok(before >= 2, `expected the prompt and the reply on screen, saw ${before} entries`);

			// The gap: the network goes away, and the live socket goes with it.
			await context.setOffline(true);
			assert.equal(await dropLiveSocket(page), 1, "there was no live socket to drop");

			// Explicit, not a silently dead transcript: the page says it is gone…
			await waitForStatusState(page, "disconnected");
			assert.match(await page.locator("#status").innerText(), /disconnected/);
			// …and what was on screen is still on screen while it is gone.
			assert.match(await page.locator("#transcript").innerText(), new RegExp(`stub: ${spoken}`));
			assert.equal(await page.getAttribute("body", "data-view"), "session");

			await context.setOffline(false);
			await waitForStatusState(page, "connected", 30_000);

			// Restored, unasked: the same session is current again, on a socket that
			// authenticated with the stored credential rather than re-pairing.
			await currentRow(page);
			assert.equal(await page.getAttribute("body", "data-view"), "session");

			const wire = await sentTypes(page);
			assert.ok(wire.length > 1, "the page never opened a second socket — it did not reconnect");
			assert.deepEqual(
				wire.filter((record) => record.types.includes("pair_device")).length,
				1,
				"a reconnect must not re-pair — its bootstrap token is spent",
			);
			const last = wire.at(-1);
			assert.deepEqual(last.types.slice(0, 2), ["hello", "authenticate"], `the last socket sent ${last.types}`);
			assert.ok(last.types.includes("attach"), "the reconnect must re-attach the session the operator had open");

			// Preserved, not rebuilt: the pre-drop entries are still there, and the
			// empty-transcript placeholder never came back.
			const transcript = await page.locator("#transcript").innerText();
			assert.match(transcript, new RegExp(spoken));
			assert.match(transcript, new RegExp(`stub: ${spoken}`));
			assert.ok(
				(await page.locator("#transcript .entry").count()) >= before,
				"the transcript was cleared across the reconnect",
			);
			assert.equal(await page.locator("#transcript-empty").isVisible(), false);

			// And live again, not merely painted: a second turn round-trips through
			// the re-attached session, into the same transcript as the first.
			const after = "spoken after the gap";
			await page.fill("#prompt", after);
			await page.click("#send");
			await waitForText(page, "#transcript", `stub: ${after}`, { timeout: 30_000 });
			assert.match(await page.locator("#transcript").innerText(), new RegExp(`stub: ${spoken}`));

			// A deliberate switch is the only thing that clears it, and going back
			// to the fleet and re-opening the session that is already on screen is
			// not one. There is nothing to fetch the conversation back with, so a
			// clear here is the same permanent loss a reconnect would have been.
			await page.click("#back");
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
			await waitForStatusState(page, "connected", 25_000);
			await page.click(`#fleet [data-session-id="${sessionId}"]`);
			await currentRow(page);

			const returned = await page.locator("#transcript").innerText();
			assert.match(returned, new RegExp(`stub: ${spoken}`), "re-opening the session already on screen cleared it");
			assert.match(returned, new RegExp(`stub: ${after}`), "re-opening the session already on screen cleared it");
		} finally {
			await close();
		}
	});

	/**
	 * The Phase 32 residual.
	 *
	 * The retry budget was replenished by `session_metadata` and by nothing else,
	 * so a console that authenticates and then sits on the fleet — the state every
	 * console is in before anyone taps a session — spent its eight attempts once,
	 * over its whole lifetime, and then stopped reconnecting for good with the
	 * network perfectly healthy.
	 *
	 * Nine drops rather than eight: the ninth is the one past `MAX_RETRIES` that a
	 * budget which is only ever spent cannot pay for.
	 */
	it("replenishes the retry budget on a successful device exchange, so a console left on the fleet outlives more drops than the budget has attempts", async () => {
		const DROPS = 9;
		const { page, context, close } = await harness.newPage(VIEWPORTS.desktop);
		try {
			await traceSockets(context);
			await page.goto(consoleUrl(nextBootstrap()));
			// The fleet, and never a session: nothing here ever sends `attach`.
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
			await waitForStatusState(page, "connected");

			for (let drop = 1; drop <= DROPS; drop += 1) {
				const opened = await page.evaluate(() => window.__sockets.length);
				assert.equal(await dropLiveSocket(page), 1, `drop ${drop}: there was no live socket to drop`);
				try {
					// A fresh socket first — a page that has given up opens none, and
					// waiting only on the status would not say which failure it was.
					await until(
						async () => (await page.evaluate(() => window.__sockets.length)) > opened,
						`drop ${drop} of ${DROPS} to be followed by a reconnect attempt`,
						25_000,
					);
					await waitForStatusState(page, "connected", 25_000);
				} catch (error) {
					const status = await page.locator("#status").innerText();
					throw new Error(`drop ${drop} of ${DROPS}: #status says ${JSON.stringify(status)} — ${error.message}`);
				}
			}

			assert.equal(await page.getAttribute("#status", "data-state"), "connected");
			// Still bounded: the ceiling is a real ceiling, just not one a healthy
			// console walks into. `MAX_RETRIES = 8` with a 500ms floor, so nine
			// drops that each reconnect at once cannot have opened more than a
			// socket apiece plus the first.
			const sockets = await page.evaluate(() => window.__sockets.length);
			assert.ok(sockets <= DROPS + 1, `${sockets} sockets for ${DROPS} drops — the reconnect is not one-for-one`);

			// The fleet is still real data on the other side of it all.
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });
		} finally {
			await close();
		}
	});
});

/**
 * Runs LAST, and kills the session every suite above attaches to.
 *
 * A page whose session has died reconnects, re-authenticates, and is then
 * refused its `attach` with `unknown_session` — and the refusal arrives AFTER
 * the greeting and after a successful device exchange. A retry counter cleared
 * on either of those is therefore never allowed to reach its ceiling, and the
 * page hammers the daemon forever. The bound is only real if it survives that
 * ordering, which is why this is a browser assertion about socket count rather
 * than a unit test about a counter.
 */
describe("a session that goes away (R32-FLEET.10)", () => {
	it("stops reconnecting after a bounded number of attempts and says so", async () => {
		const { page, context, close } = await harness.newPage(VIEWPORTS.desktop);
		try {
			await traceSockets(context);
			await page.goto(consoleUrl(nextBootstrap()));
			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 15_000 });

			// The session dies while the page still lists it, so every attach from
			// here on is refused — exactly the state the unbounded loop lived in.
			drahtSession.kill("SIGKILL");
			await page.click(`#fleet [data-session-id="${sessionId}"]`);

			// Six seconds of backoff is 500 + 1000 + 2000 ms of waiting and three
			// reconnects. A counter reset by the greeting never leaves the 500 ms
			// step, so it would be past ten by now.
			await new Promise((resolve) => setTimeout(resolve, 6_000));
			const early = await page.evaluate(() => window.__sockets.length);
			assert.ok(early <= 6, `the page opened ${early} sockets in six seconds — the backoff is not growing`);

			await waitForText(page, "#status", "reload to reconnect", { timeout: 45_000 });
			const total = await page.evaluate(() => window.__sockets.length);
			assert.ok(total <= 9, `the page opened ${total} sockets before giving up`);
		} finally {
			await close();
		}
	});
});
