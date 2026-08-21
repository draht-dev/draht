#!/usr/bin/env node
/**
 * Publish the loopback geist/gateway listener onto the tailnet with
 * `tailscale serve`, and prove the published surface actually works
 * (R33-REACH.1).
 *
 * The daemon binds `127.0.0.1` and stays there. Phones, the Quest browser and
 * every other client reach it through `tailscale serve`, which terminates TLS
 * with a real certificate on a stable MagicDNS name. That is not decoration:
 * those clients refuse a WebSocket that is not `wss://` with a certificate
 * they trust, so `ws://100.x:7878` does not work for them at all.
 *
 * Four things this script is careful about:
 *
 *   1. **Funnel is never invoked.** Funnel publishes to the public internet,
 *      which turns a credential leak into world-reachable code execution.
 *      Every argv this script would hand to `tailscale` passes through
 *      {@link assertNoFunnel} first, and the run dies before the first spawn
 *      if `funnel` appears anywhere in it.
 *   2. **Re-runnable.** The mapping is read back out of
 *      `tailscale serve status --json` before anything is published, so a
 *      second run is a no-op rather than a duplicate handler.
 *   3. **The origin comes from the live mapping**, parsed out of
 *      `serve status --json` — never from a config file, never typed in. A
 *      name in a config file can be stale; the serve config is what the
 *      daemon is actually doing.
 *   4. **Failures are named and distinct.** A certificate failure, a DNS
 *      failure and a WebSocket upgrade failure are three different problems
 *      with three different fixes, so they get three different exit codes and
 *      three different names.
 *
 * Usage:
 *   node scripts/geist-tailscale-serve.mjs [--port 7878]
 *   node scripts/geist-tailscale-serve.mjs --verify --peer <node>
 *   node scripts/geist-tailscale-serve.mjs --capture-identity --peer <node> [--out FILE]
 *   node scripts/geist-tailscale-serve.mjs --doctor [--config PATH]
 *
 * `--verify` and `--capture-identity` are fully implemented and exercised in
 * `scripts/geist-tailscale-serve.test.mjs` against
 * `scripts/fixtures/fake-tailscale.mjs`; only their *execution* against a live
 * tailnet needs hardware and a human.
 *
 * `TAILSCALE_BIN` overrides the binary, which is how the test drives the fake.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exit codes, one per failure mode. The three the requirement names —
 * certificate, DNS, upgrade — are deliberately distinct so an operator (or a
 * CI log) can tell which of the three fixes applies without reading prose.
 */
export const FAILURE_REASONS = Object.freeze({
	OK: 0,
	USAGE: 64,
	TAILSCALE_MISSING: 69,
	SERVE_FAILED: 70,
	CERT_FAILURE: 71,
	DNS_FAILURE: 72,
	UPGRADE_FAILURE: 73,
	FUNNEL_REFUSED: 74,
	ORIGIN_UNRESOLVED: 75,
	CONFIG_NON_LOOPBACK: 76,
	HTTP_FAILURE: 77,
	PEER_UNREACHABLE: 78,
	IDENTITY_CAPTURE_FAILED: 79,
});

const DEFAULT_PORT = 7878;
const DEFAULT_WS_PATH = "/geist";
const DEFAULT_HEALTH_PATH = "/health";
const CAPTURE_PATH = "/__geist-identity-capture";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_IDENTITY_OUT = resolve(HERE, "fixtures", "tailnet-identity-headers.json");
const DEFAULT_GATEWAY_CONFIG = resolve(homedir(), ".draht", "gateway.config.json");

/**
 * The only hostnames treated as loopback. Kept as an exact set — mirrors
 * `packages/gateway/src/gateway/bind-host.ts`, which is TypeScript and cannot
 * be imported from a plain `.mjs` script without a build step.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** A failure with a named reason, which `main` turns into an exit code. */
export class TailscaleServeError extends Error {
	constructor(reason, message, detail = "") {
		super(`${reason}: ${message}`);
		this.name = "TailscaleServeError";
		this.reason = reason;
		this.detail = detail;
	}
}

