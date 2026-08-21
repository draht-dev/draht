/**
 * Tests for the `tailscale serve` publish script (R33-REACH.1).
 *
 * The requirement is that a *committed, re-runnable* script publishes the
 * loopback listener, resolves MagicDNS, drives the public HTTP + WS surface
 * from a second tailnet node, fails loudly and distinctly on cert / DNS /
 * upgrade failure, and never invokes Funnel.
 *
 * None of that needs a tailnet to be *tested* — only to be *executed against
 * real hardware*. `scripts/fixtures/fake-tailscale.mjs` is a stand-in for the
 * `tailscale` binary that behaves like the real one in the ways this script
 * depends on: it keeps a real `ServeConfig`, answers `serve status --json`
 * from it, and — the part that makes this more than a mock — actually proxies
 * a probe from the "peer" through to the loopback target it has published,
 * injecting the tailnet identity headers a real `tailscale serve` injects. So
 * the HTTPS GET, the `wss://` upgrade and the identity capture below all run
 * against a real loopback server over a real socket.
 *
 * Run: node --test scripts/geist-tailscale-serve.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertNoFunnel, FAILURE_REASONS, resolveOrigin } from "./geist-tailscale-serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "geist-tailscale-serve.mjs");
const FAKE = join(HERE, "fixtures", "fake-tailscale.mjs");
const HOST = "fake-mac.tailbeef.ts.net";

let workdir;
let seq = 0;

before(() => {
	workdir = mkdtempSync(join(tmpdir(), "geist-tailscale-serve-"));
	// The script spawns TAILSCALE_BIN directly, exactly as it would spawn the
	// real `tailscale`, so the fixture has to be executable.
	chmodSync(FAKE, 0o755);
});

after(() => {
	rmSync(workdir, { recursive: true, force: true });
});

/** A fresh fake-tailscale world: its own ServeConfig and its own invocation log. */
function newEnv(extra = {}) {
	seq += 1;
	const state = join(workdir, `state-${seq}.json`);
	const log = join(workdir, `log-${seq}.jsonl`);
	return {
		state,
		log,
		env: {
			...process.env,
			TAILSCALE_BIN: FAKE,
			FAKE_TS_STATE: state,
			FAKE_TS_LOG: log,
			FAKE_TS_HOST: HOST,
			FAKE_TS_PEERS: "peer-phone,peer-laptop",
			...extra,
		},
	};
}

/**
 * Run the script as a child process.
 *
 * Asynchronous on purpose: several tests host the loopback daemon *in this
 * process*, and a synchronous spawn would block the event loop that daemon
 * needs to accept the connection the fake proxy makes back into it.
 */
function run(args, env) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [SCRIPT, ...args], { env });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
	});
}

/** Every argv the fake tailscale binary was invoked with, in order. */
function invocations(log) {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).argv);
}

function servePublishes(log) {
	return invocations(log).filter((argv) => argv[0] === "serve" && argv.includes("--bg"));
}

/**
 * A stand-in for the geist daemon: a real loopback HTTP server that answers
 * `/health` and completes (or refuses) a WebSocket upgrade.
 */
function startLoopbackDaemon({ refuseUpgrade = false } = {}) {
	const captured = [];
	// An upgraded socket is a live connection with no request/response cycle to
	// end it, so `server.close()` alone would wait forever. Track every socket
	// and tear them down explicitly.
	const sockets = new Set();
	const server = createServer((req, res) => {
		captured.push({ url: req.url, headers: req.headers });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (req, socket) => {
		captured.push({ url: req.url, headers: req.headers });
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		if (refuseUpgrade) {
			socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\ncontent-length: 0\r\n\r\n");
			return;
		}
		socket.write(
			["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: fake", "", ""].join(
				"\r\n",
			),
		);
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			resolvePromise({
				port: server.address().port,
				captured,
				close: () =>
					new Promise((done) => {
						for (const socket of sockets) socket.destroy();
						server.close(done);
					}),
			});
		});
	});
}

