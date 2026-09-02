#!/usr/bin/env node
/**
 * TLS-terminating reverse proxy reproducing the `tailscale serve` topology
 * (R33-REACH.3, R33-REACH.8, R33-REACH.9).
 *
 * Phase 33 puts the emitted binaries behind `tailscale serve`: a TLS front end on
 * a MagicDNS name, a daemon bound to 127.0.0.1 behind it, and a tailnet identity
 * header the front end sets and the daemon must never accept from the client.
 * Every property that matters there — that a `wss://` upgrade survives the hop,
 * that a credential in a query string would be visible in the transport, that
 * killing the front end mid-session produces a real disconnect — is a property of
 * the *topology*, not of the tailnet. So the topology is reproduced locally and CI
 * never needs a tailnet, a cert authority, or Oskar's laptop.
 *
 * What it deliberately is not: a tailscale emulator. There is no MagicDNS, no
 * Funnel, no node identity. It terminates TLS, forwards HTTP and WebSocket to one
 * loopback origin, owns the identity header end to end, and can be killed. The
 * observed real-tailnet identity-header contract gets pinned into it later (Phase
 * 33 class-4 evidence), which is why the header name and value are arguments
 * rather than constants.
 *
 * Usage:
 *   node scripts/fixtures/tls-proxy.mjs --target http://127.0.0.1:4711 \
 *     [--port 8443] [--identity-header Tailscale-User-Login:owner@example.com] \
 *     [--record /tmp/transcript.ndjson] [--cert-dir /tmp/certs]
 *
 * On startup it generates a self-signed cert for 127.0.0.1 into a temp directory
 * and prints, on stdout:
 *   CA <path to the PEM a client must trust>
 *   LISTENING https://127.0.0.1:<port>
 *
 * `--record` appends one NDJSON object per proxied half:
 *   {"seq":1,"direction":"client->backend","at":"<iso>","bytes":214,"kind":"http"}
 * `direction` is the two halves of the hop; `kind` separates the plain HTTP
 * exchange from everything after an upgrade. `bytes` counts the plaintext this
 * proxy forwarded — head plus body — which is what a "no credential on the wire"
 * scan needs to be able to size.
 *
 * SIGTERM destroys every live socket and exits, so a test can kill the front end
 * mid-session and immediately rebind the same port. That is the whole point of
 * the port being an argument.
 *
 * openssl is required, and its absence is a failure rather than a skip: a fixture
 * that quietly declines to run is how `listeningSockets()` passed on a machine
 * where it could not observe anything.
 */

import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1). Dropped on a plain proxied request; on an
 * upgrade, `connection` and `upgrade` are the payload of the hop and are kept.
 */
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

/**
 * The identity family `tailscale serve` owns. Stripped from every inbound request
 * whether or not this run injects one, because "absent never grants access" is
 * only meaningful if the client cannot supply it (R33-REACH.8).
 */
const IDENTITY_PREFIX = "tailscale-user-";

main();

function main() {
	const args = parseArgs(process.argv.slice(2));

	// Before anything else: no openssl, no fixture. Loudly.
	const openssl = findOpenssl();
	if (!openssl) {
		process.stderr.write("tls-proxy: openssl not found on PATH\n");
		process.exit(1);
	}

	if (!args.target) {
		process.stderr.write("tls-proxy: --target <origin> is required\n");
		process.exit(2);
	}

	let target;
	try {
		target = new URL(args.target);
	} catch {
		process.stderr.write(`tls-proxy: --target is not a URL: ${args.target}\n`);
		process.exit(2);
	}

	const identity = parseIdentityHeader(args["identity-header"]);
	const recorder = createRecorder(args.record);
	const certDir = args["cert-dir"] ?? mkdtempSync(join(tmpdir(), "tls-proxy-cert-"));
	const { certPath, keyPath } = generateSelfSignedCert(openssl, certDir);

	const backend = {
		host: target.hostname,
		port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
	};
	const authority = `${backend.host}:${backend.port}`;

	const liveSockets = new Set();
	const track = (socket) => {
		liveSockets.add(socket);
		socket.on("close", () => liveSockets.delete(socket));
	};

	const server = https.createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) =>
		proxyRequest({ req, res, backend, authority, identity, recorder, track }),
	);

	server.on("secureConnection", track);
	server.on("upgrade", (req, socket, head) =>
		proxyUpgrade({ req, socket, head, backend, authority, identity, recorder, track }),
	);
	server.on("clientError", (_error, socket) => socket.destroy());

	const shutdown = () => {
		for (const socket of liveSockets) socket.destroy();
		server.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// hostname named explicitly: this fixture stands in for a front end, and a
	// front end that binds every interface is the bug GSEC-04 is about.
	server.listen(Number(args.port ?? 0), "127.0.0.1", () => {
		const { port } = server.address();
		process.stdout.write(`CA ${certPath}\n`);
		process.stdout.write(`LISTENING https://127.0.0.1:${port}\n`);
	});
}

