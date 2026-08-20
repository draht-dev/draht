#!/usr/bin/env node
/**
 * Credential scanner for recorded transport and daemon logs (R33-REACH.3).
 *
 * Phase 33's acceptance ends with a clause no assertion in the gateway can
 * satisfy: "a scan of the recorded transport and the daemon's logs finds zero
 * credential material in any URL, query string or log line". Removing the
 * `?token=` fallback from `gateway/src/gateway/middleware/auth.ts` proves the
 * *server* no longer reads a credential out of a URL. It proves nothing about
 * whether one still ends up written down — in an access log, in a `Referer`
 * the browser forwarded to a third party, in a debug line that echoed the
 * `Authorization` header it just parsed. Those are the leaks that survive the
 * fix, and only a scan of what was actually recorded finds them.
 *
 * So this script takes the credentials the harness minted and a corpus of
 * recorded files, and reports every place a credential survived — in every
 * encoding it survives in:
 *
 *   raw                    the credential as issued
 *   percent-encoded        a URL-escaped query value, upper- and lower-case hex
 *   double-percent-encoded what a redirect chain or a proxy rewrite produces
 *   base64 / base64url     `geist.bearer.<base64url>` on `Sec-WebSocket-Protocol`
 *                          is the credential's *correct* home on the wire, and a
 *                          leak the moment a log line quotes the header
 *
 * The base64 forms are derived at all three byte alignments, because a
 * credential encoded as part of a larger frame starts at an arbitrary offset
 * and its encoding then shares no prefix with `btoa(secret)`. A scanner that
 * only looks for the aligned form reports a clean transcript over a leaking
 * one, which is worse than no scanner at all.
 *
 * Independently of any declared secret, a `?token=` / `&token=`-shaped
 * construct is a finding on its own. The declared set can never be complete:
 * a per-device credential is rotated at runtime (R33-REACH.5) and the scan
 * never sees its value. What the scan *can* see is that the transport carried
 * a credential-shaped query parameter at all, which after R33-REACH.3 is
 * always wrong regardless of what the value turns out to be.
 *
 * The scanner never prints the material it found. Its output is read in CI
 * logs, and a leak detector that copies the leak into a second, more widely
 * read log has moved the credential rather than reported it. Findings name the
 * file, the line, the column and the encoding — enough to go straight to the
 * offending line — and the excerpt has every match masked.
 *
 * An invocation with no secrets is refused. `--secret "$GEIST_TOKEN"` with the
 * variable unset would otherwise scan for nothing, find nothing, exit 0, and
 * report a clean tree forever after; use `--secret-env` to avoid putting the
 * credential in the process table at all.
 *
 * Usage:
 *   node scripts/geist-credential-scan.mjs --secret <value> [--secret <value>…] <file|dir>…
 *   node scripts/geist-credential-scan.mjs --secret-env GEIST_TOKEN recordings/
 *
 * Exit codes: 0 clean, 1 findings, 2 usage error (including a vacuous scan).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const VACUOUS_SCAN_MESSAGE = "refusing to run a vacuous scan";

/** Query parameter names that carry a credential. Matched by shape, not value. */
const CREDENTIAL_PARAMS = ["token", "access_token", "auth_token", "id_token", "api_key", "apikey", "key", "secret", "password"];

const STRUCTURAL_PARAM = new RegExp(`[?&](${CREDENTIAL_PARAMS.join("|")})=([^&\\s"'\`\\\\<>]*)`, "gi");

/** Directories that never hold recorded evidence. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Files whose bytes are not text and would only produce noise. */
const SKIP_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".mp4", ".mov", ".woff", ".woff2"]);

/**
 * Base64-encode `buf` at byte alignment `align`, then trim the characters whose
 * value depends on bytes outside the secret.
 *
 * Base64 packs three bytes into four characters, so a secret sitting at offset
 * 1 or 2 of a larger payload encodes to a completely different character
 * sequence than the same secret encoded alone. Prefixing filler bytes
 * reproduces that shift; dropping the boundary characters — 2 leading for
 * alignment 1, 3 for alignment 2, and 1 trailing whenever the secret does not
 * itself end on a 3-byte boundary — leaves the stable core, which is a
 * substring of the encoding of *any* payload containing this secret at this
 * alignment.
 */
