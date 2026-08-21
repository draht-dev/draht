#!/usr/bin/env node
/**
 * Repo-wide bind gate (R32-FLEET.9, GSEC-04 bind half).
 *
 * `Bun.serve({ port })` with no `hostname` binds EVERY interface. It does not
 * look like it does: the returned server still reports `hostname` as
 * `"localhost"`, and on a laptop that is only ever used on a trusted network
 * nothing visibly differs from a loopback bind. That is how
 * `createPairingServer()` shipped a LAN-reachable pairing endpoint
 * (`packages/geist/src/pairing/server.ts` — GSEC-04's named subject) while the
 * gateway right next door was enforcing loopback-by-default in three places.
 *
 * So the rule is mechanical and repo-wide: every `Bun.serve` call must name the
 * interface it binds. Whether that name is *allowed* is a runtime decision each
 * listener makes for itself (`assertBindHostAllowed`); what this gate enforces
 * is that the decision was made at all, and is visible at the call site.
 *
 * A call is accepted when its options object literal declares `hostname:`
 * (any value — `"0.0.0.0"` behind an explicit opt-in is a legitimate call) or
 * `unix:` (a Unix socket has no interface to bind). Everything else fails:
 *   - no options at all                 → nothing named the interface
 *   - options passed as a variable      → the call site cannot be read; inline
 *                                         the object or add `hostname`
 *   - an object literal without either  → the wildcard bind this gate exists for
 *
 * Scanning: comments and string/template contents are blanked before matching,
 * so prose about `Bun.serve()` in a doc comment is not a violation and a test
 * fixture held in a template literal is not one either. The corollary — a
 * `Bun.serve` call written *inside* a template interpolation is not seen — is
 * accepted: no real listener is created that way, and the mutation test in
 * `check-bun-serve-hostname.test.mjs` proves real call sites in real files are.
 *
 * Usage:
 *   node scripts/check-bun-serve-hostname.mjs   # exit 1 on any unnamed bind
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Directories that hold no first-party source: dependencies, build output, and
 * scratch/worktree areas that are all gitignored. `.claude` in particular
 * contains full worktree copies of this repo, which would otherwise be reported
 * twice.
 */
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"dist-chrome",
	"dist-firefox",
	"build",
	"coverage",
	".git",
	".claude",
	".artifacts",
	".astro",
	".sst",
	".next",
	".turbo",
	".draht",
	".opencode",
	".pi_config",
	".idea",
	".vscode",
	".zed",
	"__pycache__",
]);

/** Can a `/` at this position start a regex literal, given the previous significant char? */
function regexCanStart(prev) {
	if (prev === "") return true;
	return !/[)\]}\w$'"`]/.test(prev);
}

/**
 * Blank out comments and the contents of string/template literals, preserving
 * offsets and line breaks so reported line numbers stay true.
 *
 * The result is text in which only executable code remains readable, which is
 * the only thing this gate has any business matching against.
 */
export function stripNonCode(text) {
	const out = text.split("");
	const n = text.length;
	let i = 0;
	let prev = "";

	const blank = (from, to) => {
		for (let k = from; k < to && k < n; k++) {
			if (out[k] !== "\n") out[k] = " ";
		}
	};

	while (i < n) {
		const c = text[i];
		const c2 = text[i + 1];

		if (c === "/" && c2 === "/") {
			let j = i;
			while (j < n && text[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}
		if (c === "/" && c2 === "*") {
			let j = i + 2;
			while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
			j = Math.min(n, j + 2);
			blank(i, j);
			i = j;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			// A quoted string cannot span a line; stopping at the newline keeps an
			// apostrophe inside something we mis-parsed from eating the whole file.
			while (j < n && text[j] !== c && text[j] !== "\n") {
				j += text[j] === "\\" ? 2 : 1;
			}
			blank(i + 1, j);
			i = text[j] === c ? j + 1 : j;
			prev = c;
			continue;
		}
		if (c === "`") {
			let j = i + 1;
			while (j < n && text[j] !== "`") {
				j += text[j] === "\\" ? 2 : 1;
			}
			blank(i + 1, j);
			i = j + 1;
			prev = "`";
			continue;
		}
		if (c === "/" && regexCanStart(prev)) {
			let j = i + 1;
			let inClass = false;
			while (j < n && text[j] !== "\n") {
				const d = text[j];
				if (d === "\\") {
					j += 2;
					continue;
				}
				if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) break;
				j++;
			}
			blank(i + 1, j);
			i = j + 1;
			prev = "/";
			continue;
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}

	return out.join("");
}

/** Extract the text between the `(` at `openIndex` and its matching `)`. */
function argumentText(code, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth === 0) return code.slice(openIndex + 1, i);
		}
	}
	return code.slice(openIndex + 1); // unbalanced source; report on what we have
}

