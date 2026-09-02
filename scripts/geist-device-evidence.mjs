#!/usr/bin/env node
/**
 * The device-evidence harness — one command between a running draht session and
 * the archived class-4 capture R33-REACH.2 asks for.
 *
 * R33-REACH.2 wants archived evidence that **iOS Safari and the Quest 3 browser
 * each load the served bundle over `https://<magicdns>` and complete a WS
 * upgrade**, with pinned browser/OS versions, screenshots, console logs, and the
 * measured idle-timeout / sleep-wake / tailnet-drop behaviour that Phase 39 is
 * supposed to be designed against. That is class 4: two real devices, a real
 * tailnet, a human. Nothing in this repo can synthesise it and this script does
 * not try. What it removes is everything *around* the two devices — the six
 * processes, the port plumbing, and above all the transcription.
 *
 * Three design decisions carry the whole file.
 *
 * **The upgrades are observed server-side, never reported by the device.**
 * `tailscale serve` is pointed at {@link startObserverProxy}, not at the
 * gateway, and the observer sits in the middle of every request and every
 * WebSocket: it records the User-Agent, the path, how long the socket lived and
 * the close code it read off the wire. A phone cannot be asked what its close
 * code was, and a human retyping "it disconnected after about four minutes" is
 * exactly the transcription step this script exists to delete. The observer is
 * plain HTTP on loopback because TLS is already terminated by `tailscale serve`
 * one hop earlier — see `scripts/fixtures/tls-proxy.mjs` for the CI-side
 * reproduction of that topology.
 *
 * **Nothing is invented to fill a slot.** Browser and OS versions are read out
 * of the observed User-Agent, and are `null` when the UA does not carry them —
 * the Quest browser's UA names the browser build but not the Horizon OS version,
 * so the harness *asks* rather than guessing. A `null` version is an empty slot,
 * and {@link validateEvidence} refuses to write a manifest with an empty slot in
 * it. A manifest that says "iOS 18.5" because a script assumed is worse than no
 * manifest: it is a fabricated capture wearing the costume of a real one.
 *
 * **A refusal names the slot.** `--finalize` prints one line per hole —
 * `devices[quest-browser].screenshots — declared screenshots/q.png, which does
 * not exist` — and only for holes. An operator who is shown filled slots
 * alongside empty ones learns to skim the list, which is how a run ends up
 * archived with a screenshot nobody ever took.
 *
 * Usage:
 *   node scripts/geist-device-evidence.mjs                # the run
 *   node scripts/geist-device-evidence.mjs --measure      # + idle probe and transitions
 *   node scripts/geist-device-evidence.mjs --finalize     # validate and write manifest.json
 *
 * The run needs a tailnet and the two devices. Everything else — the ordering,
 * the port that gets published, the UA pinning, the close-code read, the idle
 * probe's bound, and every refusal `--finalize` can produce — is exercised
 * against fakes in `scripts/geist-device-evidence.test.mjs`.
 *
 * Evidence class: this script *produces* class-4 evidence when a human runs it
 * with two devices. Its own test suite is class 2 (in-process, fakes) and closes
 * nothing on its own — see `.planning/TEST-STRATEGY.md`.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { publish as tailscalePublish, runTailscale } from "./geist-tailscale-serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DRAHT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");
const GEIST_CLI = join(REPO_ROOT, "packages/geist/dist/cli.js");
const GATEWAY_SERVER = join(REPO_ROOT, "packages/gateway/src/gateway/server.ts");
const GEIST_CORE = join(REPO_ROOT, "packages/geist-core/src/index.ts");
const EVIDENCE_ROOT = join(REPO_ROOT, ".planning/geist/evidence");

/** The WS path the console attaches on. A flag because a route rename must not silently observe nothing. */
const DEFAULT_WS_PATH = "/attach";
/** Where the bundle is served, and therefore what the QR's deep link opens. */
const UI_PATH = "/ui";

/**
 * The run's scratch directory, directly under /tmp and nowhere else.
 *
 * macOS `os.tmpdir()` is already ~50 characters before a session uuid is
 * appended, and a Unix socket path over ~104 bytes fails to bind with EINVAL —
 * so an attachable session rooted anywhere deeper simply never publishes a
 * socket, and the run times out waiting for one that could not exist.
 */
const RUN_DIR_PREFIX = "/tmp/geist-device-evidence-";

export const MANIFEST_SCHEMA = "geist-device-evidence/1";

/**
 * The two devices R33-REACH.2 names. Not configurable: the requirement is about
 * *these two*, and a run that quietly settled for one of them plus a laptop
 * would archive evidence for a claim nobody made.
 */
export const REQUIRED_DEVICES = Object.freeze(["ios-safari", "quest-browser"]);

export const EXIT = Object.freeze({
	OK: 0,
	USAGE: 2,
	/** Evidence has a hole in it. Distinct from a crashed run: nothing is wrong, something is missing. */
	INCOMPLETE: 65,
	RUN_FAILED: 70,
});

/** Screenshots and console logs are looked for here, relative to the evidence directory. */
const SCREENSHOT_DIR = "screenshots";
const CONSOLE_DIR = "console";
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".webp"]);
const CONSOLE_EXTENSIONS = new Set([".log", ".txt", ".json", ".ndjson"]);

/** Thrown by {@link finalizeEvidence}. Carries the slots, so a caller can print them one per line. */
export class EvidenceIncompleteError extends Error {
	constructor(missing) {
		super(`evidence is incomplete: ${missing.map((entry) => entry.slot).join(", ")}`);
		this.name = "EvidenceIncompleteError";
		this.missing = missing;
	}
}

// ---------------------------------------------------------------------------
// Reading a device off its User-Agent
// ---------------------------------------------------------------------------

/**
 * Which of the two required devices this User-Agent is, or `"other"`.
 *
 * Deliberately narrow at both ends. Chrome and Firefox on iOS are still WebKit
 * underneath, but they are not iOS Safari, and pinning "Mobile Safari 18.5"
 * from a `CriOS` UA would put a version in the manifest for a browser that
 * never ran. Everything unrecognised is `"other"` — a laptop that happens to
 * hit the published origin mid-run must not be silently promoted into the
 * evidence.
 */
export function classifyUserAgent(ua) {
	if (typeof ua !== "string" || ua.length === 0) return "other";
	if (/OculusBrowser|Quest \d/i.test(ua)) return "quest-browser";
	if (/(iPhone|iPad|iPod)/.test(ua)) {
		// The iOS browsers that are not Safari all announce themselves.
		if (/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(ua)) return "other";
		if (/Safari/.test(ua)) return "ios-safari";
	}
	return "other";
}

