/**
 * Self-test for the TLS-terminating reverse-proxy fixture (R33-REACH.3, .8, .9).
 *
 * Phase 33's acceptance runs the emitted binaries behind the `tailscale serve`
 * topology: a TLS front end on one origin, a loopback-bound daemon behind it, and
 * a tailnet identity header the daemon must not trust from the wire. CI has no
 * tailnet and never will, so the topology has to exist locally or the phase can
 * only be tested by hand on Oskar's laptop.
 *
 * This proves the fixture reproduces the parts Phase 33 actually leans on:
 * an `https://` request and a `wss://` upgrade both reaching a loopback backend,
 * the identity header injected and never taken from the client, a byte-level
 * transcript of both directions (the input to the "no credential in any URL"
 * scan), and a kill-mid-session that really drops sockets and really gives the
 * port back.
 *
 * The backend is a separately spawned `Bun.serve` — the runtime the geist daemon
 * uses — not an in-process node server, so the proxy is proven against the real
 * thing rather than against a shape that happens to be convenient.
 *
 * The WebSocket client here is hand-rolled over `tls.connect` on purpose: Node's
 * global `WebSocket` cannot be handed a per-connection CA, and the fixture's cert
 * is generated fresh into a temp dir on every start.
 *
 * Run: node --test scripts/fixtures/tls-proxy.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "tls-proxy.mjs");

/**
 * The loopback backend the proxy fronts. Written out and spawned with `bun` so
 * this is a real second process on a real ephemeral port, exactly like the geist
 * daemon the phase-33 acceptance will put here.
 *
 * Routes: `/hello` (body round-trip), `/headers` (what the backend actually
 * received), `/ws` (upgrade; echoes the requested subprotocol on the 101, reports
 * the identity header it saw on open, echoes text frames).
 */
const BACKEND_SOURCE = `
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			const requested = req.headers.get("sec-websocket-protocol");
			const chosen = requested ? requested.split(",")[0].trim() : undefined;
			const identity = req.headers.get("tailscale-user-login") ?? "<none>";
			const upgraded = server.upgrade(req, {
				data: { identity },
				headers: chosen ? { "sec-websocket-protocol": chosen } : undefined,
			});
			if (upgraded) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (url.pathname === "/headers") {
			return Response.json(Object.fromEntries(req.headers));
		}
		return new Response("hello from the backend");
	},
	websocket: {
		open(ws) {
			ws.send("identity:" + ws.data.identity);
		},
		message(ws, message) {
			ws.send("echo:" + message);
		},
	},
});

process.stdout.write("LISTENING http://127.0.0.1:" + server.port + "\\n");
`;

/** @type {string} */
let workdir;
/** @type {import("node:child_process").ChildProcess} */
let backend;
/** @type {string} */
let backendOrigin;
/** @type {Set<import("node:child_process").ChildProcess>} */
const spawned = new Set();

before(async () => {
	workdir = mkdtempSync(join(tmpdir(), "tls-proxy-test-"));
	const backendPath = join(workdir, "backend.mjs");
	writeFileSync(backendPath, BACKEND_SOURCE);
	backend = spawn("bun", [backendPath], { stdio: ["ignore", "pipe", "pipe"] });
	spawned.add(backend);
	const watcher = watchProcess(backend);
	const [, origin] = await watcher.match(/LISTENING (\S+)/);
	backendOrigin = origin;
});

after(() => {
	for (const child of spawned) child.kill("SIGKILL");
});

test("an https GET and a wss upgrade both reach a loopback backend through the fixture, and the recorded transcript holds both directions", async () => {
	const recordPath = join(workdir, "transcript-smoke.ndjson");
	const proxy = await startProxy({ record: recordPath });

	const response = await httpsGet(`${proxy.url}/hello`, proxy.ca);
	assert.equal(response.status, 200);
	assert.equal(response.body, "hello from the backend");

	const ws = await wsConnect({ port: proxy.port, ca: proxy.ca });
	assert.equal(ws.status, 101);
	assert.match(await ws.next(), /^identity:/);
	ws.send("ping");
	assert.equal(await ws.next(), "echo:ping");
	ws.destroy();

	const records = readRecords(recordPath);
	const directions = new Set(records.map((entry) => entry.direction));
	assert.ok(directions.has("client->backend"), `no client->backend record in ${JSON.stringify(records)}`);
	assert.ok(directions.has("backend->client"), `no backend->client record in ${JSON.stringify(records)}`);

	await proxy.stop();
});

test("a wss upgrade echoes the requested subprotocol on the 101 and carries a text frame each way", async () => {
	const proxy = await startProxy();

	const ws = await wsConnect({ port: proxy.port, ca: proxy.ca, protocol: "geist.v1" });
	assert.equal(ws.status, 101);
	assert.equal(ws.headers["sec-websocket-protocol"], "geist.v1");
	assert.equal(ws.headers.upgrade?.toLowerCase(), "websocket");

	// backend -> client
	assert.equal(await ws.next(), "identity:<none>");
	// client -> backend, and back again
	ws.send("hello through the proxy");
	assert.equal(await ws.next(), "echo:hello through the proxy");

	ws.destroy();
	await proxy.stop();
});

