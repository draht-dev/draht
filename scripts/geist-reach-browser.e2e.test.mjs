/**
 * The phone journey, end to end, over TLS (R33-REACH.4, R33-REACH.9, R33-REACH.10).
 *
 * Deliberately a **separate file** from `scripts/geist-console-bundle.e2e.test.mjs`.
 * That suite is the Phase 32 proof and stays on plaintext `http://127.0.0.1` — it
 * is what says the bundle works when nothing is in front of it. This one asks a
 * different question: does the same bundle complete the whole product sentence
 * when it is reached the way a phone reaches it — through a TLS front end, on a
 * touch device, from a link a human scanned?
 *
 * Four real processes, none of them imported into this file:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) with
 *     `--attachable` against the in-repo keyless stub provider, so it publishes a
 *     real `<id>.sock` and answers real prompts with real streamed text;
 *   • the emitted gateway binary — whatever `packages/gateway/package.json`
 *     names as its `draht-gateway` bin, spawned as that bin, on an ephemeral
 *     loopback port, serving the bundle at `/ui` and pairing out of the store
 *     at `GEIST_DEVICES_PATH`;
 *   • `scripts/fixtures/tls-proxy.mjs` in front of it, terminating TLS the way
 *     `tailscale serve` does, so the page is loaded from `https://` and the
 *     socket is a real `wss://` upgrade through a proxy hop;
 *   • the `geist` CLI, spawned as its own process, printing the deep link the
 *     browser then opens — the CLI's real stdout, not a URL this file assembled.
 *
 * ## The two acceptances
 *
 * 1. The journey: deep link → paired → session list → prompt → assistant text,
 *    then a reload that steers again with no re-pairing (R33-REACH.4/.10).
 * 2. The drop: with an answer still streaming, the TLS front end is SIGTERMed
 *    and the page has to say so, hold the transcript, come back on its own when
 *    the front end rebinds the same port, re-attach the same session, and cost
 *    the operator nothing — no scan, no paste, no token form (R33-REACH.9).
 *
 * The second is why {@link startProxy} exists as a function and why
 * {@link proxyPort} is claimed up front instead of being ephemeral: the fixture
 * has to die and come back at the same origin, because a page that is already
 * loaded cannot be told about a new one.
 *
 * ## Evidence class
 *
 * Class 3, with nothing held back. Every process in the journey is a shipped
 * entrypoint: the draht session is the emitted `draht` binary, the gateway is
 * the emitted `draht-gateway` bin (read out of its own `package.json`, not
 * spelled out here), the pairing link is a spawned CLI's stdout, the browser
 * speaks the public geist/0.2 protocol over the wire, and every assertion below
 * is a DOM assertion or a `localStorage` read against bytes that crossed TLS.
 *
 * This file used to carve `draht-gateway` out of that claim, because the bin
 * constructed no device store and passed no `devices` port to `startGateway`
 * and so could not pair a phone at all; a bespoke ~30-line host stood in for it.
 * The bin now builds its own `DeviceRegistry` (`createDeviceAuthenticator` in
 * `packages/gateway/src/cli.ts`) and hands `/attach` a *provider*, consulted per
 * connection — which is what lets `geist pair` write the store after the daemon
 * is already up, exactly as it does below. The stand-in is gone, and "the
 * emitted gateway binary paired a phone" is now a claim this test makes.
 *
 * The daemon's isolation is `GEIST_DEVICES_PATH` (and `DRAHT_CODING_AGENT_DIR`
 * for the socket directory): real flags and real environment variables of the
 * real bin, so nothing here is a test-only seam and no run touches `~/.draht`.
 *
 * ## Build state this suite depends on
 *
 * `packages/coding-agent/dist/cli.js`, produced by `npm run build` inside
 * `packages/coding-agent` (the `before` hook runs exactly that when the file is
 * missing). Not `npm run build:binary` — the two write different entrypoints and
 * have clobbered each other before, so the command that produced the artifact is
 * named here rather than assumed.
 *
 * The `geist` CLI is spawned with `bun`, not node, and that is not a shortcut:
 * `@draht/geist-core` publishes TypeScript source (`"main": "./src/index.ts"`),
 * so `packages/geist/dist/cli.js` under node cannot load its own dependency.
 * `bun packages/geist/src/cli.ts` is how this repo runs that CLI, exactly as
 * `packages/gateway`'s `bin` is a `.ts` entry run by bun.
 *
 * Run: node --test scripts/geist-reach-browser.e2e.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, MOBILE_CONTEXT, VIEWPORTS, waitForServer, waitForText } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");
const GEIST_CLI = join(REPO_ROOT, "packages/geist/src/cli.ts");
const TLS_PROXY = join(HERE, "fixtures/tls-proxy.mjs");

/**
 * The gateway entrypoint `packages/gateway/package.json` declares as its
 * `draht-gateway` bin, read from that manifest rather than spelled out here: the
 * whole point of this suite is that the thing under test is what the package
 * ships, so a bin that moved must move this spawn with it or fail loudly.
 */