/**
 * Browser and OS, as far as the User-Agent actually says.
 *
 * `null` is a real answer here and the important one: the Quest browser's UA
 * carries `OculusBrowser/<build>` but nothing at all about the Horizon OS
 * version, so that field comes back null and the run asks a human for it. The
 * alternative — deriving a plausible OS version from the browser build — is the
 * exact shape of fabrication this phase is auditing for.
 */
export function describeUserAgent(ua) {
	const safe = typeof ua === "string" ? ua : "";

	const oculus = /OculusBrowser\/([\d.]+)/i.exec(safe);
	if (oculus || /Quest \d/i.test(safe)) {
		const android = /Android ([\d.]+)/.exec(safe);
		return {
			browser: { name: "Oculus Browser", version: oculus?.[1] ?? null },
			os: { name: "Meta Horizon OS", version: android?.[1] ?? null },
		};
	}

	if (/(iPhone|iPad|iPod)/.test(safe)) {
		const version = /Version\/([\d.]+)/.exec(safe);
		const osVersion = /OS (\d+[\d_]*) like Mac OS X/.exec(safe);
		return {
			browser: { name: "Mobile Safari", version: version?.[1] ?? null },
			os: { name: "iOS", version: osVersion ? osVersion[1].replace(/_/g, ".") : null },
		};
	}

	return { browser: { name: null, version: null }, os: { name: null, version: null } };
}

// ---------------------------------------------------------------------------
// Reading a close code off the wire
// ---------------------------------------------------------------------------

/**
 * A minimal RFC 6455 frame scanner that answers one question: what close code
 * crossed this half of the connection?
 *
 * It exists because the close code is the single most informative fact about a
 * mobile disconnect and it is invisible from every other vantage point. 1001 is
 * the page going away; 1006 is the socket dying without a close frame at all,
 * which is what a locked iPhone or a dropped tailnet actually looks like; 1000
 * is a deliberate detach. Phase 39's reconnect policy is a different design
 * depending which of those dominates, and asking a human to tell them apart is
 * not a request that can be honoured.
 *
 * Client frames are masked and server frames are not, so both are handled. A
 * close frame with an empty payload carries no code — that is reported as
 * `null` with {@link sawClose} set, never as `0`, because "closed without
 * saying why" is a distinct observation.
 */
export function createCloseSniffer() {
	let buffer = Buffer.alloc(0);
	const state = {
		sawClose: false,
		/** Feed bytes; returns the close code the moment one is seen, else null. */
		feed(chunk) {
			buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 2) return null;
				const opcode = buffer[0] & 0x0f;
				const masked = (buffer[1] & 0x80) !== 0;
				let length = buffer[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < offset + 2) return null;
					length = buffer.readUInt16BE(offset);
					offset += 2;
				} else if (length === 127) {
					if (buffer.length < offset + 8) return null;
					const big = buffer.readBigUInt64BE(offset);
					// A frame this size is not something this scanner needs to follow.
					if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
					length = Number(big);
					offset += 8;
				}
				let mask = null;
				if (masked) {
					if (buffer.length < offset + 4) return null;
					mask = buffer.subarray(offset, offset + 4);
					offset += 4;
				}
				if (buffer.length < offset + length) return null;

				const payload = Buffer.from(buffer.subarray(offset, offset + length));
				buffer = buffer.subarray(offset + length);

				if (opcode === 0x8) {
					state.sawClose = true;
					if (payload.length < 2) return null;
					if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
					return payload.readUInt16BE(0);
				}
			}
		},
	};
	return state;
}

// ---------------------------------------------------------------------------
// The observing proxy
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/** Split a request target into a path and the *names* of its query keys. */
function splitTarget(target) {
	const index = target.indexOf("?");
	if (index === -1) return { path: target, queryKeys: [] };
	const path = target.slice(0, index);
	const keys = [];
	for (const pair of target.slice(index + 1).split("&")) {
		if (pair.length === 0) continue;
		keys.push(decodeURIComponent(pair.split("=")[0]));
	}
	// Values are never recorded. R33-REACH.3 deleted the query-string credential
	// source repo-wide, and an evidence file that copied a query string verbatim
	// would be a brand-new place for one to land — an archive is the last thing
	// that should hold a secret, because it is the thing that gets shared. The
	// key *names* are kept, which is enough to see a regression without being a
	// place a credential can survive.
	return { path, queryKeys: keys };
}

/**
 * A pass-through HTTP + WebSocket proxy that records what crossed it.
 *
 * This is what `tailscale serve` is pointed at, so the served bytes are the
 * gateway's own — the observer adds no bundle, rewrites no HTML and terminates
 * no TLS. If it changed the response, the thing the devices loaded would not be
 * the thing the daemon serves, and the evidence would be about the harness.
 *
 * @returns `{ port, records, requests, close }` — `records` is one entry per
 *   upgrade, finalised when the socket dies.
 */
