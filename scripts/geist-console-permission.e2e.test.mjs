/**
 * A permission ask, rendered and answered in a real browser (R34-PERM.2, R34-PERM.4).
 *
 * The daemon-served console is the surface a phone actually holds, and until this
 * file existed nothing proved it could show a decision the agent is parked on, let
 * alone release one. Everything Phase 34 built before it stopped at the wire: the
 * socket protocol could carry a `permission_request`, geist/0.3 could declare one,
 * the attach bridge could relay one — and `packages/geist-console/bundle/console.js`
 * had no `case` for it, so a browser dropped it on the floor while the agent waited.
 *
 * Three real processes, none of them imported into this file (the shape is
 * `scripts/geist-console-bundle.e2e.test.mjs`'s; read that file's header for why
 * each one is spawned rather than constructed):
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) with
 *     `--attachable` against the keyless stub provider, SCRIPTED to issue two real
 *     `bash` tool calls, so the ask under test is one the permission gate really
 *     raised and really parked a turn on;
 *   • a daemon on an ephemeral loopback port serving the bundle at `/ui`, spawned
 *     from a temp `bun` host because the shipped `draht-gateway` CLI still
 *     constructs no device store (the gap the sibling suite reports as a blocker);
 *   • headless Chromium, through `scripts/browser-harness.mjs`.
 *
 * Every assertion is a DOM assertion against bytes the running daemon served.
 * Nothing here reads `packages/geist-console/bundle/` off disk to check what the
 * page "should" contain, and nothing constructs a bridge, a relay or a socket
 * client in-process.
 *
 * ## THE LOAD-BEARING ASSERTION IS THE MARKER FILE
 *
 * A dialog appearing and a frame going back prove plumbing. A file on disk that
 * exists only because a button in Chromium was clicked proves the answer crossed
 * the WebSocket, crossed the attach bridge, crossed the session's own socket,
 * validated against the frozen offered set, and released a tool call the agent
 * was blocked on. That is the sentence R34-PERM.2 is about.
 *
 * ## Harness hygiene, each item paid for by a probe that passed while proving nothing
 *
 *  - `DRAHT_PERMISSION_MODE` is DELETED from the child env. This repo's interactive
 *    shell exports `auto`, under which the scripted `bash` call is auto-allowed and
 *    NO ask is raised at all — the test then renders nothing and asserts nothing.
 *  - The agent dir sits directly under /tmp with a short name: a Unix socket path
 *    over ~104 bytes fails to bind with EINVAL, and macOS `os.tmpdir()` already
 *    spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed.
 *
 * Run: node --test --test-timeout=300000 scripts/geist-console-permission.e2e.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, VIEWPORTS, waitForServer, waitForText } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");

/** The daemon's shared operator token. The console never presents it — see the sibling suite. */
const OPERATOR_TOKEN = "aGVsbG8+d29ybGQ/Cg==";
/** Bootstrap tokens minted at boot; each is single-use, so every pairing takes a fresh one. */
const BOOTSTRAP_COUNT = 6;

/* ------------------------------------------------------------- the payload -- */

/**
 * The tail of the hostile command, and the only part of it a human decides on.
 *
 * `boundedSafeText` elides the MIDDLE of an over-long string and keeps the end,
 * precisely because `curl … | sh   # AND THEN rm -rf ~/.ssh` is decided by its
 * last clause. If this string is missing from the rendered ask, the console is
 * showing a human the harmless half of a command and asking them to approve it.
 */
const HOSTILE_TAIL = "echo TAIL-MARKER-9f3c";

/**
 * A command written to be misread, in the three ways that matter on this wire.
 *
 *  1. a leading ESC + `[2J` — a real terminal clears its screen and the ask above
 *     it disappears; a browser is immune to that but must still not swallow the
 *     byte, because a DELETED control character welds the two halves it separated
 *     into a different command;
 *  2. two U+202E RIGHT-TO-LEFT OVERRIDEs, which cost zero display width and
 *     reverse everything after them — the spoof a width budget cannot bound;
 *  3. ~5000 characters of padding, well past the 512-grapheme budget the ask's
 *     detail is built under, so the middle is elided and the tail must survive.
 *
 * Escaped rather than written literally so the value survives a JSON env var and
 * so a future reader can see exactly which code points are being tested.
 */