/** Proxy one ordinary HTTP request, recording the size of each half. */
function proxyRequest({ req, res, backend, authority, identity, recorder, track }) {
	const headers = forwardHeaders(req.headers, { authority, identity, websocket: false });
	const requestHead = headBytes(`${req.method} ${req.url} HTTP/1.1`, headers);
	let requestBody = 0;

	const upstream = http.request(
		{ host: backend.host, port: backend.port, method: req.method, path: req.url, headers, agent: false },
		(response) => {
			const responseHeaders = stripHopByHop(response.headers);
			const responseHead = headBytes(
				`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}`.trimEnd(),
				responseHeaders,
			);
			let responseBody = 0;
			res.writeHead(response.statusCode ?? 502, responseHeaders);
			response.on("data", (chunk) => {
				responseBody += chunk.length;
			});
			response.on("end", () => recorder.write("backend->client", responseHead + responseBody, "http"));
			response.pipe(res);
		},
	);

	upstream.on("socket", track);
	upstream.on("error", (error) => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
		res.end(`tls-proxy: backend unreachable: ${error.message}\n`);
	});

	req.on("data", (chunk) => {
		requestBody += chunk.length;
	});
	req.on("end", () => recorder.write("client->backend", requestHead + requestBody, "http"));
	req.pipe(upstream);
}

/**
 * Proxy one upgrade. The 101 is relayed verbatim — including
 * `sec-websocket-accept` and any negotiated subprotocol — and then the two raw
 * sockets are joined, with every chunk counted in the direction it travelled.
 */
function proxyUpgrade({ req, socket: clientSocket, head, backend, authority, identity, recorder, track }) {
	track(clientSocket);
	const headers = forwardHeaders(req.headers, { authority, identity, websocket: true });
	recorder.write(
		"client->backend",
		headBytes(`${req.method} ${req.url} HTTP/1.1`, headers) + (head?.length ?? 0),
		"ws",
	);

	const upstream = http.request({
		host: backend.host,
		port: backend.port,
		method: req.method,
		path: req.url,
		headers,
		agent: false,
	});

	upstream.on("upgrade", (response, backendSocket, backendHead) => {
		track(backendSocket);
		const relayed = statusHead(response.statusCode, response.statusMessage, response.headers);
		clientSocket.write(relayed);
		recorder.write("backend->client", Buffer.byteLength(relayed), "ws");

		if (head?.length) backendSocket.write(head);
		if (backendHead?.length) {
			clientSocket.write(backendHead);
			recorder.write("backend->client", backendHead.length, "ws");
		}

		clientSocket.on("data", (chunk) => recorder.write("client->backend", chunk.length, "ws"));
		backendSocket.on("data", (chunk) => recorder.write("backend->client", chunk.length, "ws"));

		const drop = () => {
			clientSocket.destroy();
			backendSocket.destroy();
		};
		clientSocket.on("error", drop);
		backendSocket.on("error", drop);
		clientSocket.on("close", () => backendSocket.destroy());
		backendSocket.on("close", () => clientSocket.destroy());

		clientSocket.pipe(backendSocket);
		backendSocket.pipe(clientSocket);
	});

	upstream.on("response", (response) => {
		// the backend refused the upgrade: relay its answer and hang up
		const relayed = statusHead(response.statusCode, response.statusMessage, response.headers);
		clientSocket.write(relayed);
		recorder.write("backend->client", Buffer.byteLength(relayed), "ws");
		response.on("data", (chunk) => clientSocket.write(chunk));
		response.on("end", () => clientSocket.end());
	});

	upstream.on("error", () => clientSocket.destroy());
	upstream.end();
}

/**
 * Build the header set forwarded to the backend.
 *
 * The identity header is removed and re-set rather than defaulted: a client that
 * supplies its own copy must not be able to influence what the backend sees, and
 * neither must one that supplies a *different* member of the same family.
 */
