/**
 * A published reel site is public-facing (see README "Privacy warning").
 * This module keeps two deliberate, documented exceptions to the "every
 * code line is verbatim" contract: a path deny-list (secrets-shaped files
 * never show their content) and whole-hunk withholding when a hunk looks
 * like it carries a secret.
 *
 * Code is never rewritten line-by-line: a shown code line is byte-for-byte
 * verbatim, or the whole hunk is withheld. Only non-code text fields (commit
 * title/body/authors, narration, prompts) go through {@link redactText},
 * which may replace a matched token in place because they are prose, not a
 * diff.
 */

import type { ChangeSet, FileChange, Hunk } from "./contract.ts";

export const DEFAULT_DENY_GLOBS = [
	".env",
	".env.*",
	"*.env",
	"*.env.*",
	".envrc",
	".npmrc",
	".netrc",
	".pypirc",
	".git-credentials",
	"*.tfstate",
	"*.tfstate.*",
	"*.tfvars",
	"kubeconfig*",
	"**/.docker/config.json",
	"*service-account*.json",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"*.jks",
	"id_rsa*",
	"id_ed25519*",
	"id_ecdsa*",
	"credentials*",
	"*.secret",
	"secrets.*",
	".htpasswd",
	"**/secrets/**",
];

const MAX_GLOB_PATH_LENGTH = 1024;