function encodeAligned(buf, align, urlAlphabet) {
	const padded = Buffer.concat([Buffer.alloc(align, 0x41), buf]);
	let encoded = padded.toString("base64").replace(/=+$/, "");
	if (urlAlphabet) encoded = encoded.replace(/\+/g, "-").replace(/\//g, "_");
	const leadDrop = [0, 2, 3][align];
	const tailDrop = (align + buf.length) % 3 === 0 ? 0 : 1;
	return encoded.slice(leadDrop, encoded.length - tailDrop);
}

/**
 * Every literal a credential can appear as, tagged with the encoding it is in.
 *
 * Values that coincide across encodings are reported under a joined label
 * (`base64/base64url` when the credential's base64 happens to contain neither
 * `+` nor `/`) rather than arbitrarily attributed to one of them.
 */
export function needlesFor(secret, label = "declared secret") {
	/** @type {Map<string, {encodings: Set<string>, expandLeft: number, expandRight: number}>} */
	const byValue = new Map();
	const push = (value, encoding, { minLength = 1, expandLeft = 0, expandRight = 0 } = {}) => {
		if (typeof value !== "string" || value.length < minLength) return;
		const existing = byValue.get(value);
		if (existing) {
			existing.encodings.add(encoding);
			existing.expandLeft = Math.max(existing.expandLeft, expandLeft);
			existing.expandRight = Math.max(existing.expandRight, expandRight);
			return;
		}
		byValue.set(value, { encodings: new Set([encoding]), expandLeft, expandRight });
	};

	push(secret, "raw");

	const percent = encodeURIComponent(secret);
	push(percent, "percent-encoded");
	push(
		percent.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
		"percent-encoded",
	);
	push(encodeURIComponent(percent), "double-percent-encoded");

	const buf = Buffer.from(secret, "utf-8");
	for (const urlAlphabet of [false, true]) {
		const encoding = urlAlphabet ? "base64url" : "base64";
		for (let align = 0; align < 3; align++) {
			// The boundary characters this needle deliberately does not contain
			// still *encode* part of the credential, so masking must cover them
			// even though matching cannot rely on them.
			const expandLeft = [0, 2, 3][align];
			const expandRight = (align + buf.length) % 3 === 0 ? 0 : 1;
			// Unaligned cores are short by construction; a 4-character needle
			// would match half the transcript, so only trust the longer ones.
			push(encodeAligned(buf, align, urlAlphabet), encoding, {
				minLength: align === 0 ? 4 : 8,
				expandLeft,
				expandRight,
			});
		}
	}

	return [...byValue].map(([value, meta]) => ({
		value,
		encoding: [...meta.encodings].join("/"),
		expandLeft: meta.expandLeft,
		expandRight: meta.expandRight,
		label,
	}));
}

/** Characters that can belong to a base64 or base64url encoding of the same payload. */
const BASE64_CHAR = /[A-Za-z0-9+/\-_=]/;

/** Widen a match to swallow the encoding's trimmed boundary characters, so the mask leaves no fragment behind. */
function widen(line, start, end, needle) {
	let from = start;
	for (let i = 0; i < (needle.expandLeft ?? 0) && from > 0 && BASE64_CHAR.test(line[from - 1]); i++) from--;
	let to = end;
	for (let i = 0; i < (needle.expandRight ?? 0) && to < line.length && BASE64_CHAR.test(line[to]); i++) to++;
	return { start: from, end: to };
}

/** Replace `[start, end)` ranges with a fixed-width marker, so no match survives into the report. */
function maskRanges(line, ranges) {
	if (ranges.length === 0) return line;
	const merged = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	let out = "";
	let cursor = 0;
	for (const range of merged) {
		out += line.slice(cursor, range.start);
		out += `[REDACTED ${range.end - range.start} chars]`;
		cursor = range.end;
	}
	return out + line.slice(cursor);
}

/** Keep excerpts readable, and keep an enormous single-line frame from flooding CI. */
function truncate(text, max = 240) {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Findings in `text`, sorted by line then column.
 *
 * Every finding carries the masked line it was found on: masked once per line
 * across *all* matches on it, so a second credential further along the line
 * cannot ride into the report inside another finding's excerpt.
 */
export function scanText(text, needles) {
	const findings = [];
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === "") continue;
		/** @type {{start: number, end: number}[]} */
		const ranges = [];
		/** @type {{line: number, column: number, encoding: string, detail: string}[]} */
		const onThisLine = [];

		for (const needle of needles) {
			let index = line.indexOf(needle.value);
			while (index !== -1) {
				ranges.push(widen(line, index, index + needle.value.length, needle));
				onThisLine.push({
					line: i + 1,
					column: index + 1,
					encoding: needle.encoding,
					detail: needle.label,
				});
				index = line.indexOf(needle.value, index + 1);
			}
		}

		for (const found of line.matchAll(STRUCTURAL_PARAM)) {
			const [, name, value] = found;
			// Point at the parameter name, not the leading `?`/`&`.
			const column = found.index + 2;
			const valueStart = found.index + 1 + name.length + 1;
			if (value.length > 0) ranges.push({ start: valueStart, end: valueStart + value.length });
			onThisLine.push({
				line: i + 1,
				column,
				encoding: "token-shaped query parameter",
				detail: `credential-shaped query parameter \`${name}\` (${value.length} chars)`,
			});
		}

		if (onThisLine.length === 0) continue;
		const excerpt = truncate(maskRanges(line, ranges).trim());
		for (const finding of onThisLine) findings.push({ ...finding, excerpt });
	}

	findings.sort((a, b) => a.line - b.line || a.column - b.column || a.encoding.localeCompare(b.encoding));
	return findings;
}