function forwardHeaders(incoming, { authority, identity, websocket }) {
	const out = {};
	for (const [name, value] of Object.entries(incoming)) {
		const lower = name.toLowerCase();
		if (lower === "host") continue;
		if (lower.startsWith(IDENTITY_PREFIX)) continue;
		if (identity && lower === identity.lowerName) continue;
		if (HOP_BY_HOP.has(lower) && !(websocket && (lower === "connection" || lower === "upgrade"))) continue;
		out[name] = value;
	}
	out.host = authority;
	if (identity) out[identity.name] = identity.value;
	return out;
}

function stripHopByHop(headers) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(name.toLowerCase())) continue;
		out[name] = value;
	}
	return out;
}

/** `--identity-header Name:Value` */
function parseIdentityHeader(raw) {
	if (!raw) return null;
	const colon = raw.indexOf(":");
	if (colon <= 0) {
		process.stderr.write(`tls-proxy: --identity-header expects <name>:<value>, got: ${raw}\n`);
		process.exit(2);
	}
	const name = raw.slice(0, colon).trim();
	return { name, lowerName: name.toLowerCase(), value: raw.slice(colon + 1).trim() };
}

/** Serialized byte length of a request/response head, as this proxy forwards it. */
function headBytes(startLine, headers) {
	return Buffer.byteLength(renderHead(startLine, headers));
}

function statusHead(statusCode, statusMessage, headers) {
	return renderHead(`HTTP/1.1 ${statusCode} ${statusMessage ?? ""}`.trimEnd(), headers);
}

function renderHead(startLine, headers) {
	let text = `${startLine}\r\n`;
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		for (const one of Array.isArray(value) ? value : [value]) text += `${name}: ${one}\r\n`;
	}
	return `${text}\r\n`;
}

/**
 * NDJSON transcript. Appended synchronously: a fixture whose transcript is still
 * in a buffer when the test reads it is worse than no transcript.
 */
function createRecorder(path) {
	if (!path) return { write() {} };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	let seq = 0;
	return {
		write(direction, bytes, kind) {
			if (!(bytes > 0)) return;
			seq += 1;
			appendFileSync(path, `${JSON.stringify({ seq, direction, at: new Date().toISOString(), bytes, kind })}\n`);
		},
	};
}

/**
 * Resolve `openssl` off PATH by hand rather than by spawning it, so that a PATH
 * with no openssl on it produces this fixture's own diagnostic rather than a
 * spawn ENOENT from somewhere deeper.
 */
function findOpenssl() {
	const separator = process.platform === "win32" ? ";" : ":";
	const names = process.platform === "win32" ? ["openssl.exe", "openssl"] : ["openssl"];
	for (const dir of (process.env.PATH ?? "").split(separator)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// keep looking
			}
		}
	}
	return null;
}

/**
 * A fresh self-signed cert for 127.0.0.1, valid for a day, generated per start.
 *
 * Written through a config file rather than `-addext` because the openssl on PATH
 * may be LibreSSL (the macOS system one is), and `-addext` is not portable across
 * both. `CA:TRUE` is set so the cert can be handed to a client as its own trust
 * root, which is how the tests reach it without touching the system trust store.
 */
function generateSelfSignedCert(openssl, dir) {
	mkdirSync(dir, { recursive: true });
	const configPath = join(dir, "openssl.cnf");
	const certPath = join(dir, "cert.pem");
	const keyPath = join(dir, "key.pem");

	writeFileSync(
		configPath,
		[
			"[req]",
			"distinguished_name = dn",
			"x509_extensions = v3",
			"prompt = no",
			"",
			"[dn]",
			"CN = 127.0.0.1",
			"",
			"[v3]",
			"basicConstraints = critical, CA:TRUE",
			"keyUsage = critical, digitalSignature, keyCertSign",
			"subjectAltName = IP:127.0.0.1, DNS:localhost",
			"",
		].join("\n"),
	);

	const result = spawnSync(
		openssl,
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-sha256",
			"-days",
			"1",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-config",
			configPath,
		],
		{ encoding: "utf-8" },
	);

	if (result.status !== 0) {
		process.stderr.write(`tls-proxy: openssl failed to generate a certificate\n${result.stderr ?? ""}\n`);
		process.exit(1);
	}

	return { certPath, keyPath };
}

/** `--flag value` and `--flag=value`; bare `--flag` is `true`. */
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const equals = token.indexOf("=");
		if (equals !== -1) {
			out[token.slice(2, equals)] = token.slice(equals + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out[token.slice(2)] = true;
			continue;
		}
		out[token.slice(2)] = next;
		i += 1;
	}
	return out;
}