const GATEWAY_PACKAGE_DIR = join(REPO_ROOT, "packages/gateway");
const GATEWAY_BIN = (() => {
	const manifest = JSON.parse(readFileSync(join(GATEWAY_PACKAGE_DIR, "package.json"), "utf8"));
	const declared = manifest.bin?.["draht-gateway"];
	if (!declared) throw new Error("packages/gateway/package.json declares no `draht-gateway` bin");
	return join(GATEWAY_PACKAGE_DIR, declared);
})();

/** Where the bundle persists `{deviceId, credential}` (R33-REACH.9). */
const DEVICE_KEY = "geist.console.device";

/**
 * The daemon's shared operator token — what `--auth` sets. The console never
 * presents it; it exists because every route that is not `/attach` still sits
 * behind the bearer middleware.
 */
const OPERATOR_TOKEN = "aGVsbG8+d29ybGQ/Cg==";

/**
 * How long a bootstrap token minted by `geist pair` stays spendable here.
 *
 * The registry's default is two minutes and a cold browser launch plus a build
 * check can outlast that, so the suite passes `--ttl` — a real flag of the real
 * command, not a test-only seam.
 */
const BOOTSTRAP_TTL_SECONDS = 3600;

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

/**
 * Poll until `probe` returns something truthy. Every wait in this file goes
 * through here or through an explicit Playwright timeout: a suite that hangs
 * tells you less than one that fails.
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

/**
 * The emitted gateway's own "I am listening" record, or null until it lands.
 *
 * `packages/gateway/src/cli.ts` reports its bind through the structured logger
 * (`startupLogForServer`), one newline-delimited JSON object per record on
 * stderr — so what is exposed is read out of the shipped binary's operator log
 * rather than out of a line written for this suite's benefit. Lines that are not
 * JSON, or are some other record, are skipped rather than thrown on: bun prints
 * its own diagnostics on the same stream.
 */
function listeningRecord(stderr) {
	for (const line of stderr.split("\n")) {
		if (!line.startsWith("{")) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.message === "draht-gateway listening") return record;
	}
	return null;
}

function sockets(socketDir) {
	try {
		return readdirSync(socketDir).filter((entry) => entry.endsWith(".sock"));
	} catch {
		return [];
	}
}

/**
 * One HTTPS GET against the fixture, trusting only the CA it generated.
 *
 * `ca` rather than `rejectUnauthorized: false`: the readiness probe must fail if
 * something other than this proxy answered the port.
 *
 * No `servername`: node refuses to put an IP in SNI, and the fixture's cert
 * carries `IP:127.0.0.1` in its SAN precisely so none is needed.
 */
function httpsGet(url, ca, timeoutMs = 5_000) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { ca, timeout: timeoutMs }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode));
		});
		request.on("timeout", () => request.destroy(new Error(`timed out after ${timeoutMs}ms`)));
		request.on("error", reject);
	});
}

let harness;
/** `https://127.0.0.1:<port>` — the TLS front end, the only origin the browser ever sees. */
let tlsOrigin;
/**
 * The front end's loopback port, claimed once and reused by every start.
 *
 * Fixed rather than ephemeral because {@link startProxy} is called more than
 * once: the resilience test kills the front end mid-session and brings it back,
 * and a page that has already been loaded cannot be told about a new port. The
 * fixture takes `--port` for exactly this.
 */
let proxyPort;
/** `http://127.0.0.1:<gateway port>` — what the front end forwards to. */
let backendOrigin;
/** The live TLS fixture, or null between a SIGTERM and the next start. */
let proxy = null;
/** The PEM the fixture generated for itself. */
let proxyCa;
/**
 * Where `geist pair` and the emitted gateway meet: one device store, two
 * shipped processes, both pointed at it by `GEIST_DEVICES_PATH`.
 */
let devicesPath;
let sessionId;
let sessionCwd;
let daemonStderr;
let drahtStderr;
let proxyStderr;

/**
 * Start the TLS front end on {@link proxyPort} and wait until it answers.
 *
 * Called by `before` and again by the resilience test, which is why it is a
 * function rather than eight lines inside the hook: "the same port rebinds" is
 * the property being tested, so the second start has to be the *same* start.
 *
 * A fresh self-signed cert is generated on every start — the fixture does that
 * per run — so {@link proxyCa} is re-read here. The browser never re-reads it:
 * pages in this suite run with `ignoreHTTPSErrors`, so a rotated cert is not
 * something the reconnect has to survive. Node's readiness probe is the one
 * client that pins the CA, and it must pin the current one.
 */