/** Every scannable file under `target`, which may itself be a file. */
export function collectTargets(target) {
	const stats = statSync(target);
	if (stats.isFile()) return [target];
	if (!stats.isDirectory()) return [];
	const out = [];
	for (const entry of readdirSync(target, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...collectTargets(join(target, entry.name)));
			continue;
		}
		if (!entry.isFile()) continue;
		const dot = entry.name.lastIndexOf(".");
		if (dot > 0 && SKIP_EXTS.has(entry.name.slice(dot).toLowerCase())) continue;
		out.push(join(target, entry.name));
	}
	return out.sort();
}

export function parseArgs(argv) {
	/** @type {{value: string, label: string}[]} */
	const secrets = [];
	const targets = [];
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--secret" || arg.startsWith("--secret=")) {
			const value = arg === "--secret" ? (argv[++i] ?? "") : arg.slice("--secret=".length);
			secrets.push({ value, label: `secret #${secrets.length + 1}` });
			continue;
		}
		if (arg === "--secret-env" || arg.startsWith("--secret-env=")) {
			const name = arg === "--secret-env" ? (argv[++i] ?? "") : arg.slice("--secret-env=".length);
			secrets.push({ value: process.env[name] ?? "", label: `$${name}` });
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unknown option \`${arg}\``);
		targets.push(arg);
	}

	return { secrets, targets, help };
}

const USAGE = [
	"Usage: node scripts/geist-credential-scan.mjs --secret <value> [--secret <value>…] <file|dir>…",
	"",
	"  --secret <value>     a credential to hunt for; repeatable",
	"  --secret-env <NAME>  read a credential from the environment instead, so it",
	"                       never appears in the process table",
	"",
	"Reports every occurrence in raw, percent-encoded, base64 and base64url form,",
	"plus any `?token=`/`&token=`-shaped construct whatever its value.",
].join("\n");

export function main(argv) {
	let parsed;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		console.error(`geist-credential-scan: ${error.message}\n\n${USAGE}`);
		return 2;
	}

	if (parsed.help) {
		console.log(USAGE);
		return 0;
	}

	const secrets = parsed.secrets.filter((s) => s.value.length > 0);
	if (secrets.length === 0) {
		console.error(
			[
				`geist-credential-scan: ${VACUOUS_SCAN_MESSAGE} — no credential was declared.`,
				"",
				parsed.secrets.length === 0
					? "No --secret was passed."
					: "Every --secret/--secret-env resolved to an empty string; an unset variable is not a credential.",
				"",
				"A scan for nothing finds nothing and exits 0, which is indistinguishable",
				"from a clean transcript. Declare the credentials the run actually minted.",
				"",
				USAGE,
			].join("\n"),
		);
		return 2;
	}

	if (parsed.targets.length === 0) {
		console.error(`geist-credential-scan: no files to scan.\n\n${USAGE}`);
		return 2;
	}

	/** @type {string[]} */
	const files = [];
	for (const target of parsed.targets) {
		const absolute = resolve(target);
		try {
			files.push(...collectTargets(absolute));
		} catch (error) {
			console.error(`geist-credential-scan: cannot read ${target}: ${error.message}`);
			return 2;
		}
	}

	const needles = secrets.flatMap((s) => needlesFor(s.value, s.label));
	const findings = [];
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, "utf-8");
		} catch (error) {
			console.error(`geist-credential-scan: cannot read ${file}: ${error.message}`);
			return 2;
		}
		// Repo-relative when the evidence lives in the tree, absolute when it does
		// not — a path climbing out of cwd on `../../..` is not actionable.
		const rel = relative(process.cwd(), file);
		const display = rel && !rel.startsWith("..") ? rel : file;
		for (const finding of scanText(text, needles)) findings.push({ file: display, ...finding });
	}

	if (findings.length > 0) {
		console.error(
			`geist-credential-scan: found ${findings.length} occurrence(s) of credential material in ${files.length} recorded file(s):\n`,
		);
		for (const f of findings) {
			console.error(`  ${f.file}:${f.line}:${f.column}  [${f.encoding}]  ${f.detail}`);
			console.error(`      ${f.excerpt}`);
		}
		console.error(
			[
				"",
				"R33-REACH.3: authentication is first-message/header only, and no credential",
				"may appear in any URL, query string, `Referer` or log line. Each occurrence",
				"above is a credential that survived into something written down.",
				"",
				"Values are masked here on purpose — this output is read in CI logs. Go to the",
				"file and line named above rather than re-reading the transcript.",
			].join("\n"),
		);
		return 1;
	}

	console.log(
		`geist-credential-scan: ok (${files.length} file(s) scanned against ${secrets.length} credential(s), ` +
			"no credential material in any URL, query string or log line)",
	);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(main(process.argv.slice(2)));
}
