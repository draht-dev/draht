/**
 * The phone starts a session: pick a project, pick a harness, and the page is
 * attached to it (R36-SPAWN.1, R36-SPAWN.8 — the Phase 36 Goal sentence).
 *
 * Real processes, none of them imported into this file (the shape is
 * `scripts/geist-console-fleet-honesty.e2e.test.mjs`'s):
 *
 *   • the emitted gateway, `bun packages/gateway/src/cli.ts --registry <path>`,
 *     pairing out of a device store at `GEIST_DEVICES_PATH`; the pairing token
 *     is minted by the real `geist pair`;
 *   • the emitted draht (`packages/coding-agent/dist/cli.js`), which the daemon
 *     itself spawns against the keyless stub provider and which outlives it;
 *   • headless Chromium on a touch-enabled 390x844 context.
 *
 * ## The load-bearing assertion
 *
 * The id the page attached to is in `GET /fleet`, fetched outside the browser
 * with the operator token, with a pid that `ps` shows alive, not a zombie, in its
 * own process group and parented by the daemon. A page that had attached to
 * something it made up would not survive that.
 *
 * The negatives are as load-bearing as the positive: with no registry file there
 * is no "New session" in the DOM at all, a refusal is text and never markup, and
 * nothing in the picker accepts typed input.
 *
 * Between the daemon's answer and the fleet listing the session the page is only
 * waiting. A tap in that window must not start a second session or take the
 * operator out of one they chose; the tracer holds frames back to keep it open.
 *
 * Run: LD_LIBRARY_PATH=$(cat /home/nix/work/chromium-ldpath.txt) node --test --test-timeout=300000 scripts/geist-console-spawn-picker.e2e.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, MOBILE_CONTEXT, VIEWPORTS, waitForServer, waitForText } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages/gateway/src/cli.ts");
const GEIST_CLI = join(REPO_ROOT, "packages/geist/src/cli.ts");

const OPERATOR_TOKEN = "aGVsbG8+d29ybGQ/Cg==";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** In the project path, so a session this run leaked is identifiable by its argv alone. */
const MARKER = `gcsp-${randomUUID().slice(0, 8)}`;
const TOUCH = 44;

const NEW_SESSION = "#new-session";
const PICKER = "#spawn-picker";
/** Anything a person could type a command into. Radios, checkboxes and hidden inputs carry no text. */
const FREE_TEXT = "input:not([type=radio]):not([type=checkbox]):not([type=hidden]), textarea, [contenteditable]";

/* ------------------------------------------------------------- the harness -- */

const tempDirs = [];
function tempDir(prefix) {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	tempDirs.push(dir);
	return realpathSync(dir);
}

const children = [];
function track(child) {
	children.push(child);
	return child;
}

/** Every pid a spawned session had, recorded from `GET /fleet`, so `after` can reap its group. */
const spawnedPids = new Set();

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

/** A 0600 file in a 0700 directory: the only shape the daemon's loader accepts. JSON is valid YAML. */
function writeRegistry(path, config) {
	chmodSync(dirname(path), 0o700);
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function psRows() {
	const listing = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" });
	if (listing.status !== 0) throw new Error(`ps failed: ${listing.stderr}`);
	return listing.stdout.split("\n").flatMap((line) => {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		return match
			? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4], command: match[5] }]
			: [];
	});
}

const markerPids = () =>
	psRows()
		.filter((row) => row.command.includes(MARKER))
		.map((row) => row.pid)
		.sort();

