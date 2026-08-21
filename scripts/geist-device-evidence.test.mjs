/**
 * Tests for the device-evidence harness (R33-REACH.2).
 *
 * R33-REACH.2 is a **class 4** requirement: the only thing that can satisfy it
 * is an iPhone and a Quest 3 in a human's hands, on a real tailnet, loading a
 * real served bundle. No test in this file — or anywhere else in this repo —
 * can produce that evidence, and none of them pretends to.
 *
 * What *can* be tested, and is tested here, is the machinery around the run:
 * the order the harness brings the processes up in, what it publishes (the
 * observer's port, not the gateway's, or nothing sees the upgrades), how it
 * classifies and pins a browser from an observed User-Agent, how it reads a
 * WebSocket close code off the wire, how it bounds the idle probe so it reports
 * a number instead of hanging, and — the test the task names first — how
 * `--finalize` refuses an incomplete manifest and says exactly which slot is
 * empty.
 *
 * Every process the harness would spawn is a fake here. That is the point: the
 * control flow is proven without hardware so that the run itself is one
 * command, and the only thing the human contributes is the two devices.
 *
 * Run: node --test scripts/geist-device-evidence.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	classifyUserAgent,
	createCloseSniffer,
	createPrompter,
	describeUserAgent,
	EXIT,
	finalizeEvidence,
	main,
	parseArgs,
	probeIdleTimeout,
	realDeps,
	REQUIRED_DEVICES,
	runEvidence,
	startObserverProxy,
	validateEvidence,
	watchTransition,
} from "./geist-device-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const workdirs = [];
function workdir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	workdirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Draft fixtures
// ---------------------------------------------------------------------------

const IOS_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const QUEST_UA =
	"Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/34.5.0.2.45 SamsungBrowser/4.0 Chrome/126.0.6478.122 VR Safari/537.36";
const DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * A device entry with every slot filled. Tests empty individual slots out of it.
 *
 * `osVersion` is passed in for the Quest because its User-Agent genuinely does
 * not carry one — the harness asks a human for it rather than deriving it from
 * the browser build, and the fixture stands in for that answer.
 */
function completeDevice(id, ua, osVersion) {
	return {
		label: id,
		userAgent: ua,
		browser: describeUserAgent(ua).browser,
		os: { ...describeUserAgent(ua).os, version: osVersion ?? describeUserAgent(ua).os.version },
		screenshots: [`screenshots/${id}-session.png`],
		consoleLog: `console/${id}.log`,
		upgrades: [{ at: "2026-08-20T10:00:01.000Z", ua, path: "/attach", lifetimeMs: 61_000, closeCode: 1000 }],
	};
}

/** A draft whose every referenced artifact also exists on disk, in a fresh directory. */
function completeDraft(dir) {
	mkdirSync(join(dir, "screenshots"), { recursive: true });
	mkdirSync(join(dir, "console"), { recursive: true });
	for (const id of REQUIRED_DEVICES) {
		writeFileSync(join(dir, "screenshots", `${id}-session.png`), "not-really-a-png-but-not-empty");
		writeFileSync(join(dir, "console", `${id}.log`), "[log] geist console ready\n");
	}
	return {
		schema: "geist-device-evidence/1",
		requirement: "R33-REACH.2",
		capturedAt: "2026-08-20T10:00:00.000Z",
		origin: "https://fake-mac.tailbeef.ts.net",
		build: { command: "npm run build", cli: "/repo/packages/coding-agent/dist/cli.js", builtAt: "2026-08-20T09:00:00.000Z" },
		tailscale: { version: "1.80.3" },
		measured: false,
		devices: {
			"ios-safari": completeDevice("ios-safari", IOS_UA),
			"quest-browser": completeDevice("quest-browser", QUEST_UA, "v81"),
		},
	};
}

function writeDraft(dir, draft) {
	const path = join(dir, "draft.json");
	writeFileSync(path, JSON.stringify(draft, null, "\t"));
	return path;
}