test("against a fake tailscale binary the script publishes 127.0.0.1:<port>, is idempotent on a second run, and never invokes funnel", async () => {
	const { env, log, state } = newEnv();

	const first = await run(["--port", "7878"], env);
	assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
	assert.match(first.stdout, new RegExp(`https://${HOST.replace(/\./g, "\\.")}`), "publishes a MagicDNS origin");
	assert.match(first.stdout, /http:\/\/127\.0\.0\.1:7878/, "maps the loopback listener, not a wider bind");

	const published = servePublishes(log);
	assert.equal(published.length, 1, `expected exactly one publish, got ${JSON.stringify(published)}`);
	assert.deepEqual(published[0], ["serve", "--bg", "--set-path", "/", "http://127.0.0.1:7878"]);

	// Re-runnable: a second run of the identical command is a no-op.
	const second = await run(["--port", "7878"], env);
	assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
	assert.match(second.stdout, /already published/i);
	assert.equal(servePublishes(log).length, 1, "a second run must not issue a duplicate mapping");

	const config = JSON.parse(readFileSync(state, "utf-8"));
	assert.deepEqual(Object.keys(config.Web[`${HOST}:443`].Handlers), ["/"], "exactly one handler survives two runs");

	// Funnel is never invoked, at any point, by any run.
	for (const argv of invocations(log)) {
		assert.ok(!argv.some((arg) => /funnel/i.test(arg)), `funnel appeared in ${JSON.stringify(argv)}`);
	}
	assert.deepEqual(Object.keys(config.AllowFunnel ?? {}), [], "no funnel mapping exists in the published config");
});

test("the funnel guard refuses any argv carrying funnel, and refuses it before anything is spawned", async () => {
	// Unit-level mutation of the chokepoint every invocation passes through.
	assert.throws(() => assertNoFunnel(["funnel", "--bg", "http://127.0.0.1:7878"]), /FUNNEL_REFUSED/);
	assert.throws(() => assertNoFunnel(["serve", "--funnel"]), /FUNNEL_REFUSED/);
	assert.throws(() => assertNoFunnel(["serve", "--bg", "--set-path", "/Funnel", "http://127.0.0.1:7878"]), /FUNNEL_REFUSED/);
	assert.throws(() => assertNoFunnel(["serve"], "/usr/local/bin/tailscale-funnel"), /FUNNEL_REFUSED/);
	assert.doesNotThrow(() => assertNoFunnel(["serve", "--bg", "http://127.0.0.1:7878"]));

	// End-to-end mutation: an operator smuggles `funnel` in through the
	// pass-through serve argument. The run must die before the first spawn.
	const { env, log } = newEnv();
	const res = await run(["--port", "7878", "--serve-arg", "funnel"], env);
	assert.equal(res.code, FAILURE_REASONS.FUNNEL_REFUSED);
	assert.match(res.stderr, /FUNNEL_REFUSED/);
	assert.deepEqual(invocations(log), [], "the guard must fire before any tailscale process is spawned");
});

test("the MagicDNS origin is resolved from `tailscale serve status --json`, never from config", async () => {
	const config = {
		TCP: { 443: { HTTPS: true } },
		Web: {
			"other-box.tailbeef.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
			"real-box.tailbeef.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7878" } } },
		},
	};
	assert.equal(resolveOrigin(config, { port: 7878, path: "/" }), "https://real-box.tailbeef.ts.net");
	assert.equal(resolveOrigin(config, { port: 9999, path: "/" }), "https://other-box.tailbeef.ts.net");
	assert.equal(resolveOrigin(config, { port: 1234, path: "/" }), null);

	// And through the CLI: the origin follows the live mapping, not a name we
	// were told. A different tailnet host yields a different printed origin.
	const { env } = newEnv({ FAKE_TS_HOST: "renamed-box.tailbeef.ts.net" });
	const res = await run(["--port", "7878"], env);
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /https:\/\/renamed-box\.tailbeef\.ts\.net/);
	assert.doesNotMatch(res.stdout, new RegExp(HOST.replace(/\./g, "\\.")));
});

test("--verify --peer drives an HTTPS GET and a wss:// upgrade from a second node", async () => {
	const daemon = await startLoopbackDaemon();
	try {
		const { env } = newEnv();
		assert.equal((await run(["--port", String(daemon.port)], env)).code, 0);

		const res = await run(["--port", String(daemon.port), "--verify", "--peer", "peer-phone"], env);
		assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, /peer-phone/);
		assert.match(res.stdout, /HTTPS GET .* 200/);
		assert.match(res.stdout, /wss:\/\/.*101/);

		// Both probes really reached the loopback daemon through the proxy.
		const paths = daemon.captured.map((entry) => entry.url);
		assert.ok(paths.includes("/health"), `expected a /health request, saw ${JSON.stringify(paths)}`);
		const upgrade = daemon.captured.find((entry) => entry.headers.upgrade === "websocket");
		assert.ok(upgrade, "expected a websocket upgrade request to reach the daemon");
	} finally {
		await daemon.close();
	}
});