async function startDaemon(label, registryPath) {
	const agentDir = tempDir(`gcsp${label}-`);
	const home = tempDir(`gcsp${label}H-`);
	const devicesPath = join(tempDir(`gcsp${label}D-`), "devices.json");
	const port = await freeLoopbackPort();
	const stderr = { text: "" };
	const child = track(
		spawn(
			"bun",
			[GATEWAY_CLI, "--port", String(port), "--host", "127.0.0.1", "--auth", OPERATOR_TOKEN, "--registry", registryPath],
			{
				cwd: REPO_ROOT,
				// Built from scratch: nothing of the developer's shell, least of all DRAHT_PERMISSION_MODE, reaches a session.
				env: {
					PATH: process.env.PATH,
					HOME: home,
					TMPDIR: home,
					DRAHT_CODING_AGENT_DIR: agentDir,
					GEIST_DEVICES_PATH: devicesPath,
					DRAHT_STUB_PROVIDER: "1",
					DRAHT_RESUME_ENV_ALLOW: "DRAHT_STUB_PROVIDER",
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		),
	);
	collect(child.stderr, stderr);
	await until(
		() => stderr.text.includes("draht-gateway listening"),
		() => `the daemon to report a bound port (stderr: ${stderr.text})`,
	);
	const origin = `http://127.0.0.1:${port}`;
	await waitForServer(`${origin}/health`);
	return { child, origin, agentDir, home, devicesPath, socketDir: join(agentDir, "sockets"), stderr };
}

/**
 * Mint a bootstrap token with the real `geist pair` and return the link's fragment.
 *
 * `--origin` only accepts https and the daemon here is plain loopback http, so the
 * fragment is taken off the printed link and put on the daemon's own origin.
 */
function pairFragment(daemon) {
	const paired = spawnSync("bun", [GEIST_CLI, "pair", "--origin", "https://127.0.0.1", "--ttl", "3600"], {
		cwd: REPO_ROOT,
		env: { ...process.env, GEIST_DEVICES_PATH: daemon.devicesPath },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (paired.status !== 0) throw new Error(`geist pair exited ${paired.status}\n${paired.stdout}\n${paired.stderr}`);
	const link = paired.stdout.split("\n").find((line) => line.trim().startsWith("https://"));
	if (!link) throw new Error(`geist pair printed no deep link:\n${paired.stdout}`);
	return new URL(link.trim()).hash;
}

async function fleetRows(daemon) {
	const response = await fetch(`${daemon.origin}/fleet`, { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
	assert.equal(response.status, 200, "GET /fleet should answer the operator token");
	const rows = (await response.json()).sessions;
	for (const row of rows) if (typeof row.pid === "number") spawnedPids.add(row.pid);
	return rows;
}

const liveIds = async (daemon) =>
	(await fleetRows(daemon))
		.filter((row) => row.origin === "socket")
		.map((row) => row.id)
		.sort();

/** The kernel's view of a session the page claims to be attached to, not the daemon's or the page's. */
async function assertLiveSession(daemon, sessionId) {
	const row = (await fleetRows(daemon)).find((candidate) => candidate.id === sessionId);
	assert.ok(row, `GET /fleet has no row for the session the page attached to (${sessionId})`);
	assert.equal(row.origin, "socket");
	assert.equal(row.attachable, true);
	assert.equal(row.cwd, projectRoot);
	assert.equal(typeof row.pid, "number", "a live row carries the pid of its process");

	const live = psRows().find((candidate) => candidate.pid === row.pid);
	assert.ok(live, `pid ${row.pid} is not in ps -A`);
	assert.equal(live.stat.startsWith("Z"), false, `pid ${row.pid} is a zombie`);
	assert.doesNotThrow(() => process.kill(row.pid, 0), `pid ${row.pid} is not signalable`);
	assert.equal(live.pgid, row.pid, "a spawned session leads its own process group");
	assert.equal(live.ppid, daemon.child.pid, "the daemon started it");
	assert.ok(live.command.includes(realpathSync(DRAHT_CLI)), `unexpected command: ${live.command}`);
	assert.ok(live.command.includes(MARKER), `the project root is not in its argv: ${live.command}`);
}

/** A draht started by hand in the daemon's agent dir: the "discovered" session already in the fleet. */
async function startHandSession(daemon) {
	const cwd = tempDir("gcspS-");
	const known = new Set(socketNames(daemon.socketDir));
	const stderr = { text: "" };
	const child = track(
		spawn("node", [DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"], {
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: daemon.home,
				TMPDIR: daemon.home,
				DRAHT_CODING_AGENT_DIR: daemon.agentDir,
				DRAHT_STUB_PROVIDER: "1",
			},
			stdio: ["pipe", "ignore", "pipe"],
		}),
	);
	collect(child.stderr, stderr);
	const name = await until(
		() => socketNames(daemon.socketDir).find((entry) => !known.has(entry)),
		() => `the hand-started draht to publish its socket (stderr: ${stderr.text})`,
	);
	return name.slice(0, -".sock".length);
}

/* --------------------------------------------------------------- the page -- */

/**
 * Record every frame the page sends and receives, in one ordered log.
 *
 * The receive listener is added when the socket is constructed, so it runs before
 * the page's own and the log is in the order the page saw things. Credentials are
 * dropped: this log is for asserting on frame order, not for keeping secrets.
 *
 * What the PAGE is handed can differ from what the daemon sent, and the log keeps
 * what the daemon really sent:
 *
 *   • `hide` names capabilities to remove from the `server_hello`. A test can show
 *     the daemon offered both and the page was told of one: no real daemon
 *     declares exactly one.
 *   • `patch` maps a frame type to fields that replace that frame's own, to hand
 *     the page a frame no real daemon sends (it filters its registry rows).
 *   • `hold` queues frames of `types` instead of delivering them, from the start or
 *     only `after` a frame of the named type has been delivered, until the test
 *     calls `window.__release()`. Delivery is synchronous inside that call, so a
 *     test can act in the window and then let the held frames land in one task.
 *   • `omitSpawned` takes the session a `session_spawned` named out of that many of
 *     the `fleet` snapshots that follow it: the daemon's observer coalesces scans,
 *     so a snapshot just after the answer can predate the row.
 *   • `replay` hands the page the latest frame of `type` a second time, right after
 *     a frame of type `after` — an answer that was already in flight.
 *
 * Every log entry carries `at`, `performance.now()` when it was noted, and every
 * socket the page constructs is kept in `window.__sockets`, in order.
 */
async function traceWire(context, { hide = [], patch = {}, hold = null, omitSpawned = 0, replay = null } = {}) {
	await context.addInitScript(({ hidden, patched, held, omit, again }) => {
		window.__wire = [];
		window.__held = [];
		window.__sockets = [];
		let holding = held !== null && held.after === undefined;
		let armedBy = held?.after ?? null;
		window.__release = () => {
			holding = false;
			armedBy = null;
			for (const deliver of window.__held.splice(0)) deliver();
		};
		let omittedId = null;
		let omitted = 0;
		const latest = {};
		const rewrites =
			hidden.length > 0 || Object.keys(patched).length > 0 || held !== null || omit > 0 || again !== null;
		const Native = window.WebSocket;
		const secret = new Set(["pair_device", "authenticate", "device_credential"]);
		const note = (dir, text) => {
			try {
				const frame = JSON.parse(String(text));
				window.__wire.push({ dir, at: performance.now(), frame: secret.has(frame.type) ? { type: frame.type } : frame });
			} catch {
				// Not JSON: nothing this log has an opinion about.
			}
		};
		window.WebSocket = new Proxy(Native, {
			construct(target, args) {
				const socket = new target(...args);
				window.__sockets.push(socket);
				const nativeSend = socket.send.bind(socket);
				socket.send = (data) => {
					note("out", data);
					nativeSend(data);
				};
				const nativeAdd = socket.addEventListener.bind(socket);
				nativeAdd("message", (event) => note("in", event.data));
				socket.addEventListener = (type, listener, options) => {
					if (type !== "message" || !rewrites) return nativeAdd(type, listener, options);
					return nativeAdd(
						type,
						(event) => {
							const frame = JSON.parse(event.data);
							if (frame.type === "server_hello") {
								frame.capabilities = frame.capabilities.filter((name) => !hidden.includes(name));
							}
							Object.assign(frame, patched[frame.type]);
							if (frame.type === "session_spawned") omittedId = frame.sessionId ?? null;
							if (frame.type === "fleet" && omittedId !== null && omitted < omit) {
								frame.sessions = frame.sessions.filter((row) => row.id !== omittedId);
								omitted += 1;
							}
							const deliver = () => listener({ data: JSON.stringify(frame) });
							if (holding && held.types.includes(frame.type)) {
								window.__held.push(deliver);
								return;
							}
							latest[frame.type] = frame;
							deliver();
							if (again !== null && frame.type === again.after) {
								listener({ data: JSON.stringify(latest[again.type]) });
							}
							if (armedBy === frame.type) {
								holding = true;
								armedBy = null;
							}
						},
						options,
					);
				};
				return socket;
			},
		});
	}, { hidden: hide, patched: patch, held: hold, omit: omitSpawned, again: replay });
}

const wireOf = (page) => page.evaluate(() => window.__wire);
const sentOf = async (page, type) =>
	(await wireOf(page)).filter((entry) => entry.dir === "out" && entry.frame.type === type).map((entry) => entry.frame);
const receivedOf = async (page, type) =>
	(await wireOf(page)).filter((entry) => entry.dir === "in" && entry.frame.type === type).map((entry) => entry.frame);

/** A paired console on a phone-sized touch context, closed again when `run` settles. */
async function withConsole(daemon, run, { viewport = VIEWPORTS.mobile, contextOptions = MOBILE_CONTEXT, ...trace } = {}) {
	const opened = await harness.newPage(viewport, contextOptions);
	try {
		await traceWire(opened.context, trace);
		await opened.page.goto(`${daemon.origin}/ui${pairFragment(daemon)}`);
		await opened.page.locator('#status[data-state="connected"]').waitFor({ timeout: 30_000 });
		await until(
			async () => (await receivedOf(opened.page, "fleet")).length > 0,
			"the fleet snapshot, which ends the connection's arrival",
		);
		await run(opened);
		assert.deepEqual(opened.errors, [], "the page logged console errors");
	} finally {
		await opened.close();
	}
}

async function openPicker(page) {
	await page.tap(NEW_SESSION);
	await page.locator(`${PICKER} input[name=project]`).first().waitFor({ timeout: 15_000 });
}

async function tapChoice(page, group, value) {
	await page.tap(`label.spawn-choice:has(input[name="${group}"][value="${value}"])`);
	assert.equal(await page.isChecked(`input[name="${group}"][value="${value}"]`), true);
}

/** A selector list, so it is applied through the element: `#picker a, b` would scope only the first. */
const freeTextInPicker = (page) =>
	page.evaluate((selector) => document.getElementById("spawn-picker").querySelectorAll(selector).length, FREE_TEXT);

/** What the open picker offers, read off the DOM. */
function pickerChoices(page) {
	return page.evaluate(() => {
		const form = document.getElementById("spawn-picker");
		const radios = (name) =>
			[...form.querySelectorAll(`input[type=radio][name=${name}]`)].map((radio) => ({
				value: radio.value,
				checked: radio.checked,
				text: radio.closest("label").textContent,
			}));
		return {
			projects: radios("project"),
			harnesses: radios("harness"),
			submitDisabled: form.querySelector("#spawn-submit").disabled,
		};
	});
}

/** The session the page is attached to, as the page itself says it. */
async function attachedSession(page) {
	await page.locator('body[data-view="session"]').waitFor({ timeout: 60_000 });
	const id = await until(
		() => page.evaluate(() => document.querySelector('#fleet [aria-current="true"]')?.dataset.sessionId ?? null),
		"the attached row to be marked current",
	);
	await waitForText(page, "#session-meta", id);
	return id;
}

const heldCount = (page) => page.evaluate(() => window.__held.length);
const releaseHeld = (page) => page.evaluate(() => window.__release());

/**
 * Tap Start on the fixture project and wait until the daemon's answer is in and the
 * tracer is holding a frame back. Returns the id the answer named.
 */
async function startAndWaitHeld(page) {
	await openPicker(page);
	await tapChoice(page, "project", "fixture");
	await page.tap("#spawn-submit");
	await until(
		async () => (await receivedOf(page, "session_spawned")).length === 1 && (await heldCount(page)) > 0,
		"the daemon's answer to be in and a frame to be held back",
	);
	return (await receivedOf(page, "session_spawned"))[0].sessionId;
}

/* ----------------------------------------------------------------- state -- */

let harness;
let projectRoot;
let missingRoot;
/** Daemon with no registry file at its `--registry` path. */
let bare;
let bareRegistry;
/** Daemon whose registry names one real project and one that does not exist. */
let equipped;
let registryPath;
let registryConfig;
let handSessionId;

before(
	async () => {
		if (!existsSync(DRAHT_CLI)) {
			const build = spawnSync("npm", ["run", "build"], { cwd: join(REPO_ROOT, "packages/coding-agent"), encoding: "utf8" });
			if (build.status !== 0) throw new Error(`draht build failed:\n${build.stderr}`);
		}

		bareRegistry = join(tempDir("gcspB-"), "config.yaml");
		bare = await startDaemon("A", bareRegistry);

		const base = tempDir("gcspP-");
		projectRoot = join(base, MARKER);
		mkdirSync(projectRoot);
		// Markup in a name and in a path, to be shown as the characters they are.
		missingRoot = join(base, "missing<i>root</i>");
		registryPath = join(tempDir("gcspR-"), "config.yaml");
		registryConfig = {
			harness: { default: "draht", agents: { draht: { cmd: DRAHT_CLI } } },
			projects: {
				fixture: { root: projectRoot, name: "Fixture <b>project</b>" },
				ghost: { root: missingRoot, name: "Ghost" },
			},
			approvedRoots: [REPO_ROOT, realpathSync("/tmp")],
		};
		writeRegistry(registryPath, registryConfig);
		equipped = await startDaemon("C", registryPath);
		handSessionId = await startHandSession(equipped);

		harness = await launchHeadlessBrowser();
	},
	{ timeout: 300_000 },
);

after(async () => {
	// Before the daemons die: the fleet is where the pids are written down.
	if (equipped) await fleetRows(equipped).catch(() => []);
	for (const child of children) child.kill("SIGKILL");
	// Detached, in their own groups: killing the daemon does not kill them. Reaped
	// before the browser closes, so a close that rejects cannot skip it.
	for (const pid of spawnedPids) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
	// Also by the marker in their argv, which covers one that never reached the fleet.
	for (const row of psRows()) {
		if (!row.command.includes(MARKER)) continue;
		try {
			process.kill(row.pgid === row.pid ? -row.pid : row.pid, "SIGKILL");
		} catch {}
	}
	const survivors = () =>
		psRows().filter((row) => (spawnedPids.has(row.pid) || row.command.includes(MARKER)) && !row.stat.startsWith("Z"));
	try {
		await harness?.close();
	} finally {
		try {
			await until(() => survivors().length === 0, () => `spawned sessions to die: ${JSON.stringify(survivors())}`, 15_000);
		} finally {
			for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		}
	}
});

/* ------------------------------------------------------------------ cases -- */

describe("a daemon with no registry offers no way to start a session", () => {
	it("renders no New session element at all", async () => {
		await withConsole(bare, async ({ page }) => {
			const hello = (await receivedOf(page, "server_hello"))[0];
			assert.ok(hello.capabilities.includes("fleet-delta"), "the capability list was read, and has the daemon's other entries");
			assert.equal(hello.capabilities.includes("session-spawn"), false);
			assert.equal(hello.capabilities.includes("registry"), false);

			const present = await page.evaluate(() => ({
				button: document.querySelector("#new-session") !== null,
				section: document.querySelector("#spawn, #spawn-picker") !== null,
				anywhere: [...document.querySelectorAll("*")].some(
					(node) =>
						/new session/i.test(node.getAttribute("aria-label") ?? "") ||
						(node.childElementCount === 0 && /new session/i.test(node.textContent ?? "")),
				),
			}));
			assert.deepEqual(present, { button: false, section: false, anywhere: false });
			assert.deepEqual(await sentOf(page, "registry_resync"), []);
		});
	});

	for (const hidden of ["session-spawn", "registry"]) {
		it(`renders none when the connection was not told of ${hidden}, though the daemon offered both`, async () => {
			await withConsole(
				equipped,
				async ({ page }) => {
					const hello = (await receivedOf(page, "server_hello"))[0];
					assert.ok(hello.capabilities.includes("session-spawn") && hello.capabilities.includes("registry"));
					assert.equal(await page.locator("#new-session, #spawn").count(), 0);
				},
				{ hide: [hidden] },
			);
		});
	}

	it("offers it to the next connection once a registry file exists, with nothing else changed", async () => {
		writeRegistry(bareRegistry, registryConfig);
		await withConsole(bare, async ({ page }) => {
			const hello = (await receivedOf(page, "server_hello"))[0];
			assert.ok(hello.capabilities.includes("session-spawn") && hello.capabilities.includes("registry"));
			await page.locator(NEW_SESSION).waitFor({ timeout: 15_000 });
		});
	});
});

describe("the phone starts a session (R36-SPAWN.1, R36-SPAWN.8)", () => {
	it("shows the project and the default harness, sends one session_spawn, and ends up attached to a live new session", async () => {
		await withConsole(equipped, async ({ page }) => {
			// The first spawn on this daemon: no earlier case started a session.
			const idsBefore = await liveIds(equipped);
			assert.deepEqual(idsBefore, [handSessionId], "the hand-started session is the only one before the spawn");

			assert.equal(await page.getAttribute(NEW_SESSION, "aria-controls"), null, "aria-controls names an element that is not there yet");
			await openPicker(page);
			assert.equal((await sentOf(page, "registry_resync")).length, 1);
			assert.equal(await page.getAttribute(NEW_SESSION, "aria-controls"), "spawn-picker");

			const choices = await pickerChoices(page);
			assert.deepEqual(
				choices.projects.map((project) => [project.value, project.checked]),
				[
					["fixture", false],
					["ghost", false],
				],
			);
			assert.ok(choices.projects[0].text.includes("Fixture <b>project</b>"), `the name was not shown as text: ${choices.projects[0].text}`);
			assert.ok(choices.projects[0].text.includes(projectRoot), `the root is shown as secondary text: ${choices.projects[0].text}`);
			assert.equal(await page.locator(`${PICKER} b, ${PICKER} i`).count(), 0, "markup in a name or root became an element");
			assert.deepEqual(choices.harnesses.map((harness_) => [harness_.value, harness_.checked]), [["draht", true]]);
			assert.ok(choices.harnesses[0].text.includes("default"));
			assert.equal(choices.submitDisabled, true, "no project is chosen yet");

			await tapChoice(page, "project", "fixture");
			assert.equal(await page.locator("#spawn-submit").isDisabled(), false);

			// A double tap, and a submit that does not come from the button at all.
			const fired = await page.evaluate(() => {
				const submit = document.getElementById("spawn-submit");
				submit.click();
				const disabledAfterFirst = submit.disabled;
				submit.click();
				document.getElementById("spawn-picker").requestSubmit();
				return { disabledAfterFirst };
			});
			assert.equal(fired.disabledAfterFirst, true, "the submit must be disabled until the answer arrives");
			assert.deepEqual(await sentOf(page, "session_spawn"), [
				{ type: "session_spawn", harnessId: "draht", projectId: "fixture" },
			]);

			const sessionId = await attachedSession(page);
			assert.match(sessionId, UUID);
			assert.notEqual(sessionId, handSessionId);
			assert.equal(idsBefore.includes(sessionId), false, "the page attached to a session that was already there");

			await assertLiveSession(equipped, sessionId);
			assert.deepEqual(await liveIds(equipped), [handSessionId, sessionId].sort());
			assert.equal((await sentOf(page, "session_spawn")).length, 1, "a second spawn was sent");
			assert.equal((await receivedOf(page, "session_spawned")).length, 1);

			// The page opened the session the fleet showed it, not one it made up from the answer.
			const wire = await wireOf(page);
			const spawnedAt = wire.findIndex((entry) => entry.dir === "in" && entry.frame.type === "session_spawned");
			const listedAt = wire.findIndex(
				(entry) =>
					entry.dir === "in" && entry.frame.type === "fleet" && entry.frame.sessions.some((row) => row.id === sessionId),
			);
			const attachedAt = wire.findIndex(
				(entry) => entry.dir === "out" && entry.frame.type === "attach" && entry.frame.sessionId === sessionId,
			);
			assert.ok(spawnedAt >= 0 && listedAt > spawnedAt, "the fleet snapshot that lists the session follows the answer");
			assert.ok(attachedAt > listedAt, "the attach must follow the fleet listing the session");

			const prompt = "hello from the picker";
			await page.fill("#prompt", prompt);
			await page.tap("#send");
			await waitForText(page, "#transcript", `stub: ${prompt}`, { timeout: 60_000 });
		});
	});

	it("renders a refusal as text, names the rule, leaves the fleet alone, and stays usable", async () => {
		await withConsole(equipped, async ({ page }) => {
			await openPicker(page);
			await tapChoice(page, "project", "fixture");

			const idsBefore = await liveIds(equipped);
			const processesBefore = markerPids();
			chmodSync(registryPath, 0o644);
			try {
				await page.tap("#spawn-submit");
				const result = page.locator('#spawn-result[data-state="failed"]');
				await result.waitFor({ timeout: 15_000 });
				const text = await result.textContent();
				assert.ok(text.startsWith("refused: "), text);
				assert.ok(text.includes(`(mode on file ${registryPath})`), `the rule and its scope are not named: ${text}`);
				assert.equal(await result.getAttribute("data-code"), "refused");

				await new Promise((resolve) => setTimeout(resolve, 250));
				assert.deepEqual(await liveIds(equipped), idsBefore, "a refused spawn put a session in the fleet");
				assert.deepEqual(markerPids(), processesBefore, "a refused spawn started a process");

				assert.equal(await page.locator("#spawn-submit").isDisabled(), false, "the picker is not usable again");
				assert.equal(await page.isChecked('input[name="project"][value="fixture"]'), true, "the choice was lost");
				await page.tap("#spawn-submit");
				await until(async () => (await receivedOf(page, "session_spawned")).length === 2, "a second answer");
				assert.equal((await sentOf(page, "session_spawn")).length, 2);
			} finally {
				chmodSync(registryPath, 0o600);
			}

			// The operator fixes the file; the same page, the same picker, the same tap.
			await page.tap("#spawn-submit");
			const sessionId = await attachedSession(page);
			assert.equal(idsBefore.includes(sessionId), false);
			await assertLiveSession(equipped, sessionId);
		});
	});

	it("shows markup in a refusal as the characters it is", async () => {
		await withConsole(equipped, async ({ page }) => {
			await openPicker(page);
			await tapChoice(page, "project", "ghost");
			await page.tap("#spawn-submit");

			const result = page.locator('#spawn-result[data-state="failed"]');
			await result.waitFor({ timeout: 15_000 });
			const text = await result.textContent();
			assert.ok(text.includes('the "ghost" project root does not exist'), text);
			assert.ok(text.includes("missing<i>root</i>"), `the path was not shown as text: ${text}`);
			assert.equal(await page.locator("#spawn-result i, #spawn-result b").count(), 0, "markup became an element");
			assert.equal(await result.getAttribute("data-code"), "refused");
		});
	});

	it("says there is nothing to start when the registry answers empty, and recovers when it is fixed", async () => {
		await withConsole(equipped, async ({ page }) => {
			chmodSync(registryPath, 0o644);
			try {
				await page.tap(NEW_SESSION);
				await waitForText(page, PICKER, "no projects available on this machine");
				assert.equal(await page.locator(`${PICKER} input, ${PICKER} button`).count(), 0, "an empty picker offers a control");
				assert.equal(await freeTextInPicker(page), 0);
			} finally {
				chmodSync(registryPath, 0o600);
			}

			await page.tap(NEW_SESSION);
			assert.equal(await page.locator(PICKER).count(), 0, "the second tap closes the picker");
			await openPicker(page);
			assert.equal(await page.locator(`${PICKER} input[name=project]`).count(), 2);
			assert.equal((await sentOf(page, "registry_resync")).length, 2, "each opening asks the daemon again");
		});
	});

	it("has no free-text field in the picker", async () => {
		await withConsole(equipped, async ({ page }) => {
			await openPicker(page);
			const counts = await page.evaluate((selector) => {
				const form = document.getElementById("spawn-picker");
				return {
					picker: form.querySelectorAll(selector).length,
					page: document.querySelectorAll(selector).length,
					radios: form.querySelectorAll("input[type=radio]").length,
					groups: new Set([...form.querySelectorAll("input[type=radio]")].map((radio) => radio.name)).size,
				};
			}, FREE_TEXT);
			assert.equal(counts.picker, 0);
			assert.ok(counts.page >= 2, "the selector must see the composer and the token field, or it proves nothing");
			assert.equal(counts.groups, 2);
			assert.equal(counts.radios, 3);
		});
	});

	it("fits a 390px phone with every control a thumb target", async () => {
		await withConsole(equipped, async ({ page }) => {
			await openPicker(page);
			await tapChoice(page, "project", "fixture");
			const measured = await page.evaluate(
				([selectors, width, touch]) => ({
					overflow: document.documentElement.scrollWidth - width,
					titles: [...document.querySelectorAll(".spawn-group legend, #rail > .pane-title")].map((node) => {
						const style = getComputedStyle(node);
						return [style.fontSize, style.fontWeight, style.letterSpacing, style.textTransform, style.color].join(" ");
					}),
					small: selectors.flatMap((selector) =>
						[...document.querySelectorAll(selector)].flatMap((node) => {
							const box = node.getBoundingClientRect();
							return box.width < touch || box.height < touch || box.right > width
								? [`${selector} ${box.width.toFixed(1)}x${box.height.toFixed(1)} right=${box.right.toFixed(1)}`]
								: [];
						}),
					),
				}),
				[["#new-session", ".spawn-choice", "#spawn-submit"], VIEWPORTS.mobile.width, TOUCH],
			);
			assert.ok(measured.overflow <= 0, `horizontal overflow: ${measured.overflow}px`);
			assert.equal(measured.titles.length, 3, "the picker's two group titles and the rail's own");
			assert.equal(new Set(measured.titles).size, 1, `a group title is not typed like the pane title: ${measured.titles}`);
			assert.deepEqual(measured.small, []);
		});
	});
});

describe("a started session that has not joined the fleet yet", () => {
	const HOLD_FLEET = { types: ["fleet", "fleet_delta"], after: "session_spawned" };

	it("takes a second submit as no submit, and leaves New session usable once the session is open", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				const idsBefore = await liveIds(equipped);
				const socketsBefore = socketNames(equipped.socketDir).length;
				await startAndWaitHeld(page);

				// Every way a second submit can arrive: the button, the form, a bare submit event, and the toggle.
				// The toggle is tried with its button enabled as well: the disabled attribute is one lock, the handler's own check another.
				const waiting = await page.evaluate(() => {
					const submit = document.getElementById("spawn-submit");
					const open = document.getElementById("new-session");
					const form = document.getElementById("spawn-picker");
					const state = { submitDisabled: submit.disabled, openDisabled: open.disabled };
					submit.click();
					form.requestSubmit();
					form.dispatchEvent(new Event("submit", { cancelable: true }));
					open.click();
					open.disabled = false;
					open.click();
					open.disabled = true;
					return { ...state, pickerOpen: document.getElementById("spawn-picker") !== null };
				});
				assert.equal(
					(await sentOf(page, "session_spawn")).length,
					1,
					"a second session_spawn was sent while the first session was still joining the fleet",
				);
				assert.deepEqual(
					waiting,
					{ submitDisabled: true, openDisabled: true, pickerOpen: true },
					"Start and New session must stay disabled until the new session is open",
				);

				await releaseHeld(page);
				const sessionId = await attachedSession(page);
				await assertLiveSession(equipped, sessionId);
				assert.deepEqual(await liveIds(equipped), [...idsBefore, sessionId].sort(), "more than one session was started");
				assert.equal(socketNames(equipped.socketDir).length, socketsBefore + 1, "more than one session published a socket");
				assert.equal((await sentOf(page, "session_spawn")).length, 1);
				assert.equal((await receivedOf(page, "session_spawned")).length, 1);

				// The picker closed with its job done; the button that opens it must not be left disabled.
				const open = await page.evaluate(() => {
					const button = document.getElementById("new-session");
					return {
						disabled: button.disabled,
						expanded: button.getAttribute("aria-expanded"),
						controls: button.getAttribute("aria-controls"),
					};
				});
				assert.deepEqual(open, { disabled: false, expanded: "false", controls: null });
			},
			{ hold: HOLD_FLEET },
		);
	});

	it("keeps Start and the choices off when a registry answer redraws the picker while the session is joining", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				const idsBefore = await liveIds(equipped);
				await startAndWaitHeld(page);

				// The answer of an earlier open of the picker, landing after Start: the form is drawn again from it.
				const redrawn = await page.evaluate(() => ({
					fresh: document.getElementById("spawn-result")?.textContent === "",
					groups: [...document.querySelectorAll("#spawn-picker fieldset")].map((group) => group.disabled),
					open: document.getElementById("new-session").disabled,
					submit: document.getElementById("spawn-submit").disabled,
				}));
				assert.deepEqual(redrawn, { fresh: true, groups: [true, true], open: true, submit: true });

				await page.evaluate(() => {
					document.querySelector('input[name="project"]').click();
					document.getElementById("spawn-submit").click();
					document.getElementById("spawn-picker").requestSubmit();
				});
				assert.equal((await sentOf(page, "session_spawn")).length, 1, "a second session_spawn was sent");

				await releaseHeld(page);
				const sessionId = await attachedSession(page);
				assert.deepEqual(await liveIds(equipped), [...idsBefore, sessionId].sort(), "more than one session was started");
			},
			{ hold: HOLD_FLEET, replay: { type: "registry", after: "session_spawned" } },
		);
	});

	for (const [phase, hold] of [
		["while the daemon has not answered yet", { types: ["session_spawned"] }],
		["while the answer is in and the fleet has not listed it", HOLD_FLEET],
	]) {
		it(`leaves the operator in the session they opened ${phase}`, async () => {
			await withConsole(
				equipped,
				async ({ page }) => {
					await openPicker(page);
					await tapChoice(page, "project", "fixture");
					await page.tap("#spawn-submit");
					await until(
						async () => (await receivedOf(page, "session_spawned")).length === 1 && (await heldCount(page)) > 0,
						"the daemon's answer to be in and a frame to be held back",
					);
					const spawnedId = (await receivedOf(page, "session_spawned"))[0].sessionId;

					await page.tap(`#fleet .session-row[data-session-id="${handSessionId}"]`);
					await page.locator('body[data-view="session"]').waitFor({ timeout: 30_000 });
					await waitForText(page, "#session-meta", handSessionId);
					const prompt = "typed in the session I chose";
					await page.fill("#prompt", prompt);
					await page.tap("#send");
					await waitForText(page, "#transcript", `stub: ${prompt}`, { timeout: 60_000 });

					await releaseHeld(page);
					await page.locator(`#fleet [data-session-id="${spawnedId}"]`).waitFor({ state: "attached", timeout: 15_000 });
					await new Promise((resolve) => setTimeout(resolve, 300));

					const shown = await page.evaluate(() => ({
						view: document.body.dataset.view,
						meta: document.getElementById("session-meta").textContent,
						transcript: document.getElementById("transcript").textContent,
						current: [...document.querySelectorAll('#fleet [aria-current="true"]')].map((row) => row.dataset.sessionId),
						result: document.getElementById("spawn-result")?.textContent ?? null,
						state: document.getElementById("spawn-result")?.dataset.state ?? null,
						submitDisabled: document.getElementById("spawn-submit")?.disabled ?? null,
					}));
					assert.equal(shown.view, "session");
					assert.ok(shown.meta.includes(handSessionId), `the operator was moved off the session they opened: ${shown.meta}`);
					assert.ok(shown.transcript.includes(`stub: ${prompt}`), "the session they opened lost its transcript");
					assert.deepEqual(shown.current, [handSessionId]);
					assert.deepEqual(
						(await sentOf(page, "attach")).map((frame) => frame.sessionId),
						[handSessionId],
						"the page attached to the new session as well",
					);
					assert.deepEqual(await sentOf(page, "detach"), [], "the page let go of the session the operator opened");

					assert.equal(
						shown.result,
						"started — open it from the fleet list (Refresh if it is missing)",
						"the new session is reported as text",
					);
					assert.equal(shown.state, "ok");
					assert.equal(shown.submitDisabled, false, "the picker is not usable again");
					await assertLiveSession(equipped, spawnedId);
				},
				{ hold },
			);
		});
	}

	it("asks the fleet once more, after a pause, when the first snapshot after the answer lacks the row, and then opens it", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				await openPicker(page);
				await tapChoice(page, "project", "fixture");
				await page.tap("#spawn-submit");
				const sessionId = await attachedSession(page);
				await assertLiveSession(equipped, sessionId);

				const wire = await wireOf(page);
				const answeredAt = wire.findIndex((entry) => entry.dir === "in" && entry.frame.type === "session_spawned");
				const since = wire.slice(answeredAt);
				const asks = since.filter((entry) => entry.dir === "out" && entry.frame.type === "fleet_resync");
				assert.equal(asks.length, 2, "the page gave up on the first snapshot, or asked more than once more");

				// The daemon reuses a scan younger than 25 ms: asked at once, the second answer can come from the scan that lacked the row.
				const lacking = since.find((entry) => entry.dir === "in" && entry.frame.type === "fleet");
				const pause = asks[1].at - lacking.at;
				assert.ok(pause >= 90, `the second ask followed the snapshot that lacked the row by ${pause.toFixed(1)} ms`);
			},
			{ omitSpawned: 1 },
		);
	});

	it("says the session is not listed after asking once more, and leaves the picker usable", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				const idsBefore = await liveIds(equipped);
				await openPicker(page);
				await tapChoice(page, "project", "fixture");
				await page.tap("#spawn-submit");
				const result = page.locator('#spawn-result[data-state="ok"]');
				await result.waitFor({ timeout: 15_000 });
				assert.equal(await result.textContent(), "started, but it is not in the fleet list yet — use Refresh");

				const wire = await wireOf(page);
				const answeredAt = wire.findIndex((entry) => entry.dir === "in" && entry.frame.type === "session_spawned");
				assert.equal(
					wire.slice(answeredAt).filter((entry) => entry.dir === "out" && entry.frame.type === "fleet_resync").length,
					2,
					"the page did not ask exactly once more",
				);
				assert.equal(await page.evaluate(() => document.body.dataset.view), "fleet");
				assert.equal(await page.locator("#spawn-submit").isDisabled(), false, "the picker is not usable again");
				assert.equal(await page.locator(NEW_SESSION).isDisabled(), false);
				assert.equal((await liveIds(equipped)).length, idsBefore.length + 1, "the session was started, and only once");
			},
			{ omitSpawned: 2 },
		);
	});

	it("does not ask again when the operator opens a session during the pause", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				await startAndWaitHeld(page);
				// Delivery is synchronous inside the release, so the snapshot that lacks the row arms the pause and the tap lands inside it.
				await page.evaluate((id) => {
					window.__release();
					document.querySelector(`#fleet .session-row[data-session-id="${id}"]`).click();
				}, handSessionId);
				await waitForText(page, "#session-meta", handSessionId);
				await new Promise((resolve) => setTimeout(resolve, 400));

				const wire = await wireOf(page);
				const answeredAt = wire.findIndex((entry) => entry.dir === "in" && entry.frame.type === "session_spawned");
				assert.equal(
					wire.slice(answeredAt).filter((entry) => entry.dir === "out" && entry.frame.type === "fleet_resync").length,
					1,
					"the page asked the fleet again for a session the operator had stopped waiting for",
				);
			},
			{ hold: HOLD_FLEET, omitSpawned: 1 },
		);
	});

	it("still asks once more when Refresh is tapped during the pause", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				await startAndWaitHeld(page);
				// The snapshot Refresh asks for lacks the row too, and lands while the pause is still running.
				await page.evaluate(() => {
					window.__release();
					document.getElementById("refresh").click();
				});
				const sessionId = await attachedSession(page);
				await assertLiveSession(equipped, sessionId);
			},
			{ hold: HOLD_FLEET, omitSpawned: 2 },
		);
	});

	it("does not open the new session after Back, though the fleet lands in the same task", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				await page.tap(`#fleet .session-row[data-session-id="${handSessionId}"]`);
				await waitForText(page, "#session-meta", handSessionId);
				await startAndWaitHeld(page);

				// A window resized to a phone: the session pane alone, with a Back button, and the spawn still waiting.
				await page.setViewportSize(VIEWPORTS.mobile);
				await page.locator("#back").waitFor({ state: "visible" });
				// One task, so the held fleet is applied before the connection Back detaches has closed.
				await page.evaluate(() => {
					document.getElementById("back").click();
					window.__release();
				});

				await until(async () => (await receivedOf(page, "device_credential")).length === 2, "the reconnect Back causes");
				await page.locator('#status[data-state="connected"]').waitFor({ timeout: 30_000 });
				assert.deepEqual(
					(await sentOf(page, "attach")).map((frame) => frame.sessionId),
					[handSessionId],
					"the operator went Back and the page attached to the new session anyway",
				);
				assert.equal(await page.evaluate(() => document.body.dataset.view), "fleet");
				assert.equal(await page.locator("#spawn-note").count(), 0, "a spawn the daemon answered was reported as lost");
			},
			{ viewport: VIEWPORTS.desktop, contextOptions: { hasTouch: true }, hold: HOLD_FLEET },
		);
	});
});