/** A free loopback port, so the test does not fight whatever is on 7878. */
function freeLoopbackPort() {
	return new Promise((resolvePromise, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolvePromise(port));
		});
	});
}

/** Poll until a condition holds, with an explicit bound: a hanging test is worse than a failing one. */
async function until(probe, what, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probe()) return;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 20));
	}
}

/** The set of slot names a validation reported empty. */
function emptySlots(result) {
	return new Set(result.missing.map((entry) => entry.slot));
}

// ---------------------------------------------------------------------------
// The named test
// ---------------------------------------------------------------------------

test("--finalize refuses to write a manifest that is missing a browser version, a screenshot or a console log, and names exactly which slot is empty", async () => {
	const dir = workdir("gde-incomplete-");
	const draft = completeDraft(dir);

	// Three different kinds of hole, one of each kind the requirement names.
	draft.devices["ios-safari"].browser = { name: "Mobile Safari", version: "" };
	// A screenshot path that is *declared* but never landed on disk. This is the
	// failure mode that matters: a manifest listing a screenshot nobody took
	// reads exactly like a manifest listing one somebody did.
	rmSync(join(dir, "screenshots", "quest-browser-session.png"));
	// A console log that was opened and never written to. Zero bytes is
	// indistinguishable from "not captured", so it is refused as not captured.
	writeFileSync(join(dir, "console", "ios-safari.log"), "");

	const draftPath = writeDraft(dir, draft);

	const errors = [];
	const code = await main(["--finalize", "--draft", draftPath, "--out", dir], {
		log: () => {},
		err: (line) => errors.push(line),
	});

	assert.equal(code, EXIT.INCOMPLETE, "an incomplete manifest must not exit 0");
	assert.equal(existsSync(join(dir, "manifest.json")), false, "no manifest may be written when evidence is incomplete");

	const stderr = errors.join("\n");
	// Exactly which slot: the three holes, named individually.
	assert.match(stderr, /devices\[ios-safari\]\.browser\.version/);
	assert.match(stderr, /devices\[quest-browser\]\.screenshots/);
	assert.match(stderr, /devices\[ios-safari\]\.consoleLog/);
	// And *only* those: a filled slot must never be reported empty, or the
	// operator learns to skim the list.
	assert.doesNotMatch(stderr, /devices\[ios-safari\]\.screenshots/);
	assert.doesNotMatch(stderr, /devices\[quest-browser\]\.consoleLog/);
	assert.doesNotMatch(stderr, /devices\[quest-browser\]\.browser\.version/);

	// The same three, exactly, from the validator the CLI is a thin shell over.
	const result = validateEvidence(draft, { dir });
	assert.equal(result.ok, false);
	assert.deepEqual(
		emptySlots(result),
		new Set([
			"devices[ios-safari].browser.version",
			"devices[quest-browser].screenshots",
			"devices[ios-safari].consoleLog",
		]),
	);
});

// ---------------------------------------------------------------------------
// The rest of --finalize
// ---------------------------------------------------------------------------

test("--finalize writes the manifest when every slot is filled, pinning versions, artifacts and the build command", async () => {
	const dir = workdir("gde-complete-");
	const draft = completeDraft(dir);
	const draftPath = writeDraft(dir, draft);

	const lines = [];
	const code = await main(["--finalize", "--draft", draftPath, "--out", dir], {
		log: (line) => lines.push(line),
		err: (line) => lines.push(line),
	});

	assert.equal(code, EXIT.OK, lines.join("\n"));
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	assert.equal(manifest.requirement, "R33-REACH.2");
	assert.equal(manifest.devices["ios-safari"].browser.version, "18.5");
	assert.equal(manifest.devices["quest-browser"].browser.name, "Oculus Browser");
	// The recorded lesson: a run is only evidence if the build state it ran
	// against is named.
	assert.equal(manifest.build.command, "npm run build");
	assert.ok(manifest.devices["ios-safari"].upgrades.length >= 1);
});

