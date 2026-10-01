#!/usr/bin/env node
/**
 * Absence gate for the spawn surface (R36-SPAWN.8, R36-SPAWN.5).
 *
 * Both properties are claims about what is NOT there, and no runtime test can
 * make one: a test only exercises surfaces that exist.
 *
 * The incident behind rules A and B: `POST /sessions` used to accept a
 * caller-supplied `command: string[]` and hand it to `Bun.spawn` (R32-FLEET.8,
 * GSEC-12), so any bearer-token holder could run any binary as the gateway's
 * user. The field is gone; this gate keeps it gone on frames nobody has
 * written yet.
 *
 * RULE A — no command-shaped field on a client→server frame. The frame set is
 * read out of `ClientFrameSchema`, and a field is followed through nested
 * `z.object`, a chained `.extend`/`.merge`, and a named sub-schema, because
 * `options: SpawnOptionsSchema` is the same surface with an extra dot. Anything
 * unreadable — a spread member, a base this file does not declare — is a
 * violation, never a silent skip. Server→client frames are out of scope:
 * `permission_request` legitimately carries `command`, `path` and `cwd`.
 *
 * RULE B — a route under packages/gateway/src/gateway/routes/ may test a body
 * for a spawn-selecting key in order to answer 4xx, and may not read its value.
 * Reading it to refuse it is still reading it, and `body.command ? body.command
 * : c.json({ ... }, 400)` is what "refuses it" looks like when someone wants
 * the value.
 *
 * RULE C — no project-trust writer in the daemon: packages/gateway/src plus the
 * src of every geist package. Test sources are out of scope: a test writing the
 * operator's own decision file IS the local machine.
 *
 * OUT OF SCOPE: `packages/gateway/src/session/session-process.ts` still wraps
 * `Bun.spawn(command, …)`; the wave-4 command-surface task removes that chain.
 *
 * Usage:
 *   node scripts/check-no-free-text-command.mjs   # exit 1 on any violation
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const WIRE_FILE = "packages/geist-protocol/src/wire.ts";
const ROUTES_DIR = "packages/gateway/src/gateway/routes";
const TRUST_SCAN_ROOTS = ["packages/gateway/src"];

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

/**
 * Name tokens that make a field a choice of what to execute, matched per camel/
 * snake token so `commandLine` and `workingDir` are caught and `capabilities`
 * is not. `data` is deliberately absent: `input.data` is keystrokes to a
 * session the local machine already authorised, not a choice of what to run.
 */
export const COMMAND_SHAPED_TOKENS = new Set([
	"command",
	"cmd",
	"argv",
	"args",
	"exec",
	"executable",
	"shell",
	"entrypoint",
	"interpreter",
	"path",
	"cwd",
	"dir",
	"env",
	"environment",
]);

/** Narrower than rule A: `cwd` is a validated route input, `path` is a URL. */
const SPAWN_SELECTING_BODY_KEYS = ["command", "cmd", "argv", "args", "exec", "executable", "entrypoint", "shell", "interpreter"];

const REFUSES_WITH_4XX = /,\s*4\d\d\s*\)|status\s*[:(]\s*4\d\d/;

/** `setMany` is not repeated here: it has its own rule, on any receiver. */
const TRUST_STORE_MUTATORS = ["set", "delete", "clear", "write"];
const TRUST_STORE_FACTORY = "[\\w$]*ProjectTrustStore[\\w$]*";
const WRITE_CALLS = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?(write[A-Za-z_$]*|append[A-Za-z_$]*|createWriteStream|openSync|open)\s*\(/g;
const WRITE_FLAG = /["'][aw]\+?["']|O_WRONLY|O_APPEND|O_CREAT|O_TRUNC/;

// ── source scanning ──────────────────────────────────────────────────────────

function regexCanStart(prev) {
	if (prev === "") return true;
	return !/[)\]}\w$'"`]/.test(prev);
}

/**
 * Blank comments — and, with `blankStrings`, string/template/regex contents —
 * preserving every offset and line break, so two blankings of one file can be
 * read against each other by index: call sites are located in the blanked text
 * where prose cannot trip the gate, while quoted keys and path literals are
 * read from the same offsets in the text that kept its strings.
 */
export function blankNonCode(text, { blankStrings = true } = {}) {
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
			while (j < n && text[j] !== c && text[j] !== "\n") {
				j += text[j] === "\\" ? 2 : 1;
			}
			if (blankStrings) blank(i + 1, j);
			i = text[j] === c ? j + 1 : j;
			prev = c;
			continue;
		}
		if (c === "`") {
			let j = i + 1;
			while (j < n && text[j] !== "`") {
				j += text[j] === "\\" ? 2 : 1;
			}
			if (blankStrings) blank(i + 1, j);
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
			if (blankStrings) blank(i + 1, j);
			i = j + 1;
			prev = "/";
			continue;
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}

	return out.join("");
}