const HOSTILE_COMMAND = `\u001b[2Jecho start \u202e${"A".repeat(5000)}\u202e && ${HOSTILE_TAIL}`;

/** C0 controls and DEL. None of these may reach the DOM: they arrive already replaced one-for-one. */
const C0_AND_DEL = /[\u0000-\u001f\u007f]/;
/** The bidi overrides and embeddings U+202A..U+202E, likewise. */
const BIDI_OVERRIDES = /[\u202a-\u202e]/;
/** ESC (U+001B) as its Control Pictures glyph — the one-for-one replacement, proving nothing was deleted. */
const ESC_PICTURE = "␛";
/** The one-for-one replacement for every non-C0 forbidden code point. */
const REPLACEMENT_CHARACTER = "�";

/* -------------------------------------------------------------- the daemon -- */

/**
 * A gateway with a device store, in its own process — verbatim in intent from
 * `scripts/geist-console-bundle.e2e.test.mjs`, whose header explains why the
 * shipped `draht-gateway` CLI cannot yet do this itself.
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

/* ------------------------------------------------------------- scaffolding -- */

/** See the header: a Unix socket path over ~104 bytes fails to bind with EINVAL. */
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

function collect(stream, sink) {
	stream.on("data", (chunk) => {
		sink.text += String(chunk);
	});
}

/**
 * Poll until `probe` yields something truthy.
 *
 * The value is AWAITED, not merely tested: every Promise is truthy, so a version
 * of this that skipped the await would succeed on its first tick.
 */