test("--identity-header injects the configured value and overwrites a client-supplied copy", async () => {
	const proxy = await startProxy({ identityHeader: "Tailscale-User-Login:owner@example.com" });

	const forged = {
		"tailscale-user-login": "attacker@example.com",
		"tailscale-user-name": "Attacker",
	};

	const response = await httpsGet(`${proxy.url}/headers`, proxy.ca, forged);
	assert.equal(response.status, 200);
	const seen = JSON.parse(response.body);
	assert.equal(seen["tailscale-user-login"], "owner@example.com");
	assert.equal(seen["tailscale-user-name"], undefined);

	// the upgrade path strips and injects on exactly the same terms
	const ws = await wsConnect({ port: proxy.port, ca: proxy.ca, headers: forged });
	assert.equal(await ws.next(), "identity:owner@example.com");
	ws.destroy();

	await proxy.stop();
});

test("--record writes NDJSON {seq, direction, at, bytes} for both halves of both the HTTP and the WS exchange", async () => {
	const recordPath = join(workdir, "transcript-shape.ndjson");
	const proxy = await startProxy({ record: recordPath });

	await httpsGet(`${proxy.url}/hello`, proxy.ca);
	const ws = await wsConnect({ port: proxy.port, ca: proxy.ca });
	await ws.next();
	ws.send("recorded");
	assert.equal(await ws.next(), "echo:recorded");
	ws.destroy();
	await proxy.stop();

	const records = readRecords(recordPath);
	assert.ok(records.length >= 4, `expected at least four records, got ${records.length}`);

	records.forEach((entry, index) => {
		assert.equal(entry.seq, index + 1, `seq must be dense and 1-based: ${JSON.stringify(entry)}`);
		assert.ok(
			entry.direction === "client->backend" || entry.direction === "backend->client",
			`unexpected direction: ${JSON.stringify(entry)}`,
		);
		assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `bytes must be a positive integer: ${JSON.stringify(entry)}`);
		assert.ok(!Number.isNaN(Date.parse(entry.at)), `at must parse as a timestamp: ${JSON.stringify(entry)}`);
	});

	const halves = new Set(records.map((entry) => `${entry.kind}:${entry.direction}`));
	for (const half of ["http:client->backend", "http:backend->client", "ws:client->backend", "ws:backend->client"]) {
		assert.ok(halves.has(half), `missing ${half} in ${[...halves].join(", ")}`);
	}
});

test("SIGTERM drops every live socket and a second start rebinds the same port", async () => {
	const port = await freePort();
	const first = await startProxy({ port });
	assert.equal(first.port, port);

	const ws = await wsConnect({ port, ca: first.ca });
	assert.match(await ws.next(), /^identity:/);

	first.child.kill("SIGTERM");
	await withTimeout(ws.whenClosed, 5000, "the live websocket was never dropped by SIGTERM");
	await withTimeout(once(first.child, "exit"), 5000, "the fixture never exited on SIGTERM");

	const second = await startProxy({ port });
	assert.equal(second.port, port);
	const response = await httpsGet(`${second.url}/hello`, second.ca);
	assert.equal(response.body, "hello from the backend");
	await second.stop();
});

test("with openssl absent from PATH the fixture exits non-zero instead of skipping", async () => {
	const emptyDir = mkdtempSync(join(tmpdir(), "tls-proxy-nopath-"));
	const child = spawn(process.execPath, [FIXTURE, "--target", backendOrigin], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PATH: emptyDir },
	});
	spawned.add(child);
	const watcher = watchProcess(child);
	const [code] = await withTimeout(once(child, "exit"), 20000, "the fixture never exited");

	assert.notEqual(code, 0, `expected a non-zero exit, got ${code}`);
	assert.match(`${watcher.stderr}${watcher.stdout}`, /tls-proxy: openssl not found on PATH/);
});

// --- helpers ---------------------------------------------------------------

/**
 * Start the fixture and wait until it has reported both the origin it bound and
 * the CA it generated.
 *
 * @param {{ port?: number, record?: string, identityHeader?: string }} [options]
 */
async function startProxy(options = {}) {
	const args = [FIXTURE, "--target", backendOrigin, "--port", String(options.port ?? 0)];
	if (options.record) args.push("--record", options.record);
	if (options.identityHeader) args.push("--identity-header", options.identityHeader);

	const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
	spawned.add(child);
	const watcher = watchProcess(child);

	const [, url] = await watcher.match(/LISTENING (https:\/\/127\.0\.0\.1:\d+)/);
	const [, caPath] = await watcher.match(/^CA (.+)$/m);

	return {
		child,
		url,
		port: Number(new URL(url).port),
		caPath,
		ca: readFileSync(caPath),
		watcher,
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			await withTimeout(once(child, "exit"), 5000, "the fixture never exited on SIGTERM");
		},
	};
}