async function startProxy() {
	const stdout = { text: "" };
	proxyStderr = { text: "" };
	const child = track(
		spawn("node", [TLS_PROXY, "--target", backendOrigin, "--port", String(proxyPort)], {
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	collect(child.stdout, stdout);
	collect(child.stderr, proxyStderr);
	await until(
		() => /LISTENING (\S+)/.test(stdout.text),
		() => `the TLS fixture to bind :${proxyPort} (stdout: ${stdout.text}, stderr: ${proxyStderr.text})`,
		20_000,
	);
	proxyCa = readFileSync(stdout.text.match(/^CA (.+)$/m)[1]);
	const listening = stdout.text.match(/LISTENING (\S+)/)[1];
	if (tlsOrigin && listening !== tlsOrigin) {
		throw new Error(`the fixture rebound a different origin: ${listening} (was ${tlsOrigin})`);
	}
	tlsOrigin = listening;

	let lastProbeError;
	await until(
		async () =>
			(await httpsGet(`${tlsOrigin}/health`, proxyCa).catch((error) => {
				lastProbeError = error;
				return null;
			})) !== null,
		() => `the TLS fixture to answer ${tlsOrigin}/health (last error: ${lastProbeError}, stderr: ${proxyStderr.text})`,
		20_000,
	);
	proxy = child;
	return child;
}

/**
 * SIGTERM the front end and do not return until the process is gone *and* the
 * port refuses connections.
 *
 * Both halves matter. A test that killed the proxy and immediately asserted a
 * disconnected UI could be reading a state the browser reached for some other
 * reason; waiting until an HTTPS probe is refused makes "the transport is dead"
 * an observation rather than an assumption. The exit wait is bounded because a
 * fixture that ignored the signal would otherwise hang the suite.
 */
async function stopProxy() {
	const child = proxy;
	proxy = null;
	if (!child) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	let timer;
	try {
		await Promise.race([
			exited,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("the TLS fixture did not exit within 10s of SIGTERM")), 10_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	await until(
		async () => {
			try {
				await httpsGet(`${tlsOrigin}/health`, proxyCa, 1_000);
				return false;
			} catch {
				return true;
			}
		},
		() => `${tlsOrigin} to stop answering after the fixture exited`,
		10_000,
	);
}

/**
 * Run the real `geist pair` and return what it printed.
 *
 * The link is *found* in stdout rather than rebuilt from a token, so a CLI that
 * changed its URL shape — a query string, a different path, a lost fragment —
 * breaks this suite at the browser rather than passing a reconstruction.
 */
function runGeistPair() {
	const result = spawnSync("bun", [GEIST_CLI, "pair", "--origin", tlsOrigin, "--ttl", String(BOOTSTRAP_TTL_SECONDS)], {
		cwd: REPO_ROOT,
		env: { ...process.env, GEIST_DEVICES_PATH: devicesPath },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.status !== 0) {
		throw new Error(`geist pair exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
	}
	const link = result.stdout.split("\n").find((line) => line.trim().startsWith("https://"));
	if (!link) throw new Error(`geist pair printed no deep link:\n${result.stdout}`);
	return { link: link.trim(), stderr: result.stderr };
}

/**
 * Record every WebSocket the page constructs and every frame it sends.
 *
 * Installed on the *context*, so it survives the reload the journey ends with —
 * and is re-installed by that reload, which is what makes "the reconnect sent no
 * `pair_device`" an assertion about the post-reload page alone.
 */
function traceSockets(context) {
	return context.addInitScript(() => {
		window.__sockets = [];
		const Native = window.WebSocket;
		window.WebSocket = new Proxy(Native, {
			construct(target, args) {
				const record = { url: args[0], protocols: args[1] ?? null, sent: [] };
				window.__sockets.push(record);
				const socket = new target(...args);
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

/** The frame types the page has sent, socket by socket, with the URL each was opened on. */
function sentTypes(page) {
	return page.evaluate(() =>
		window.__sockets.map((record) => ({
			url: record.url,
			protocols: record.protocols,
			types: record.sent.map((text) => JSON.parse(text).type),
		})),
	);
}

/** Every frame the page has sent, socket by socket, parsed. */
function sentFrames(page) {
	return page.evaluate(() =>
		window.__sockets.map((record) => ({
			url: record.url,
			frames: record.sent.map((text) => JSON.parse(text)),
		})),
	);
}

/**
 * Record every state `#status` passes through, and every moment `#token-form`
 * becomes visible.
 *
 * A polled DOM read cannot prove "the page said disconnected": the backoff
 * window it says it in is 500ms on the first attempt, and a poll that lands
 * either side of one sees `connecting…` and concludes nothing happened. So the
 * page records its own transitions, with wall-clock timestamps this file can
 * compare against the instant it sent the signal.
 *
 * The token-form half is the negative: the whole claim of R33-REACH.9 is that a
 * transport death costs the operator *nothing*, and a credential prompt that
 * flashed for 200ms and went away would be a re-entry this suite otherwise
 * could not see.
 */
function traceStatus(context) {
	return context.addInitScript(() => {
		window.__statusLog = [];
		window.__tokenFormShown = [];
		const install = () => {
			const status = document.getElementById("status");
			const tokenForm = document.getElementById("token-form");
			if (!status || !tokenForm) return false;
			const noteStatus = () => {
				const entry = { at: Date.now(), text: status.textContent, state: status.dataset.state };
				const last = window.__statusLog.at(-1);
				if (last && last.text === entry.text && last.state === entry.state) return;
				window.__statusLog.push(entry);
			};
			noteStatus();
			new MutationObserver(noteStatus).observe(status, {
				attributes: true,
				childList: true,
				characterData: true,
				subtree: true,
			});
			const noteForm = () => {
				if (!tokenForm.hidden) window.__tokenFormShown.push({ at: Date.now() });
			};
			noteForm();
			new MutationObserver(noteForm).observe(tokenForm, { attributes: true, attributeFilter: ["hidden"] });
			return true;
		};
		// The init script runs before the document exists; `console.js` is a module
		// and therefore runs just before DOMContentLoaded, so this is installed
		// after the elements are parsed and before any status the page sets itself.
		if (!install()) document.addEventListener("DOMContentLoaded", install, { once: true });
	});
}

/** The `{deviceId, credential}` this browser has persisted, or null. */
function storedDevice(page) {
	return page.evaluate((storageKey) => {
		const raw = localStorage.getItem(storageKey);
		return raw === null ? null : JSON.parse(raw);
	}, DEVICE_KEY);
}

before(async () => {
	if (!existsSync(DRAHT_CLI)) {
		const build = spawnSync("npm", ["run", "build"], {
			cwd: join(REPO_ROOT, "packages/coding-agent"),
			encoding: "utf8",
			timeout: 900_000,
		});
		if (build.status !== 0) throw new Error(`draht build failed:\n${build.stderr}`);
	}

	const agentDir = tempDir("grb-agent-");
	const home = tempDir("grb-home-");
	sessionCwd = realpathSync(tempDir("grb-cwd-"));

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

	const socketDir = join(agentDir, "sockets");
	const socketFile = await until(
		() => sockets(socketDir)[0],
		() => `draht to publish its socket (stderr: ${drahtStderr.text})`,
	);
	sessionId = socketFile.slice(0, -".sock".length);

	devicesPath = join(tempDir("grb-devices-"), "devices.json");

	const gatewayPort = await freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemon = track(
		spawn("bun", [GATEWAY_BIN, "--port", String(gatewayPort), "--host", "127.0.0.1", "--auth", OPERATOR_TOKEN], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HOME: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				GEIST_DEVICES_PATH: devicesPath,
			},
			stdio: ["ignore", "ignore", "pipe"],
		}),
	);
	collect(daemon.stderr, daemonStderr);
	const listening = await until(
		() => listeningRecord(daemonStderr.text),
		() => `the daemon to report a bound port (stderr: ${daemonStderr.text})`,
	);
	// The daemon behind the front end is on loopback, which is the whole reason
	// there is a front end (GSEC-04 bind half). Read out of the bin's own
	// structured startup record rather than a line this suite asked it to print.
	assert.equal(listening.host, "127.0.0.1", daemonStderr.text);
	assert.equal(listening.port, gatewayPort, daemonStderr.text);
	await waitForServer(`http://127.0.0.1:${gatewayPort}/health`);

	backendOrigin = `http://127.0.0.1:${gatewayPort}`;
	proxyPort = await freeLoopbackPort();
	await startProxy();

	harness = await launchHeadlessBrowser();
}, { timeout: 900_000 });

after(async () => {
	await harness?.close();
	for (const child of children) child.kill("SIGKILL");
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test(
	"on a mobile-emulated context the journey deep-link → paired → session list → prompt → assistant text completes, then a reload steers again with no re-pairing",
	{ timeout: 240_000 },
	async () => {
		// The emulation contract this suite runs under, asserted before a browser
		// is spent on it — a "mobile" run that is only a narrow window is the
		// failure mode this file exists to close.
		assert.ok(MOBILE_CONTEXT, "browser-harness.mjs must export MOBILE_CONTEXT");
		assert.equal(MOBILE_CONTEXT.isMobile, true, "MOBILE_CONTEXT must emulate a mobile device, not just a viewport");
		assert.equal(MOBILE_CONTEXT.hasTouch, true, "a phone has touch");
		assert.equal(MOBILE_CONTEXT.deviceScaleFactor, 3, "a modern phone renders at 3x");
		assert.match(MOBILE_CONTEXT.userAgent, /Mobile/, "MOBILE_CONTEXT must carry a mobile user agent");

		const { page, context, errors, close } = await harness.newPage(VIEWPORTS.mobile, {
			...MOBILE_CONTEXT,
			// The fixture generates its own cert on every start; a browser cannot be
			// handed a per-connection CA, so the trust decision is made here.
			ignoreHTTPSErrors: true,
		});

		/** Every URL this page asked the network for — the "no credential in a URL" half of R33-REACH.4. */
		const requested = [];
		context.on("request", (request) => requested.push(request.url()));

		try {
			await traceSockets(context);

			// ── the deep link, printed by the real CLI ──────────────────────────
			const paired = runGeistPair();
			assert.match(
				paired.stderr,
				/--origin bypasses the live `tailscale serve` mapping/,
				"`geist pair --origin` must keep announcing that it bypassed the live mapping",
			);
			assert.equal(
				paired.link.startsWith(`${tlsOrigin}/ui#token=`),
				true,
				`geist pair printed a link this suite cannot use: ${paired.link}`,
			);
			assert.equal(paired.link.includes("?"), false, `the deep link carries a query string: ${paired.link}`);

			// ── deep-link → paired ─────────────────────────────────────────────
			await page.goto(paired.link, { timeout: 30_000 });
			await waitForText(page, "#status", "connected", { timeout: 30_000 });

			// The transport really is the one a phone gets: TLS in front, and a
			// `wss://` upgrade through the proxy hop rather than a same-origin `ws://`.
			assert.equal(await page.evaluate(() => location.protocol), "https:");
			const firstSockets = await sentTypes(page);
			assert.equal(firstSockets.length, 1, `expected one socket, got ${JSON.stringify(firstSockets)}`);
			assert.equal(
				firstSockets[0].url.startsWith(`wss://127.0.0.1:${new URL(tlsOrigin).port}/attach`),
				true,
				`the page did not open a wss:// socket: ${firstSockets[0].url}`,
			);
			assert.equal(firstSockets[0].protocols, null, "the credential must not ride on Sec-WebSocket-Protocol");
			assert.deepEqual(firstSockets[0].types.slice(0, 2), ["hello", "pair_device"]);

			// The device emulation took, and the layout viewport is still the 390x844
			// target — see MOBILE_CONTEXT's note on why 844 and not 664.
			const device = await page.evaluate(() => ({
				touchPoints: navigator.maxTouchPoints,
				dpr: window.devicePixelRatio,
				ua: navigator.userAgent,
				width: window.innerWidth,
				height: window.innerHeight,
				documentWidth: document.documentElement.scrollWidth,
			}));
			assert.ok(device.touchPoints > 0, `the context is not a touch device: maxTouchPoints=${device.touchPoints}`);
			assert.equal(device.dpr, 3, "deviceScaleFactor did not reach the page");
			assert.match(device.ua, /Mobile/, `the page sees a desktop UA: ${device.ua}`);
			assert.deepEqual(
				{ width: device.width, height: device.height },
				VIEWPORTS.mobile,
				"the layout viewport must stay 390x844",
			);
			assert.ok(device.documentWidth <= VIEWPORTS.mobile.width, `horizontal overflow: ${device.documentWidth}px`);

			// The bootstrap token never survives the first tick in the address bar.
			assert.equal(page.url(), `${tlsOrigin}/ui`, `the fragment outlived the first tick: ${page.url()}`);

			const device1 = await storedDevice(page);
			assert.ok(device1, `nothing was persisted under ${DEVICE_KEY}`);
			assert.match(device1.deviceId, /^dev_/);
			assert.ok(device1.credential.length > 0, "a stored credential with no credential in it");

			// ── session list ───────────────────────────────────────────────────
			const row = page.locator(`#fleet [data-session-id="${sessionId}"]`);
			await row.waitFor({ timeout: 30_000 });
			assert.match(await row.innerText(), new RegExp(sessionCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

			// ── prompt → assistant text ────────────────────────────────────────
			await page.tap(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd, { timeout: 20_000 });
			assert.equal(await page.getAttribute("body", "data-view"), "session");

			const first = "hello from the phone, before the reload";
			await page.fill("#prompt", first);
			await page.tap("#send");
			await waitForText(page, "#transcript", first, { timeout: 30_000 });
			await waitForText(page, "#transcript", `stub: ${first}`, { timeout: 45_000 });

			// ── reload, and steer again with no re-pairing ──────────────────────
			await page.reload({ timeout: 30_000 });
			await waitForText(page, "#status", "connected", { timeout: 30_000 });

			const afterReload = await sentTypes(page);
			assert.equal(
				afterReload.length,
				1,
				`the reloaded page opened ${afterReload.length} sockets: ${JSON.stringify(afterReload)}`,
			);
			assert.deepEqual(
				afterReload[0].types.slice(0, 2),
				["hello", "authenticate"],
				"a reloaded page must authenticate with the stored credential, not re-pair",
			);
			assert.equal(
				afterReload.some((record) => record.types.includes("pair_device")),
				false,
				"a reload must not re-pair — the bootstrap token is spent",
			);
			assert.equal(page.url(), `${tlsOrigin}/ui`, `a reload put something back in the address bar: ${page.url()}`);

			const device2 = await storedDevice(page);
			assert.equal(device2.deviceId, device1.deviceId, "rotation must not mint a second device");
			assert.notEqual(device2.credential, device1.credential, "the credential must rotate at every exchange");

			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 30_000 });
			await page.tap(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd, { timeout: 20_000 });

			const second = "steering again after the reload";
			await page.fill("#prompt", second);
			await page.tap("#send");
			await waitForText(page, "#transcript", `stub: ${second}`, { timeout: 45_000 });

			// ── the journey left nothing behind ────────────────────────────────
			// Everything a server, a proxy log or a `Referer` would see: origin,
			// path and query, with the fragment dropped because a fragment is never
			// sent — which is the entire reason `geist pair` puts the token there.
			// The three secrets are matched literally rather than by the word
			// "token", which `/ui/tokens.css` would otherwise trip.
			const secrets = [
				new URL(paired.link).hash.replace(/^#token=/, ""),
				device1.credential,
				device2.credential,
				device1.deviceId,
			];
			const leaked = requested.filter((url) => {
				const sent = (() => {
					const parsed = new URL(url);
					return `${parsed.origin}${parsed.pathname}${parsed.search}`;
				})();
				return /[?&]token=/i.test(sent) || secrets.some((secret) => sent.includes(secret));
			});
			assert.deepEqual(leaked, [], `a credential reached a URL: ${leaked.join(", ")}`);
			assert.deepEqual(errors, [], "the phone journey must produce zero console or page errors");
		} finally {
			await close();
		}
	},
);

/**
 * The bundle's own reconnect ceiling (`packages/geist-console/bundle/console.js`,
 * `MAX_RETRIES`). Mirrored rather than imported — the bundle is served bytes, not
 * a module this file can load — and used only as the *upper* bound on socket
 * constructions, so a drift towards a smaller ceiling cannot make the bound pass
 * vacuously.
 */
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * How long after the SIGTERM the page has to be *saying* it is disconnected.
 *
 * The first backoff window opens the moment the socket closes, so the honest
 * bound is milliseconds; 10s leaves room for a loaded CI box while still failing
 * a page that only admits the truth after exhausting its retries (~27.5s of
 * backoff) or never.
 */
const DISCONNECT_VISIBLE_WITHIN_MS = 10_000;

/**
 * Wait until a locator's text has stopped changing for `quietMs`.
 *
 * Used to tell "the stub is still streaming" from "the turn is over" without
 * knowing how much of a turn survived a transport death — which is the one thing
 * this test deliberately does not control.
 */
function settledText(locator, quietMs, timeoutMs, what) {
	let last = null;
	let since = Date.now();
	return until(
		async () => {
			const text = await locator.innerText().catch(() => "");
			if (text !== last) {
				last = text;
				since = Date.now();
				return null;
			}
			return Date.now() - since >= quietMs ? { text } : null;
		},
		what,
		timeoutMs,
	);
}

test(
	"killing the TLS proxy mid-session shows an explicit disconnected state, and restarting it reconnects, re-attaches the same session and leaves the pre-drop transcript on screen — with no credential re-entry",
	{ timeout: 300_000 },
	async () => {
		const { page, context, errors, close } = await harness.newPage(VIEWPORTS.mobile, {
			...MOBILE_CONTEXT,
			ignoreHTTPSErrors: true,
		});

		try {
			await traceSockets(context);
			await traceStatus(context);

			// ── paired, attached, and a prompt in flight ────────────────────────
			const paired = runGeistPair();
			await page.goto(paired.link, { timeout: 30_000 });
			// The attribute, never the text: "connected" is a substring of
			// "disconnected", so a text match here would greet the very state this
			// test exists to distinguish.
			await page.waitForSelector('#status[data-state="connected"]', { timeout: 30_000 });

			const device1 = await storedDevice(page);
			assert.ok(device1, `nothing was persisted under ${DEVICE_KEY}`);

			await page.locator(`#fleet [data-session-id="${sessionId}"]`).waitFor({ timeout: 30_000 });
			await page.tap(`#fleet [data-session-id="${sessionId}"]`);
			await waitForText(page, "#session-cwd", sessionCwd, { timeout: 20_000 });

			// Long on purpose. The stub streams one character per token at 60 tokens
			// per second, so this answer takes about four seconds to arrive and the
			// front end can be killed while it is still arriving — which is the
			// scenario, and the reason the reply is not a short greeting.
			const prompt = `steering from the phone while the front end is about to die ${"·pad".repeat(50)}`;
			const fullReply = `stub: ${prompt}`;
			await page.fill("#prompt", prompt);
			await page.tap("#send");
			await waitForText(page, "#transcript", prompt, { timeout: 30_000 });

			const agentBubble = page.locator('#transcript .entry[data-kind="agent"]').last();
			await until(
				async () => (await agentBubble.innerText().catch(() => "")).length >= 24,
				"the stub's answer to start streaming into the transcript",
				45_000,
			);

			// ── the front end dies ──────────────────────────────────────────────
			const killedAt = Date.now();
			await stopProxy();

			// Output stops the instant the socket does, so whatever is on screen now
			// *is* the pre-drop transcript. That it is a strict prefix of the answer
			// is what makes this a mid-stream kill rather than a kill after the turn.
			const frozen = (await agentBubble.innerText()).trim();
			assert.ok(frozen.length > 0, "nothing had streamed before the drop — there is no mid-session to interrupt");
			assert.ok(
				fullReply.startsWith(frozen),
				`the pre-drop text is not a prefix of the stub's answer: ${JSON.stringify(frozen)}`,
			);
			assert.ok(
				frozen.length < fullReply.length,
				`the turn had already finished when the proxy died (${frozen.length} of ${fullReply.length} chars)`,
			);

			// ── an explicit disconnected state, said out loud ───────────────────
			await page.waitForSelector('#status[data-state="disconnected"]', { timeout: DISCONNECT_VISIBLE_WITHIN_MS });
			const drop = await until(
				async () => {
					const log = await page.evaluate(() => window.__statusLog);
					return log.find((entry) => entry.state === "disconnected" && entry.at >= killedAt) ?? null;
				},
				() => "the page to record an explicit disconnected state",
				DISCONNECT_VISIBLE_WITHIN_MS,
			);
			assert.match(drop.text, /^disconnected\b/, `the disconnected state does not say so: ${JSON.stringify(drop.text)}`);
			assert.match(drop.text, /reconnecting/, `the page did not say it was retrying: ${JSON.stringify(drop.text)}`);
			assert.ok(
				drop.at - killedAt <= DISCONNECT_VISIBLE_WITHIN_MS,
				`the page took ${drop.at - killedAt}ms to admit the transport was gone`,
			);

			// A dead transport is not a dead conversation: the transcript rendered
			// before the drop stays on screen, and the operator stays in the session.
			const duringGap = await page.locator("#transcript").innerText();
			assert.ok(duringGap.includes(prompt), "the prompt vanished from the transcript when the transport died");
			assert.ok(duringGap.includes(frozen), "the streamed answer vanished from the transcript when the transport died");
			assert.equal(
				await page.getAttribute("body", "data-view"),
				"session",
				"a dead transport must not throw the operator back to the fleet",
			);
			assert.equal(await page.locator("#token-form").isHidden(), true, "the drop revealed a credential prompt");

			// The credential survived because of *where* it lives. sessionStorage is
			// scoped to the tab's lifetime and would survive this gap too, so the
			// assertion that distinguishes them is that nothing is in it at all.
			const storage = await page.evaluate(
				(key) => ({
					local: localStorage.getItem(key),
					session: sessionStorage.getItem(key),
					sessionKeys: Object.keys(sessionStorage),
				}),
				DEVICE_KEY,
			);
			assert.ok(storage.local, "the stored credential did not survive the drop");
			assert.equal(storage.session, null, "the credential is in sessionStorage, which a restarted app would lose");
			assert.deepEqual(storage.sessionKeys, [], "the bundle put something in sessionStorage");

			// ── the front end comes back on the same port ───────────────────────
			await startProxy();

			await page.waitForSelector('#status[data-state="connected"]', { timeout: 60_000 });
			const reconnectedAt = Date.now();

			// It reconnected inside its budget rather than giving up and asking to be
			// reloaded — the one other thing `closed()` can do.
			const gap = (await page.evaluate(() => window.__statusLog)).filter(
				(entry) => entry.at >= killedAt && entry.at <= reconnectedAt,
			);
			assert.equal(
				gap.some((entry) => /reload to reconnect/.test(entry.text)),
				false,
				`the page exhausted its retry budget before the front end returned: ${JSON.stringify(gap)}`,
			);

			// ── it re-attached the same session, by itself ──────────────────────
			const records = await sentFrames(page);
			const expectedSocketUrl = `wss://127.0.0.1:${proxyPort}/attach`;
			for (const record of records) {
				assert.equal(
					record.url,
					expectedSocketUrl,
					`a socket was opened somewhere other than the front end: ${record.url}`,
				);
			}
			assert.deepEqual(
				records[0].frames.map((frame) => frame.type).slice(0, 2),
				["hello", "pair_device"],
				"the first socket is the pairing one",
			);
			const last = records.at(-1);
			assert.deepEqual(
				last.frames.map((frame) => frame.type).slice(0, 3),
				["hello", "authenticate", "attach"],
				`the reconnect did not authenticate and re-attach on its own: ${JSON.stringify(last.frames.map((f) => f.type))}`,
			);
			assert.equal(
				last.frames.find((frame) => frame.type === "attach").sessionId,
				sessionId,
				"the reconnect attached a different session",
			);
			assert.equal(
				records.slice(1).some((record) => record.frames.some((frame) => frame.type === "pair_device")),
				false,
				"a reconnect re-paired — the bootstrap token is spent and the operator would have had to scan again",
			);

			// Bounded on both sides. Below: the reconnect is a *new* socket, so a
			// count that never moved would mean the old one was somehow still alive
			// and nothing here was tested. Above: a page that reconnects by hammering
			// is not a page that reconnects — one pairing socket plus at most the
			// bundle's own ceiling.
			assert.ok(records.length >= 2, "the drop opened no new socket — the transport did not actually die");
			assert.ok(
				records.length <= 1 + MAX_RECONNECT_ATTEMPTS,
				`the page opened ${records.length} sockets across one drop`,
			);
			// And it stopped: the count is still the same a moment later.
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			const settledRecords = await sentFrames(page);
			assert.equal(
				settledRecords.length,
				records.length,
				`the page kept opening sockets after it reconnected (${records.length} → ${settledRecords.length})`,
			);

			const device2 = await storedDevice(page);
			assert.equal(device2.deviceId, device1.deviceId, "the reconnect minted a second device");
			assert.notEqual(device2.credential, device1.credential, "the credential must rotate at every exchange");

			await waitForText(page, "#session-cwd", sessionCwd, { timeout: 20_000 });
			assert.match(await page.locator("#session-meta").innerText(), new RegExp(sessionId));
			assert.equal(
				await page.getAttribute(`#fleet [data-session-id="${sessionId}"]`, "aria-current"),
				"true",
				"the re-attached session is not marked current in the fleet",
			);

			// ── and the transcript from before the drop is still there ──────────
			const afterReconnect = await page.locator("#transcript").innerText();
			assert.ok(afterReconnect.includes(prompt), "the reconnect lost the prompt");
			assert.ok(afterReconnect.includes(frozen), "the reconnect cleared the text that had streamed before the drop");

			// ── steerable again, with nothing re-entered ────────────────────────
			await settledText(agentBubble, 1_000, 60_000, "the interrupted turn to finish arriving");
			const second = "steering again after the front end came back";
			await page.fill("#prompt", second);
			await page.tap("#send");
			await waitForText(page, "#transcript", `stub: ${second}`, { timeout: 60_000 });

			// This is what makes the pre-drop prefix assertion mean something. An
			// *uninterrupted* turn renders the answer in full, so `frozen` being a
			// strictly shorter prefix of the first answer is a stream that was cut —
			// not a renderer that never shows the last characters of anything.
			assert.equal(
				(await page.locator('#transcript .entry[data-kind="agent"]').last().innerText()).trim(),
				`stub: ${second}`,
				"an uninterrupted turn did not render the whole answer",
			);

			const finalTranscript = await page.locator("#transcript").innerText();
			assert.ok(finalTranscript.includes(frozen), "the second turn cleared the pre-drop transcript");

			assert.deepEqual(
				await page.evaluate(() => window.__tokenFormShown),
				[],
				"a credential prompt was revealed at some point during the drop",
			);

			// Chromium logs a console error for every refused `wss://` attempt while
			// the front end is down; those are the drop, not a defect. Anything else
			// is.
			const unexpected = errors.filter((text) => !/websocket|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED/i.test(text));
			assert.deepEqual(unexpected, [], `the drop produced errors that are not the drop: ${unexpected.join(", ")}`);
		} finally {
			// A test that fails between the kill and the restart must not leave the
			// front end down for whatever runs next.
			if (!proxy) await startProxy().catch(() => {});
			await close();
		}
	},
);