test("--finalize names a whole missing device, not just its fields", () => {
	const dir = workdir("gde-missing-device-");
	const draft = completeDraft(dir);
	delete draft.devices["quest-browser"];

	const result = validateEvidence(draft, { dir });
	assert.equal(result.ok, false);
	assert.deepEqual(emptySlots(result), new Set(["devices[quest-browser]"]));
	// One line, not six: a device that was never brought to the run is one hole.
	assert.match(result.missing[0].why, /not captured/i);
});

test("--finalize refuses a device whose only evidence is a load, with no observed WS upgrade", () => {
	const dir = workdir("gde-no-upgrade-");
	const draft = completeDraft(dir);
	draft.devices["quest-browser"].upgrades = [];

	const result = validateEvidence(draft, { dir });
	assert.equal(result.ok, false);
	assert.deepEqual(emptySlots(result), new Set(["devices[quest-browser].upgrades"]));
});

test("--finalize refuses a measured draft whose lock/unlock and tailnet transitions were never recorded", () => {
	const dir = workdir("gde-measure-");
	const draft = completeDraft(dir);
	draft.measured = true;
	draft.devices["ios-safari"].measurements = {
		idleTimeoutMs: 240_000,
		lockUnlock: [{ transition: "locked", at: "2026-08-20T10:05:00.000Z", closeCode: 1006 }],
		tailnetToggle: [],
	};
	// quest-browser has no measurements block at all.

	const result = validateEvidence(draft, { dir });
	assert.equal(result.ok, false);
	assert.deepEqual(
		emptySlots(result),
		new Set(["devices[ios-safari].measurements.tailnetToggle", "devices[quest-browser].measurements"]),
	);

	// Without --measure those slots are not asked for, and the same draft passes.
	draft.measured = false;
	assert.equal(validateEvidence(draft, { dir }).ok, true);
});

test("finalizeEvidence never leaves a partial manifest behind when validation fails", () => {
	const dir = workdir("gde-atomic-");
	const draft = completeDraft(dir);
	draft.origin = "";

	assert.throws(
		() => finalizeEvidence({ draft, dir }),
		(error) => {
			assert.match(error.message, /origin/);
			assert.equal(error.missing.length, 1);
			return true;
		},
	);
	assert.equal(existsSync(join(dir, "manifest.json")), false);
});

// ---------------------------------------------------------------------------
// User-Agent classification and pinning
// ---------------------------------------------------------------------------

test("a User-Agent is classified into the two devices the requirement names, and a laptop is neither", () => {
	assert.equal(classifyUserAgent(IOS_UA), "ios-safari");
	assert.equal(classifyUserAgent(QUEST_UA), "quest-browser");
	assert.equal(classifyUserAgent(DESKTOP_UA), "other");
	// Chrome-on-iOS is an iPhone but not iOS Safari. Recording it as iOS Safari
	// would pin a version for a browser that never ran.
	assert.equal(
		classifyUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
		),
		"other",
	);
});

test("browser and OS versions are read out of the observed User-Agent, and are null when it does not say", () => {
	assert.deepEqual(describeUserAgent(IOS_UA), {
		browser: { name: "Mobile Safari", version: "18.5" },
		os: { name: "iOS", version: "18.5" },
	});
	assert.deepEqual(describeUserAgent(QUEST_UA), {
		browser: { name: "Oculus Browser", version: "34.5.0.2.45" },
		os: { name: "Meta Horizon OS", version: null },
	});
	// Nothing is invented for a UA that does not carry a version.
	const vague = describeUserAgent("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile Safari/604.1");
	assert.equal(vague.browser.version, null);
	assert.equal(vague.os.version, null);
	// …and a null version is an empty slot, so it can never reach a manifest.
	const dir = workdir("gde-vague-");
	const draft = completeDraft(dir);
	draft.devices["ios-safari"].browser = vague.browser;
	draft.devices["ios-safari"].os = vague.os;
	assert.deepEqual(
		emptySlots(validateEvidence(draft, { dir })),
		new Set(["devices[ios-safari].browser.version", "devices[ios-safari].os.version"]),
	);
});

// ---------------------------------------------------------------------------
// Close-code sniffing
// ---------------------------------------------------------------------------