/** Accumulate a child's output and let callers await a pattern in its stdout. */
function watchProcess(child) {
	const waiters = new Set();
	const state = { stdout: "", stderr: "" };
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		state.stdout += chunk;
		for (const waiter of [...waiters]) {
			const found = state.stdout.match(waiter.pattern);
			if (!found) continue;
			waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(found);
		}
	});
	child.stderr.on("data", (chunk) => {
		state.stderr += chunk;
	});

	return {
		get stdout() {
			return state.stdout;
		},
		get stderr() {
			return state.stderr;
		},
		match(pattern, timeoutMs = 20000) {
			const already = state.stdout.match(pattern);
			if (already) return Promise.resolve(already);
			return new Promise((resolve, reject) => {
				const waiter = { pattern, resolve };
				waiter.timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error(`timed out waiting for ${pattern}\nstdout: ${state.stdout}\nstderr: ${state.stderr}`));
				}, timeoutMs);
				waiters.add(waiter);
			});
		},
	};
}

/** One HTTPS GET that trusts exactly the CA the fixture generated. */
function httpsGet(url, ca, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { ca, headers }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
		});
		request.on("error", reject);
	});
}

/**
 * A minimal RFC 6455 client over TLS: enough to complete the handshake, read the
 * 101's headers, and move small text frames in both directions.
 *
 * @param {{ port: number, ca: Buffer, path?: string, protocol?: string, headers?: Record<string, string> }} options
 */
function wsConnect(options) {
	const { port, ca, path = "/ws", protocol, headers = {} } = options;

	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: "127.0.0.1", port, ca }, () => {
			const lines = [
				`GET ${path} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
				"Sec-WebSocket-Version: 13",
			];
			if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
			for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		});

		let buffer = Buffer.alloc(0);
		let handshakeDone = false;
		const inbox = [];
		const waiters = [];
		let closeResolve;
		const whenClosed = new Promise((done) => {
			closeResolve = done;
		});

		socket.on("error", reject);
		socket.on("close", () => closeResolve());

		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!handshakeDone) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end === -1) return;
				const head = buffer.subarray(0, end).toString("utf8");
				buffer = buffer.subarray(end + 4);
				handshakeDone = true;
				const [statusLine, ...headerLines] = head.split("\r\n");
				const responseHeaders = {};
				for (const line of headerLines) {
					const colon = line.indexOf(":");
					if (colon === -1) continue;
					responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
				}
				resolve({
					status: Number(statusLine.split(" ")[1]),
					headers: responseHeaders,
					socket,
					whenClosed,
					send,
					next,
					destroy: () => socket.destroy(),
				});
			}
			drain();
		});

		function drain() {
			while (buffer.length >= 2) {
				const opcode = buffer[0] & 0x0f;
				const masked = (buffer[1] & 0x80) !== 0;
				let length = buffer[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < 4) return;
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.length < 10) return;
					length = Number(buffer.readBigUInt64BE(2));
					offset = 10;
				}
				if (masked) offset += 4;
				if (buffer.length < offset + length) return;

				let payload = buffer.subarray(offset, offset + length);
				if (masked) {
					const mask = buffer.subarray(offset - 4, offset);
					payload = Buffer.from(payload);
					for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
				}
				buffer = buffer.subarray(offset + length);

				if (opcode === 0x1) {
					const text = payload.toString("utf8");
					const waiter = waiters.shift();
					if (waiter) waiter(text);
					else inbox.push(text);
				} else if (opcode === 0x8) {
					socket.destroy();
					return;
				}
			}
		}

		function send(text) {
			const payload = Buffer.from(text, "utf8");
			assert.ok(payload.length < 126, "the test client only writes short frames");
			const mask = randomBytes(4);
			const body = Buffer.from(payload);
			for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
			socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]));
		}

		function next(timeoutMs = 5000) {
			if (inbox.length > 0) return Promise.resolve(inbox.shift());
			return new Promise((settle, fail) => {
				const timer = setTimeout(() => fail(new Error("timed out waiting for a websocket text frame")), timeoutMs);
				waiters.push((text) => {
					clearTimeout(timer);
					settle(text);
				});
			});
		}
	});
}

/** Read the NDJSON transcript back as objects. */
function readRecords(path) {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

/** An ephemeral port that was free a moment ago — enough to test rebinding. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function withTimeout(promise, timeoutMs, message) {
	let timer;
	return Promise.race([
		promise.finally?.(() => clearTimeout(timer)) ?? promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		}),
	]);
}
