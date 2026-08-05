"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const cli = path.resolve(__dirname, "../bin/draht-tools.cjs");

function runMap(extraArgs = [], extraEnv = {}, suppliedHome) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-shim-test-"));
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
	fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
	const home = suppliedHome || fs.mkdtempSync(path.join(os.tmpdir(), "draht-shim-home-"));
	const result = spawnSync(process.execPath, [cli, "map-graph", "--quiet", ...extraArgs], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: home,
			PATH: "",
			DRAHT_GRAPH_BIN: "",
			DRAHT_GRAPH_ENGINE: "auto",
			...extraEnv,
		},
	});
	return { ...result, root };
}

function managedBinaryFixture(stampValue) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "draht-shim-managed-"));
	const binDir = path.join(home, ".draht", "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const binary = path.join(binDir, "draht-graph");
	const original = "#!/bin/sh\nprintf delegated > \"$DRAHT_DELEGATED_MARKER\"\n";
	fs.writeFileSync(binary, original);
	fs.chmodSync(binary, 0o755);
	const stamp = stampValue ?? {
		name: "draht-graph",
		version: "1.2.3",
		schemaVersion: 5,
		sha256: crypto.createHash("sha256").update(original).digest("hex"),
		size: Buffer.byteLength(original),
	};
	fs.writeFileSync(path.join(binDir, ".draht-graph.json"), typeof stamp === "string" ? stamp : JSON.stringify(stamp));
	return { home, binary, original };
}

test("auto mode warns when symbol signatures cannot be provided by a Go binary", () => {
	const result = runMap(["--symbol-signatures"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /--symbol-signatures requires the Go graph engine/i);
	const map = JSON.parse(fs.readFileSync(path.join(result.root, ".planning/codebase/MAP.json"), "utf8"));
	assert.equal(JSON.stringify(map).includes('"signature"'), false);
});

test("forced Go mode fails clearly when symbol signatures cannot be provided", () => {
	const result = runMap(["--symbol-signatures"], { DRAHT_GRAPH_ENGINE: "go" });
	assert.equal(result.status, 127);
	assert.match(result.stderr, /Go graph engine was required/i);
});

test("default auto commands preserve silent JavaScript fallback", () => {
	const result = runMap();
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /requires the Go graph engine|symbol-signatures/i);
});

test("auto mode rejects a same-size tampered managed binary instead of executing it", () => {
	const fixture = managedBinaryFixture();
	const marker = path.join(fixture.home, "delegated");
	const tampered = fixture.original.replace("delegated", "TAMPERED!");
	assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(fixture.original));
	fs.writeFileSync(fixture.binary, tampered);
	const result = runMap([], { DRAHT_DELEGATED_MARKER: marker }, fixture.home);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(marker), false);
	assert.match(result.stderr, /sha-256|provenance stamp/i);
});

test("auto mode rejects a managed binary with a malformed stamp", () => {
	const fixture = managedBinaryFixture("{not json");
	const marker = path.join(fixture.home, "delegated");
	const result = runMap([], { DRAHT_DELEGATED_MARKER: marker }, fixture.home);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(marker), false);
	assert.match(result.stderr, /provenance stamp/i);
});

test("an explicit managed binary override cannot bypass its digest stamp", () => {
	const fixture = managedBinaryFixture();
	const marker = path.join(fixture.home, "delegated");
	fs.writeFileSync(fixture.binary, fixture.original.replace("delegated", "TAMPERED!"));
	const result = runMap([], {
		DRAHT_GRAPH_BIN: fixture.binary,
		DRAHT_DELEGATED_MARKER: marker,
	}, fixture.home);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(marker), false);
	assert.match(result.stderr, /provenance stamp/i);
});

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