/** A server→client close frame: unmasked, code big-endian in the first two payload bytes. */
function serverClose(code, reason = "") {
	const payload = Buffer.concat([Buffer.alloc(2), Buffer.from(reason)]);
	payload.writeUInt16BE(code, 0);
	return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

/** A client→server close frame: masked, as every browser sends it. */
function clientClose(code, reason = "") {
	const payload = Buffer.concat([Buffer.alloc(2), Buffer.from(reason)]);
	payload.writeUInt16BE(code, 0);
	const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
	const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
	return Buffer.concat([Buffer.from([0x88, 0x80 | payload.length]), mask, masked]);
}

test("the close sniffer reads a close code from either half of the wire, across chunk boundaries", () => {
	const fromServer = createCloseSniffer();
	assert.equal(fromServer.feed(Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63])), null, "a text frame is not a close");
	assert.equal(fromServer.feed(serverClose(1001, "going away")), 1001);

	const fromClient = createCloseSniffer();
	const frame = clientClose(1000, "bye");
	// Split the frame in three, mid-header and mid-payload: a real socket does.
	assert.equal(fromClient.feed(frame.subarray(0, 1)), null);
	assert.equal(fromClient.feed(frame.subarray(1, 5)), null);
	assert.equal(fromClient.feed(frame.subarray(5)), 1000);

	// A close with no payload at all carries no code; that is not 0, it is unknown.
	const empty = createCloseSniffer();
	assert.equal(empty.feed(Buffer.from([0x88, 0x00])), null);
	assert.equal(empty.sawClose, true);
});

// ---------------------------------------------------------------------------
// The observing proxy
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptKey(key) {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}

/** A backend that accepts a WS upgrade and closes it with a chosen code. */
function fakeBackend({ closeCode = 1000, closeAfterMs = 20 } = {}) {
	// Tracked so `close()` can drop them: a fake that only stops listening leaves
	// its live sockets holding the event loop open, and a suite that ends by
	// waiting out a 60-second timer is a suite nobody runs.
	const live = new Set();
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
	});
	server.on("connection", (socket) => {
		live.add(socket);
		socket.on("close", () => live.delete(socket));
	});
	server.on("upgrade", (req, socket) => {
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${acceptKey(req.headers["sec-websocket-key"])}`,
				"",
				"",
			].join("\r\n"),
		);
		const timer = setTimeout(() => {
			socket.write(serverClose(closeCode));
			socket.end();
		}, closeAfterMs);
		socket.on("close", () => clearTimeout(timer));
		socket.on("error", () => clearTimeout(timer));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({
				port: server.address().port,
				close: () => {
					for (const socket of live) socket.destroy();
					live.clear();
					server.close();
				},
			}),
		);
	});
}

/** Speak the client half by hand, so the User-Agent is ours to choose. */
function rawUpgrade({ port, path = "/attach", userAgent }) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(
				[
					`GET ${path} HTTP/1.1`,
					`Host: 127.0.0.1:${port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Sec-WebSocket-Version: 13",
					`User-Agent: ${userAgent}`,
					"",
					"",
				].join("\r\n"),
			);
		});
		// Drain: a socket with no reader stays paused, so the peer's FIN never
		// ends it and `close` never fires. A browser reads its socket; so do we.
		socket.resume();
		socket.setTimeout(10_000, () => {
			socket.destroy();
			reject(new Error("raw upgrade timed out"));
		});
		socket.once("error", reject);
		socket.once("close", () => resolve());
	});
}

