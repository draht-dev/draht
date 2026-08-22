/**
 * The console tells the truth about what it can steer, and keeps up without
 * dropping its socket (R35-ALWAYS.7 renderer half, R35-ALWAYS.10 client half).
 *
 * Three real processes, none of them imported into this file (the shape is
 * `scripts/geist-console-bundle.e2e.test.mjs`'s; read that file's header for why
 * each one is spawned rather than constructed):
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) with
 *     `--attachable` against the keyless stub provider — one session live for the
 *     whole run, and three more started and killed mid-suite so the fleet really
 *     moves under a page that is already open;
 *   • a daemon on an ephemeral loopback port serving the bundle at `/ui`, spawned
 *     from a temp `bun` host because the shipped `draht-gateway` CLI still
 *     constructs no device store;
 *   • headless Chromium, through `scripts/browser-harness.mjs`.
 *
 * Every assertion is a DOM assertion against bytes the running daemon served.
 * Nothing here reads `packages/geist-console/bundle/` off disk to check what the
 * page "should" contain, and nothing constructs a bridge, an observer or a fleet
 * projection in-process.
 *
 * ## The claim, and why the DOM is where it has to be proved
 *
 * "No renderer may present a history session as steerable" is a statement about
 * what the UI OFFERS, not about what the wire carries. The wire has already said
 * `attachable:false, resumable:true` for a history row since `geist/0.4` — a
 * renderer that renders every row as a `<button>` bound to `attach` satisfies the
 * wire perfectly and still offers a human a dead session to type into. So the
 * load-bearing assertion here is a tag name: the live row IS a `<button>`, the
 * history row is NOT, and clicking the history row moves nothing.
 *
 * ## Why one page, and one order
 *
 * The delta stream is gated on `attach.capabilities` at the daemon
 * (`FLEET_DELTA_CAPABILITY` in `packages/geist-core/src/attach/attach-bridge.ts`),
 * so a connection is only fed `fleet_delta` once it has attached to a session —
 * and "without reconnecting" is a claim about ONE connection over time. A page
 * per test would open a fresh socket for each and prove nothing about the thing
 * under test. So {@link page} is opened once, in `before`, and the suites below
 * run in order against it: the fleet view first, then the attach, then three
 * fleet changes and a forced gap, with {@link socketCount} asserted at every step.
 *
 * ## Harness hygiene, each item paid for by a probe that passed while proving nothing
 *
 *  - `DRAHT_PERMISSION_MODE` is DELETED from every child env. This repo's
 *    interactive shell exports `auto`.
 *  - Every directory sits directly under /tmp with a short name: a Unix socket
 *    path over ~104 bytes fails to bind with EINVAL, and macOS `os.tmpdir()`
 *    already spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed.
 *
 * Run: node --test --test-concurrency=1 --test-timeout=300000 scripts/geist-console-fleet-honesty.e2e.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, VIEWPORTS, waitForServer } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");

/** The daemon's shared operator token. The console never presents it — see the sibling suite. */
const OPERATOR_TOKEN = "aGVsbG8+d29ybGQ/Cg==";
/** Bootstrap tokens minted at boot; each is single-use, so every pairing takes a fresh one. */
const BOOTSTRAP_COUNT = 8;

/**
 * The capability the renderer must declare to be fed `fleet_delta`.
 *
 * Written out rather than imported: this file drives the SERVED bundle, and the
 * point of asserting the string is that the bytes in the browser and the bytes
 * in the daemon agree on it. Importing the daemon's constant would make the
 * assertion tautological on one side.
 */
const FLEET_DELTA_CAPABILITY = "fleet-delta";

/* -------------------------------------------------------------- the daemon -- */

/**
 * A gateway with a device store, in its own process — verbatim in intent from
 * `scripts/geist-console-bundle.e2e.test.mjs`, whose header explains why the
 * shipped `draht-gateway` CLI cannot yet do this itself.
 *
 * `sessionsDir` is NOT passed: it resolves off `DRAHT_CODING_AGENT_DIR`, the
 * same env var the spawned draht sessions use, so the live half and the history
 * half of the fleet come from one throwaway directory and a developer's real
 * session store is never read by a test daemon.
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

/* ------------------------------------------------------------- the harness -- */

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

function socketNames(dir) {
	try {
		return readdirSync(dir).filter((entry) => entry.endsWith(".sock"));
	} catch {
		return [];
	}
}