/**
 * Top-level property names declared by an object-literal source fragment.
 *
 * Only the outermost level counts: a `hostname` buried in `{ tls: { hostname } }`
 * names a TLS server name, not the interface to bind, and must not satisfy this
 * gate. `...spread` is reported as the literal `"..."` so the caller can say why
 * the call site is unreadable.
 */
export function topLevelKeys(objectSource) {
	const keys = [];
	let depth = 0;
	let segmentStart = 1; // skip the opening brace
	const flush = (end) => {
		const segment = objectSource.slice(segmentStart, end).trim();
		if (segment.length === 0) return;
		if (segment.startsWith("...")) {
			keys.push("...");
			return;
		}
		// `key:`, `key,`, `key` (shorthand), `"key":` — anything else (a computed
		// key) is deliberately not credited.
		const named = segment.match(/^(?:(['"`])([^'"`]+)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/);
		if (named) keys.push(named[2] ?? named[3]);
	};

	for (let i = 0; i < objectSource.length; i++) {
		const c = objectSource[i];
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") {
			depth--;
			if (depth === 0) {
				flush(i);
				return keys;
			}
		} else if (c === "," && depth === 1) {
			flush(i);
			segmentStart = i + 1;
		}
	}
	flush(objectSource.length);
	return keys;
}

/**
 * Find every `Bun.serve` call in one file's source and classify it.
 *
 * @returns Array of `{ line, reason }` for the calls that do not name an interface.
 */
export function findUnnamedBinds(source) {
	const code = stripNonCode(source);
	const findings = [];
	const call = /\bBun\s*\.\s*serve\s*\(/g;

	for (let m = call.exec(code); m !== null; m = call.exec(code)) {
		const openIndex = m.index + m[0].length - 1;
		const args = argumentText(code, openIndex).trim();
		const line = code.slice(0, m.index).split("\n").length;

		if (args.length === 0) {
			findings.push({ line, reason: "called with no options — nothing names the interface to bind" });
			continue;
		}
		if (!args.startsWith("{")) {
			findings.push({
				line,
				reason: "options are not an object literal, so the bind interface cannot be read at the call site",
			});
			continue;
		}
		const keys = topLevelKeys(args);
		if (keys.includes("hostname") || keys.includes("unix")) continue;

		findings.push({
			line,
			reason: keys.includes("...")
				? "options object spreads another value and does not declare `hostname` — the bind interface cannot be read at the call site"
				: "no `hostname` — this binds EVERY interface, not loopback",
		});
	}

	return findings;
}

/** Recursively collect first-party code files under `dir`. */
function collect(dir, files = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collect(join(dir, entry.name), files);
		} else if (entry.isFile() && CODE_EXTS.some((ext) => entry.name.endsWith(ext))) {
			files.push(join(dir, entry.name));
		}
	}
	return files;
}

/** Run the gate over `root`. Exported so the mutation test can drive it in-process too. */
export function scanRepo(root = ROOT) {
	const violations = [];
	let scanned = 0;
	for (const file of collect(root)) {
		scanned++;
		for (const finding of findUnnamedBinds(readFileSync(file, "utf-8"))) {
			violations.push({ file: relative(root, file), ...finding });
		}
	}
	return { scanned, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { scanned, violations } = scanRepo();

	if (violations.length > 0) {
		console.error("check:bun-serve-hostname: found Bun.serve calls that do not name the interface they bind:\n");
		for (const v of violations) {
			console.error(`  ${v.file}:${v.line}  ${v.reason}`);
		}
		console.error(
			[
				"",
				"A Bun.serve without `hostname` binds 0.0.0.0 while still reporting",
				'`server.hostname === "localhost"` — the exposure is invisible at runtime.',
				"",
				"Fix: pass the interface explicitly, and route it through a bind guard so a",
				"non-loopback value has to be opted into:",
				"",
				"    const hostname = assertBindHostAllowed({ host: options.host ?? \"127.0.0.1\" });",
				"    Bun.serve({ port, hostname, fetch, websocket });",
				"",
				"`unix:` sockets are accepted too — they have no interface to bind.",
			].join("\n"),
		);
		process.exit(1);
	}

	console.log(`check:bun-serve-hostname: ok (${scanned} files scanned, every Bun.serve names its interface)`);
}