// ---------------------------------------------------------------------------
// The funnel guard
// ---------------------------------------------------------------------------

/**
 * Refuse any invocation that would carry Funnel.
 *
 * This is the single chokepoint every `tailscale` invocation passes through,
 * and it is intentionally blunt: `funnel` appearing *anywhere* in the argv or
 * in the binary's own path is a refusal, not a warning. There is no flag to
 * override it. Funnel publishes the daemon to the public internet, and a
 * daemon that drives agent processes with this user's privileges must never be
 * publicly reachable — a subtler check is a check that can be argued around.
 *
 * @param args - The argv that would be handed to the tailscale binary.
 * @param bin - The binary that would be spawned.
 * @returns The argv, unchanged, when it is safe to run.
 * @throws TailscaleServeError with reason `FUNNEL_REFUSED`.
 */
export function assertNoFunnel(args, bin = process.env.TAILSCALE_BIN ?? "tailscale") {
	const offending = [bin, ...args].find((token) => typeof token === "string" && /funnel/i.test(token));
	if (offending !== undefined) {
		throw new TailscaleServeError(
			"FUNNEL_REFUSED",
			`refusing an invocation carrying Funnel (${JSON.stringify(offending)})`,
			[
				"Funnel publishes this listener to the public internet. The daemon behind it",
				"drives agent processes with your user's privileges, so a public mapping is",
				"remote code execution for anyone who finds the name. Use `tailscale serve`,",
				"which is tailnet-only. There is no override for this.",
			].join("\n"),
		);
	}
	return args;
}

// ---------------------------------------------------------------------------
// Talking to tailscale
// ---------------------------------------------------------------------------

function tailscaleBin() {
	return process.env.TAILSCALE_BIN ?? "tailscale";
}

/**
 * Run the tailscale binary once, through the funnel guard.
 *
 * @returns `{ code, stdout, stderr }` — non-zero codes are the caller's to
 *          interpret, because a probe's exit code carries which failure it was.
 */
export function runTailscale(args, { timeoutMs = 30000 } = {}) {
	const bin = tailscaleBin();
	assertNoFunnel(args, bin);
	const res = spawnSync(bin, args, { encoding: "utf-8", timeout: timeoutMs });
	if (res.error && res.error.code === "ENOENT") {
		throw new TailscaleServeError(
			"TAILSCALE_MISSING",
			`could not run ${JSON.stringify(bin)}`,
			"Install Tailscale and log in, or set TAILSCALE_BIN to the binary's path.",
		);
	}
	if (res.error) {
		throw new TailscaleServeError("SERVE_FAILED", `${bin} ${args.join(" ")} failed to run`, String(res.error.message ?? res.error));
	}
	return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Run the tailscale binary once without blocking this process's event loop.
 *
 * `--capture-identity` hosts a loopback recorder *in this process* and then
 * asks a peer to call back into it, so the probe cannot be a synchronous
 * spawn: the recorder would never get the chance to accept the connection.
 */
export function runTailscaleAsync(args, { timeoutMs = 60000 } = {}) {
	const bin = tailscaleBin();
	assertNoFunnel(args, bin);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(bin, args);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			if (error.code === "ENOENT") {
				reject(
					new TailscaleServeError(
						"TAILSCALE_MISSING",
						`could not run ${JSON.stringify(bin)}`,
						"Install Tailscale and log in, or set TAILSCALE_BIN to the binary's path.",
					),
				);
				return;
			}
			reject(new TailscaleServeError("SERVE_FAILED", `${bin} ${args.join(" ")} failed to run`, String(error.message ?? error)));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: timedOut ? 28 : (code ?? -1), stdout, stderr: timedOut ? `${stderr}\ntimed out after ${timeoutMs}ms` : stderr });
		});
	});
}