async function until(probe, what, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) {
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
/** Written by the FIRST scripted tool call, and only if a human approves it. */
let marker;
/** The exact command that first call carries, as the ask must show it. */
let benignCommand;
let daemonStderr;
let drahtStderr;
let bootstraps = [];

function nextBootstrap() {
	const token = bootstraps.shift();
	if (!token) throw new Error(`out of bootstrap tokens — mint more than ${BOOTSTRAP_COUNT}`);
	return token;
}

function consoleUrl(bootstrapToken) {
	return bootstrapToken === undefined ? `${origin}/ui` : `${origin}/ui#token=${encodeURIComponent(bootstrapToken)}`;
}

/** Record every WebSocket the page constructs, so a test can drop a live one. */
async function traceSockets(context) {
	await context.addInitScript(() => {
		window.__sockets = [];
		const Native = window.WebSocket;
		window.WebSocket = new Proxy(Native, {
			construct(target, args) {
				const record = { url: args[0], socket: null };
				window.__sockets.push(record);
				const socket = new target(...args);
				record.socket = socket;
				return socket;
			},
		});
	});
}

/** Drop the page's live connection from the peer's side, the way a tunnel or a lock screen does. */
function dropLiveSocket(page) {
	return page.evaluate(() => {
		const live = window.__sockets.filter((record) => record.socket?.readyState === WebSocket.OPEN);
		for (const record of live) record.socket.close(4000, "dropped");
		return live.length;
	});
}

/**
 * Every permission ask on screen, projected into plain data.
 *
 * `textContent`, not `innerText`: the properties under test are about which code
 * points reached the DOM, and `innerText` normalises whitespace and would hide
 * exactly the difference between a control character that was replaced and one
 * that was dropped.
 */
async function asksOnScreen(page) {
	transcriptSnapshot = await page.locator("#transcript").textContent().catch(() => "(no transcript)");
	return page.evaluate(() =>
		[...document.querySelectorAll("#transcript .entry[data-kind='permission']")].map((root) => ({
			requestId: root.dataset.requestId,
			decision: root.dataset.decision ?? null,
			dir: root.getAttribute("dir"),
			text: root.textContent,
			heading: root.querySelector(".permission-heading")?.textContent ?? null,
			facts: Object.fromEntries(
				[...root.querySelectorAll(".permission-row")].map((row) => [
					row.dataset.fact,
					row.querySelector(".permission-value").textContent,
				]),
			),
			options: [...root.querySelectorAll(".permission-option")].map((button) => ({
				id: button.dataset.optionId,
				label: button.textContent,
				disabled: button.disabled,
			})),
			outcome: root.querySelector(".permission-outcome")?.textContent ?? null,
			notice: root.querySelector(".permission-notice")?.textContent ?? null,
		})),
	);
}

/**
 * The two direction properties `console.css` sets, as the browser actually computed them.
 *
 * Read off the LIVE element rather than off the stylesheet text: what protects a human is what
 * Chromium resolved, and a rule that never matched the element it was written for computes to the
 * initial value while the file still contains the declaration.
 */
function computedDirection(page, requestId) {
	return page.evaluate((id) => {
		const root = document.querySelector(`#transcript .entry[data-request-id="${id}"]`);
		if (!root) return null;
		const value = root.querySelector('.permission-row[data-fact="command"] .permission-value');
		const read = (element) => {
			const style = getComputedStyle(element);
			return { direction: style.direction, unicodeBidi: style.unicodeBidi };
		};
		return { root: read(root), value: value ? read(value) : null };
	}, requestId);
}

/**
 * Lay a right-to-left SCRIPT out under the ask's real classes and report the x of every glyph.
 *
 * This is the residual attack the neutralization deliberately does NOT touch: U+202E is replaced
 * before the wire, but Hebrew letters are ordinary text and no sanitizer may remove them, so the
 * ONLY thing keeping `… && rm -rf ~` from being displayed in a different order than it will run in
 * is `unicode-bidi: isolate-override` on the value. Asserting the property name would pass against
 * a rule that never applies; asserting the geometry is the claim itself.
 *
 * Built as its own subtree, with the real class names and the real nesting, and torn down again:
 * the styles come from the served stylesheet, and #transcript is left exactly as it was found.
 */
function glyphOrderUnderRealClasses(page, text) {
	return page.evaluate((probeText) => {
		const root = document.createElement("div");
		root.className = "entry permission";
		root.dataset.kind = "permission";
		// Everything console.js contributes, and nothing else: no inline direction, no inline
		// unicode-bidi. If the glyphs come out in order it is because the stylesheet said so.
		root.dir = "ltr";
		const facts = document.createElement("div");
		facts.className = "permission-facts";
		const row = document.createElement("div");
		row.className = "permission-row";
		row.dataset.fact = "command";
		const value = document.createElement("span");
		value.className = "permission-value";
		value.textContent = probeText;
		row.append(value);
		facts.append(row);
		root.append(facts);
		document.body.append(root);
		try {
			const node = value.firstChild;
			const glyphs = [];
			for (let index = 0; index < probeText.length; index += 1) {
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + 1);
				const rect = range.getBoundingClientRect();
				glyphs.push({ x: rect.x, top: rect.top });
			}
			return glyphs;
		} finally {
			root.remove();
		}
	}, text);
}

/** The concatenated text of every streamed-assistant bubble. */
function agentBubbleText(page) {
	return page.evaluate(() =>
		[...document.querySelectorAll("#transcript .entry[data-kind='agent']")].map((el) => el.textContent).join("\n"),
	);
}

/** Wait until an ask this page has not yet seen is on screen, and return it. */
function waitForNewAsk(page, seen, timeoutMs = 90_000) {
	return until(
		async () => (await asksOnScreen(page)).find((ask) => !seen.has(ask.requestId)),
		// A thunk, so a failure quotes what the session was actually doing rather
		// than only saying that nothing arrived.
		() =>
			`a permission ask other than ${[...seen].join(", ") || "(none)"} to reach the browser` +
			`\n--- transcript ---\n${transcriptSnapshot}` +
			`\n--- draht stderr ---\n${drahtStderr.text.slice(-4000)}`,
		timeoutMs,
	);
}