test("the observer records every upgrade server-side — UA, path, lifetime and close code — without the device reporting anything", async () => {
	const backend = await fakeBackend({ closeCode: 1001, closeAfterMs: 40 });
	const observer = await startObserverProxy({ backend: { host: "127.0.0.1", port: backend.port } });
	try {
		await rawUpgrade({ port: observer.port, userAgent: IOS_UA });
		await rawUpgrade({ port: observer.port, path: "/attach?session=abc", userAgent: QUEST_UA });
		// The client's own socket close and the proxy's are two different events
		// on two different sockets; wait for the proxy to finish its records
		// rather than assuming an ordering between them. Bounded, so a proxy that
		// never finalises fails instead of hanging.
		await until(() => observer.records.filter((record) => record.lifetimeMs !== null).length === 2, "both records to close");

		assert.equal(observer.records.length, 2);
		const [ios, quest] = observer.records;
		assert.equal(ios.ua, IOS_UA);
		assert.equal(ios.device, "ios-safari");
		assert.equal(ios.path, "/attach");
		assert.equal(ios.closeCode, 1001, "the code the backend sent, read off the wire");
		assert.ok(ios.lifetimeMs >= 30, `lifetime ${ios.lifetimeMs}ms should span the 40ms the socket was open`);
		assert.equal(quest.device, "quest-browser");
	} finally {
		await observer.close();
		backend.close();
	}
});