/** Read the live serve config. An unpublished node reports `{}`, not an error. */
export function readServeConfig() {
	const { code, stdout, stderr } = runTailscale(["serve", "status", "--json"]);
	if (code !== 0) {
		throw new TailscaleServeError("SERVE_FAILED", "`tailscale serve status --json` failed", stderr.trim() || stdout.trim());
	}
	const text = stdout.trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new TailscaleServeError("SERVE_FAILED", "could not parse `tailscale serve status --json`", String(error));
	}
}

function normalizeProxy(target) {
	if (typeof target !== "string") return "";
	return target.trim().replace(/\/+$/, "");
}

/**
 * Resolve the public MagicDNS origin serving a given loopback port.
 *
 * The origin is derived *only* from the serve config the daemon reports. This
 * is the whole point of the function: a MagicDNS name written into a config
 * file can be stale, renamed, or simply wrong, whereas the serve config is a
 * description of what the daemon is doing right now.
 *
 * @param serveConfig - Parsed `tailscale serve status --json`.
 * @param options.port - The loopback port whose mapping we want.
 * @param options.path - The served path prefix (default `/`).
 * @returns `https://<magicdns>` (with an explicit port when it is not 443), or
 *          null when nothing maps that loopback port.
 */
export function resolveOrigin(serveConfig, { port, path = "/" } = {}) {
	const wanted = new Set([normalizeProxy(`http://127.0.0.1:${port}`), normalizeProxy(`http://localhost:${port}`)]);
	for (const [key, web] of Object.entries(serveConfig?.Web ?? {})) {
		const handler = web?.Handlers?.[path];
		if (!handler || !wanted.has(normalizeProxy(handler.Proxy))) continue;
		const separator = key.lastIndexOf(":");
		const host = separator === -1 ? key : key.slice(0, separator);
		const servedPort = separator === -1 ? "443" : key.slice(separator + 1);
		return servedPort === "443" ? `https://${host}` : `https://${host}:${servedPort}`;
	}
	return null;
}

/** This node's MagicDNS name, from `tailscale status --json`. */
function readTailnetStatus() {
	const { code, stdout, stderr } = runTailscale(["status", "--json"]);
	if (code !== 0) {
		throw new TailscaleServeError("SERVE_FAILED", "`tailscale status --json` failed", stderr.trim() || stdout.trim());
	}
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new TailscaleServeError("SERVE_FAILED", "could not parse `tailscale status --json`", String(error));
	}
}