test("--verify fails with a distinct named reason for DNS, cert and upgrade failure", async () => {
	const reasons = [FAILURE_REASONS.DNS_FAILURE, FAILURE_REASONS.CERT_FAILURE, FAILURE_REASONS.UPGRADE_FAILURE];
	assert.equal(new Set(reasons).size, 3, "cert, DNS and upgrade failure must not share an exit code");

	const ok = await startLoopbackDaemon();
	try {
		for (const [scenario, reason] of [
			["dns", FAILURE_REASONS.DNS_FAILURE],
			["cert", FAILURE_REASONS.CERT_FAILURE],
		]) {
			const { env } = newEnv({ FAKE_TS_SCENARIO: scenario });
			assert.equal((await run(["--port", String(ok.port)], env)).code, 0);
			const res = await run(["--port", String(ok.port), "--verify", "--peer", "peer-phone"], env);
			assert.equal(res.code, reason, `${scenario}: ${res.stdout}\n${res.stderr}`);
			assert.match(res.stderr, new RegExp(scenario === "dns" ? "DNS_FAILURE" : "CERT_FAILURE"));
		}
	} finally {
		await ok.close();
	}

	// Upgrade failure is not simulated: a real loopback daemon really refuses
	// the upgrade, and the refusal really travels back through the proxy.
	const refusing = await startLoopbackDaemon({ refuseUpgrade: true });
	try {
		const { env } = newEnv();
		assert.equal((await run(["--port", String(refusing.port)], env)).code, 0);
		const res = await run(["--port", String(refusing.port), "--verify", "--peer", "peer-phone"], env);
		assert.equal(res.code, FAILURE_REASONS.UPGRADE_FAILURE, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stderr, /UPGRADE_FAILURE/);
		assert.match(res.stderr, /400/);
	} finally {
		await refusing.close();
	}
});

test("--verify refuses a peer the tailnet does not know", async () => {
	const { env } = newEnv();
	assert.equal((await run(["--port", "7878"], env)).code, 0);
	const res = await run(["--port", "7878", "--verify", "--peer", "not-a-node"], env);
	assert.equal(res.code, FAILURE_REASONS.PEER_UNREACHABLE);
	assert.match(res.stderr, /PEER_UNREACHABLE/);
});

test("--capture-identity records the tailnet identity headers and leaves no extra mapping behind", async () => {
	const daemon = await startLoopbackDaemon();
	try {
		const { env, state } = newEnv();
		assert.equal((await run(["--port", String(daemon.port)], env)).code, 0);

		const out = join(workdir, "identity.json");
		const res = await run(["--port", String(daemon.port), "--capture-identity", "--peer", "peer-phone", "--out", out], env);
		assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);

		const captured = JSON.parse(readFileSync(out, "utf-8"));
		assert.equal(typeof captured.capturedAt, "string");
		assert.equal(captured.origin, `https://${HOST}`);
		assert.ok(captured.tailscaleVersion, "the pinned contract must name the tailscale version it came from");
		const headerNames = Object.keys(captured.headers).map((name) => name.toLowerCase());
		assert.ok(headerNames.includes("tailscale-user-login"), `saw ${JSON.stringify(headerNames)}`);
		assert.ok(headerNames.includes("tailscale-user-name"), `saw ${JSON.stringify(headerNames)}`);

		// The capture mapping is temporary: the published config is back to
		// exactly the one handler the publish run created.
		const config = JSON.parse(readFileSync(state, "utf-8"));
		assert.deepEqual(Object.keys(config.Web[`${HOST}:443`].Handlers), ["/"]);
	} finally {
		await daemon.close();
	}
});

test("--doctor reports a non-loopback gateway.config.json and prints the exact replacement", async () => {
	const { env } = newEnv();
	const bad = join(workdir, "gateway.bad.json");
	writeFileSync(bad, `${JSON.stringify({ port: 7878, host: "0.0.0.0", maxSessions: 100 }, null, 2)}\n`);

	const res = await run(["--doctor", "--config", bad], env);
	assert.equal(res.code, FAILURE_REASONS.CONFIG_NON_LOOPBACK, `${res.stdout}\n${res.stderr}`);
	assert.match(res.stderr, /CONFIG_NON_LOOPBACK/);
	assert.match(res.stdout, /0\.0\.0\.0/);
	assert.match(res.stdout, /"host": "127\.0\.0\.1"/, "prints the exact replacement, not advice");
	assert.match(res.stdout, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	// The replacement it prints is the whole file, and it is valid JSON with
	// everything else preserved.
	const printed = res.stdout.slice(res.stdout.indexOf("{"), res.stdout.lastIndexOf("}") + 1);
	assert.deepEqual(JSON.parse(printed), { port: 7878, host: "127.0.0.1", maxSessions: 100 });

	const good = join(workdir, "gateway.good.json");
	writeFileSync(good, `${JSON.stringify({ port: 7878, host: "127.0.0.1" }, null, 2)}\n`);
	const clean = await run(["--doctor", "--config", good], env);
	assert.equal(clean.code, 0, `${clean.stdout}\n${clean.stderr}`);
	assert.match(clean.stdout, /127\.0\.0\.1/);
});