describe("a connection the page has replaced", () => {
	const OPEN = 1;
	const CLOSED = 3;
	const socketStates = (page) => page.evaluate(() => window.__sockets.map((socket) => socket.readyState));

	it("opens one replacement, not two, when Refresh is tapped while a reconnect is pending", async () => {
		await withConsole(equipped, async ({ page }) => {
			// The drop and the tap share one task, so the backoff timer the drop armed is still pending when the tap lands.
			await page.evaluate(
				() =>
					new Promise((resolve) => {
						const dropped = window.__sockets[0];
						dropped.addEventListener(
							"close",
							() => {
								document.getElementById("refresh").click();
								resolve();
							},
							{ once: true },
						);
						dropped.close();
					}),
			);
			await page.locator('#status[data-state="connected"]').waitFor({ timeout: 30_000 });
			// Past the 500 ms the first backoff waits.
			await new Promise((resolve) => setTimeout(resolve, 900));

			assert.deepEqual(await socketStates(page), [CLOSED, OPEN], "the pending reconnect opened a socket beside the one Refresh opened");
			assert.equal((await sentOf(page, "hello")).length, 2, "each extra socket costs a credential rotation");
		});
	});

	it("closes the socket it replaces, and takes nothing from it afterwards", async () => {
		const token = new URLSearchParams(pairFragment(equipped).slice(1)).get("token");
		await withConsole(equipped, async ({ page }) => {
			// A refused credential shows the pairing form while the refused socket is still open: a daemon closes it a moment later, this one is left open.
			await page.evaluate(() =>
				window.__sockets[0].dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({ type: "protocol_error", code: "not_authenticated", message: "revoked" }),
					}),
				),
			);
			await page.locator("#token-form").waitFor({ state: "visible" });
			await page.fill("#token-input", token);
			await page.tap("#token-save");
			await page.locator('#status[data-state="connected"]').waitFor({ timeout: 30_000 });
			await until(
				async () => (await socketStates(page))[0] === CLOSED,
				"the socket the page replaced to be closed",
				5_000,
			);

			await openPicker(page);
			await tapChoice(page, "project", "fixture");
			// One task: the answer cannot arrive between the tap and the read.
			const pending = await page.evaluate(() => {
				document.getElementById("spawn-submit").click();
				window.__sockets[0].dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({ type: "session_spawned", ok: false, code: "refused", message: "from the replaced socket" }),
					}),
				);
				const result = document.getElementById("spawn-result");
				return {
					text: result.textContent,
					state: result.dataset.state,
					submitDisabled: document.getElementById("spawn-submit").disabled,
				};
			});
			assert.deepEqual(
				pending,
				{ text: "starting…", state: "pending", submitDisabled: true },
				"a frame from the replaced socket answered the spawn sent on its replacement",
			);

			const sessionId = await attachedSession(page);
			await assertLiveSession(equipped, sessionId);
			assert.equal((await sentOf(page, "session_spawn")).length, 1);
		});
	});
});