export function startObserverProxy({ backend, port = 0, host = "127.0.0.1", now = () => Date.now() }) {
	const records = [];
	const requests = [];
	const live = new Set();
	let seq = 0;

	const server = createServer((req, res) => {
		const { path, queryKeys } = splitTarget(req.url ?? "/");
		requests.push({
			at: new Date(now()).toISOString(),
			method: req.method,
			path,
			queryKeys,
			ua: req.headers["user-agent"] ?? null,
			device: classifyUserAgent(req.headers["user-agent"]),
		});
		const upstream = httpRequest(
			{
				host: backend.host,
				port: backend.port,
				method: req.method,
				path: req.url,
				headers: forward(req.headers),
				agent: false,
			},
			(response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end("observer: backend unreachable");
		});
		req.pipe(upstream);
	});

	server.on("upgrade", (req, clientSocket, head) => {
		seq += 1;
		const { path, queryKeys } = splitTarget(req.url ?? "/");
		const ua = req.headers["user-agent"] ?? null;
		const startedAt = now();
		const record = {
			seq,
			at: new Date(startedAt).toISOString(),
			ua,
			device: classifyUserAgent(ua),
			path,
			queryKeys,
			remote: clientSocket.remoteAddress ?? null,
			upgraded: false,
			lifetimeMs: null,
			closeCode: null,
			closedBy: null,
		};
		records.push(record);

		live.add(clientSocket);
		clientSocket.on("close", () => live.delete(clientSocket));

		const finish = (by) => {
			if (record.lifetimeMs !== null) return;
			record.lifetimeMs = now() - startedAt;
			if (record.closedBy === null) record.closedBy = by;
		};

		const upstream = httpRequest({
			host: backend.host,
			port: backend.port,
			method: req.method,
			path: req.url,
			headers: forward(req.headers, true),
			agent: false,
		});

		upstream.on("upgrade", (response, backendSocket, backendHead) => {
			record.upgraded = true;
			live.add(backendSocket);
			backendSocket.on("close", () => live.delete(backendSocket));

			clientSocket.write(renderHead(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`, response.headers));

			const fromClient = createCloseSniffer();
			const fromServer = createCloseSniffer();
			const note = (sniffer, chunk, by) => {
				const code = sniffer.feed(chunk);
				if (code !== null && record.closeCode === null) {
					record.closeCode = code;
					record.closedBy = by;
				}
			};

			if (head?.length) {
				note(fromClient, head, "client");
				backendSocket.write(head);
			}
			if (backendHead?.length) {
				note(fromServer, backendHead, "server");
				clientSocket.write(backendHead);
			}

			clientSocket.on("data", (chunk) => {
				note(fromClient, chunk, "client");
				backendSocket.write(chunk);
			});
			backendSocket.on("data", (chunk) => {
				note(fromServer, chunk, "server");
				clientSocket.write(chunk);
			});

			const drop = (by) => () => {
				finish(by);
				clientSocket.destroy();
				backendSocket.destroy();
			};
			clientSocket.on("error", drop("client"));
			backendSocket.on("error", drop("server"));
			// A socket that dies without a close frame keeps `closeCode === null`,
			// which is the honest record of a 1006 — the harness does not invent
			// the code the browser will report to itself.
			clientSocket.on("close", drop("client"));
			backendSocket.on("close", drop("server"));
			// `end` as well as `close`, and this is not belt-and-braces. Node builds
			// its HTTP server on a `net.Server` with `allowHalfOpen: true`, so a peer
			// that simply vanishes — FIN, no close frame, which is precisely what a
			// locked phone or a dropped tailnet looks like — leaves the socket
			// half-open and `close` never fires. Without this the record for the
			// single most interesting disconnect stays `lifetimeMs: null` forever.
			clientSocket.on("end", drop("client"));
			backendSocket.on("end", drop("server"));
		});

		upstream.on("response", (response) => {
			// The backend refused the upgrade — a 401 on `/attach` is a *result*,
			// so it is recorded rather than dropped.
			record.upgraded = false;
			record.refusedStatus = response.statusCode ?? null;
			clientSocket.write(renderHead(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`, response.headers));
			response.on("data", (chunk) => clientSocket.write(chunk));
			response.on("end", () => {
				finish("server");
				clientSocket.end();
			});
		});

		upstream.on("error", () => {
			finish("server");
			clientSocket.destroy();
		});
		upstream.end();
	});

	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			resolvePromise({
				port: server.address().port,
				host,
				records,
				requests,
				close() {
					for (const socket of live) socket.destroy();
					live.clear();
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}

function forward(incoming, websocket = false) {
	const out = {};
	for (const [name, value] of Object.entries(incoming)) {
		const lower = name.toLowerCase();
		if (websocket && (lower === "connection" || lower === "upgrade")) {
			out[name] = value;
			continue;
		}
		if (HOP_BY_HOP.has(lower)) continue;
		out[name] = value;
	}
	if (websocket) {
		out.Connection = "Upgrade";
		out.Upgrade = "websocket";
	}
	return out;
}

function renderHead(startLine, headers) {
	const lines = [startLine];
	for (const [name, value] of Object.entries(headers)) {
		if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
		else if (value !== undefined) lines.push(`${name}: ${value}`);
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

// ---------------------------------------------------------------------------
// The idle probe
// ---------------------------------------------------------------------------

/**
 * Hold a WebSocket open, silent, and report how long the path let it live.
 *
 * The number this returns is the declared input to Phase 39: whether the
 * transport needs an application-level keepalive, and at what interval, is a
 * different answer for a path that idles out at 60 seconds than for one that
 * never does. It is measured rather than assumed because `tailscale serve`, the
 * carrier NAT and iOS's own suspension each impose one and the smallest wins.
 *
 * **`maxMs` is not optional in spirit.** A probe with no bound is a run that
 * hangs on a path that never idles out, and a hang is worse than a failure: it
 * burns the human's attention with no result at all. At the bound the probe
 * closes the socket itself and says plainly that the timeout was never reached.
 */
export async function probeIdleTimeout({ url, maxMs = 300_000, handshake, connectTimeoutMs = 15_000 }) {
	const socket = new WebSocket(url);
	const openedAt = Date.now();
	let settled = false;

	const opened = await new Promise((resolvePromise) => {
		const timer = setTimeout(() => resolvePromise(false), connectTimeoutMs);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolvePromise(true);
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			resolvePromise(false);
		});
	});

	if (!opened) {
		try {
			socket.close();
		} catch {
			// already dead
		}
		return { closed: false, closeCode: null, idleMs: Date.now() - openedAt, note: "the socket never opened" };
	}

	if (handshake) await handshake(socket);
	const idleFrom = Date.now();

	return await new Promise((resolvePromise) => {
		const bound = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				socket.close(1000, "probe bound reached");
			} catch {
				// nothing to close
			}
			resolvePromise({
				closed: false,
				closeCode: null,
				idleMs: Date.now() - idleFrom,
				note: `still open at the ${maxMs}ms probe bound — the path did not idle it out`,
			});
		}, maxMs);

		socket.addEventListener("close", (event) => {
			if (settled) return;
			settled = true;
			clearTimeout(bound);
			resolvePromise({
				closed: true,
				closeCode: event.code ?? null,
				reason: event.reason || null,
				idleMs: Date.now() - idleFrom,
				note: null,
			});
		});
	});
}

/**
 * The handshake a geist client owes before it is allowed to sit idle.
 *
 * `AttachBridge` gives an unauthenticated connection five seconds, so a probe
 * that skipped this would measure the pre-auth deadline and report it as the
 * transport's idle timeout — a wrong number that looks like a right one.
 */
export function geistHandshake({ bootstrapToken, deviceName = "geist-device-evidence probe" }) {
	return async (socket) =>
		await new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for device_credential")), 10_000);
			socket.addEventListener("message", (event) => {
				let frame;
				try {
					frame = JSON.parse(String(event.data));
				} catch {
					return;
				}
				if (frame.type === "server_hello") {
					socket.send(
						JSON.stringify({
							type: "pair_device",
							bootstrapToken,
							device: { name: deviceName, platform: "node" },
						}),
					);
					return;
				}
				if (frame.type === "device_credential") {
					clearTimeout(timer);
					resolvePromise(frame);
					return;
				}
				if (frame.type === "protocol_error") {
					clearTimeout(timer);
					reject(new Error(`daemon refused the probe: ${frame.reason ?? "protocol_error"}`));
				}
			});
			socket.send(
				JSON.stringify({
					type: "hello",
					protocol: "geist/0.x",
					version: "0.2",
					client: { name: "geist-device-evidence", version: "1" },
				}),
			);
		});
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFilledString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