function tailscaleVersion() {
	try {
		const { code, stdout } = runTailscale(["version"]);
		if (code !== 0) return "unknown";
		return stdout.trim().split("\n")[0] ?? "unknown";
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Publish `http://127.0.0.1:<port>` at `path`, unless it is already published.
 *
 * Idempotency is decided by reading the live serve config first, so re-running
 * this script — from a shell, from a launchd job, from CI — cannot accumulate
 * duplicate handlers.
 */
export function publish({ port, path = "/", serveArgs = [], log = console.log }) {
	const before = readServeConfig();
	const existing = resolveOrigin(before, { port, path });
	if (existing) {
		log(`already published: ${existing}${path === "/" ? "" : path} -> http://127.0.0.1:${port} (no change)`);
		return { origin: existing, changed: false };
	}

	const args = ["serve", "--bg", "--set-path", path, `http://127.0.0.1:${port}`, ...serveArgs];
	const { code, stdout, stderr } = runTailscale(args);
	if (code !== 0) {
		throw new TailscaleServeError(
			"SERVE_FAILED",
			`\`tailscale ${args.join(" ")}\` exited ${code}`,
			[stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
		);
	}

	const origin = resolveOrigin(readServeConfig(), { port, path });
	if (!origin) {
		throw new TailscaleServeError(
			"ORIGIN_UNRESOLVED",
			`no MagicDNS mapping for http://127.0.0.1:${port} after publishing`,
			[
				"`tailscale serve` reported success but `serve status --json` does not name a",
				"host for this mapping. MagicDNS is usually the cause — enable it in the",
				"Tailscale admin console. This script will not guess a name from config.",
			].join("\n"),
		);
	}
	log(`published: ${origin}${path === "/" ? "" : path} -> http://127.0.0.1:${port}`);
	return { origin, changed: true };
}

/** Take the mapping down again. Best-effort: used to clean up a temporary path. */
function unpublish(path) {
	try {
		runTailscale(["serve", "--https=443", "off", "--set-path", path]);
	} catch {
		// A cleanup failure must not mask the result of the run itself.
	}
}

// ---------------------------------------------------------------------------
// The two-node drive
// ---------------------------------------------------------------------------

/**
 * Map a curl exit code onto one of our named reasons.
 *
 * curl distinguishes "I could not find the name" from "I found it but do not
 * trust its certificate", and those are exactly the DNS and cert failures the
 * requirement asks be reported distinctly.
 */
export function classifyCurlFailure(code, stderr = "") {
	if (code === 5 || code === 6) return "DNS_FAILURE";
	if ([35, 51, 58, 59, 60, 66, 77, 83, 90, 91].includes(code)) return "CERT_FAILURE";
	if (/could not resolve|name or service not known|no such host/i.test(stderr)) return "DNS_FAILURE";
	if (/ssl|certificate|tls/i.test(stderr)) return "CERT_FAILURE";
	return "HTTP_FAILURE";
}

/** Assert the tailnet actually knows `peer`, before we try to drive it. */
function assertPeerKnown(peer) {
	const status = readTailnetStatus();
	const names = Object.values(status?.Peer ?? {}).flatMap((entry) => [entry?.HostName, (entry?.DNSName ?? "").replace(/\.$/, "")]);
	const known = names.filter(Boolean).some((name) => name === peer || name.split(".")[0] === peer);
	if (!known) {
		throw new TailscaleServeError(
			"PEER_UNREACHABLE",
			`no tailnet peer named ${JSON.stringify(peer)}`,
			`Known peers: ${[...new Set(names.filter(Boolean))].join(", ") || "(none)"}`,
		);
	}
}

/** Quote a string for a single-quoted `sh -lc` command. */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run one command on `peer` over Tailscale SSH.
 *
 * The drive genuinely originates on a second tailnet node: that is what makes
 * it evidence. Driving the origin from *this* machine would prove only that
 * the loopback listener answers, which we already knew.
 */
function driveFromPeer(peer, command, { timeoutMs = 60000 } = {}) {
	return runTailscaleAsync(["ssh", peer, "sh", "-lc", command], { timeoutMs });
}

/** `https://…` GET from the peer, reporting only the status code. */
function httpProbeCommand(url) {
	return `curl -sS -o /dev/null -w '%{http_code}' --max-time 20 ${shellQuote(url)}`;
}

/**
 * A real `wss://` handshake from the peer.
 *
 * curl speaks `https://`, and a `wss://` connection *is* an HTTP/1.1 Upgrade
 * over TLS — so this is the `wss://` drive, expressed in the one tool every
 * tailnet node already has. A trusted certificate is required for it to get
 * this far at all, which is precisely what we are trying to prove.
 */
function upgradeProbeCommand(url) {
	const key = Buffer.from(`geist-${Date.now()}`.slice(0, 16).padEnd(16, "0")).toString("base64");
	return [
		"curl -sS -i -N --http1.1 --max-time 20",
		"-H 'Connection: Upgrade'",
		"-H 'Upgrade: websocket'",
		"-H 'Sec-WebSocket-Version: 13'",
		`-H 'Sec-WebSocket-Key: ${key}'`,
		shellQuote(url),
	].join(" ");
}

/**
 * Drive the published surface from a second tailnet node: an HTTPS GET and a
 * `wss://` upgrade, failing loudly and distinctly on cert, DNS or upgrade
 * failure.
 */
export async function verify({ origin, peer, healthPath = DEFAULT_HEALTH_PATH, wsPath = DEFAULT_WS_PATH, log = console.log }) {
	assertPeerKnown(peer);

	const httpUrl = `${origin}${healthPath}`;
	const http = await driveFromPeer(peer, httpProbeCommand(httpUrl));
	if (http.code !== 0) {
		const reason = classifyCurlFailure(http.code, http.stderr);
		throw new TailscaleServeError(reason, `HTTPS GET ${httpUrl} from ${peer} failed (curl exit ${http.code})`, http.stderr.trim());
	}
	const statusCode = http.stdout.trim();
	if (!/^2\d\d$/.test(statusCode)) {
		throw new TailscaleServeError(
			"HTTP_FAILURE",
			`HTTPS GET ${httpUrl} from ${peer} answered ${statusCode || "(no status)"}`,
			"TLS and DNS worked; the daemon behind the proxy did not answer 2xx.",
		);
	}
	log(`  HTTPS GET ${httpUrl} from ${peer} -> ${statusCode}`);

	const wsUrl = `${origin}${wsPath}`;
	const wssUrl = wsUrl.replace(/^https:/, "wss:");
	const upgrade = await driveFromPeer(peer, upgradeProbeCommand(wsUrl));
	if (upgrade.code !== 0) {
		const reason = classifyCurlFailure(upgrade.code, upgrade.stderr);
		throw new TailscaleServeError(reason, `${wssUrl} upgrade from ${peer} failed (curl exit ${upgrade.code})`, upgrade.stderr.trim());
	}
	const statusLine = (upgrade.stdout.split(/\r?\n/)[0] ?? "").trim();
	if (!/^HTTP\/1\.1 101\b/i.test(statusLine)) {
		throw new TailscaleServeError(
			"UPGRADE_FAILURE",
			`${wssUrl} from ${peer} did not upgrade: ${statusLine || "(no status line)"}`,
			[
				"TLS and DNS are fine — the handshake reached the daemon and came back",
				"without `101 Switching Protocols`. Either the proxy did not forward the",
				"Upgrade headers, or the daemon does not serve a WebSocket at this path",
				`(${wsPath}; override with --ws-path).`,
			].join("\n"),
		);
	}
	log(`  ${wssUrl} from ${peer} -> ${statusLine}`);
	return { statusCode, statusLine };
}

// ---------------------------------------------------------------------------
// Identity header capture
// ---------------------------------------------------------------------------

function startCaptureServer() {
	const received = [];
	const server = createServer((req, res) => {
		received.push({ url: req.url, method: req.method, headers: req.headers });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ captured: true }));
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			resolvePromise({
				port: server.address().port,
				received,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

/**
 * Capture the exact headers `tailscale serve` adds to a proxied request.
 *
 * A tailnet-fronted deployment is allowed to check a tailnet identity header
 * (R33-REACH.8), but only against a contract someone has actually observed —
 * guessing a header name and then trusting it is how an identity check becomes
 * theatre. This publishes a throwaway loopback recorder at a temporary path,
 * drives one request to it from a real peer, records what arrived, and takes
 * the temporary mapping down again.
 */
export async function captureIdentity({ origin, peer, out, log = console.log }) {
	assertPeerKnown(peer);
	const recorder = await startCaptureServer();
	let published = false;
	try {
		const args = ["serve", "--bg", "--set-path", CAPTURE_PATH, `http://127.0.0.1:${recorder.port}`];
		const result = runTailscale(args);
		if (result.code !== 0) {
			throw new TailscaleServeError(
				"SERVE_FAILED",
				`could not publish the temporary capture path ${CAPTURE_PATH}`,
				[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
			);
		}
		published = true;

		const url = `${origin}${CAPTURE_PATH}`;
		const probe = await driveFromPeer(peer, httpProbeCommand(url));
		if (probe.code !== 0) {
			const reason = classifyCurlFailure(probe.code, probe.stderr);
			throw new TailscaleServeError(reason, `identity capture GET ${url} from ${peer} failed (curl exit ${probe.code})`, probe.stderr.trim());
		}
		if (recorder.received.length === 0) {
			throw new TailscaleServeError(
				"IDENTITY_CAPTURE_FAILED",
				`${peer} reported ${probe.stdout.trim() || "no status"} but nothing reached the recorder`,
				"Something answered on the tailnet that was not this machine's serve mapping.",
			);
		}

		const headers = recorder.received[0].headers;
		const record = {
			capturedAt: new Date().toISOString(),
			origin,
			peer,
			path: CAPTURE_PATH,
			tailscaleVersion: tailscaleVersion(),
			identityHeaders: Object.fromEntries(Object.entries(headers).filter(([name]) => /^tailscale-/i.test(name))),
			headers,
		};
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
		const names = Object.keys(record.identityHeaders);
		log(`captured ${names.length} tailnet identity header(s) from ${peer}: ${names.join(", ") || "(none)"}`);
		log(`written: ${out}`);
		return record;
	} finally {
		if (published) unpublish(CAPTURE_PATH);
		await recorder.close();
	}
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export function isLoopbackHost(host) {
	if (typeof host !== "string") return false;
	return LOOPBACK_HOSTS.has(host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, ""));
}

/**
 * Report the state an operator needs before believing the mapping works, and
 * refuse a `gateway.config.json` that would put the daemon on a reachable
 * interface — printing the exact file that replaces it, not advice about it.
 */
export function doctor({ configPath, port, log = console.log }) {
	log("geist-tailscale-serve --doctor");
	log(`  tailscale binary   ${tailscaleBin()}`);
	log(`  tailscale version  ${tailscaleVersion()}`);

	let backend = "unknown";
	let selfName = "unknown";
	try {
		const status = readTailnetStatus();
		backend = status?.BackendState ?? "unknown";
		selfName = (status?.Self?.DNSName ?? "").replace(/\.$/, "") || "unknown";
	} catch (error) {
		log(`  tailnet status     unavailable - ${error.message}`);
	}
	log(`  backend state      ${backend}`);
	log(`  this node          ${selfName}`);

	let origin = null;
	try {
		origin = resolveOrigin(readServeConfig(), { port, path: "/" });
	} catch (error) {
		log(`  serve status       unavailable - ${error.message}`);
	}
	log(`  serve mapping      ${origin ? `${origin} -> http://127.0.0.1:${port}` : `none for http://127.0.0.1:${port}`}`);
	log("  funnel             never invoked by this script");

	if (!existsSync(configPath)) {
		log(`  gateway config     ${configPath} (absent - the daemon will use its loopback default)`);
		return { ok: true };
	}

	let raw;
	let parsed;
	try {
		raw = readFileSync(configPath, "utf-8");
		parsed = JSON.parse(raw);
	} catch (error) {
		log(`  gateway config     ${configPath} (unreadable - ${error.message})`);
		return { ok: true };
	}

	const host = parsed?.host;
	if (host === undefined || isLoopbackHost(host)) {
		log(`  gateway config     ${configPath} host=${host ?? "(unset, defaults to 127.0.0.1)"} - loopback, correct`);
		return { ok: true };
	}

	const replacement = { ...parsed, host: "127.0.0.1" };
	log("");
	log(`  gateway config     ${configPath} host=${host} - NON-LOOPBACK`);
	log("");
	log(`A non-loopback bind makes the daemon reachable without the tailnet in front`);
	log(`of it, and a credential on that interface is shell access as you. Replace the`);
	log(`whole of ${configPath} with exactly this:`);
	log("");
	log(JSON.stringify(replacement, null, 2));
	log("");
	log(`Then re-run: node scripts/geist-tailscale-serve.mjs --port ${port}`);
	return { ok: false, host, replacement };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
	"Usage:",
	"  node scripts/geist-tailscale-serve.mjs [--port N] [--path /] [--serve-arg ARG]...",
	"  node scripts/geist-tailscale-serve.mjs --verify --peer NODE [--ws-path /geist] [--health-path /health]",
	"  node scripts/geist-tailscale-serve.mjs --capture-identity --peer NODE [--out FILE]",
	"  node scripts/geist-tailscale-serve.mjs --doctor [--config PATH]",
	"",
	"Publishes the loopback listener with `tailscale serve`. Funnel is never invoked.",
].join("\n");

export function parseArgs(argv) {
	const options = {
		port: DEFAULT_PORT,
		path: "/",
		wsPath: DEFAULT_WS_PATH,
		healthPath: DEFAULT_HEALTH_PATH,
		serveArgs: [],
		verify: false,
		captureIdentity: false,
		doctor: false,
		peer: null,
		out: DEFAULT_IDENTITY_OUT,
		configPath: DEFAULT_GATEWAY_CONFIG,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			const value = argv[index + 1];
			if (value === undefined) throw new TailscaleServeError("USAGE", `${arg} needs a value`, USAGE);
			index += 1;
			return value;
		};
		switch (arg) {
			case "--port":
				options.port = Number(next());
				break;
			case "--path":
				options.path = next();
				break;
			case "--ws-path":
				options.wsPath = next();
				break;
			case "--health-path":
				options.healthPath = next();
				break;
			case "--serve-arg":
				options.serveArgs.push(next());
				break;
			case "--peer":
				options.peer = next();
				break;
			case "--out":
				options.out = next();
				break;
			case "--config":
				options.configPath = next();
				break;
			case "--verify":
				options.verify = true;
				break;
			case "--capture-identity":
				options.captureIdentity = true;
				break;
			case "--doctor":
				options.doctor = true;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new TailscaleServeError("USAGE", `unknown argument ${JSON.stringify(arg)}`, USAGE);
		}
	}
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
		throw new TailscaleServeError("USAGE", `--port must be a TCP port, got ${JSON.stringify(options.port)}`, USAGE);
	}
	if ((options.verify || options.captureIdentity) && !options.peer) {
		throw new TailscaleServeError("USAGE", "--verify and --capture-identity need --peer <node>", USAGE);
	}
	if (!isAbsolute(options.out)) options.out = resolve(process.cwd(), options.out);
	if (!isAbsolute(options.configPath)) options.configPath = resolve(process.cwd(), options.configPath);
	// The funnel guard runs at parse time as well as at spawn time, so a
	// pass-through argument carrying Funnel kills the run before any process
	// is started rather than after the mapping has already been made.
	assertNoFunnel(options.serveArgs);
	return options;
}

export async function main(argv, { log = console.log, err = console.error } = {}) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof TailscaleServeError) {
			err(`geist-tailscale-serve: FAILED reason=${error.reason} ${error.message.replace(/^[A-Z_]+: /, "")}`);
			if (error.detail) err(error.detail);
			return FAILURE_REASONS[error.reason] ?? 1;
		}
		throw error;
	}

	if (options.help) {
		log(USAGE);
		return FAILURE_REASONS.OK;
	}

	try {
		if (options.doctor) {
			const result = doctor({ configPath: options.configPath, port: options.port, log });
			if (result.ok) return FAILURE_REASONS.OK;
			err(`geist-tailscale-serve: FAILED reason=CONFIG_NON_LOOPBACK ${options.configPath} binds ${result.host}`);
			return FAILURE_REASONS.CONFIG_NON_LOOPBACK;
		}

		const { origin } = publish({ port: options.port, path: options.path, serveArgs: options.serveArgs, log });

		if (options.verify) {
			log(`verifying ${origin} from ${options.peer}:`);
			await verify({ origin, peer: options.peer, healthPath: options.healthPath, wsPath: options.wsPath, log });
			log("verified: HTTPS and wss:// both reachable from a second tailnet node");
		}

		if (options.captureIdentity) {
			await captureIdentity({ origin, peer: options.peer, out: options.out, log });
		}

		return FAILURE_REASONS.OK;
	} catch (error) {
		if (error instanceof TailscaleServeError) {
			err(`geist-tailscale-serve: FAILED reason=${error.reason} ${error.message.replace(/^[A-Z_]+: /, "")}`);
			if (error.detail) err(error.detail);
			return FAILURE_REASONS[error.reason] ?? 1;
		}
		throw error;
	}
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	process.exitCode = await main(process.argv.slice(2));
}