/** Last transcript text seen by {@link asksOnScreen}, for a failure message. */
let transcriptSnapshot = "";

/** Wait until the named ask carries a resolution, and return it. */
function waitForResolved(page, requestId, timeoutMs = 60_000) {
	return until(
		async () => (await asksOnScreen(page)).find((ask) => ask.requestId === requestId && ask.decision !== null),
		`ask ${requestId} to be resolved on screen`,
		timeoutMs,
	);
}

before(async () => {
	// The artifact under test is emitted, not committed: build it, every run.
	const build = spawnSync("bun", ["run", "build"], {
		cwd: join(REPO_ROOT, "packages/coding-agent"),
		encoding: "utf8",
	});
	if (build.status !== 0) throw new Error(`draht build failed:\n${build.stderr}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	const agentDir = tempDir("gcp-a-");
	const home = tempDir("gcp-h-");
	sessionCwd = realpathSync(tempDir("gcp-c-"));
	marker = join(sessionCwd, "approved-in-the-browser.txt");
	benignCommand = `echo approved > ${marker}`;

	// Two provider turns, so the session raises two asks in sequence: the first
	// is decided by a click and really runs; the second carries the hostile
	// payload and is refused. `parseStubToolCallScripts` consumes one entry per
	// provider turn and falls back to plain text once they are spent, which is
	// what lets the turn finish afterwards.
	const script = JSON.stringify([
		{ toolCalls: [{ id: "call-benign", name: "bash", arguments: { command: benignCommand } }] },
		{ toolCalls: [{ id: "call-hostile", name: "bash", arguments: { command: HOSTILE_COMMAND } }] },
	]);

	drahtStderr = { text: "" };
	// Built from scratch rather than inherited: this repo's shell exports
	// DRAHT_PERMISSION_MODE=auto, under which no ask is raised at all.
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
				DRAHT_STUB_TOOL_CALLS: script,
			},
			stdio: ["pipe", "ignore", "pipe"],
		}),
	);
	collect(draht.stderr, drahtStderr);

	const socketDir = join(agentDir, "sockets");
	const socketFile = await until(() => {
		if (draht.exitCode !== null) {
			throw new Error(`draht exited with ${draht.exitCode} before publishing a socket:\n${drahtStderr.text}`);
		}
		return sockets(socketDir)[0];
	}, () => `draht to publish its socket (stderr: ${drahtStderr.text})`);
	sessionId = socketFile.slice(0, -".sock".length);

	const hostDir = tempDir("gcp-g-");
	const hostFile = join(hostDir, "device-gateway.ts");
	writeFileSync(hostFile, DEVICE_HOST, "utf8");

	const port = await freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemonStdout = { text: "" };
	const daemonEnv = { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir };
	delete daemonEnv.DRAHT_PERMISSION_MODE;
	const daemon = track(
		spawn(
			"bun",
			[hostFile, String(port), socketDir, join(hostDir, "devices.json"), OPERATOR_TOKEN, String(BOOTSTRAP_COUNT)],
			{ env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] },
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
}, { timeout: 600_000 });

after(async () => {
	await harness?.close();
	for (const child of children) child.kill("SIGKILL");
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * One page, one session, two asks, in order. The `it`s share state deliberately:
 * this is one product sentence and each step is only meaningful after the last.
 */
describe("a permission ask in the served console (R34-PERM.2, R34-PERM.4)", () => {
	let page;
	let context;
	let errors;
	let close;
	/** Request ids this page has already been shown. */
	const seen = new Set();
	let benignAsk;
	let hostileAsk;

	before(async () => {
		({ page, context, errors, close } = await harness.newPage(VIEWPORTS.mobile));
		await traceSockets(context);
		await page.goto(consoleUrl(nextBootstrap()));
		await waitForText(page, "#status", "connected", { timeout: 30_000 });
		await page.click(`#fleet [data-session-id="${sessionId}"]`);
		await waitForText(page, "#session-cwd", sessionCwd, { timeout: 20_000 });
	}, { timeout: 120_000 });

	after(async () => {
		await close?.();
	});

	it("renders the ask in its OWN element, with the tool, the cwd and the command the gate really received", async () => {
		assert.equal(existsSync(marker), false, "the scripted tool call must not have run before anybody approved it");

		// Down the same wire a phone would use. The stub answers with the scripted
		// `bash` call; the permission gate parks the turn on it.
		await page.fill("#prompt", "run the scripted tool");
		await page.click("#send");

		benignAsk = await waitForNewAsk(page, seen);
		seen.add(benignAsk.requestId);

		assert.equal(benignAsk.facts.tool, "bash");
		// Canonical: /tmp is a symlink to /private/tmp on macOS, so an un-realpathed
		// cwd would read as a different project on the surface being asked.
		assert.equal(benignAsk.facts.cwd, sessionCwd);
		assert.equal(benignAsk.facts.command, benignCommand);
		assert.equal(benignAsk.dir, "ltr", "the ask must carry its own base direction");
		assert.ok(benignAsk.heading, "the ask must be titled");

		// ITS OWN ELEMENT. `addOutput` concatenates streamed text into one shared
		// agent bubble, and an ask rendered there would inherit that bubble's
		// direction and read as something the agent said rather than something the
		// human is being asked. The command must not be in it.
		const bubbles = await agentBubbleText(page);
		assert.equal(
			bubbles.includes(benignCommand),
			false,
			`the command leaked into the assistant transcript: ${JSON.stringify(bubbles)}`,
		);
		assert.equal(bubbles.includes(marker), false, "the marker path leaked into the assistant transcript");
	});

	it("offers one button per offered option, labelled from the frame", async () => {
		// Built from the `options` array, never parsed out of a sentence: the ids
		// are the only vocabulary an answer may name, and the labels are the
		// session's own words for them.
		assert.deepEqual(
			benignAsk.options.map((option) => option.id).sort(),
			["approve", "deny"],
			`buttons were ${JSON.stringify(benignAsk.options)}`,
		);
		for (const option of benignAsk.options) {
			assert.ok(option.label.length > 0, `option ${option.id} has no label`);
			assert.equal(option.disabled, false, "an unanswered ask must be answerable");
		}
	});

	/**
	 * R34-PERM.4's LAST line of defence, and the one no frame can carry.
	 *
	 * Neutralization replaces every bidi CONTROL before the wire, and the sibling test below proves
	 * that. It cannot touch a right-to-left SCRIPT: Hebrew and Arabic are ordinary text that a
	 * command may legitimately contain, and a right-to-left run reorders the characters around it
	 * wherever it lands. `dir="ltr"` alone does not stop that — it only sets the base direction the
	 * run is embedded in. What stops it is `unicode-bidi: isolate-override` in `console.css`, and
	 * until this test existed both of that file's declarations of it could be deleted with the
	 * whole suite still green, because the only bidi assertion in it read the `dir` ATTRIBUTE that
	 * `console.js` sets.
	 */
	it("lays the ask out under console.css's own direction defence, which the dir attribute cannot supply", async () => {
		// THE GEOMETRY FIRST, because it is the property the human is actually owed and it holds
		// even if the defence is spelled some other way tomorrow. ALEF and BET are a right-to-left
		// run: without the override they are painted in the opposite order to the order they are
		// stored in, which is the whole spoof.
		const probe = "AB\u05d0\u05d1CD";
		const glyphs = await glyphOrderUnderRealClasses(page, probe);
		assert.equal(glyphs.length, probe.length);
		// One line, so an x comparison means what it says.
		assert.equal(new Set(glyphs.map((glyph) => Math.round(glyph.top))).size, 1, "the probe wrapped");
		for (let index = 1; index < glyphs.length; index += 1) {
			assert.ok(
				glyphs[index].x > glyphs[index - 1].x,
				`glyph ${index} of ${JSON.stringify(probe)} was painted left of glyph ${index - 1}: ` +
					`the string is displayed in a different order than it is written (${JSON.stringify(glyphs)})`,
			);
		}
		// …and then the properties themselves, on the elements really on screen — computed, not
		// declared, so a rule that never matched what it was written for cannot pass. This is the
		// half that covers the CONTAINER, whose own override the value inside it does not inherit.
		const computed = await computedDirection(page, benignAsk.requestId);
		assert.ok(computed, "the ask element was not on screen to measure");
		assert.deepEqual(
			computed.root,
			{ direction: "ltr", unicodeBidi: "isolate-override" },
			"the ask container lost its direction defence",
		);
		assert.deepEqual(
			computed.value,
			{ direction: "ltr", unicodeBidi: "isolate-override" },
			"the command — the part that is read as an instruction — lost its direction defence",
		);
	});

	/**
	 * A reconnect is not a second ask. The session REPLAYS every still-pending ask
	 * to a client that re-attaches (`PermissionDelivery.forgetClient` deliberately
	 * forgets what a dead connection was shown), and this page's transcript
	 * survives the gap — so without an index keyed by `requestId` the phone would
	 * grow a second copy of the same question with its own Approve button.
	 */
	it("is idempotent across a dropped connection — a replayed ask UPDATES the element, it does not stack a second one and it is not ignored", async () => {
		// The transcript survives a reconnect on purpose (`clearTranscript` is not called), so the
		// original element is still on screen no matter what the replay does — which means "exactly
		// one element, still answerable" is equally true of a frame switch that DROPS a replayed
		// ask. Stamping the element first is what tells those two apart: every field below is one
		// `renderPermissionRequest` writes on every render, so if the replay is consumed they come
		// back, and if it is dropped they stay as they are here.
		const STALE = "STALE-4b1c — replaced by hand, restored only by the replay";
		await page.evaluate(
			({ requestId, stale }) => {
				const root = document.querySelector(`#transcript .entry[data-request-id="${requestId}"]`);
				root.querySelector(".permission-heading").textContent = stale;
				root.querySelector('.permission-row[data-fact="command"] .permission-value').textContent = stale;
				// The buttons too: a replay that is dropped leaves an ask nobody can answer, and the
				// next test in this file clicks one of these.
				root.querySelector(".permission-options").textContent = "";
			},
			{ requestId: benignAsk.requestId, stale: STALE },
		);
		// The stamp landed — otherwise a mistyped selector would make everything below vacuous.
		const stamped = (await asksOnScreen(page)).find((ask) => ask.requestId === benignAsk.requestId);
		assert.equal(stamped.facts.command, STALE, "the stamp did not take");
		assert.equal(stamped.heading, STALE, "the stamp did not take");
		assert.deepEqual(stamped.options, [], "the stamp did not take");

		assert.equal(await dropLiveSocket(page), 1, "there should have been exactly one live socket to drop");
		await waitForText(page, "#status", "connected", { timeout: 30_000 });
		// Attached, not visible: on a phone the whole fleet rail is off-screen while
		// a session is open, and `aria-current` is the page's own answer to "am I
		// attached right now" — set from `session_metadata`, cleared the instant the
		// socket closes.
		await page
			.locator(`#fleet [aria-current="true"][data-session-id="${sessionId}"]`)
			.waitFor({ state: "attached", timeout: 30_000 });

		// The replay is a SEND, not a state transition: the ask is still pending,
		// so it must still be on screen — once — and still answerable.
		const replayed = await until(
			async () => {
				const asks = await asksOnScreen(page);
				const mine = asks.filter((ask) => ask.requestId === benignAsk.requestId);
				// Consumed, not merely survived: the stamped fields are the frame's own values
				// again, and the buttons the stamp removed are back.
				const restored =
					mine.length === 1 &&
					mine[0].options.length === 2 &&
					mine[0].facts.command === benignCommand &&
					mine[0].heading === benignAsk.heading;
				return restored ? { asks, ask: mine[0] } : null;
			},
			() =>
				`the replayed ask to be re-applied to the one element for ${benignAsk.requestId} ` +
				`(command back to ${JSON.stringify(benignCommand)}, heading back to ${JSON.stringify(benignAsk.heading)}, ` +
				`two buttons) rather than left holding ${JSON.stringify(STALE)}`,
			45_000,
		);
		assert.equal(replayed.asks.length, 1, `the reconnect duplicated the ask: ${JSON.stringify(replayed.asks)}`);
		assert.equal(replayed.ask.facts.command, benignCommand, "the replayed ask must still show what it gates");
		assert.equal(replayed.ask.heading, benignAsk.heading, "the replayed ask must be re-titled from the frame");
		assert.equal(replayed.ask.decision, null, "a replayed ask is still pending");
	});

	it("runs the tool when the approve button is clicked, and echoes who decided", async () => {
		await page.click(
			`#transcript .entry[data-request-id="${benignAsk.requestId}"] .permission-option[data-option-id="approve"]`,
		);

		// THE LOAD-BEARING ASSERTION. This file exists only because a button in a
		// browser was clicked: the answer crossed a WebSocket, the attach bridge,
		// the session's own socket, and the frozen offered set, and released a tool
		// call the agent was blocked on.
		await until(() => existsSync(marker), "the approved tool call to write its marker file", 60_000);

		// R34-PERM.2's echo, reaching the browser: a viewer must be able to see that
		// the ask was answered, and where.
		const resolved = await waitForResolved(page, benignAsk.requestId);
		assert.equal(resolved.decision, "approved");
		assert.match(resolved.outcome, /approved/);
		assert.match(resolved.outcome, /attach/, `the resolution must name the deciding surface: ${resolved.outcome}`);
		// Answered means answered: the controls are gone, not merely greyed.
		assert.deepEqual(resolved.options, [], "a settled ask must offer no second answer");
	});

	/**
	 * R34-PERM.4 in the one place it is finally visible to a human.
	 *
	 * The neutralization itself happens where the frame is CONSTRUCTED, not here —
	 * this asserts what reached the DOM, which is the only statement that covers
	 * the whole path including the bundle's own rendering.
	 */
	it("renders a hostile command with no control and no bidi code point, and keeps the decisive tail", async () => {
		hostileAsk = await waitForNewAsk(page, seen);
		seen.add(hostileAsk.requestId);

		const shown = hostileAsk.facts.command;
		assert.ok(typeof shown === "string" && shown.length > 0, "the hostile ask showed no command at all");

		// Nothing an ANSI parser or a bidi algorithm can act on survived the wire.
		assert.equal(C0_AND_DEL.test(hostileAsk.text), false, "a C0 control reached the DOM");
		assert.equal(BIDI_OVERRIDES.test(hostileAsk.text), false, "a bidi override reached the DOM");

		// Neutralized ONE FOR ONE, not deleted: dropping a control character welds
		// the two halves it separated into a command nobody wrote.
		assert.ok(shown.includes(ESC_PICTURE), `the ESC was not replaced by its glyph: ${JSON.stringify(shown.slice(0, 40))}`);
		assert.ok(shown.includes(REPLACEMENT_CHARACTER), "the bidi override was not replaced by a visible marker");

		// The end of the command is the part the decision is about, and ~5000
		// characters of padding must not be able to push it off the ask.
		assert.ok(
			shown.includes(HOSTILE_TAIL),
			`the decisive tail was elided away; the ask showed ${JSON.stringify(shown.slice(-120))}`,
		);
		assert.match(shown, /chars elided/, "an elided string must say that it was elided");

		// And the element still owns its own direction, so a right-to-left SCRIPT —
		// which no neutralization removes — cannot reorder the buttons under it.
		assert.equal(hostileAsk.dir, "ltr");

		// Answer it so the turn is not left parked when the suite tears down.
		await page.click(
			`#transcript .entry[data-request-id="${hostileAsk.requestId}"] .permission-option[data-option-id="deny"]`,
		);
		const denied = await waitForResolved(page, hostileAsk.requestId);
		assert.equal(denied.decision, "denied");
	});

	it("did all of that with no console or page errors", async () => {
		assert.deepEqual(errors, []);
	});
});