/** A file that exists and has bytes in it. Zero bytes is treated as never captured — see below. */
function capturedFile(dir, relative) {
	if (!isFilledString(relative)) return { ok: false, why: "not captured" };
	const path = isAbsolute(relative) ? relative : join(dir, relative);
	if (!existsSync(path)) return { ok: false, why: `declared ${relative}, which does not exist` };
	let size = 0;
	try {
		size = statSync(path).size;
	} catch (error) {
		return { ok: false, why: `declared ${relative}, which could not be read (${String(error)})` };
	}
	// An empty file is indistinguishable from a file that was created and never
	// written to, and a zero-byte console log in an archive reads as "the console
	// was clean" when it means "the capture failed".
	if (size === 0) return { ok: false, why: `declared ${relative}, which is 0 bytes` };
	return { ok: true, path, size };
}

/**
 * Every empty slot in a draft, named.
 *
 * The contract is the whole point of the function: `ok` is true only when there
 * is nothing left to say, and `missing` names *only* the holes. Callers print it
 * verbatim.
 *
 * @param draft - The evidence draft, as `draft.json` holds it.
 * @param dir - The evidence directory relative paths resolve against.
 */
export function validateEvidence(draft, { dir }) {
	const missing = [];
	const flag = (slot, why) => missing.push({ slot, why });

	if (!isFilledString(draft?.origin)) flag("origin", "no published origin — the run never resolved a MagicDNS name");
	if (!isFilledString(draft?.capturedAt)) flag("capturedAt", "not captured");
	if (!isFilledString(draft?.build?.command)) {
		// The recorded lesson: a run against an unnamed build state is not
		// evidence, because nobody can reproduce which entrypoint was live.
		flag("build.command", "no build command recorded — which build produced the binary that ran?");
	}

	const measured = draft?.measured === true;

	for (const id of REQUIRED_DEVICES) {
		const device = draft?.devices?.[id];
		if (!device || typeof device !== "object") {
			flag(`devices[${id}]`, "not captured — this device never reached the run");
			continue;
		}

		if (!isFilledString(device.browser?.name)) flag(`devices[${id}].browser.name`, "not captured");
		if (!isFilledString(device.browser?.version)) {
			flag(
				`devices[${id}].browser.version`,
				"no pinned browser version — the User-Agent did not carry one and nobody supplied it",
			);
		}
		if (!isFilledString(device.os?.name)) flag(`devices[${id}].os.name`, "not captured");
		if (!isFilledString(device.os?.version)) flag(`devices[${id}].os.version`, "no pinned OS version");

		const screenshots = Array.isArray(device.screenshots) ? device.screenshots : [];
		if (screenshots.length === 0) {
			flag(`devices[${id}].screenshots`, `not captured — drop one in ${SCREENSHOT_DIR}/ named ${id}-*.png`);
		} else {
			const broken = screenshots.map((relative) => capturedFile(dir, relative)).filter((result) => !result.ok);
			if (broken.length > 0) flag(`devices[${id}].screenshots`, broken.map((result) => result.why).join("; "));
		}

		const log = capturedFile(dir, device.consoleLog);
		if (!log.ok) flag(`devices[${id}].consoleLog`, log.why);

		const upgrades = Array.isArray(device.upgrades) ? device.upgrades.filter((entry) => entry?.ua) : [];
		if (upgrades.length === 0) {
			flag(
				`devices[${id}].upgrades`,
				"no WS upgrade was observed from this device — a page load alone is not the claim",
			);
		}

		if (!measured) continue;

		const measurements = device.measurements;
		if (!measurements || typeof measurements !== "object") {
			flag(`devices[${id}].measurements`, "--measure was declared but nothing was recorded for this device");
			continue;
		}
		const idle = measurements.idleTimeoutMs;
		const idleUnreached = Number.isFinite(measurements.idleTimeoutUnreachedMs);
		// `null` is allowed here and only here, and only when the bound that was
		// waited out is recorded next to it: "it survived ten minutes" is a real
		// measurement, and rounding it to a number would be a fabricated one.
		if (!(Number.isFinite(idle) || (idle === null && idleUnreached))) {
			flag(`devices[${id}].measurements.idleTimeoutMs`, "no idle timeout measured, and no bound recorded either");
		}
		if (!Array.isArray(measurements.lockUnlock) || measurements.lockUnlock.length === 0) {
			flag(`devices[${id}].measurements.lockUnlock`, "no lock/unlock transition recorded");
		}
		if (!Array.isArray(measurements.tailnetToggle) || measurements.tailnetToggle.length === 0) {
			flag(`devices[${id}].measurements.tailnetToggle`, "no tailnet on/off transition recorded");
		}
	}

	return { ok: missing.length === 0, missing };
}

/**
 * Fill empty artifact slots from what is actually sitting in the evidence
 * directory, so the human's job is "airdrop the screenshots, save the console
 * logs" rather than "hand-edit a JSON file".
 *
 * Only ever fills; a declared path is never replaced, because a declared path
 * that is wrong must surface as a refusal rather than be silently repaired.
 */
export function discoverArtifacts(draft, dir) {
	const listing = (sub, extensions) => {
		const path = join(dir, sub);
		if (!existsSync(path)) return [];
		return readdirSync(path)
			.filter((name) => extensions.has(name.slice(name.lastIndexOf(".")).toLowerCase()))
			.sort()
			.map((name) => `${sub}/${name}`);
	};

	const screenshots = listing(SCREENSHOT_DIR, SCREENSHOT_EXTENSIONS);
	const logs = listing(CONSOLE_DIR, CONSOLE_EXTENSIONS);

	for (const id of REQUIRED_DEVICES) {
		const device = draft?.devices?.[id];
		if (!device) continue;
		if (!Array.isArray(device.screenshots) || device.screenshots.length === 0) {
			device.screenshots = screenshots.filter((path) => path.includes(id));
		}
		if (!isFilledString(device.consoleLog)) {
			device.consoleLog = logs.find((path) => path.includes(id)) ?? null;
		}
	}
	return draft;
}

/**
 * Validate, then write `manifest.json` — in that order, with nothing written on
 * the way to the decision.
 *
 * The write is a temp file plus a rename so an interrupted finalize cannot leave
 * half a manifest in an archive directory. An archive whose manifest is
 * truncated is worse than one with no manifest: the first looks readable.
 */