test("the observer closes out a record when the client vanishes without a close frame — the phone case", async () => {
	// The most important disconnect on a phone is the one with no close frame at
	// all: the screen locks, the tailnet drops, the TCP connection just stops.
	// Every other test here has the *backend* close first, which exercises a
	// different path through the proxy. If this one is broken the manifest
	// records `lifetimeMs: null` for exactly the events Phase 39 is about.
	const backend = await fakeBackend({ closeAfterMs: 30_000 });
	const observer = await startObserverProxy({ backend: { host: "127.0.0.1", port: backend.port } });
	try {
		const socket = connect(observer.port, "127.0.0.1", () => {
			socket.write(
				[
					"GET /attach HTTP/1.1",
					`Host: 127.0.0.1:${observer.port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Sec-WebSocket-Version: 13",
					`User-Agent: ${IOS_UA}`,
					"",
					"",
				].join("\r\n"),
			);
		});
		socket.resume();
		await until(() => observer.records[0]?.upgraded === true, "the upgrade to complete");
		// The phone goes away. No close frame, no FIN handshake.
		socket.destroy();

		await until(() => observer.records[0]?.lifetimeMs !== null, "the record to close out");
		const record = observer.records[0];
		assert.ok(record.lifetimeMs >= 0, "a vanished client still has a measured lifetime");
		assert.equal(record.closeCode, null, "no frame crossed, so there is no code to report");
		assert.equal(record.closedBy, "client");
	} finally {
		await observer.close();
		backend.close();
	}
});

test("the observer passes plain HTTP through, so the bundle it is measuring is the bundle that is served", async () => {
	const backend = await fakeBackend();
	const observer = await startObserverProxy({ backend: { host: "127.0.0.1", port: backend.port } });
	try {
		const response = await fetch(`http://127.0.0.1:${observer.port}/ui`, { headers: { "user-agent": IOS_UA } });
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "ok");
		assert.equal(observer.requests.at(-1).path, "/ui");
	} finally {
		await observer.close();
		backend.close();
	}
});

// ---------------------------------------------------------------------------
// The idle probe
// ---------------------------------------------------------------------------

test("the idle probe reports the measured idle timeout and its close code", async () => {
	const backend = await fakeBackend({ closeCode: 1001, closeAfterMs: 120 });
	try {
		const measured = await probeIdleTimeout({
			url: `ws://127.0.0.1:${backend.port}/attach`,
			maxMs: 5_000,
			handshake: async () => {},
		});
		assert.equal(measured.closed, true);
		assert.equal(measured.closeCode, 1001);
		assert.ok(measured.idleMs >= 80, `idleMs ${measured.idleMs} should be around 120`);
	} finally {
		backend.close();
	}
});

test("the idle probe gives up at its bound instead of hanging, and says the timeout was not reached", async () => {
	// A backend that never closes: without a bound this probe would hang the run.
	const backend = await fakeBackend({ closeAfterMs: 60_000 });
	try {
		const measured = await probeIdleTimeout({
			url: `ws://127.0.0.1:${backend.port}/attach`,
			maxMs: 250,
			handshake: async () => {},
		});
		assert.equal(measured.closed, false);
		assert.equal(measured.closeCode, null);
		assert.ok(measured.idleMs >= 250);
		assert.match(measured.note, /still open/i);
	} finally {
		backend.close();
	}
});

// ---------------------------------------------------------------------------
// The run's control flow
// ---------------------------------------------------------------------------

/** Fakes for every process the run would spawn, plus a log of the order they were used in. */
function fakeRunDeps(overrides = {}) {
	const order = [];
	const stopped = [];
	const base = {
		build: async () => {
			order.push("build");
			return { command: "npm run build", cli: "/repo/packages/coding-agent/dist/cli.js", builtAt: "2026-08-20T09:00:00.000Z" };
		},
		startSession: async () => {
			order.push("startSession");
			return { sessionId: "sess-1", socketDir: "/tmp/sockets", stop: async () => stopped.push("session") };
		},
		startGateway: async () => {
			order.push("startGateway");
			return { port: 41000, bootstraps: ["boot-1", "boot-2"], stop: async () => stopped.push("gateway") };
		},
		startObserver: async () => {
			order.push("startObserver");
			return { port: 41001, records: [], requests: [], close: async () => stopped.push("observer") };
		},
		publish: async ({ port }) => {
			order.push(`publish:${port}`);
			return { origin: "https://fake-mac.tailbeef.ts.net", tailscaleVersion: "1.80.3" };
		},
		pair: async ({ origin }) => {
			order.push("pair");
			return { url: `${origin}/ui#token=boot-1`, qr: "▄▄▄ QR ▄▄▄" };
		},
		awaitDevices: async () => {
			order.push("awaitDevices");
			return {
				"ios-safari": { userAgent: IOS_UA, upgrades: [{ at: "t", ua: IOS_UA, path: "/attach", lifetimeMs: 5, closeCode: 1000 }] },
				"quest-browser": {
					userAgent: QUEST_UA,
					upgrades: [{ at: "t", ua: QUEST_UA, path: "/attach", lifetimeMs: 5, closeCode: 1000 }],
				},
			};
		},
		measure: async () => {
			order.push("measure");
			return {
				"ios-safari": { idleTimeoutMs: 240_000, lockUnlock: [{ transition: "locked" }], tailnetToggle: [{ transition: "off" }] },
				"quest-browser": { idleTimeoutMs: 240_000, lockUnlock: [{ transition: "locked" }], tailnetToggle: [{ transition: "off" }] },
			};
		},
		log: () => {},
		err: () => {},
	};
	return { deps: { ...base, ...overrides }, order, stopped };
}

test("the run brings the fleet up in order and publishes the observer's port, not the gateway's", async () => {
	const dir = workdir("gde-run-");
	const { deps, order, stopped } = fakeRunDeps();
	const result = await runEvidence({ out: dir, measure: false }, deps);

	assert.deepEqual(order, [
		"build",
		"startSession",
		"startGateway",
		"startObserver",
		// 41001 is the observer, 41000 the gateway. Publishing the gateway would
		// serve the same bundle and observe nothing — the whole point of the
		// harness is that the upgrades are seen without the device reporting them.
		"publish:41001",
		"pair",
		"awaitDevices",
	]);
	assert.deepEqual(stopped.sort(), ["gateway", "observer", "session"]);

	const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));
	assert.equal(draft.origin, "https://fake-mac.tailbeef.ts.net");
	assert.equal(draft.build.command, "npm run build");
	assert.equal(draft.measured, false);
	assert.deepEqual(Object.keys(draft.devices).sort(), [...REQUIRED_DEVICES].sort());
	assert.equal(result.draftPath, join(dir, "draft.json"));
});

test("--measure adds the idle probe and the recorded lock/unlock and tailnet transitions", async () => {
	const dir = workdir("gde-run-measure-");
	const { deps, order } = fakeRunDeps();
	await runEvidence({ out: dir, measure: true }, deps);

	assert.ok(order.includes("measure"), `measure step missing from ${order.join(" → ")}`);
	const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));
	assert.equal(draft.measured, true);
	assert.equal(draft.devices["ios-safari"].measurements.idleTimeoutMs, 240_000);
	assert.equal(draft.devices["quest-browser"].measurements.tailnetToggle.length, 1);
});

