#!/usr/bin/env node
/**
 * A stand-in for the `tailscale` CLI, for `scripts/geist-tailscale-serve.mjs`.
 *
 * This is deliberately more than a mock. The publish script's whole value is
 * that it drives a *real* proxy topology, so the fixture reproduces the parts
 * of that topology the script depends on:
 *
 *   - it keeps a real `ipn.ServeConfig` on disk and answers
 *     `serve status --json` out of it, so idempotency is decided by the same
 *     data structure the real daemon would report;
 *   - `serve --bg` / `serve --https=443 off` really mutate that config;
 *   - `ssh <peer> sh -lc '<curl …>'` really performs the request: it looks the
 *     URL up in the ServeConfig, connects to the loopback target that config
 *     names, injects the `Tailscale-User-*` identity headers a real
 *     `tailscale serve` injects, and reports back with curl's own exit codes
 *     and output shapes. HTTPS GETs and `wss://` upgrades therefore cross a
 *     real socket to a real server.
 *
 * What it cannot reproduce is TLS, MagicDNS resolution and the tailnet itself;
 * `FAKE_TS_SCENARIO` stands in for those, letting a test ask for the DNS and
 * certificate failures that only a real tailnet could otherwise produce.
 *
 * Environment:
 *   FAKE_TS_STATE     path to the ServeConfig JSON file (created on demand)
 *   FAKE_TS_LOG       path to a JSONL invocation log, one `{argv}` per call
 *   FAKE_TS_HOST      this node's MagicDNS name (default fake-mac.tailbeef.ts.net)
 *   FAKE_TS_PEERS     comma-separated peer node names known to the tailnet
 *   FAKE_TS_SCENARIO  ok (default) | dns | cert — what the tailnet does to a probe
 *   FAKE_TS_VERSION   version string reported by `tailscale version`
 *
 * Never referenced outside tests. Nothing here talks to a real tailnet.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

const STATE = process.env.FAKE_TS_STATE ?? "";
const LOG = process.env.FAKE_TS_LOG ?? "";
const HOST = process.env.FAKE_TS_HOST ?? "fake-mac.tailbeef.ts.net";
const PEERS = (process.env.FAKE_TS_PEERS ?? "peer-phone").split(",").filter(Boolean);
const SCENARIO = process.env.FAKE_TS_SCENARIO ?? "ok";
const VERSION = process.env.FAKE_TS_VERSION ?? "1.78.1-fake";

/** Identity headers a tailnet-fronted `tailscale serve` adds to a proxied request. */
const IDENTITY_HEADERS = {
	"Tailscale-User-Login": "oskar@fr3n.tech",
	"Tailscale-User-Name": "Oskar Freye",
	"Tailscale-User-Profile-Pic": "https://example.invalid/pfp.png",
};

const argv = process.argv.slice(2);

if (LOG) {
	mkdirSync(dirname(LOG), { recursive: true });
	appendFileSync(LOG, `${JSON.stringify({ argv, at: new Date().toISOString() })}\n`);
}

function loadConfig() {
	if (!STATE) return {};
	try {
		return JSON.parse(readFileSync(STATE, "utf-8"));
	} catch {
		return {};
	}
}

function saveConfig(config) {
	if (!STATE) return;
	mkdirSync(dirname(STATE), { recursive: true });
	writeFileSync(STATE, `${JSON.stringify(config, null, 2)}\n`);
}