export function finalizeEvidence({ draft, dir, now = () => new Date() }) {
	const result = validateEvidence(draft, { dir });
	if (!result.ok) throw new EvidenceIncompleteError(result.missing);

	const manifest = {
		...draft,
		schema: MANIFEST_SCHEMA,
		requirement: "R33-REACH.2",
		finalizedAt: now().toISOString(),
	};
	mkdirSync(dir, { recursive: true });
	const target = join(dir, "manifest.json");
	const temp = `${target}.tmp`;
	writeFileSync(temp, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	renameSync(temp, target);
	return { manifest, path: target };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Bring the whole stack up, hand the human a QR, watch the two devices arrive,
 * and write `draft.json`.
 *
 * The ordering is load-bearing in two places and neither is stylistic:
 *
 *  - the observer is published, **not** the gateway. Publishing the gateway
 *    would serve exactly the same bundle to exactly the same devices and see
 *    nothing, which is the failure mode where a run "works" and produces no
 *    evidence;
 *  - `pair` runs strictly after `publish` succeeds. `geist pair` mints a
 *    single-use bootstrap credential, and minting one before there is an origin
 *    to send it to leaves a live credential in the store that nobody ever saw.
 *    `packages/geist/src/commands/pair.ts` makes the same argument about its own
 *    two steps; this is that argument one level up.
 *
 * Every dependency is injected so the whole flow above can be asserted against
 * fakes. That is class 2 evidence about the *harness*; the run it orchestrates
 * is what produces the class 4 evidence.
 */
export async function runEvidence(options, deps) {
	const { out, measure } = options;
	const log = deps.log ?? console.log;
	const started = [];

	const stopAll = async () => {
		for (const stop of started.reverse()) {
			try {
				await stop();
			} catch {
				// A cleanup failure must not mask the result of the run.
			}
		}
	};

	try {
		const build = await deps.build();
		log(`build: ${build.command} → ${build.cli}`);

		const session = await deps.startSession({ build });
		started.push(session.stop);
		log(`session: ${session.sessionId}`);

		const gateway = await deps.startGateway({ socketDir: session.socketDir });
		started.push(gateway.stop);

		const observer = await deps.startObserver({ backendPort: gateway.port });
		started.push(observer.close);
		log(`observer: 127.0.0.1:${observer.port} → gateway 127.0.0.1:${gateway.port}`);

		const published = await deps.publish({ port: observer.port });

		const paired = await deps.pair({ origin: published.origin, bootstraps: gateway.bootstraps });
		log("");
		log(`  open on the phone and in the Quest:  ${published.origin}${UI_PATH}`);
		log("");
		if (paired.qr) log(paired.qr);
		if (paired.url) log(paired.url);
		log("");

		const observed = await deps.awaitDevices({ observer, log });
		const absent = REQUIRED_DEVICES.filter((id) => !observed[id]);
		if (absent.length > 0) {
			// Refused here rather than written and refused later: a draft for a
			// run that half happened invites a second, partial run on top of it.
			throw new Error(`no upgrade was observed from: ${absent.join(", ")} — the run captured nothing for them`);
		}

		let measurements = {};
		if (measure) {
			measurements = await deps.measure({ observer, origin: published.origin, bootstraps: gateway.bootstraps, log });
		}

		const devices = {};
		for (const id of REQUIRED_DEVICES) {
			const seen = observed[id];
			const described = describeUserAgent(seen.userAgent);
			devices[id] = {
				label: seen.label ?? id,
				userAgent: seen.userAgent,
				browser: seen.browser ?? described.browser,
				os: seen.os ?? described.os,
				screenshots: [],
				consoleLog: null,
				upgrades: seen.upgrades,
				...(measure ? { measurements: measurements[id] ?? null } : {}),
			};
		}

		const draft = {
			schema: MANIFEST_SCHEMA,
			requirement: "R33-REACH.2",
			capturedAt: new Date().toISOString(),
			origin: published.origin,
			build,
			tailscale: { version: published.tailscaleVersion ?? null },
			topology: {
				observerPort: observer.port,
				gatewayPort: gateway.port,
				sessionId: session.sessionId,
				// Named so a failed run can be re-read, and so it is visible that the
				// device store did NOT land in the archive.
				runDir: deps.runDir ?? null,
			},
			measured: measure === true,
			devices,
		};

		mkdirSync(join(out, SCREENSHOT_DIR), { recursive: true });
		mkdirSync(join(out, CONSOLE_DIR), { recursive: true });
		const draftPath = join(out, "draft.json");
		writeFileSync(draftPath, `${JSON.stringify(draft, null, "\t")}\n`, "utf8");
		log(`draft: ${draftPath}`);
		log(`next:  drop screenshots in ${join(out, SCREENSHOT_DIR)} and console logs in ${join(out, CONSOLE_DIR)},`);
		log(`       then: node scripts/geist-device-evidence.mjs --finalize --out ${out}`);

		return { draft, draftPath };
	} finally {
		await stopAll();
	}
}

// ---------------------------------------------------------------------------
// Real dependencies for the run
// ---------------------------------------------------------------------------

/**
 * One readline interface for the whole run, and every question bounded twice.
 *
 * A fresh interface per question looks harmless and is not: once the input has
 * run out — a pipe that ended, a closed terminal — the next `question` callback
 * never fires at all, and the run sits on its prompt bound with nothing left to
 * read. That is a hang, and a hang during a device capture costs the operator
 * the whole session with both devices in hand. So a closed input resolves
 * `null` immediately, and `null` flows on to become an empty slot the
 * `--finalize` refusal will name — never a silent default.
 */
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
	const rl = createInterface({ input, output });
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});

	return {
		ask(question, { timeoutMs = 900_000 } = {}) {
			if (closed) return Promise.resolve(null);
			return new Promise((resolvePromise) => {
				let done = false;
				const onClose = () => settle(null);
				const settle = (value) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					rl.removeListener("close", onClose);
					resolvePromise(value);
				};
				const timer = setTimeout(() => settle(null), timeoutMs);
				rl.once("close", onClose);
				rl.question(`${question} `, (answer) => settle(answer.trim()));
			});
		},
		close() {
			rl.close();
		},
	};
}

let sharedPrompter = null;

/** Read a line from the operator, with a bound so an unattended run cannot hang forever. */
export function askLine(question, options = {}) {
	sharedPrompter ??= createPrompter();
	return sharedPrompter.ask(question, options);
}