describe("a spawn the connection closed under", () => {
	const NOTE = "#spawn-note";
	const NOTE_TEXT = "a session you started may still be starting — check the list";
	// The daemon closes the connection on detach and never answers a spawn still in flight; holding the answer makes that true whatever the timing.
	const HOLD_ANSWER = { types: ["session_spawned"] };
	const WIDE = { viewport: VIEWPORTS.desktop, contextOptions: { hasTouch: true }, hold: HOLD_ANSWER };

	/** The one session that joined the fleet beyond `idsBefore`, read outside the browser: the closed connection did begin it. */
	const joined = (idsBefore) =>
		until(async () => {
			const ids = await liveIds(equipped);
			return ids.length === idsBefore.length + 1 ? ids.filter((id) => !idsBefore.includes(id))[0] : null;
		}, "the session started before the close to join the fleet");

	/** Attached to the hand session on a wide window, Start tapped, then Back: the page detaches, the daemon closes the socket, the page reconnects. */
	async function loseSpawn(page) {
		await page.tap(`#fleet .session-row[data-session-id="${handSessionId}"]`);
		await waitForText(page, "#session-meta", handSessionId);
		await openPicker(page);
		await tapChoice(page, "project", "fixture");
		await page.tap("#spawn-submit");
		await until(async () => (await sentOf(page, "session_spawn")).length === 1, "the spawn to be sent");

		const snapshots = (await receivedOf(page, "fleet")).length;
		// A window resized to a phone: the session pane alone, with a Back button.
		await page.setViewportSize(VIEWPORTS.mobile);
		await page.locator("#back").waitFor({ state: "visible" });
		await page.tap("#back");
		await until(async () => (await receivedOf(page, "device_credential")).length === 2, "the reconnect Back causes");
		await page.locator('#status[data-state="connected"]').waitFor({ timeout: 30_000 });
		await until(async () => (await receivedOf(page, "fleet")).length > snapshots, "the reconnect's own snapshot");
	}

	it("says a session may still be starting, opens nothing, and drops the note once the list is re-read", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				const idsBefore = await liveIds(equipped);
				assert.equal(await page.locator(NOTE).count(), 0, "a note before any spawn was lost");
				await loseSpawn(page);

				const shown = await page.evaluate((selector) => {
					const note = document.querySelector(selector);
					return {
						note: note?.textContent ?? null,
						within: note?.parentElement?.id ?? null,
						picker: document.getElementById("spawn-picker") !== null,
						newSessionDisabled: document.getElementById("new-session").disabled,
						view: document.body.dataset.view,
					};
				}, NOTE);
				assert.deepEqual(shown, {
					note: NOTE_TEXT,
					within: "spawn",
					picker: false,
					newSessionDisabled: false,
					view: "fleet",
				});
				assert.deepEqual(
					(await sentOf(page, "attach")).map((frame) => frame.sessionId),
					[handSessionId],
					"the page opened a session on its own",
				);

				// The note is not a false alarm: the session the closed connection began is starting.
				await assertLiveSession(equipped, await joined(idsBefore));

				// A snapshot the page asked for is the operator checking the list.
				await page.tap("#refresh");
				await until(async () => (await page.locator(NOTE).count()) === 0, "the note to go once the list is re-read");
				assert.equal(await page.locator(NEW_SESSION).isDisabled(), false);

				// Dealt with: a later reconnect has nothing to report.
				await page.evaluate(() => window.__sockets.at(-1).close());
				await until(async () => (await receivedOf(page, "device_credential")).length === 3, "the reconnect after the drop");
				assert.equal(await page.locator(NOTE).count(), 0, "the note came back after it had been dealt with");
			},
			WIDE,
		);
	});

	it("says so as well when the answer was in but the session had not joined the fleet", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				const idsBefore = await liveIds(equipped);
				await startAndWaitHeld(page);
				await page.evaluate(() => window.__sockets.at(-1).close());
				await page.locator(NOTE).waitFor({ timeout: 30_000 });
				assert.equal(await page.locator(NOTE).textContent(), NOTE_TEXT);
				assert.equal(await page.locator(NEW_SESSION).isDisabled(), false);
				await assertLiveSession(equipped, await joined(idsBefore));
			},
			{ hold: { types: ["fleet", "fleet_delta"], after: "session_spawned" } },
		);
	});

	it("keeps the note while the next spawn is outstanding, and drops it when that spawn is answered", async () => {
		await withConsole(
			equipped,
			async ({ page }) => {
				const idsBefore = await liveIds(equipped);
				await loseSpawn(page);
				await page.locator(NOTE).waitFor();
				// The daemon refuses a second spawn for the same project while the first is still starting, and lets go a moment after the row appears.
				await joined(idsBefore);
				await new Promise((resolve) => setTimeout(resolve, 300));
				await startAndWaitHeld(page);
				assert.equal((await receivedOf(page, "session_spawned"))[0].ok, true, "the next spawn was refused");
				assert.equal(await page.locator(NOTE).count(), 1, "the note went before the next spawn was answered");

				// Delivery is synchronous inside the release, so no snapshot can have followed the answer yet.
				const left = await page.evaluate((selector) => {
					window.__release();
					return document.querySelector(selector)?.textContent ?? null;
				}, NOTE);
				assert.equal(left, null, "the answer to the next spawn left the note up");
				const sessionId = await attachedSession(page);
				await assertLiveSession(equipped, sessionId);
			},
			WIDE,
		);
	});
});