function lineAt(text, index) {
	return text.slice(0, index).split("\n").length;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text between the bracket at `openIndex` and its match, with the offset it starts at. */
function bracketedText(code, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth === 0) return { text: code.slice(openIndex + 1, i), start: openIndex + 1 };
		}
	}
	return { text: code.slice(openIndex + 1), start: openIndex + 1 };
}

/** Comma-separated segments at depth 0 of `text`, each with its offset. */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let start = 0;
	const push = (end) => {
		const raw = text.slice(start, end);
		const value = raw.trim();
		if (value.length > 0) parts.push({ value, index: start + raw.indexOf(value) });
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			push(i);
			start = i + 1;
		}
	}
	push(text.length);
	return parts;
}

function firstArgument(argText) {
	return splitTopLevel(argText)[0]?.value ?? "";
}

/**
 * Top-level property names of an object-literal fragment. A `...spread` is
 * reported as `"..."` so the caller can say the literal is unreadable rather
 * than credit it as clean.
 */
export function topLevelKeys(objectSource) {
	const keys = [];
	let depth = 0;
	let segmentStart = 1;

	const flush = (end) => {
		const raw = objectSource.slice(segmentStart, end);
		const segment = raw.trim();
		if (segment.length === 0) return;
		const index = segmentStart + raw.indexOf(segment);
		if (segment.startsWith("...")) {
			keys.push({ name: "...", index, segment });
			return;
		}
		const named = segment.match(/^(?:(['"`])([^'"`]+)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/);
		if (named) keys.push({ name: named[2] ?? named[3], index, segment });
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

export function nameTokens(field) {
	return field
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

export function isCommandShaped(field) {
	return nameTokens(field).some((token) => COMMAND_SHAPED_TOKENS.has(token));
}

// ── rule A — no command-shaped field on a client→server frame ────────────────

const SCHEMA_OBJECT_CALL = /(?:\bz\s*\.\s*object|\.\s*(?:extend|merge|and))\s*\(/g;
const SCHEMA_REFERENCE = /\b([A-Za-z_$][\w$]*Schema)\b/g;

/** The initializer expression of `const <name> = …`, with its absolute offset. */
function declarationInitializer(code, name) {
	const decl = new RegExp(`\\b${escapeRegExp(name)}\\s*(?<![=!<>])=(?!=)\\s*`).exec(code);
	if (!decl) return null;
	const start = decl.index + decl[0].length;
	let depth = 0;
	for (let i = start; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) return { text: code.slice(start, i), start };
			depth--;
		} else if (c === ";" && depth === 0) return { text: code.slice(start, i), start };
	}
	return { text: code.slice(start), start };
}

/**
 * Every field a schema expression declares: the object literal of each
 * `z.object`/`.extend`/`.merge` in it at any depth, plus the fields of every
 * named schema it refers to, so a field one dot down is still this frame's.
 */
function fieldsOfExpression(code, expr, exprStart, seen, out) {
	for (const m of expr.matchAll(SCHEMA_OBJECT_CALL)) {
		const arg = bracketedText(expr, m.index + m[0].length - 1);
		const brace = arg.text.indexOf("{");
		if (brace === -1) continue;
		const base = exprStart + arg.start + brace;
		for (const key of topLevelKeys(arg.text.slice(brace))) {
			out.push({ name: key.name, index: base + key.index });
		}
	}
	for (const m of expr.matchAll(SCHEMA_REFERENCE)) {
		fieldsOfSchema(code, m[1], exprStart + m.index, seen, out);
	}
	return out;
}

function fieldsOfSchema(code, name, referenceIndex, seen, out) {
	if (seen.has(name)) return out;
	seen.add(name);
	const init = declarationInitializer(code, name);
	if (!init) {
		out.push({ unreadable: `\`${name}\``, index: referenceIndex });
		return out;
	}
	return fieldsOfExpression(code, init.text, init.start, seen, out);
}

/** The members of `ClientFrameSchema`, or the reason the union cannot be read. */
export function clientUnionMembers(code) {
	const union = /\bClientFrameSchema\s*=\s*z\s*\.\s*discriminatedUnion\s*\(/.exec(code);
	if (!union) {
		return {
			members: [],
			violations: [
				{
					line: 1,
					message:
						"no `ClientFrameSchema = z.discriminatedUnion(...)` here — this gate reads the client frame set from that union and cannot enforce anything without it. Restore the union or point the gate at its new home.",
				},
			],
		};
	}
	const line = lineAt(code, union.index);
	const args = bracketedText(code, union.index + union[0].length - 1);
	const open = args.text.indexOf("[");
	if (open === -1) return { members: [], violations: [{ line, message: "`ClientFrameSchema` lists no member array the gate can read" }] };

	const members = [];
	const violations = [];
	for (const entry of splitTopLevel(bracketedText(args.text, open).text)) {
		if (/^[A-Za-z_$][\w$]*$/.test(entry.value)) {
			members.push(entry.value);
			continue;
		}
		violations.push({
			line: lineAt(code, args.start + open + entry.index),
			message: `\`ClientFrameSchema\` lists \`${entry.value.slice(0, 40)}\`, which is not a schema this gate can name — every client frame must be a bare identifier here, or the field it hides is unenforced.`,
		});
	}
	if (members.length === 0 && violations.length === 0) {
		violations.push({ line, message: "`ClientFrameSchema` lists no member schemas the gate can resolve" });
	}
	return { members, violations };
}

export function findCommandShapedClientFields(wireSource) {
	const code = blankNonCode(wireSource, { blankStrings: false });
	const { members, violations } = clientUnionMembers(code);

	for (const member of members) {
		const init = declarationInitializer(code, member);
		if (!init) {
			violations.push({
				line: lineAt(code, code.indexOf(member)),
				message: `\`${member}\` is a member of ClientFrameSchema but this file does not declare it — the gate cannot read its fields. Declare it here, or the field it hides is unenforced.`,
			});
			continue;
		}
		const frameType = /\btype\s*:\s*z\s*\.\s*literal\s*\(\s*["']([^"']+)["']/.exec(init.text)?.[1] ?? member;
		const fields = fieldsOfExpression(code, init.text, init.start, new Set([member]), []);
		if (fields.length === 0) {
			violations.push({ line: lineAt(code, init.start), message: `\`${member}\` declares no object literal the gate can read` });
			continue;
		}
		for (const field of fields) {
			const line = lineAt(code, field.index);
			if (field.unreadable) {
				violations.push({
					line,
					message: `client frame \`${frameType}\` is built from ${field.unreadable}, which this file does not declare, so its fields cannot be read. Inline them.`,
				});
				continue;
			}
			if (field.name === "...") {
				violations.push({
					line,
					message: `client frame \`${frameType}\` spreads another value, so its fields cannot be read at the declaration. Inline them.`,
				});
				continue;
			}
			if (!isCommandShaped(field.name)) continue;
			violations.push({
				line,
				message: `client frame \`${frameType}\` declares \`${field.name}\` — a client→server frame may not name what runs. Remove the field and resolve it in the daemon from the user-owned registry; this frame reaches a phone.`,
			});
		}
	}
	return violations.sort((a, b) => a.line - b.line);
}

// ── rule B — no spawn-selecting body key read on the HTTP surface ────────────

/** The statement or block a test at `index` governs: to the terminating `;` or through the block it opens. */
function guardedRegionAfter(code, index) {
	let depth = 0;
	for (let i = index; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
		else if (c === "{") {
			if (depth === 0) return bracketedText(code, i).text;
			depth++;
		} else if (c === "}") {
			if (depth === 0) return code.slice(index, i);
			depth--;
		} else if (c === ";" && depth === 0) {
			return code.slice(index, i);
		}
	}
	return code.slice(index);
}

const READ_ADVICE =
	"test for it with `\"<key>\" in body` and answer 4xx; do not bind the value. What gets executed is chosen by the gateway, never by a request body.";

export function findUnrefusedBodyKeyReads(source) {
	const keys = SPAWN_SELECTING_BODY_KEYS.join("|");
	const withStrings = blankNonCode(source, { blankStrings: false });
	const codeOnly = blankNonCode(source, { blankStrings: true });

	const keyAliases = new Map(
		[...withStrings.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*["'](${keys})["']`, "g"))].map((m) => [m[1], m[2]]),
	);
	const aliasProbe = keyAliases.size > 0 ? new RegExp(`\\[\\s*(${[...keyAliases.keys()].map(escapeRegExp).join("|")})\\s*\\]`, "g") : null;

	const probes = [
		[codeOnly, new RegExp(`\\.\\s*(${keys})\\b(?!\\s*\\()`, "g"), "read"],
		[codeOnly, new RegExp(`\\{[^{}]*\\b(${keys})\\b[^{}]*\\}\\s*=[^=]`, "g"), "read"],
		[withStrings, new RegExp(`\\[\\s*["'](${keys})["']\\s*\\]`, "g"), "read"],
		[withStrings, new RegExp(`["'](${keys})["']\\s*\\bin\\b`, "g"), "test"],
		[withStrings, new RegExp(`(?:[=!]==?\\s*["'](${keys})["']|["'](${keys})["']\\s*[=!]==?|\\bcase\\s+["'](${keys})["']\\s*:)`, "g"), "test"],
	];
	if (aliasProbe) probes.push([codeOnly, aliasProbe, "read"]);

	const violations = [];
	const seen = new Set();
	for (const [haystack, pattern, kind] of probes) {
		for (let m = pattern.exec(haystack); m !== null; m = pattern.exec(haystack)) {
			if (seen.has(m.index)) continue;
			seen.add(m.index);
			const matched = m.slice(1).find(Boolean);
			const key = keyAliases.get(matched) ?? matched;
			const before = haystack.slice(Math.max(0, m.index - 40), m.index);
			const after = haystack.slice(m.index + m[0].length, m.index + m[0].length + 24);
			const isPresenceTest =
				kind === "test" ||
				/\btypeof\s+[A-Za-z_$][\w$.[\]"']*$/.test(before) ||
				/^\s*[=!]==?\s*(?:undefined|null)\b/.test(after);
			if (isPresenceTest && REFUSES_WITH_4XX.test(guardedRegionAfter(withStrings, m.index))) continue;
			violations.push({
				line: lineAt(haystack, m.index),
				message: isPresenceTest
					? `tests for a \`${key}\` key without answering 4xx — a route may only look at this key in order to refuse it. What gets executed is chosen by the gateway, never by a request body.`
					: `reads the value of a \`${key}\` key — ${READ_ADVICE.replace("<key>", key)}`,
			});
		}
	}
	return violations.sort((a, b) => a.line - b.line || a.message.localeCompare(b.message));
}

// ── rule C — no project-trust writer in the daemon ───────────────────────────

const squeeze = (text) => text.replace(/\s+/g, "");

export function findTrustWriters(source) {
	const withStrings = blankNonCode(source, { blankStrings: false });
	const codeOnly = blankNonCode(source, { blankStrings: true });

	const pathAliases = [
		...[...withStrings.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*trust\.json/g)].map((m) => m[1]),
		...[...withStrings.matchAll(/(this\s*\.\s*#?[A-Za-z_$][\w$]*)\s*=\s*[^;\n]*trust\.json/g)].map((m) => m[1]),
	].map(squeeze);

	const storeAliases = new Set([
		...[...codeOnly.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*ProjectTrustStore\b/g)].map((m) => m[1]),
		...[...codeOnly.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:new\\s+)?${TRUST_STORE_FACTORY}\\s*\\(`, "g"))].map((m) => m[1]),
	]);

	const violations = [];
	const report = (index, message) => violations.push({ line: lineAt(codeOnly, index), message });
	const targetsTrustFile = (target) => target.includes("trust.json") || pathAliases.some((alias) => squeeze(target).includes(alias));

	for (const m of codeOnly.matchAll(/\bsetProjectTrusted\s*\(/g)) {
		report(m.index, "calls `setProjectTrusted(` — trust is granted at the local machine, never by the daemon. Read trust here; do not write it.");
	}
	for (const m of codeOnly.matchAll(/\.\s*setMany\s*\(/g)) {
		report(m.index, "calls `.setMany(` — that is the project-trust store's bulk writer. The daemon may read trust, never record a decision.");
	}
	for (const m of codeOnly.matchAll(WRITE_CALLS)) {
		const args = bracketedText(withStrings, m.index + m[0].length - 1).text;
		if (!targetsTrustFile(firstArgument(args))) continue;
		if (/^open(?:Sync)?$/.test(m[1]) && !WRITE_FLAG.test(args)) continue;
		report(m.index, `\`${m[1]}\` targets the project-trust file — trust is granted at the local machine, never by the daemon. Remove the write.`);
	}
	const mutators = TRUST_STORE_MUTATORS.join("|");
	for (const alias of storeAliases) {
		for (const m of codeOnly.matchAll(new RegExp(`\\b${escapeRegExp(alias)}\\s*\\.\\s*(${mutators})\\s*\\(`, "g"))) {
			report(m.index, `mutates a ProjectTrustStore via \`${alias}.${m[1]}(\` — the daemon holds this store to read it. Remove the mutation.`);
		}
	}
	for (const m of codeOnly.matchAll(new RegExp(`${TRUST_STORE_FACTORY}\\s*\\([^()]*\\)\\s*\\.\\s*(${mutators})\\s*\\(`, "g"))) {
		report(m.index, `mutates a ProjectTrustStore via \`.${m[1]}(\` on the store it just obtained — the daemon holds this store to read it. Remove the mutation.`);
	}
	return violations.sort((a, b) => a.line - b.line);
}

// ── repo scan ────────────────────────────────────────────────────────────────

function walk(dir, exts) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...walk(full, exts));
		} else if (exts.some((e) => entry.name.endsWith(e))) {
			out.push(full);
		}
	}
	return out;
}

export function isTestSource(path) {
	return /(^|\/)(__tests__|__mocks__|test|tests|fixtures)\//.test(path) || /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(path);
}

/** Daemon source roots for rule C: the gateway plus every geist package. */
export function trustScanRoots(root) {
	const roots = TRUST_SCAN_ROOTS.map((r) => join(root, r));
	const packages = join(root, "packages");
	if (existsSync(packages)) {
		for (const entry of readdirSync(packages, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith("geist")) roots.push(join(packages, entry.name, "src"));
		}
	}
	return roots.filter((dir) => existsSync(dir));
}

export function scanRepo(root = ROOT) {
	const violations = [];
	const add = (rule, file, line, message) => violations.push({ rule, file: relative(root, file), line, message });

	const wirePath = join(root, WIRE_FILE);
	if (!existsSync(wirePath)) {
		add("A", wirePath, 0, `${WIRE_FILE} is missing — the gate's scan target moved and rule A enforces nothing`);
	} else {
		for (const v of findCommandShapedClientFields(readFileSync(wirePath, "utf-8"))) add("A", wirePath, v.line, v.message);
	}

	const routesDir = join(root, ROUTES_DIR);
	if (!existsSync(routesDir)) {
		add("B", routesDir, 0, `${ROUTES_DIR} is missing — the gate's scan target moved and rule B enforces nothing`);
	} else {
		for (const file of walk(routesDir, CODE_EXTS)) {
			for (const v of findUnrefusedBodyKeyReads(readFileSync(file, "utf-8"))) add("B", file, v.line, v.message);
		}
	}

	const roots = trustScanRoots(root);
	if (roots.length === 0) {
		add("C", join(root, "packages"), 0, "no daemon source roots found — rule C enforces nothing");
	}
	for (const dir of roots) {
		for (const file of walk(dir, CODE_EXTS)) {
			if (isTestSource(relative(root, file))) continue;
			for (const v of findTrustWriters(readFileSync(file, "utf-8"))) add("C", file, v.line, v.message);
		}
	}

	return violations;
}

const RULE_TITLES = {
	A: "a client→server frame names what runs (R36-SPAWN.8)",
	B: "an HTTP route lets a request body select what runs (R32-FLEET.8, GSEC-12)",
	C: "the daemon writes project trust (R36-SPAWN.5)",
};

const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	const violations = scanRepo();
	if (violations.length > 0) {
		console.error(`check:no-free-text-command: ${violations.length} violation(s)\n`);
		for (const v of violations) {
			console.error(`  ✗ [rule ${v.rule}] ${v.file}:${v.line}  ${v.message}`);
		}
		const rules = [...new Set(violations.map((v) => v.rule))].sort();
		console.error(`\n${rules.map((r) => `rule ${r} — ${RULE_TITLES[r]}`).join("\n")}`);
		process.exit(1);
	}
	console.log("check:no-free-text-command: ok (no command-shaped client frame field, no unrefused body key, no daemon trust writer)");
}