/** Let go of stdin. Until this runs, the open interface keeps the process alive. */
export function closePrompter() {
	sharedPrompter?.close();
	sharedPrompter = null;
}

/**
 * Verify the emitted binary, building it if it is not there.
 *
 * The check is a *spawn*, not an `existsSync`. This repo has already been bitten
 * by `npm run build` and `npm run build:binary` clobbering each other so that
 * exactly one entrypoint worked at a time; a file on disk proves nothing about
 * whether the entrypoint the run is about to depend on actually runs. The build
 * command is recorded into the manifest for the same reason.
 */
function realBuild({ log }) {
	const command = "npm run build";
	if (!existsSync(DRAHT_CLI)) {
		log(`building draht: ${command} (packages/coding-agent)`);
		const built = spawnSync("npm", ["run", "build"], { cwd: join(REPO_ROOT, "packages/coding-agent"), encoding: "utf8" });
		if (built.status !== 0) throw new Error(`draht build failed:\n${built.stderr}`);
	}
	if (!existsSync(GEIST_CLI)) {
		log(`building geist: ${command} (packages/geist)`);
		const built = spawnSync("npm", ["run", "build"], { cwd: join(REPO_ROOT, "packages/geist"), encoding: "utf8" });
		if (built.status !== 0) throw new Error(`geist build failed:\n${built.stderr}`);
	}
	const probe = spawnSync("node", [DRAHT_CLI, "--version"], { encoding: "utf8", timeout: 60_000 });
	if (probe.status !== 0) {
		throw new Error(
			[
				`the emitted binary at ${DRAHT_CLI} does not run — \`${command}\` did not leave a working entrypoint.`,
				probe.stderr?.trim() ?? "",
			].join("\n"),
		);
	}
	return {
		command,
		cli: DRAHT_CLI,
		version: probe.stdout.trim().split("\n").at(-1) ?? null,
		builtAt: new Date(statSync(DRAHT_CLI).mtimeMs).toISOString(),
	};
}

/** The gateway with the ten lines of device-registry adapter the shipped CLI still owes. */
const GATEWAY_HOST = `
import { DeviceRegistry } from ${JSON.stringify(GEIST_CORE)};
import { startGateway } from ${JSON.stringify(GATEWAY_SERVER)};

const [port, socketDir, devicesPath, authToken, count, ttlMs] = process.argv.slice(2);
const registry = new DeviceRegistry({ path: devicesPath });
const issue = (deviceId, credential) => ({
	ok: true,
	deviceId,
	credential,
	issuedAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + Number(ttlMs)).toISOString(),
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
for (let i = 0; i < Number(count); i += 1) bootstraps.push(registry.mintBootstrap({ ttlMs: Number(ttlMs) }).token);

const { server } = startGateway({ port: Number(port), host: "127.0.0.1", authToken, socketDir, devices });
process.stdout.write(JSON.stringify({ bootstraps }) + "\\n");
process.stderr.write("draht-gateway listening on " + server.port + "\\n");
`;