describe("a registry frame the daemon would not send", () => {
	const LONGEST = "e".repeat(64);

	it("lists each row once, and only rows whose id the daemon would accept", async () => {
		const patch = {
			registry: {
				harnesses: [
					null,
					3,
					{ id: "bad id", isDefault: true },
					{ isDefault: true },
					{ id: "draht", isDefault: true },
					{ id: "draht", isDefault: false },
					{ id: "e".repeat(65), isDefault: false },
				],
				projects: [
					null,
					"fixture",
					{ name: "no id", root: "/x" },
					{ id: 7, name: "numeric", root: "/x" },
					{ id: "has space", name: "space", root: "/x" },
					{ id: "../up", name: "path", root: "/x" },
					{ id: "-leading", name: "dash", root: "/x" },
					{ id: "e".repeat(65), name: "one too long", root: "/x" },
					{ id: "fixture", name: "Fixture <b>project</b>", root: projectRoot },
					{ id: "fixture", name: "Imposter", root: "/elsewhere" },
					{ id: "ghost", name: "Ghost", root: missingRoot },
					{ id: LONGEST, name: "Longest", root: "/x" },
				],
			},
		};
		await withConsole(
			equipped,
			async ({ page }) => {
				await openPicker(page);
				const choices = await pickerChoices(page);
				assert.deepEqual(
					choices.projects.map((project) => project.value),
					["fixture", "ghost", LONGEST],
				);
				assert.deepEqual(
					choices.harnesses.map((harness_) => [harness_.value, harness_.checked]),
					[["draht", true]],
				);
				assert.ok(choices.projects[0].text.includes("Fixture <b>project</b>"), `the first row did not win: ${choices.projects[0].text}`);
				assert.equal(
					choices.projects.some((project) => project.text.includes("Imposter")),
					false,
				);

				// The frame the page sends is one the daemon accepts: a refusal answers it, the connection stays.
				await tapChoice(page, "project", "ghost");
				await page.tap("#spawn-submit");
				await page.locator('#spawn-result[data-state="failed"]').waitFor({ timeout: 15_000 });
				assert.deepEqual(await sentOf(page, "session_spawn"), [
					{ type: "session_spawn", harnessId: "draht", projectId: "ghost" },
				]);
				assert.deepEqual(await receivedOf(page, "protocol_error"), []);
				await page.locator('#status[data-state="connected"]').waitFor({ timeout: 5_000 });
			},
			{ patch },
		);
	});

	for (const [missing, registry] of [
		[
			"projects",
			{ projects: [null, { id: "bad id", name: "x", root: "/x" }], harnesses: [{ id: "draht", isDefault: true }] },
		],
		[
			"harnesses",
			{ projects: [{ id: "fixture", name: "F", root: "/f" }], harnesses: [null, { id: "has space", isDefault: true }] },
		],
	]) {
		it(`says there are no ${missing} when none of the rows is usable, instead of a blank panel`, async () => {
			await withConsole(
				equipped,
				async ({ page }) => {
					await page.tap(NEW_SESSION);
					await waitForText(page, PICKER, `no ${missing} available on this machine`);
					assert.equal(await page.locator(`${PICKER} input, ${PICKER} button`).count(), 0, "an empty picker offers a control");
				},
				{ patch: { registry } },
			);
		});
	}
});