function die(message, code = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

/** `--set-path <p>` out of a serve argv, defaulting to `/` like the real CLI. */
function setPathOf(args) {
	const index = args.indexOf("--set-path");
	if (index === -1) return "/";
	return args[index + 1] ?? "/";
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

function serve(args) {
	if (args[0] === "status") {
		const config = loadConfig();
		if (args.includes("--json")) {
			process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
		} else {
			process.stdout.write(Object.keys(config.Web ?? {}).join("\n"));
		}
		process.exit(0);
	}

	const key = `${HOST}:443`;
	const path = setPathOf(args);

	if (args.includes("off")) {
		const config = loadConfig();
		const web = config.Web?.[key];
		if (web?.Handlers) {
			delete web.Handlers[path];
			if (Object.keys(web.Handlers).length === 0) delete config.Web[key];
		}
		saveConfig(config);
		process.exit(0);
	}

	const target = args.find((arg) => /^https?:\/\//.test(arg));
	if (!target) die("error: no target given to `tailscale serve`", 1);

	const config = loadConfig();
	config.TCP = { ...(config.TCP ?? {}), 443: { HTTPS: true } };
	config.Web = config.Web ?? {};
	config.Web[key] = config.Web[key] ?? { Handlers: {} };
	config.Web[key].Handlers[path] = { Proxy: target };
	saveConfig(config);

	process.stdout.write(`Available within your tailnet:\n\nhttps://${HOST}${path === "/" ? "/" : path}\n|-- proxy ${target}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function status(args) {
	if (!args.includes("--json")) {
		process.stdout.write(`100.64.0.1   ${HOST.split(".")[0]}   fake   macOS   -\n`);
		process.exit(0);
	}
	const peers = {};
	PEERS.forEach((name, index) => {
		peers[`fakekey${index}`] = {
			DNSName: `${name}.tailbeef.ts.net.`,
			HostName: name,
			TailscaleIPs: [`100.64.0.${index + 2}`],
			Online: true,
			OS: "linux",
		};
	});
	process.stdout.write(
		`${JSON.stringify(
			{
				Version: VERSION,
				BackendState: "Running",
				MagicDNSSuffix: "tailbeef.ts.net",
				Self: { DNSName: `${HOST}.`, HostName: HOST.split(".")[0], TailscaleIPs: ["100.64.0.1"], Online: true },
				Peer: peers,
			},
			null,
			2,
		)}\n`,
	);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// ssh — the two-node drive
// ---------------------------------------------------------------------------

/** Resolve `https://<host><path>` back to the loopback target it is served from. */
function proxyTargetFor(url) {
	const parsed = new URL(url);
	if (parsed.hostname !== HOST) return { error: "dns" };
	const handlers = loadConfig().Web?.[`${HOST}:443`]?.Handlers ?? {};
	// Longest prefix wins, as the real serve config's handler matching does.
	const match = Object.keys(handlers)
		.filter((prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(prefix === "/" ? "/" : `${prefix}/`))
		.sort((a, b) => b.length - a.length)[0];
	if (!match) return { error: "no-handler" };
	return { target: handlers[match].Proxy, path: parsed.pathname + parsed.search };
}

/**
 * Speak HTTP/1.1 to the loopback target and hand back the raw response head
 * plus whatever body arrived. Used for both the plain GET and the upgrade,
 * because the upgrade must not be swallowed by a high-level HTTP client.
 */
function proxyRequest({ target, path, headers, timeoutMs = 15000 }) {
	return new Promise((resolvePromise, reject) => {
		const url = new URL(target);
		const socket = connect({ host: url.hostname, port: Number(url.port || 80) });
		let raw = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("timeout"));
		}, timeoutMs);
		socket.setTimeout(timeoutMs);
		socket.on("connect", () => {
			const lines = [`GET ${path} HTTP/1.1`, `Host: ${HOST}`];
			for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		});
		socket.on("data", (chunk) => {
			raw += chunk.toString("utf-8");
			// The head is all the probe needs; a 101 has no terminating body.
			if (raw.includes("\r\n\r\n")) {
				clearTimeout(timer);
				socket.destroy();
				resolvePromise(raw);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			resolvePromise(raw);
		});
	});
}

/** Pull a single-quoted or bare `-H 'Name: value'` set out of a curl command line. */
function headersFromCurl(command) {
	const headers = {};
	for (const match of command.matchAll(/-H\s+'([^']+)'/g)) {
		const [, pair] = match;
		const index = pair.indexOf(":");
		if (index > 0) headers[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
	}
	return headers;
}

async function ssh(args) {
	const peer = args.find((arg) => !arg.startsWith("-"));
	if (!peer || !PEERS.includes(peer)) die(`ssh: Could not resolve hostname ${peer}: no such host`, 1);

	const command = args[args.length - 1] ?? "";
	const urlMatch = command.match(/https:\/\/[^\s'"]+/);
	if (!urlMatch) die("fake-tailscale: ssh command carried no URL", 2);
	const url = urlMatch[0];

	// Failures only a real tailnet could produce, reported with curl's codes.
	if (SCENARIO === "dns") die(`curl: (6) Could not resolve host: ${new URL(url).hostname}`, 6);
	if (SCENARIO === "cert") die("curl: (60) SSL certificate problem: unable to get local issuer certificate", 60);

	const resolved = proxyTargetFor(url);
	if (resolved.error === "dns") die(`curl: (6) Could not resolve host: ${new URL(url).hostname}`, 6);
	if (resolved.error === "no-handler") {
		process.stdout.write(command.includes("%{http_code}") ? "404" : "HTTP/1.1 404 Not Found\r\n\r\n");
		process.exit(0);
	}

	let raw;
	try {
		raw = await proxyRequest({
			target: resolved.target,
			path: resolved.path,
			headers: { ...IDENTITY_HEADERS, ...headersFromCurl(command) },
		});
	} catch {
		die("curl: (7) Failed to connect", 7);
		return;
	}

	if (!raw) die("curl: (52) Empty reply from server", 52);
	if (command.includes("%{http_code}")) {
		const statusLine = raw.split("\r\n")[0] ?? "";
		process.stdout.write((statusLine.split(" ")[1] ?? "000").trim());
		process.exit(0);
	}
	process.stdout.write(raw);
	process.exit(0);
}

// ---------------------------------------------------------------------------

const [command, ...rest] = argv;
switch (command) {
	case "serve":
		serve(rest);
		break;
	case "status":
		status(rest);
		break;
	case "ssh":
		await ssh(rest);
		break;
	case "version":
		process.stdout.write(`${VERSION}\n`);
		process.exit(0);
		break;
	case "funnel":
		// Unreachable through the script — the guard refuses before spawning.
		// Present so a regression that bypasses the guard fails loudly here.
		die("fake-tailscale: FUNNEL WAS INVOKED — the guard did not hold", 99);
		break;
	default:
		die(`fake-tailscale: unsupported command ${JSON.stringify(command)}`, 64);
}