async function until(probe, what, timeoutMs, intervalMs = 100) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${typeof what === "function" ? what() : what}`);
		}
		await new Promise((done) => setTimeout(done, intervalMs));
	}
}

/**
 * The processes the run actually spawns.
 *
 * Kept in one factory so {@link runEvidence} never reaches for a global, and so
 * the fakes in the test suite are substituting for a named, single thing.
 */
export function realDeps({ log = console.log, err = console.error, options }) {
	// Two independent reasons this is not inside the evidence directory, and
	// either one on its own would be enough:
	//
	//  1. a Unix socket path over ~104 bytes fails to bind with EINVAL, and
	//     `.planning/geist/evidence/<date>-devices/agent/sockets/<uuid>.sock` is
	//     already past it before the repo's own path is counted — the session
	//     would simply never publish a socket;
	//  2. the device store lives here, and the evidence directory is the thing
	//     that gets committed and shared. A credential store is not an artifact,
	//     even one that only holds salted digests.
	const runDir = mkdtempSync(RUN_DIR_PREFIX);
	const devicesPath = options.devicesPath ?? join(runDir, "devices.json");

	return {
		runDir,
		devicesPath,

		log,
		err,

		build: async () => realBuild({ log }),

		startSession: async () => {
			const agentDir = join(runDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			const socketDir = join(agentDir, "sockets");
			const stderr = { text: "" };
			const child = spawn(
				"node",
				[DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
				{
					cwd: REPO_ROOT,
					env: {
						...process.env,
						DRAHT_CODING_AGENT_DIR: agentDir,
						// Keyless: the run must not need an API key or the network
						// (R32-FLEET.11), or "does the phone work" turns into "is the
						// provider up".
						DRAHT_STUB_PROVIDER: "1",
						DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND: "60",
					},
					stdio: ["pipe", "ignore", "pipe"],
				},
			);
			child.stderr.on("data", (chunk) => {
				stderr.text += String(chunk);
			});
			const socketFile = await until(
				() => {
					try {
						return readdirSync(socketDir).find((entry) => entry.endsWith(".sock"));
					} catch {
						return null;
					}
				},
				() => `draht to publish its socket (stderr: ${stderr.text})`,
				60_000,
			);
			return {
				sessionId: socketFile.slice(0, -".sock".length),
				socketDir,
				stop: async () => {
					child.kill("SIGTERM");
				},
			};
		},

		startGateway: async ({ socketDir }) => {
			const hostFile = join(runDir, "gateway-host.ts");
			writeFileSync(hostFile, GATEWAY_HOST, "utf8");

			const authToken = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("base64");
			const port = await freePort();
			const stdout = { text: "" };
			const stderr = { text: "" };
			const child = spawn(
				"bun",
				[
					hostFile,
					String(port),
					socketDir,
					devicesPath,
					authToken,
					String(options.bootstrapCount),
					String(options.bootstrapTtlMs),
				],
				{ cwd: REPO_ROOT, env: { ...process.env, GEIST_DEVICES_PATH: devicesPath }, stdio: ["ignore", "pipe", "pipe"] },
			);
			child.stdout.on("data", (chunk) => {
				stdout.text += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr.text += String(chunk);
			});
			await until(
				() => stderr.text.includes("draht-gateway listening"),
				() => `the gateway to bind (stderr: ${stderr.text})`,
				60_000,
			);
			return {
				port,
				bootstraps: JSON.parse(stdout.text.trim().split("\n")[0]).bootstraps,
				stop: async () => {
					child.kill("SIGTERM");
				},
			};
		},

		startObserver: async ({ backendPort }) => {
			try {
				return await startObserverProxy({
					backend: { host: "127.0.0.1", port: backendPort },
					port: options.port,
				});
			} catch (error) {
				if (error?.code === "EADDRINUSE") {
					throw new Error(
						`port ${options.port} is already in use — stop whatever is on it, or pass --port <n>. ` +
							"The port is fixed rather than ephemeral so re-runs reuse one `tailscale serve` mapping.",
					);
				}
				throw error;
			}
		},

		publish: async ({ port }) => {
			const { origin } = tailscalePublish({ port, path: "/", log });
			const version = runTailscale(["version"]);
			return { origin, tailscaleVersion: version.code === 0 ? version.stdout.trim().split("\n")[0] : null };
		},

		pair: async ({ origin }) => {
			// The real `geist pair`, spawned rather than imported: the QR an
			// operator scans has to be the one the shipped command prints.
			//
			// Run under `bun`, not `node`, and that is not a preference. The
			// emitted `packages/geist/dist/cli.js` imports `@draht/geist-core`,
			// whose package entry point is `./src/index.ts` — TypeScript source.
			// Under node the binary dies at import with ERR_MODULE_NOT_FOUND on
			// `attach-bridge.js`. That is a real property of the shipped bin and
			// is reported as a blocker rather than papered over here.
			const result = spawnSync("bun", [GEIST_CLI, "pair", "--origin", origin], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: { ...process.env, GEIST_DEVICES_PATH: devicesPath },
				timeout: 60_000,
			});
			if (result.status !== 0) throw new Error(`geist pair exited ${result.status}:\n${result.stderr}`);
			const output = result.stdout;
			const url = output.split("\n").find((line) => line.trim().startsWith("https://"))?.trim() ?? null;
			return { qr: output, url };
		},

		awaitDevices: async ({ observer }) => {
			log("waiting for both devices to load the bundle and complete a WS upgrade…");
			log(`  required: ${REQUIRED_DEVICES.join(", ")}   (ctrl-c to abort)`);
			const seen = () => {
				const byDevice = {};
				for (const record of observer.records) {
					if (!record.upgraded) continue;
					if (!REQUIRED_DEVICES.includes(record.device)) continue;
					const bucket = (byDevice[record.device] ??= { userAgent: record.ua, upgrades: [] });
					bucket.upgrades.push({
						at: record.at,
						ua: record.ua,
						path: record.path,
						lifetimeMs: record.lifetimeMs,
						closeCode: record.closeCode,
						closedBy: record.closedBy,
					});
				}
				return byDevice;
			};
			await until(
				() => REQUIRED_DEVICES.every((id) => seen()[id]),
				() => `both devices (so far: ${Object.keys(seen()).join(", ") || "none"})`,
				options.waitMs,
				1_000,
			);
			// Whatever the UA did not carry is asked for, once, per device.
			//
			// An unanswered prompt yields `null`, and `null` becomes an empty slot
			// that `--finalize` names and refuses on. That is the whole design: a
			// question nobody answered must never turn into a plausible default,
			// because a plausible default in an archive is indistinguishable from
			// an observation. (Answers are read as they are asked; text piped
			// ahead of a prompt is not queued, so a scripted run ends in a
			// refusal rather than in guesses.)
			const answers = {};
			for (const id of REQUIRED_DEVICES) {
				const described = describeUserAgent(seen()[id].userAgent);
				const browser = { ...described.browser };
				const os = { ...described.os };
				if (!browser.version) browser.version = (await askLine(`${id}: browser version (the UA did not say) —`)) || null;
				if (!os.version) os.version = (await askLine(`${id}: OS version (the UA did not say) —`)) || null;
				const label = (await askLine(`${id}: label for the archive (e.g. "iPhone 15 Pro") —`)) || id;
				answers[id] = { browser, os, label };
			}

			// Re-read the records *after* the prompts: sockets that were still open
			// when the devices first arrived have usually closed by now, and a
			// closed socket carries the lifetime and close code the earlier
			// snapshot could only record as null.
			const observed = seen();
			for (const id of REQUIRED_DEVICES) Object.assign(observed[id], answers[id]);
			return observed;
		},

		measure: async ({ observer, origin, bootstraps }) => {
			const wsUrl = `${origin.replace(/^https:/, "wss:")}${options.wsPath}`;
			const path = await probeIdleTimeout({
				url: wsUrl,
				maxMs: options.idleMaxMs,
				handshake: geistHandshake({ bootstrapToken: bootstraps.shift() }),
			});
			log(`path idle probe: ${path.closed ? `closed after ${path.idleMs}ms with code ${path.closeCode}` : path.note}`);

			const out = {};
			for (const id of REQUIRED_DEVICES) {
				const device = {
					idleTimeoutMs: null,
					idleTimeoutUnreachedMs: null,
					pathProbe: path,
					lockUnlock: [],
					tailnetToggle: [],
				};

				const idle = await watchTransition({
					observer,
					device: id,
					log,
					prompt: `${id}: leave the page open and DO NOT touch it. Press enter to start the idle measurement —`,
					bound: options.idleMaxMs,
				});
				if (idle.closed) device.idleTimeoutMs = idle.lifetimeMs;
				else device.idleTimeoutUnreachedMs = options.idleMaxMs;

				for (const step of ["lock the device", "unlock the device"]) {
					device.lockUnlock.push(
						await watchTransition({
							observer,
							device: id,
							log,
							prompt: `${id}: ${step}, then press enter —`,
							bound: 120_000,
							transition: step,
						}),
					);
				}
				for (const step of ["turn Tailscale OFF on the device", "turn Tailscale back ON"]) {
					device.tailnetToggle.push(
						await watchTransition({
							observer,
							device: id,
							log,
							prompt: `${id}: ${step}, then press enter —`,
							bound: 120_000,
							transition: step,
						}),
					);
				}
				out[id] = device;
			}
			return out;
		},
	};
}

/**
 * Record what the observer saw around one operator-driven transition.
 *
 * The human's only contribution is pressing enter twice; the socket count, the
 * lifetime and the close code are read from the observer, because those are the
 * three facts a person cannot supply and the three Phase 39 needs.
 */
export async function watchTransition({
	observer,
	device,
	log,
	prompt,
	bound,
	transition = "idle",
	ask = askLine,
	settleMs = 1_500,
}) {
	const before = observer.records.filter((record) => record.device === device);
	// Snapshotted *before* the prompt, and that is the whole subtlety: the
	// records are live objects the observer mutates in place, so asking after
	// the transition which of them "was open" would answer about the world the
	// transition already changed.
	const wasOpen = new Set(before.filter((record) => record.lifetimeMs === null));
	const openBefore = wasOpen.size;
	await ask(prompt, { timeoutMs: bound });
	const startedAt = Date.now();
	// Give the transition a moment to actually reach the wire before reading it.
	await new Promise((done) => setTimeout(done, settleMs));
	const after = observer.records.filter((record) => record.device === device);
	const closedDuring = after.filter((record) => wasOpen.has(record) && record.lifetimeMs !== null);
	const newSockets = after.filter((record) => !before.includes(record));
	const openAfter = after.filter((record) => record.lifetimeMs === null).length;
	// The *newly* closed one: a record that finished during some earlier
	// transition must not make this one read as a disconnect.
	const lastClosed = [...closedDuring].reverse()[0] ?? null;

	const result = {
		transition,
		at: new Date(startedAt).toISOString(),
		openBefore,
		openAfter,
		reconnected: newSockets.length,
		closed: lastClosed !== null || openAfter < openBefore,
		lifetimeMs: lastClosed?.lifetimeMs ?? null,
		closeCode: lastClosed?.closeCode ?? null,
		closedBy: lastClosed?.closedBy ?? null,
		observedCloseCount: closedDuring.length,
	};
	log(
		`  ${device} ${transition}: open ${openBefore}→${openAfter}, ` +
			`reconnects ${result.reconnected}, last close ${result.closeCode ?? "none (1006-shaped)"}`,
	);
	return result;
}

function freePort() {
	return new Promise((resolvePromise, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolvePromise(port));
		});
	});
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
	"usage: node scripts/geist-device-evidence.mjs [--measure] [--finalize] [options]",
	"",
	"  (no mode)         run: start the session, gateway and observer, publish via",
	"                    tailscale serve, print the MagicDNS URL and pairing QR, and",
	"                    record every upgrade the two devices make",
	"  --measure         also probe the idle timeout and record a lock/unlock cycle",
	"                    and a tailnet toggle per device (the Phase 39 input)",
	"  --finalize        validate draft.json and write manifest.json; refuses to",
	"                    write anything incomplete and names every empty slot",
	"",
	"options:",
	"  --out <dir>       evidence directory (default .planning/geist/evidence/<date>-devices)",
	"  --date <YYYY-MM-DD>  date used in the default evidence directory",
	"  --draft <path>    draft to finalize (default <out>/draft.json)",
	"  --port <n>        port to publish and observe (default 7878, the phase's port)",
	"  --ws-path <path>  the WS route to observe (default /attach)",
	"  --wait-ms <n>     how long to wait for both devices (default 900000)",
	"  --idle-max-ms <n> bound on the idle probe (default 300000)",
].join("\n");

export function parseArgs(argv) {
	const options = {
		mode: "run",
		measure: false,
		out: null,
		date: null,
		draft: null,
		// The port `tailscale serve` publishes and the observer binds. Stable on
		// purpose: `publish()` is idempotent per port, so a fixed port makes a
		// re-run a no-op instead of a second serve mapping nobody will clean up.
		// 7878 is the same port `geist pair` and the serve script default to.
		port: 7878,
		wsPath: DEFAULT_WS_PATH,
		waitMs: 900_000,
		idleMaxMs: 300_000,
		bootstrapCount: 8,
		bootstrapTtlMs: 3_600_000,
		devicesPath: process.env.GEIST_DEVICES_PATH ?? null,
		help: false,
	};

	const need = (flag, value) => {
		if (value === undefined) throw new Error(`${flag} needs a value`);
		return value;
	};

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		switch (flag) {
			case "--measure":
				options.measure = true;
				break;
			case "--finalize":
				options.mode = "finalize";
				break;
			case "--out":
				options.out = need("--out", argv[++i]);
				break;
			case "--date":
				options.date = need("--date", argv[++i]);
				break;
			case "--draft":
				options.draft = need("--draft", argv[++i]);
				break;
			case "--port":
				options.port = Number(need("--port", argv[++i]));
				if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
					throw new Error(`--port must be a port number, got: ${argv[i]}`);
				}
				break;
			case "--ws-path":
				options.wsPath = need("--ws-path", argv[++i]);
				break;
			case "--wait-ms":
				options.waitMs = Number(need("--wait-ms", argv[++i]));
				break;
			case "--idle-max-ms":
				options.idleMaxMs = Number(need("--idle-max-ms", argv[++i]));
				break;
			case "--devices":
				options.devicesPath = need("--devices", argv[++i]);
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new Error(`unknown flag: ${flag}`);
		}
	}

	const date = options.date ?? new Date().toISOString().slice(0, 10);
	options.date = date;
	options.out = options.out ?? join(EVIDENCE_ROOT, `${date}-devices`);
	options.draft = options.draft ?? join(options.out, "draft.json");
	// `devicesPath` is deliberately left unresolved here: {@link realDeps} puts
	// it in the run's scratch directory under /tmp, and the reason is in the
	// comment on {@link RUN_DIR_PREFIX}.
	return options;
}

export async function main(argv, { log = console.log, err = console.error } = {}) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		err(`geist-device-evidence: ${error.message}`);
		err(USAGE);
		return EXIT.USAGE;
	}

	if (options.help) {
		log(USAGE);
		return EXIT.OK;
	}

	if (options.mode === "finalize") {
		if (!existsSync(options.draft)) {
			err(`geist-device-evidence: no draft at ${options.draft} — run the harness first`);
			return EXIT.INCOMPLETE;
		}
		let draft;
		try {
			draft = JSON.parse(readFileSync(options.draft, "utf8"));
		} catch (error) {
			err(`geist-device-evidence: ${options.draft} is not readable JSON: ${String(error)}`);
			return EXIT.INCOMPLETE;
		}
		discoverArtifacts(draft, options.out);
		try {
			const { path } = finalizeEvidence({ draft, dir: options.out });
			log(`geist-device-evidence: wrote ${path}`);
			return EXIT.OK;
		} catch (error) {
			if (!(error instanceof EvidenceIncompleteError)) throw error;
			err(`geist-device-evidence: refusing to write an incomplete manifest — ${error.missing.length} empty slot(s)`);
			for (const entry of error.missing) err(`  ${entry.slot} — ${entry.why}`);
			err("");
			err("Nothing was written. Fill the slots above and run --finalize again.");
			return EXIT.INCOMPLETE;
		}
	}

	try {
		mkdirSync(options.out, { recursive: true });
		await runEvidence(options, realDeps({ log, err, options }));
		return EXIT.OK;
	} catch (error) {
		err(`geist-device-evidence: the run failed — ${error.message}`);
		return EXIT.RUN_FAILED;
	} finally {
		closePrompter();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(error);
			process.exitCode = EXIT.RUN_FAILED;
		});
}
