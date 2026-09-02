import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { needlesFor, scanText } from "./geist-credential-scan.mjs";

/**
 * The credential scanner that closes R33-REACH.3's acceptance clause: "a scan
 * of the recorded transport and the daemon's logs finds zero credential
 * material in any URL, query string or log line".
 *
 * These tests are the scanner's own mutation proof. A scanner nobody has
 * watched *find* something is worth nothing as a gate: every case below plants
 * a credential in the shape a real leak takes — a query string, an
 * `Authorization:` line a debug logger echoed, a `Referer:` the browser sent
 * onward, a base64url subprotocol — and asserts the scanner names the file,
 * the line and the encoding, so the failure is actionable without re-reading
 * the transcript.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(ROOT, "scripts", "geist-credential-scan.mjs");

/** A credential shaped like the ones `geist pair` mints: opaque, high entropy. */
const SECRET = "gst_live_7Qx91bN3vTf0KpZm";

function run(args) {
	const res = spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf-8" });
	return {
		exitCode: res.status ?? -1,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
		output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
	};
}

/** Materialise `files` (relative path → content) in a fresh dir, run `fn`, clean up. */
function withCorpus(files, fn) {
	const dir = mkdtempSync(join(tmpdir(), "geist-credential-scan-"));
	try {
		const written = {};
		for (const [name, content] of Object.entries(files)) {
			const path = join(dir, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			written[name] = path;
		}
		return fn({ dir, files: written });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a recorded line containing ?token=<secret> is reported with its file, line number and the encoding it was found in", () => {
	const transcript = [
		"2026-08-20T10:00:00.100Z --> GET /health HTTP/1.1",
		`2026-08-20T10:00:00.200Z --> GET /attach?session=s1&token=${SECRET} HTTP/1.1`,
		"2026-08-20T10:00:00.300Z <-- HTTP/1.1 101 Switching Protocols",
	].join("\n");

	withCorpus({ "transport.log": transcript }, ({ files }) => {
		const { exitCode, output } = run(["--secret", SECRET, files["transport.log"]]);

		assert.notEqual(exitCode, 0, `expected a non-zero exit, got:\n${output}`);
		// The file and the line, so the operator can go straight to it.
		assert.match(output, /transport\.log:2\b/, output);
		// The encoding it was found in.
		assert.match(output, /\braw\b/, output);
		// And the shape, named as such, so the fix is obvious.
		assert.match(output, /token/, output);
		// Never the credential itself: this output lands in CI logs.
		assert.doesNotMatch(output, new RegExp(SECRET), "the scanner leaked the secret it was hunting");
	});
});

test("a clean corpus exits 0", () => {
	const files = {
		"transport.log": [
			"2026-08-20T10:00:00.100Z --> GET /fleet HTTP/1.1",
			"2026-08-20T10:00:00.100Z --> Authorization: Bearer [redacted]",
			"2026-08-20T10:00:00.200Z <-- HTTP/1.1 200 OK",
		].join("\n"),
		"daemon.log": ["[AUTH] GET /fleet", "[AUTH] ok device=dev_01H", "[fleet] 2 sessions"].join("\n"),
	};

	withCorpus(files, ({ dir }) => {
		const { exitCode, stdout } = run(["--secret", SECRET, join(dir, "transport.log"), join(dir, "daemon.log")]);
		assert.equal(exitCode, 0, stdout);
		assert.match(stdout, /no credential material/);
	});
});

test("a secret echoed in an Authorization: header line is reported", () => {
	const log = ["[AUTH] GET /attach", `[AUTH] header Authorization: Bearer ${SECRET}`, "[AUTH] ok"].join("\n");

	withCorpus({ "daemon.log": log }, ({ files }) => {
		const { exitCode, output } = run(["--secret", SECRET, files["daemon.log"]]);
		assert.notEqual(exitCode, 0, output);
		assert.match(output, /daemon\.log:2\b/, output);
		assert.match(output, /\braw\b/, output);
		assert.doesNotMatch(output, new RegExp(SECRET));
	});
});

test("a secret carried onward in a Referer: header line is reported", () => {
	const log = [
		"2026-08-20T10:01:00.000Z --> GET /assets/app.css HTTP/1.1",
		`2026-08-20T10:01:00.000Z --> Referer: https://box.tail1234.ts.net/console?token=${encodeURIComponent(SECRET)}`,
	].join("\n");

	withCorpus({ "transport.log": log }, ({ files }) => {
		const { exitCode, output } = run(["--secret", SECRET, files["transport.log"]]);
		assert.notEqual(exitCode, 0, output);
		assert.match(output, /transport\.log:2\b/, output);
		assert.doesNotMatch(output, new RegExp(SECRET));
	});
});

test("a secret percent-encoded in a URL is reported as percent-encoded", () => {
	// A value whose percent form differs from its raw form.
	const secret = "gst live/7Qx+91bN3vTf0KpZm";
	const line = `GET /attach?token=${encodeURIComponent(secret)} HTTP/1.1`;

	withCorpus({ "transport.log": `head\n${line}\n` }, ({ files }) => {
		const { exitCode, output } = run(["--secret", secret, files["transport.log"]]);
		assert.notEqual(exitCode, 0, output);
		assert.match(output, /transport\.log:2\b/, output);
		assert.match(output, /percent-encoded/, output);
	});
});

test("a secret base64url-encoded in a WebSocket subprotocol is reported as base64url", () => {
	// The exact shape the served console uses: `geist.bearer.<base64url>` on
	// `Sec-WebSocket-Protocol`, the only credential a browser can put on an
	// upgrade. Correct on the wire — a leak the moment it lands in a log file.
	const encoded = Buffer.from(SECRET, "utf-8").toString("base64url");
	const log = [
		"2026-08-20T10:02:00.000Z --> GET /attach HTTP/1.1",
		`2026-08-20T10:02:00.000Z --> Sec-WebSocket-Protocol: geist.bearer.${encoded}`,
		"2026-08-20T10:02:00.000Z <-- HTTP/1.1 101 Switching Protocols",
	].join("\n");

	withCorpus({ "daemon.log": log }, ({ files }) => {
		const { exitCode, output } = run(["--secret", SECRET, files["daemon.log"]]);
		assert.notEqual(exitCode, 0, output);
		assert.match(output, /daemon\.log:2\b/, output);
		assert.match(output, /base64url/, output);
		assert.doesNotMatch(output, new RegExp(encoded), "the scanner leaked the encoded secret");
	});
});

test("the masked excerpt leaves no fragment of the encoded credential behind", () => {
	// The base64 needle deliberately omits the boundary characters whose value
	// depends on neighbouring bytes — but those characters still encode part of
	// the credential, so the mask has to cover more than it matched.
	const encoded = Buffer.from(SECRET, "utf-8").toString("base64url");
	const log = `Sec-WebSocket-Protocol: geist.bearer.${encoded}\n`;

	withCorpus({ "daemon.log": log }, ({ files }) => {
		const { output } = run(["--secret", SECRET, files["daemon.log"]]);
		const excerpt = output.split("\n").find((l) => l.includes("geist.bearer."));
		assert.ok(excerpt, output);
		assert.match(excerpt, /geist\.bearer\.\[REDACTED \d+ chars\]$/, excerpt);
	});
});

test("a token= construct is reported even when its value is not a declared secret", () => {
	// The declared-secret set can never be complete — a rotated per-device
	// credential (R33-REACH.5) is minted at runtime and the scan never sees it.
	// So the *shape* is a finding on its own.
	const log = ["GET /fleet HTTP/1.1", "GET /attach?session=s1&token=rotated_dev_credential_not_declared HTTP/1.1"].join("\n");

	withCorpus({ "transport.log": log }, ({ files }) => {
		const { exitCode, output } = run(["--secret", SECRET, files["transport.log"]]);
		assert.notEqual(exitCode, 0, output);
		assert.match(output, /transport\.log:2\b/, output);
		assert.match(output, /query parameter/i, output);
		assert.doesNotMatch(output, /rotated_dev_credential_not_declared/, "the scanner echoed the undeclared value");
	});
});

test("an empty secret set exits non-zero rather than reporting a clean tree", () => {
	withCorpus({ "transport.log": "nothing to see\n" }, ({ files }) => {
		const noFlags = run([files["transport.log"]]);
		assert.notEqual(noFlags.exitCode, 0);
		assert.match(noFlags.output, /refusing to run a vacuous scan/);

		// An empty --secret value is the same vacuum wearing a flag: the CI
		// invocation `--secret "$GEIST_TOKEN"` with the variable unset must not
		// silently pass.
		const emptyFlag = run(["--secret", "", files["transport.log"]]);
		assert.notEqual(emptyFlag.exitCode, 0);
		assert.match(emptyFlag.output, /refusing to run a vacuous scan/);
	});
});

test("a directory target is walked, and every occurrence on a line is reported", () => {
	const files = {
		"recordings/a.log": "clean\n",
		"recordings/nested/b.log": `x ${SECRET} y ${SECRET} z\n`,
	};

	withCorpus(files, ({ dir }) => {
		const { exitCode, output } = run(["--secret", SECRET, join(dir, "recordings")]);
		assert.notEqual(exitCode, 0, output);
		assert.match(output, /nested\/b\.log:1\b/, output);
		// Both columns, so "there is one more further along the line" is visible.
		assert.match(output, /b\.log:1:3\b/, output);
		assert.match(output, /b\.log:1:\d+/, output);
		assert.doesNotMatch(output, /a\.log/, output);
	});
});

test("needlesFor derives the four encodings a credential survives in", () => {
	const encodings = new Set(needlesFor("a b/c+d").flatMap((n) => n.encoding.split("/")));
	assert.ok(encodings.has("raw"), [...encodings].join(", "));
	assert.ok(encodings.has("percent-encoded"), [...encodings].join(", "));
	assert.ok(encodings.has("base64"), [...encodings].join(", "));
	assert.ok(encodings.has("base64url"), [...encodings].join(", "));
});

test("scanText finds a base64 credential that is not aligned to a 3-byte boundary", () => {
	// A credential base64'd as part of a larger frame lands at an arbitrary byte
	// offset, so its encoding shares no prefix with `btoa(secret)`. A scanner
	// that only looks for the aligned form reports a clean transcript.
	const secret = "gst_live_7Qx91bN3vTf0KpZm";
	const needles = needlesFor(secret);
	for (const prefix of ["", "x", "xy"]) {
		const frame = Buffer.from(`${prefix}${secret}!tail`, "utf-8").toString("base64");
		const findings = scanText(`frame=${frame}\n`, needles);
		assert.ok(
			findings.some((f) => f.encoding.includes("base64")),
			`offset ${prefix.length}: no base64 finding in ${JSON.stringify(findings)}`,
		);
	}
});