/**
 * Write a session JSONL the daemon's history index will read.
 *
 * A session this machine RECORDED: one file whose first line is a session
 * header, in the store the daemon enumerates, with no `<id>.sock` + `.lock` pair
 * behind it. That absence IS the observable discriminator `origin: "history"` is
 * defined by — there is no marker in a header saying which build wrote it — so
 * this is the whole of what it takes to make a history row, and it is also the
 * only way to get one without waiting on a process to die.
 *
 * The slug is the binary's own bucket key. It is lossy and irreversible, which
 * is exactly why the index reads project identity out of the header's `cwd`.
 */
function recordSession(id, cwd) {
	const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	mkdirSync(join(sessionsDir, slug), { recursive: true });
	writeFileSync(
		join(sessionsDir, slug, `2026-08-22T09-00-00_${id}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date(Date.now() - 3_600_000).toISOString(),
			cwd,
		})}\n${JSON.stringify({ type: "message", role: "user", content: "an earlier conversation" })}\n`,
		"utf8",
	);
}

/** One authenticated read of a daemon route. The console never uses this path. */
async function daemonJson(path) {
	const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
	assert.equal(response.status, 200, `${path} should answer an operator token`);
	return await response.json();
}

/** The env every draht child runs under. `DRAHT_PERMISSION_MODE` is absent by construction. */
function drahtEnv(home, agentDir) {
	return {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: home,
		DRAHT_CODING_AGENT_DIR: agentDir,
		DRAHT_STUB_PROVIDER: "1",
		DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND: "60",
	};
}

/**
 * Start one attachable draht and wait for the socket it publishes.
 *
 * Returns `{ child, id, cwd }`. The id is read off the `<id>.sock` filename
 * rather than out of any log line, because that file IS what makes the session
 * a member of the fleet.
 */
async function startSession(label) {
	const cwd = realpathSync(tempDir(label));
	const before = new Set(socketNames(socketDir));
	const stderr = { text: "" };
	const child = track(
		spawn("node", [DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"], {
			cwd,
			env: drahtEnv(home, agentDir),
			stdio: ["pipe", "ignore", "pipe"],
		}),
	);
	collect(child.stderr, stderr);
	const name = await until(
		() => socketNames(socketDir).find((entry) => !before.has(entry)),
		() => `${label} to publish its socket (stderr: ${stderr.text})`,
	);
	return { child, cwd, id: name.slice(0, -".sock".length) };
}

/* --------------------------------------------------------------- the page -- */

/**
 * Record every WebSocket the page constructs and every frame it sends, and give
 * the suite a switch that SWALLOWS `fleet_delta` frames on the way in.
 *
 * The swallow is how the forced `seq` gap below is produced, and it is produced
 * at the transport rather than by patching the bundle on purpose: a phone that
 * slept through a delta loses exactly this — one frame that was sent, delivered
 * to a socket, and never seen by the application. Nothing else about the page is
 * touched, so the recovery under test is the recovery that ships.
 */
async function instrument(context) {
	await context.addInitScript(() => {
		window.__sockets = [];
		/** While true, `fleet_delta` frames are dropped before the page sees them. */
		window.__swallowFleetDeltas = false;
		/** How many have been dropped. */
		window.__swallowed = 0;
		const Native = window.WebSocket;
		window.WebSocket = new Proxy(Native, {
			construct(target, args) {
				const record = { url: args[0], sent: [], socket: null };
				window.__sockets.push(record);
				const socket = new target(...args);
				record.socket = socket;

				const nativeSend = socket.send.bind(socket);
				socket.send = (data) => {
					record.sent.push(String(data));
					nativeSend(data);
				};

				const nativeAdd = socket.addEventListener.bind(socket);
				socket.addEventListener = (type, listener, options) => {
					if (type !== "message") return nativeAdd(type, listener, options);
					return nativeAdd(
						type,
						(event) => {
							if (window.__swallowFleetDeltas) {
								try {
									if (JSON.parse(event.data)?.type === "fleet_delta") {
										window.__swallowed += 1;
										return;
									}
								} catch {
									// Not JSON: nothing this hook has an opinion about.
								}
							}
							listener(event);
						},
						options,
					);
				};
				return socket;
			},
		});
	});
}

/** How many WebSockets this page has ever constructed. One means it never reconnected. */
function socketCount(page) {
	return page.evaluate(() => window.__sockets.length);
}

/** Every frame the page has sent, flattened and parsed, in order. */
function sentFrames(page) {
	return page.evaluate(() =>
		window.__sockets.flatMap((record) =>
			record.sent.map((text) => {
				try {
					return JSON.parse(text);
				} catch {
					return { type: "<unparseable>" };
				}
			}),
		),
	);
}

/** One fleet row as the DOM holds it, or null. Works while the rail is off-screen. */
function rowShape(page, id) {
	return page.evaluate((sessionId) => {
		const row = document.querySelector(`#fleet [data-session-id="${sessionId}"]`);
		if (row === null) return null;
		return {
			tag: row.tagName,
			origin: row.dataset.origin ?? null,
			attachable: row.dataset.attachable ?? null,
			resumable: row.dataset.resumable ?? null,
			text: row.textContent ?? "",
		};
	}, id);
}

/** Every `data-session-id` currently in the list, in document order. */
function rowIds(page) {
	return page.evaluate(() =>
		[...document.querySelectorAll("#fleet [data-session-id]")].map((row) => row.dataset.sessionId),
	);
}

/* ----------------------------------------------------------------- state -- */

let harness;
let page;
let pageErrors;
let closePage;
let origin;
let agentDir;
let home;
let socketDir;
let sessionsDir;
let daemonStderr;
let bootstraps = [];

/** The session the console attaches to, live for the whole run. */
let live;
/** The recorded-but-not-running session, written as a header the daemon reads. */
let historyId;
let historyCwd;

before(async () => {
	if (!existsSync(DRAHT_CLI)) {
		const build = spawnSync("npm", ["run", "build"], {
			cwd: join(REPO_ROOT, "packages/coding-agent"),
			encoding: "utf8",
		});
		if (build.status !== 0) throw new Error(`draht build failed:\n${build.stderr}`);
	}

	agentDir = tempDir("gcf-agent-");
	home = tempDir("gcf-home-");
	socketDir = join(agentDir, "sockets");
	sessionsDir = join(agentDir, "sessions");

	live = await startSession("gcf-live-");

	// A session this machine RECORDED and is not running: one JSONL whose first
	// line is a session header, in the store the daemon enumerates. No socket, no
	// lock, no process — which is exactly the observable discriminator
	// `origin: "history"` is defined by, and the only way to obtain a history row
	// without waiting on a process to die.
	historyId = randomUUID();
	historyCwd = realpathSync(tempDir("gcf-past-"));
	recordSession(historyId, historyCwd);

	const hostDir = tempDir("gcf-host-");
	const hostFile = join(hostDir, "device-gateway.ts");
	writeFileSync(hostFile, DEVICE_HOST, "utf8");

	const port = await freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemonStdout = { text: "" };
	const daemonEnv = { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir };
	daemonEnv.DRAHT_PERMISSION_MODE = undefined;
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
	const opened = await harness.newPage(VIEWPORTS.desktop);
	page = opened.page;
	pageErrors = opened.errors;
	closePage = opened.close;
	await instrument(opened.context);
	await page.goto(`${origin}/ui#token=${encodeURIComponent(bootstraps.shift())}`);
	await page.locator(`#fleet [data-session-id="${live.id}"]`).waitFor({ timeout: 30_000 });
	await page.locator(`#fleet [data-session-id="${historyId}"]`).waitFor({ timeout: 30_000 });
}, { timeout: 300_000 });

after(async () => {
	await closePage?.();
	await harness?.close();
	for (const child of children) child.kill("SIGKILL");
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("a history row is not steerable (R35-ALWAYS.7)", () => {
	/**
	 * THE assertion of this file. A tag name, because that is what an offer is:
	 * `<button>` + a click handler is the console offering to steer a session,
	 * and no amount of grey text takes that offer back.
	 */
	it("renders the live session as a button and the recorded one as an inert element", async () => {
		const liveRow = await rowShape(page, live.id);
		const pastRow = await rowShape(page, historyId);

		assert.deepEqual(
			{ tag: liveRow.tag, origin: liveRow.origin, attachable: liveRow.attachable, resumable: liveRow.resumable },
			{ tag: "BUTTON", origin: "socket", attachable: "true", resumable: "false" },
		);
		assert.deepEqual(
			{ tag: pastRow.tag, origin: pastRow.origin, attachable: pastRow.attachable, resumable: pastRow.resumable },
			{ tag: "DIV", origin: "history", attachable: "false", resumable: "true" },
		);

		// Marked in WORDS, not merely in styling: a stylesheet that failed to load
		// must not turn an inert row into an inviting one.
		assert.match(pastRow.text, /history/i);
		assert.match(pastRow.text, /resumable/i);
		assert.equal(await page.locator(`#fleet [data-session-id="${historyId}"] button`).count(), 0);
	});

	/**
	 * The DOM's claim, against the daemon's own body for the same two rows. The
	 * page is not being trusted to describe the fleet correctly — the wire is,
	 * and this is where the two are made to agree.
	 */
	it("agrees with the fleet the daemon serves", async () => {
		const body = await daemonJson("/fleet");
		const served = new Map(body.sessions.map((session) => [session.id, session]));

		assert.deepEqual(
			{
				origin: served.get(live.id)?.origin,
				attachable: served.get(live.id)?.attachable,
				resumable: served.get(live.id)?.resumable,
			},
			{ origin: "socket", attachable: true, resumable: false },
		);
		assert.deepEqual(
			{
				origin: served.get(historyId)?.origin,
				attachable: served.get(historyId)?.attachable,
				resumable: served.get(historyId)?.resumable,
				pid: served.get(historyId)?.pid,
				status: served.get(historyId)?.status,
			},
			{ origin: "history", attachable: false, resumable: true, pid: undefined, status: "unknown" },
		);
	});

	/**
	 * `pid` became OPTIONAL in `geist/0.4`, and the row template that preceded
	 * this task was `` `pid ${session.pid} · …` `` — which prints `pid undefined`
	 * on every history row, forever, silently.
	 */
	it("never renders the word undefined", async () => {
		const text = await page.locator("#fleet").innerText();
		assert.ok(text.includes(historyCwd), `the recorded row should be on screen; got:\n${text}`);
		assert.equal(text.includes("undefined"), false, `a row rendered an absent field:\n${text}`);
	});

	/**
	 * The quad-state, said as itself (R35-ALWAYS.8). A history row is never
	 * probed — 945 of the 1,052 cwds in the real corpus no longer exist — so
	 * `unknown` is its honest status, and `unknown` rendered as `clean` is the
	 * one failure the four values exist to prevent.
	 */
	it("renders an unknown status as unknown, never as clean", async () => {
		const pastRow = await rowShape(page, historyId);
		assert.match(pastRow.text, /unknown/);
		assert.equal(/\bclean\b/.test(pastRow.text), false, `an unprobed row claimed a status:\n${pastRow.text}`);
	});

	it("does nothing when the recorded row is clicked", async () => {
		await page.click(`#fleet [data-session-id="${historyId}"]`);
		await new Promise((resolve) => setTimeout(resolve, 500));

		assert.equal(await page.evaluate(() => document.body.dataset.view), "fleet");
		const attaches = (await sentFrames(page)).filter((frame) => frame.type === "attach");
		assert.deepEqual(attaches, [], "clicking a history row must not send an attach");
	});
});

describe("the fleet stays current without reconnecting (R35-ALWAYS.10)", () => {
	it("declares fleet-delta when it attaches to the live session", async () => {
		await page.click(`#fleet [data-session-id="${live.id}"]`);
		await page.locator(`#fleet [aria-current="true"][data-session-id="${live.id}"]`).waitFor({ timeout: 30_000 });

		const attaches = (await sentFrames(page)).filter((frame) => frame.type === "attach");
		assert.equal(attaches.length, 1);
		assert.equal(attaches[0].sessionId, live.id);
		assert.ok(
			(attaches[0].capabilities ?? []).includes(FLEET_DELTA_CAPABILITY),
			`attach must declare ${FLEET_DELTA_CAPABILITY}; got ${JSON.stringify(attaches[0].capabilities)}`,
		);
		assert.equal(await socketCount(page), 1);
	});

	it("shows a session started after the page authenticated, on the same socket", async () => {
		const second = await startSession("gcf-second-");
		await page.locator(`#fleet [data-session-id="${second.id}"]`).waitFor({ timeout: 30_000 });

		const row = await rowShape(page, second.id);
		assert.deepEqual({ tag: row.tag, attachable: row.attachable }, { tag: "BUTTON", attachable: "true" });
		assert.equal(row.text.includes("undefined"), false);
		assert.equal(await socketCount(page), 1, "a new row must not have cost a reconnect");

		// Kept for the next test, which needs a row it can take away again.
		live.second = second;
	});

	it("removes a killed session's row, still on the same socket", async () => {
		const second = live.second;
		second.child.kill("SIGKILL");
		await page.locator(`#fleet [data-session-id="${second.id}"]`).waitFor({ state: "detached", timeout: 30_000 });

		assert.deepEqual(await rowShape(page, second.id), null);
		assert.ok((await rowIds(page)).includes(live.id), "the surviving session must still be listed");
		assert.equal(await socketCount(page), 1, "a removed row must not have cost a reconnect");
	});

	/**
	 * REPLACE, NEVER MERGE — the assertion the wire's own doc comment asks for.
	 *
	 * `appeared` and `changed` carry the whole session body precisely because a
	 * session can keep its id while everything about it changes: a resume reuses
	 * the id with a new pid and startedAt, and the inverse — a live session whose
	 * process ends while its recorded file remains — swaps `origin: "socket"` with
	 * a pid for `origin: "history"` with NONE, under the same key, in one tick.
	 *
	 * That is what is built here, deterministically: a live session is given a
	 * recorded file of its own, the daemon is made to fold that reading into its
	 * state, and only then is the process killed. The scan that reaps the socket
	 * therefore finds the history row for the same id in the same pass and emits
	 * `changed` rather than a disappear/appear pair — so a client that merged the
	 * body into the row it already held would keep the dead pid on screen and go
	 * on labelling a process that no longer exists as one you can steer.
	 */
	it("replaces a row wholesale when a live session ends — the dead pid does not survive", async () => {
		const ending = await startSession("gcf-ends-");
		await page.locator(`#fleet [data-session-id="${ending.id}"]`).waitFor({ timeout: 30_000 });
		const beforeKill = await rowShape(page, ending.id);
		assert.equal(beforeKill.attachable, "true");
		assert.match(beforeKill.text, /pid \d+/, "a live row states the pid it is talking to");

		recordSession(ending.id, ending.cwd);
		await until(
			async () => (await daemonJson("/history")).sessions.some((session) => session.id === ending.id),
			"the daemon's history index to see the recorded file",
		);
		// `GET /fleet` is the one caller that forces a fresh history reading. It is
		// awaited BEFORE the kill so the observer already holds the row that will
		// take the socket's place — which is what makes the transition one tick,
		// and therefore a `changed` rather than a pair a merge could not be caught by.
		await daemonJson("/fleet");

		ending.child.kill("SIGKILL");
		await until(
			async () => (await rowShape(page, ending.id))?.origin === "history",
			() => `the ended session to be re-described as history`,
		);

		const row = await rowShape(page, ending.id);
		assert.deepEqual(
			{ tag: row.tag, attachable: row.attachable, resumable: row.resumable },
			{ tag: "DIV", attachable: "false", resumable: "true" },
		);
		assert.equal(/pid \d/.test(row.text), false, `a merged row kept a dead pid:\n${row.text}`);
		assert.equal(row.text.includes("undefined"), false, `an absent field was rendered:\n${row.text}`);
		assert.equal(await socketCount(page), 1, "a replaced row must not have cost a reconnect");
	});

	/**
	 * A gap, and the recovery that is not a reload.
	 *
	 * One `fleet_delta` is dropped at the transport — what a phone that slept
	 * through one loses — so the next delta's `seq` is two past the last applied
	 * one. A renderer with no ordering would apply it and call the result current;
	 * this one refuses it, asks for a snapshot with `fleet_resync`, and converges
	 * ON THE SAME CONNECTION.
	 */
	it("recovers from a dropped delta with fleet_resync, not a reconnect", async () => {
		const resyncsBefore = (await sentFrames(page)).filter((frame) => frame.type === "fleet_resync").length;

		await page.evaluate(() => {
			window.__swallowFleetDeltas = true;
		});
		const third = await startSession("gcf-third-");
		await until(
			() => page.evaluate(() => window.__swallowed > 0),
			() => "the page to lose a fleet_delta",
		);
		await page.evaluate(() => {
			window.__swallowFleetDeltas = false;
		});

		// The fleet moves again. Whatever the page missed, the frame that follows
		// cannot be applied against what it holds.
		third.child.kill("SIGKILL");

		await until(
			async () => (await sentFrames(page)).some((frame) => frame.type === "fleet_resync"),
			() => "the page to send fleet_resync",
		);
		await page.locator(`#fleet [data-session-id="${third.id}"]`).waitFor({ state: "detached", timeout: 30_000 });

		const ids = await rowIds(page);
		assert.ok(ids.includes(live.id), `the live session must survive a resync; got ${JSON.stringify(ids)}`);
		assert.ok(ids.includes(historyId), `the recorded session must survive a resync; got ${JSON.stringify(ids)}`);
		assert.ok(
			(await sentFrames(page)).filter((frame) => frame.type === "fleet_resync").length > resyncsBefore,
			"the gap must have driven a fleet_resync",
		);
		assert.equal(await socketCount(page), 1, "a resync must not have cost a reconnect");
		assert.equal(
			await page.evaluate(() => window.__sockets[0].socket.readyState === WebSocket.OPEN),
			true,
			"the one connection must still be open",
		);
	});

	it("left no console error behind", () => {
		assert.deepEqual(pageErrors, []);
	});
});