function escapeRegExpLiteral(chunk: string): string {
	return chunk.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Translates a shell-style glob into an anchored regex: `*` stays within a path segment, `**` crosses segments. */
function compileGlob(glob: string): RegExp {
	let pattern = "";
	let i = 0;
	while (i < glob.length) {
		if (glob.startsWith("**/", i)) {
			pattern += "(?:.*/)?";
			i += 3;
			continue;
		}
		if (glob.startsWith("**", i)) {
			pattern += ".*";
			i += 2;
			continue;
		}
		const ch = glob[i];
		if (ch === "*") {
			pattern += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			pattern += "[^/]";
			i += 1;
			continue;
		}
		pattern += escapeRegExpLiteral(ch);
		i += 1;
	}
	return new RegExp(`^${pattern}$`, "i");
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
	let compiled = globCache.get(glob);
	if (!compiled) {
		compiled = compileGlob(glob);
		globCache.set(glob, compiled);
	}
	return compiled;
}

/** True if `path`'s basename (or full path) matches a deny glob and no allow glob overrides it. */
export function isPathDenied(path: string, denyGlobs: readonly string[], allowGlobs: readonly string[] = []): boolean {
	if (path.length > MAX_GLOB_PATH_LENGTH) return true;
	const base = path.split("/").pop() ?? path;
	const matches = (globs: readonly string[]) =>
		globs.some((g) => {
			const re = globToRegExp(g);
			return g.includes("/") ? re.test(path) : re.test(base);
		});
	if (!matches(denyGlobs)) return false;
	return !matches(allowGlobs);
}

const WITHHELD_FILE_HEADER = "@@ content withheld: path matches the privacy deny-list @@";
const WITHHELD_HUNK_HEADER = "@@ content withheld: possible secret @@";

function withholdContent(file: FileChange): FileChange {
	return { ...file, hunks: [{ header: WITHHELD_FILE_HEADER, lines: [], withheld: true }] };
}

function withholdHunk(): Hunk {
	return { header: WITHHELD_HUNK_HEADER, lines: [], withheld: true };
}

/**
 * Credential-like key fragments. A key is only treated as credential-like
 * when it *ends* with one of these (see {@link SECRET_KEY_NAME_RE}) —
 * `secret_name`, `api_key_env`, and `tokenEndpoint` do not end with a
 * fragment and are deliberately not credential-like, even though they
 * contain one as a substring.
 */
const SECRET_KEY_FRAGMENT =
	"(?:api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?token|passw(?:or)?d|pass(?:wd)?\\b|pwd|credentials?|secret|token)";
/** Whole extracted key names (e.g. from {@link ENV_STYLE_LINE_RE}) are checked against this, anchored at the end. */
const SECRET_KEY_NAME_RE = new RegExp(`${SECRET_KEY_FRAGMENT}$`, "i");

/** A single quote character: `"`, `'`, or a backtick. */
const QUOTE_CLASS = "[\"'`]";

/**
 * `key = "value"` / `key: 'value'` / `` key = `value` `` / escaped-JSON
 * `\"key\": \"value\"`, where key *ends* with a credential-like fragment
 * (optionally wrapped in a quote) and the quoted value is >= 8 chars. The
 * fragment must be followed immediately by an optional backslash/quote and
 * then the separator — no run of identifier characters in between — so a
 * key like `passwordField` or `tokenEndpoint` (fragment followed by more
 * identifier characters, not the separator) does not match. No leading
 * wildcard before the fragment either: an unanchored `.*fragment` pair
 * retried at every string position is the classic quadratic-backtracking
 * trap, so the fragment is the search anchor.
 */
const ASSIGNMENT_QUOTED_RE = new RegExp(
	`${SECRET_KEY_FRAGMENT}\\\\?${QUOTE_CLASS}?\\s*[:=]\\s*\\\\?(${QUOTE_CLASS})(.{8,}?)\\\\?\\1`,
	"i",
);

/**
 * A whole `.env`-style line `KEY=value` / `KEY: value`, with an optional
 * leading `export ` and an optional trailing ` # comment`. The value is
 * just "the next non-space token" here; whether it counts as a secret is
 * decided in {@link lineHasSecret} based on whether the key is
 * credential-like, so code like `secret: z.string(),` (key is
 * credential-like, but the value contains code punctuation) is still excluded.
 */
const ENV_STYLE_LINE_RE = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*[:=]\s*(\S+)(?:\s+#.*)?\s*$/;

/** Value charset for a credential-like key: anything but whitespace and code-structural punctuation (so `fn(a, b)` is never a "value"). */
const BROAD_SECRET_VALUE_RE = /^[^\s,;(){}[\]<>]+$/;
/** A value that is itself just a reference to another env var name, not a literal secret. */
const ENV_VAR_REFERENCE_RE = /^[A-Z][A-Z0-9_]*$/;
const NON_SECRET_VALUES = new Set(["access_token", "bearer", "basic"]);

function isLikelySecretValue(value: string): boolean {
	if (value.length < 8) return false;
	if (ENV_VAR_REFERENCE_RE.test(value)) return false;
	if (NON_SECRET_VALUES.has(value.toLowerCase())) return false;
	return true;
}

/** High-confidence secret token shapes. Deliberately linear (no nested/overlapping quantifiers) to stay ReDoS-safe. */
const TOKEN_PATTERNS: RegExp[] = [
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/,
	/\bAIza[0-9A-Za-z_-]{35}\b/,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
	/\bnpm_[A-Za-z0-9]{36}\b/,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+\b/,
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@/,
];

/** PEM private key block. The opening line alone ("-----BEGIN ... PRIVATE KEY-----") is enough to detect it per-line. */
function lineLooksLikePemBoundary(line: string): boolean {
	return line.includes("-----BEGIN") && line.includes("PRIVATE KEY");
}

/** True if `line` contains anything that looks like a secret. Used to decide whether to withhold a whole code hunk. */
export function lineHasSecret(line: string): boolean {
	if (lineLooksLikePemBoundary(line)) return true;
	for (const pattern of TOKEN_PATTERNS) {
		if (pattern.test(line)) return true;
	}
	if (ASSIGNMENT_QUOTED_RE.test(line)) return true;
	const envMatch = ENV_STYLE_LINE_RE.exec(line);
	if (envMatch) {
		const [, key, value] = envMatch;
		if (SECRET_KEY_NAME_RE.test(key) && isLikelySecretValue(value) && BROAD_SECRET_VALUE_RE.test(value)) return true;
	}
	return false;
}

/** Diff body lines keep their leading " "/"+"/"-" marker (see {@link Hunk.lines}); strip it before pattern matching so an anchored pattern like the .env-style line still applies to the actual content. */
function stripDiffMarker(line: string): string {
	return /^[ +-]/.test(line) ? line.slice(1) : line;
}

function hunkHasSecret(hunk: Hunk): boolean {
	if (lineHasSecret(hunk.header)) return true;
	return hunk.lines.some((line) => lineHasSecret(stripDiffMarker(line)));
}

const PEM_BEGIN_MARKER = "-----BEGIN";
const PEM_PRIVATE_KEY_HEADER = "PRIVATE KEY-----";
const PEM_END_MARKER = "-----END";

/**
 * Redacts every `-----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE
 * KEY-----` block (or, if unterminated, everything from BEGIN to the end of
 * the string) in one indexOf-based left-to-right scan. A regex with a lazy
 * `[\s\S]*?` between BEGIN and END is quadratic on an unterminated block
 * followed by many more BEGIN markers: each failed match attempt rescans
 * the remaining text, and there is one attempt per marker.
 */
function redactPemBlocks(text: string): string {
	let out = "";
	let pos = 0;
	while (pos < text.length) {
		const beginIdx = text.indexOf(PEM_BEGIN_MARKER, pos);
		if (beginIdx === -1) {
			out += text.slice(pos);
			break;
		}
		const headerEnd = text.indexOf(PEM_PRIVATE_KEY_HEADER, beginIdx);
		if (headerEnd === -1) {
			out += text.slice(pos);
			break;
		}
		out += text.slice(pos, beginIdx);
		out += "[redacted]";
		const valueStart = headerEnd + PEM_PRIVATE_KEY_HEADER.length;
		const endIdx = text.indexOf(PEM_END_MARKER, valueStart);
		if (endIdx === -1) return out;
		const endHeaderEnd = text.indexOf(PEM_PRIVATE_KEY_HEADER, endIdx);
		pos = endHeaderEnd === -1 ? text.length : endHeaderEnd + PEM_PRIVATE_KEY_HEADER.length;
	}
	return out;
}

/**
 * `key = value` / `key: value` in prose (no quotes), where key ends with a
 * credential-like fragment and the value is a single >= 8 char token with
 * no code-structural punctuation. Mirrors the hunk-level .env-style check
 * in {@link lineHasSecret}, but replaces the whole `key = value` span since
 * prose may be rewritten, unlike a diff code line.
 */
const UNQUOTED_ASSIGNMENT_TEXT_RE = new RegExp(
	`\\b[A-Za-z0-9_.-]*${SECRET_KEY_FRAGMENT}\\s*[:=]\\s*[^\\s,;(){}[\\]<>]{8,}`,
	"gi",
);

/** Text-field patterns, applied with a global flag so every occurrence in a string is replaced. */
const TEXT_REDACTION_PATTERNS: RegExp[] = [
	...TOKEN_PATTERNS.map((p) => new RegExp(p.source, `${p.flags}g`)),
	new RegExp(ASSIGNMENT_QUOTED_RE.source, "gi"),
	UNQUOTED_ASSIGNMENT_TEXT_RE,
];

/**
 * Redacts obvious secret-shaped substrings in a non-code text field (commit
 * title/body/authors, narration, prompts, shown hunk headers). Not for code:
 * code is withheld at the hunk level instead, never rewritten line-by-line.
 */
export function redactText(text: string): string {
	let out = redactPemBlocks(text);
	for (const pattern of TEXT_REDACTION_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	return out;
}

export interface ContentPolicyOptions {
	denyGlobs?: readonly string[];
	allowGlobs?: readonly string[];
}

/**
 * Applies the deny-list (withholds every hunk for a matched path, keeping
 * path and stats) and secret detection (withholds any individual hunk whose
 * header or lines look like a secret) to a change set, before it ever
 * reaches a script writer. A writer never sees withheld content, so it
 * cannot accidentally select it for a code scene.
 */
export function applyContentPolicy(changeSet: ChangeSet, options: ContentPolicyOptions = {}): ChangeSet {
	const denyGlobs = options.denyGlobs ?? DEFAULT_DENY_GLOBS;
	const allowGlobs = options.allowGlobs ?? [];

	const files = changeSet.files.map((file) => {
		const pathDenied =
			isPathDenied(file.path, denyGlobs, allowGlobs) ||
			(file.oldPath !== undefined && isPathDenied(file.oldPath, denyGlobs, allowGlobs));
		if (pathDenied) return withholdContent(file);
		return {
			...file,
			hunks: file.hunks.map((hunk) => (hunkHasSecret(hunk) ? withholdHunk() : hunk)),
		};
	});

	return { ...changeSet, files };
}