function waitForText(child, text, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${text}; output=${output}`)), timeoutMs);
		const onData = (chunk) => {
			output += chunk;
			if (!output.includes(text)) return;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			resolve();
		};
		child.stdout.on("data", onData);
	});
}

test("JavaScript map-serve watches planning sources exactly once without generated-output loops", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-planning-watch-test-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "draht-planning-watch-home-"));
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
	fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
	fs.mkdirSync(path.join(root, ".planning", "codebase"), { recursive: true });
	const planningSources = [
		"STATE.md", "ROADMAP.md", "PROJECT.md", "DOMAIN.md", "DOMAIN-MODEL.md",
		path.join("codebase", "GROUPS.json"), path.join("codebase", "FLOWS.json"),
	];
	for (const relative of planningSources) {
		fs.writeFileSync(path.join(root, ".planning", relative), relative.endsWith(".json") ? "{}\n" : `${relative} v1\n`);
	}

	const port = await freePort();
	const child = spawn(process.execPath, [cli, "map-serve", "--port", String(port), "--no-open"], {
		cwd: root,
		env: { ...process.env, HOME: home, PATH: "", DRAHT_GRAPH_ENGINE: "js" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	t.after(() => {
		child.kill();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});
	await waitForText(child, `Open http://localhost:${port}`);

	const regenerationCount = () => (output.match(/regenerated MAP\.json/g) || []).length;
	const waitForRegenerations = async (expected, timeoutMs = 5000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && regenerationCount() < expected) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(regenerationCount(), expected, `expected ${expected} regenerations; output=${output}`);
	};
	for (let i = 0; i < planningSources.length; i++) {
		const relative = planningSources[i];
		fs.writeFileSync(path.join(root, ".planning", relative), relative.endsWith(".json") ? `{"version":${i + 2}}\n` : `${relative} v2\n`);
		await waitForRegenerations(i + 1);
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.equal(regenerationCount(), i + 1, `${relative} triggered a regeneration loop; output=${output}`);
	}

	const outDir = path.join(root, ".planning", "codebase");
	fs.writeFileSync(path.join(outDir, "MAP.json"), "{}\n");
	fs.writeFileSync(path.join(outDir, "MAP.html"), "generated\n");
	fs.writeFileSync(path.join(outDir, "GRAPH_REPORT.md"), "generated\n");
	for (const generatedDir of [".cache", ".map-publish-lock", ".map-publish-stage-js-test"]) {
		const dir = path.join(outDir, generatedDir);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "generated.js"), "generated\n");
	}
	await new Promise((resolve) => setTimeout(resolve, 900));
	assert.equal(regenerationCount(), planningSources.length, `generated outputs triggered regeneration; output=${output}`);
});

test("JavaScript map-serve caps SSE clients before sending stream bytes", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-sse-cap-test-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "draht-sse-cap-home-"));
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
	fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
	const port = await freePort();
	const child = spawn(process.execPath, [cli, "map-serve", "--port", String(port), "--no-open"], {
		cwd: root,
		env: { ...process.env, HOME: home, PATH: "", DRAHT_GRAPH_ENGINE: "js" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const requests = [];
	t.after(() => {
		for (const request of requests) request.destroy();
		child.kill();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});
	await waitForText(child, `Open http://localhost:${port}`);

	for (let i = 0; i < 64; i++) {
		const request = http.get(`http://127.0.0.1:${port}/events`);
		requests.push(request);
		const response = await new Promise((resolve, reject) => {
			request.once("response", resolve);
			request.once("error", reject);
		});
		assert.equal(response.statusCode, 200);
		await new Promise((resolve) => response.once("data", resolve));
	}
	const rejected = http.get(`http://127.0.0.1:${port}/events`);
	requests.push(rejected);
	const response = await new Promise((resolve, reject) => {
		rejected.once("response", resolve);
		rejected.once("error", reject);
	});
	assert.equal(response.statusCode, 503);
	assert.notEqual(response.headers["content-type"], "text/event-stream");
});

test("JavaScript map-serve evicts an SSE client that signals backpressure", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-sse-test-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "draht-sse-home-"));
	const log = path.join(root, "writes.log");
	const preload = path.join(root, "preload.cjs");
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
	fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
	fs.writeFileSync(preload, `
const fs = require("node:fs");
const http = require("node:http");
const original = http.ServerResponse.prototype.write;
let forced = false;
http.ServerResponse.prototype.write = function (chunk, ...args) {
  const text = String(chunk);
  const result = original.call(this, chunk, ...args);
  if (!text.includes("data: changed")) return result;
  fs.appendFileSync(process.env.DRAHT_SSE_LOG, "event\\n");
  if (!forced) { forced = true; return false; }
  return result;
};
`);
	const port = await freePort();
	const child = spawn(process.execPath, ["--require", preload, cli, "map-serve", "--port", String(port), "--no-open"], {
		cwd: root,
		env: { ...process.env, HOME: home, PATH: "", DRAHT_GRAPH_ENGINE: "js", DRAHT_SSE_LOG: log },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => {
		child.kill();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});
	await waitForText(child, `Open http://localhost:${port}`);

	const request = http.get(`http://127.0.0.1:${port}/events`);
	await new Promise((resolve, reject) => {
		request.once("response", (response) => { response.once("data", resolve); });
		request.once("error", reject);
	});
	for (let generation = 2; generation <= 3; generation++) {
		const regenerated = waitForText(child, "regenerated MAP.json");
		fs.writeFileSync(path.join(root, "index.js"), `export const value = ${generation};\n`);
		await regenerated;
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	const writes = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	assert.equal(writes.length, 1, `backpressured SSE response received ${writes.length} event writes`);
});