test("a failed publish stops everything it started and never mints a bootstrap token", async () => {
	const dir = workdir("gde-run-fail-");
	const { deps, order, stopped } = fakeRunDeps({
		publish: async () => {
			order.push("publish");
			throw new Error("DNS_FAILURE: MagicDNS name did not resolve");
		},
	});

	await assert.rejects(() => runEvidence({ out: dir, measure: false }, deps), /DNS_FAILURE/);
	// Nothing to send a token to means nothing is minted: a live bootstrap
	// credential nobody ever saw is a credential with no owner.
	assert.equal(order.includes("pair"), false);
	assert.deepEqual(stopped.sort(), ["gateway", "observer", "session"]);
	assert.equal(existsSync(join(dir, "draft.json")), false);
});

test("the run refuses a device that never showed up rather than writing a draft that finalize will reject", async () => {
	const dir = workdir("gde-run-missing-");
	const { deps } = fakeRunDeps({
		awaitDevices: async () => ({
			"ios-safari": { userAgent: IOS_UA, upgrades: [{ at: "t", ua: IOS_UA, path: "/attach", lifetimeMs: 5, closeCode: 1000 }] },
		}),
	});

	await assert.rejects(() => runEvidence({ out: dir, measure: false }, deps), /quest-browser/);
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test("a measured transition records what the observer saw around it, not what the operator says happened", async () => {
	// The operator's only contribution is pressing enter. Everything in the
	// record — did the socket drop, with what code, did it come back — is read
	// off the observer, because those are exactly the three facts a person
	// cannot supply and the three Phase 39 has to be designed against.
	const open = { device: "ios-safari", lifetimeMs: null, closeCode: null, closedBy: null };
	const observer = { records: [open] };

	const result = await watchTransition({
		observer,
		device: "ios-safari",
		log: () => {},
		prompt: "lock the device",
		bound: 5_000,
		transition: "lock the device",
		settleMs: 5,
		// Pressing enter is where the world changes: the phone locked, the socket
		// died without a close frame, and the page reconnected on unlock.
		ask: async () => {
			open.lifetimeMs = 41_000;
			open.closeCode = null;
			open.closedBy = "client";
			observer.records.push({ device: "ios-safari", lifetimeMs: null, closeCode: null, closedBy: null });
			return "";
		},
	});

	assert.equal(result.transition, "lock the device");
	assert.equal(result.openBefore, 1);
	assert.equal(result.openAfter, 1, "the reconnect is open again");
	assert.equal(result.reconnected, 1, "…and it is a new socket, not the old one");
	assert.equal(result.closed, true);
	assert.equal(result.lifetimeMs, 41_000);
	// A socket that died without a close frame has no code. Recorded as null —
	// never as 1006, which is a code the browser synthesises and the wire never
	// carries.
	assert.equal(result.closeCode, null);
	assert.equal(result.observedCloseCount, 1);

	// A transition where nothing at all happened must not read as a drop.
	const quiet = { device: "quest-browser", lifetimeMs: null, closeCode: null, closedBy: null };
	const still = await watchTransition({
		observer: { records: [quiet] },
		device: "quest-browser",
		log: () => {},
		prompt: "toggle",
		bound: 5_000,
		settleMs: 5,
		ask: async () => "",
	});
	assert.equal(still.closed, false, "an untouched socket is not a disconnect");
	assert.equal(still.reconnected, 0);
});

test("a prompt whose input has run out resolves null instead of holding the run open", async () => {
	// The failure this pins down was observed, not imagined: one readline
	// interface per question meant that once piped stdin was exhausted the next
	// `question` callback simply never fired, and the run sat on its 15-minute
	// prompt bound with nothing left to read. A prompt that cannot be answered
	// has to say so immediately — an unanswerable prompt is a hang, and a hang
	// costs the operator the whole session with both devices in hand.
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();
	const prompter = createPrompter({ input, output });
	try {
		const first = prompter.ask("browser version?", { timeoutMs: 5_000 });
		input.write("18.5\n");
		assert.equal(await first, "18.5");

		const second = prompter.ask("os version?", { timeoutMs: 5_000 });
		input.end();
		assert.equal(await second, null, "an exhausted input must resolve, not wait out the bound");

		assert.equal(await prompter.ask("and again?", { timeoutMs: 5_000 }), null);
	} finally {
		prompter.close();
	}
});

test("realDeps wires the observer to the gateway it was given and binds the port that gets published", async () => {
	// Every other run test replaces `startObserver` with a fake, which means the
	// real one — the piece that decides what is proxied where — is the one thing
	// the fakes cannot check. It is also the piece whose failure mode is silent:
	// an observer that binds an ephemeral port publishes a mapping to a port
	// nothing serves, and the operator sees a QR that leads nowhere.
	const backend = await fakeBackend();
	const port = await freeLoopbackPort();
	const deps = realDeps({ log: () => {}, err: () => {}, options: { ...parseArgs(["--port", String(port)]), out: workdir("gde-realdeps-") } });
	const observer = await deps.startObserver({ backendPort: backend.port });
	try {
		assert.equal(observer.port, port, "the observer must bind the port that will be published");
		const response = await fetch(`http://127.0.0.1:${observer.port}/ui`);
		assert.equal(await response.text(), "ok", "…and proxy to the gateway it was handed, not to itself");
	} finally {
		await observer.close();
		backend.close();
	}
});

test("parseArgs names the three modes and defaults the evidence directory to a dated path", () => {
	const run = parseArgs([]);
	assert.equal(run.mode, "run");
	assert.equal(run.measure, false);
	assert.match(run.out, /\.planning\/geist\/evidence\/\d{4}-\d{2}-\d{2}-devices$/);

	// The published port is stable by default, and 7878 is the phase's port
	// everywhere else. An ephemeral port would leave a fresh `tailscale serve`
	// mapping behind on every run — the publish script is idempotent *per port*,
	// so a random port defeats it and litters the tailnet with dead handlers.
	assert.equal(run.port, 7878);
	assert.equal(parseArgs(["--port", "9000"]).port, 9000);

	assert.equal(parseArgs(["--measure"]).measure, true);
	assert.equal(parseArgs(["--finalize"]).mode, "finalize");
	assert.equal(parseArgs(["--date", "2026-09-01"]).out.endsWith("2026-09-01-devices"), true);
	assert.equal(parseArgs(["--out", "/tmp/x"]).out, "/tmp/x");
	assert.throws(() => parseArgs(["--nope"]), /unknown/i);
	assert.throws(() => parseArgs(["--port"]), /--port/);
});

test("the shipped entrypoint refuses an incomplete draft when it is spawned, not just when it is imported", async () => {
	// Every other test here calls `main()` in-process, which cannot see a broken
	// shebang, a bad import or an entrypoint guard that never fires. This one
	// runs the file the way an operator runs it. It is still not class 3 for
	// R33-REACH.2 — the requirement is about two devices, and no spawn produces
	// those — but it does prove the command an operator types actually works.
	const dir = workdir("gde-spawn-");
	const draft = completeDraft(dir);
	rmSync(join(dir, "console", "quest-browser.log"));
	draft.devices["quest-browser"].consoleLog = "console/quest-browser.log";
	writeDraft(dir, draft);

	const result = await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [join(HERE, "geist-device-evidence.mjs"), "--finalize", "--out", dir], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", reject);
		child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
	});

	assert.equal(result.code, EXIT.INCOMPLETE, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /devices\[quest-browser\]\.consoleLog/);
	assert.equal(existsSync(join(dir, "manifest.json")), false);
});

test("the harness never offers a flag that would put a credential in a URL", () => {
	const source = readFileSync(join(HERE, "geist-device-evidence.mjs"), "utf8");
	assert.doesNotMatch(source, /[?&]token=/, "R33-REACH.3: no query-string credential, anywhere, ever");
});
