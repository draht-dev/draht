/**
 * Permission gate: a three-tier permission system that decides whether a
 * tool call may proceed automatically, must be blocked, or must be confirmed
 * by the user before it runs.
 *
 * SECURITY-CRITICAL: this module gates real bash/write tool calls. Prefer
 * fail-safe (approve/deny) over fail-open (allow) whenever a decision is
 * ambiguous.
 *
 * Configuration is read from `.draht/permissions.yml` (project) and
 * `~/.draht/agent/permissions.yml` (global), e.g.:
 *
 * ```yaml
 * rules:
 *   - tool: bash
 *     pattern: "rm -rf *"
 *     action: deny
 *   - tool: bash
 *     pattern: "git push *"
 *     action: approve
 *   - tool: read
 *     action: allow
 *   - tool: write
 *     paths: ["src/**"]
 *     action: allow
 *   - tool: write
 *     action: approve
 * ```
 *
 * Rules are evaluated top-to-bottom; the first matching rule wins.
 *
 * On top of the rules sits a session-level `PermissionMode` (`default` /
 * `auto` / `yolo`, see the type doc) that relaxes how unmatched calls and
 * `approve` outcomes are handled — `deny` rules are never relaxed.
 *
 * `pattern` matching against bash commands is textual (no real shell
 * parser), so `deny` and `allow`/`approve` patterns are matched with
 * deliberately asymmetric strategies to stay fail-safe: `deny` scans every
 * chained/wrapped/unwrapped piece of the command it can find (paranoid,
 * over-matching is safe), while `allow`/`approve` require an exact
 * chain-shape match and reject anything containing `$(...)`, backticks, or
 * redirection (strict, under-matching just falls through to the default
 * decision instead of silently authorizing more than intended). See the
 * doc comment on `matchCommandPattern` below for details and known limits —
 * in particular, `pattern` can never guarantee real path containment; use
 * `paths` for that.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { parse } from "yaml";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";

/** The three permission tiers a rule (or default) can resolve to. */
export type PermissionAction = "deny" | "allow" | "approve";

/**
 * Session-level permission mode. Modes only relax the gate's *default*
 * decisions — explicit rules from `permissions.yml` always win first:
 *
 * - `default`: rules as authored; unmatched bash requires approval.
 * - `auto`: unmatched bash is auto-allowed unless it trips the built-in
 *   danger filter (`DANGEROUS_COMMAND_PATTERNS`), in which case it still
 *   requires approval. Explicit `deny`/`approve` rules behave as authored.
 * - `yolo`: every `approve` (rule-based or default) is downgraded to
 *   `allow`. Explicit `deny` rules still block — yolo is "stop asking",
 *   not "disable the gate".
 */
export type PermissionMode = "default" | "auto" | "yolo";

export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "auto", "yolo"];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** A single permission rule as authored in `permissions.yml`. */
export interface PermissionRule {
	/** Tool identifier this rule applies to (e.g. "bash", "read", "write", "edit"), or "*" for any tool. */
	tool: string;
	/** Glob pattern matched against the bash command string (only meaningful for tools with a `command` arg). */
	pattern?: string;
	/** Glob patterns matched against the file path (only meaningful for tools with a `path`/`file_path` arg). */
	paths?: string[];
	/** The action to take when this rule matches. */
	action: PermissionAction;
}

/** The result of evaluating a tool call against the permission rules. */
export interface PermissionDecision {
	action: PermissionAction;
	reason: string;
}

const VALID_ACTIONS: readonly PermissionAction[] = ["deny", "allow", "approve"];
const RULES_FILE_NAME = "permissions.yml";
const PATH_SCOPED_TOOLS = new Set(["read", "write", "edit"]);

function isPermissionAction(value: unknown): value is PermissionAction {
	return typeof value === "string" && (VALID_ACTIONS as readonly string[]).includes(value);
}

function validateRule(raw: unknown, index: number): PermissionRule {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`permissions.yml: rule at index ${index} must be an object`);
	}
	const record = raw as Record<string, unknown>;

	if (typeof record.tool !== "string" || record.tool.length === 0) {
		throw new Error(`permissions.yml: rule at index ${index} is missing a valid "tool" field`);
	}
	if (!isPermissionAction(record.action)) {
		throw new Error(
			`permissions.yml: rule at index ${index} has an invalid "action" (must be one of ${VALID_ACTIONS.join(", ")})`,
		);
	}

	const rule: PermissionRule = { tool: record.tool, action: record.action };

	if (record.pattern !== undefined) {
		if (typeof record.pattern !== "string") {
			throw new Error(`permissions.yml: rule at index ${index} has a non-string "pattern"`);
		}
		rule.pattern = record.pattern;
	}

	if (record.paths !== undefined) {
		if (!Array.isArray(record.paths) || !record.paths.every((entry) => typeof entry === "string")) {
			throw new Error(`permissions.yml: rule at index ${index} has an invalid "paths" (must be a string array)`);
		}
		rule.paths = record.paths as string[];
	}

	return rule;
}

/**
 * Parse a `permissions.yml` document (as a string) into an ordered list of
 * rules. Returns an empty array for empty documents or documents without a
 * `rules` key. Throws on malformed rule entries so misconfiguration fails
 * loudly rather than silently degrading the gate.
 */
export function parseRules(yamlText: string): PermissionRule[] {
	const parsed = parse(yamlText) as { rules?: unknown } | null | undefined;
	if (parsed === null || parsed === undefined) return [];
	if (parsed.rules === undefined) return [];
	if (!Array.isArray(parsed.rules)) {
		throw new Error('permissions.yml: "rules" must be an array');
	}
	return parsed.rules.map((raw, index) => validateRule(raw, index));
}

function readRulesFile(filePath: string): PermissionRule[] {
	if (!existsSync(filePath)) return [];
	return parseRules(readFileSync(filePath, "utf-8"));
}

/**
 * Load and merge permission rules from the global (`~/.draht/agent/permissions.yml`)
 * and project (`<projectDir>/.draht/permissions.yml`) config files.
 *
 * Loading order: global is read first, project is read after (so a project
 * can be authored as a delta on top of the global defaults). Merge order is
 * reversed relative to load order: project rules are placed *before* global
 * rules in the returned array, so that under first-match-wins evaluation the
 * project's rules take precedence over — i.e. "override" — the global ones.
 */
export function loadRules(projectDir?: string, globalDir?: string): PermissionRule[] {
	const globalRulesPath = join(globalDir ?? getAgentDir(), RULES_FILE_NAME);
	const projectRulesPath = join(projectDir ?? process.cwd(), CONFIG_DIR_NAME, RULES_FILE_NAME);

	const globalRules = readRulesFile(globalRulesPath);
	const projectRules = readRulesFile(projectRulesPath);

	return [...projectRules, ...globalRules];
}

/**
 * Bash `pattern` matching against the raw command string can never be more
 * than textual — it has no real shell parser behind it. A previous
 * implementation matched the whole command string against the pattern with
 * minimatch after stripping every "/" (to stop "*" from being blocked by
 * minimatch's path-segment semantics). That was trivially bypassed: any
 * prefix at all (a leading space, `sudo`, `/bin/`, `env`, chaining with `;`
 * or `&&`, wrapping in `bash -c "..."`, double spaces, reordered combined
 * flags like `-fr` vs `-rf`, or different case) defeated the anchored match,
 * and — separately — a trailing-wildcard *allow* rule like
 * `{ pattern: "npm test*", action: "allow" }` matched anything appended
 * after it via `;`, `&&`, `|`, backticks, or `$(...)`, silently
 * auto-approving injected commands.
 *
 * To stay fail-safe rather than fail-open, `deny` and `allow`/`approve` are
 * matched with deliberately different, asymmetric strategies:
 *
 *  - `deny` is matched *paranoidly*. The command is decomposed into every
 *    independently-executed piece we can find — split on chaining operators
 *    (`;`, `&&`, `||`, `|`, `&`, newlines); unwrapped from passthrough
 *    prefixes (`sudo`, `env`, `nice`, ...) and leading `VAR=val`
 *    assignments; unwrapped from `bash -c "..."` / `sh -c '...'` / `eval
 *    "..."`; unwrapped from `$(...)`/backtick substitutions; resolved from
 *    an absolute/relative path to a bare command name — recursively, up to
 *    a bounded depth/count. The pattern matches if *any* resulting
 *    candidate matches, after collapsing whitespace and canonicalizing
 *    combined short flags (so `-rf`/`-fr` compare equal), case-insensitively.
 *    Over-matching here is the safe failure mode.
 *  - `allow`/`approve` are matched *strictly*: the command is rejected
 *    outright if it contains any dynamic/opaque construct (`$(...)`,
 *    backticks, redirection `<`/`>`), and otherwise must have the exact same
 *    chain shape (same number of segments joined by the same operators) as
 *    the pattern, with each segment matched independently. A rule authored
 *    for `npm test*` therefore can never also authorize
 *    `npm test; rm -rf /` — the extra chained segment has no counterpart in
 *    the pattern, so the rule simply doesn't match (falling through to the
 *    default decision) instead of silently allowing it.
 *
 * KNOWN LIMITATION (not fixable with text matching alone): interpreter
 * escape hatches. Once a command hands control to a language runtime, the
 * payload is no longer shell and no shell-shaped pattern — `deny` rules
 * included — can see into it: `python -c "os.system('rm -rf /')"` never
 * surfaces `rm -rf /` as a match candidate, `python script.py` hides the
 * danger in file contents the gate never reads, and
 * `python -c "shutil.rmtree('/')"` involves no shell command at all. The
 * built-in danger filter flags *inline eval* invocations (`python -c`,
 * `node -e`, ...) so auto mode prompts on them, but script files and
 * in-language equivalents are out of reach by construction. The gate is a
 * guard against a confused agent, not a confinement boundary for a
 * malicious one — a hard boundary needs OS-level sandboxing of the bash
 * tool itself (Seatbelt/Landlock-style), not better string matching.
 *
 * KNOWN LIMITATION (not fixable with text matching alone): `pattern` cannot
 * enforce real directory containment. A rule like
 * `{ pattern: "cat /safe/dir/*", action: "allow" }` will still match
 * `cat /safe/dir/../../../etc/passwd`, because from a glob's point of view
 * `..` is just more characters absorbed by the trailing `*` — there is no
 * shell/path awareness in a plain string pattern. Use the `paths` mechanism
 * (which resolves real paths via `resolve`/`relative`, see `toMatchablePath`
 * below) instead of `pattern` whenever a rule needs to be scoped to a
 * directory; don't rely on `pattern` for path containment.
 */

/** Command names that merely forward to another command without changing what ultimately runs. */
const PASSTHROUGH_PREFIXES = new Set([
	"sudo",
	"doas",
	"command",
	"exec",
	"nice",
	"nohup",
	"env",
	"time",
	"stdbuf",
	"ionice",
	"chrt",
	"setsid",
	"xargs",
]);

/** Shells whose `-c <command>` argument is itself a full command line to unwrap and re-check. */
const SHELL_C_WRAPPERS = new Set(["bash", "sh", "zsh", "ksh", "dash"]);

/** Constructs that make a command dynamic/opaque enough that allow/approve patterns must never match it. */
const DANGEROUS_CONSTRUCT_RE = /\$\(|`|<|>/;

interface ChainSegment {
	text: string;
	/** The operator immediately preceding this segment; `undefined` for the first segment. */
	operator?: string;
}

/** Quote-aware split of a command string on top-level chain operators (`;`, `&&`, `||`, `|`, `&`, newlines). */
function splitChain(command: string): ChainSegment[] {
	const segments: ChainSegment[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let operator: string | undefined;
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[i + 1];
			i += 2;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			segments.push({ text: current, operator });
			current = "";
			operator = two;
			i += 2;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			segments.push({ text: current, operator });
			current = "";
			operator = ch === "\n" ? ";" : ch;
			i += 1;
			continue;
		}
		current += ch;
		i++;
	}
	segments.push({ text: current, operator });
	return segments;
}

function collapseWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/** Canonicalizes combined single-dash short-flag clusters (`-rf` / `-fr`) by sorting their letters. */
function normalizeFlagClusters(text: string): string {
	return text.replace(/(^|\s)-([A-Za-z]{2,})(?=\s|$)/g, (_match, pre: string, letters: string) => {
		return `${pre}-${letters.split("").sort().join("")}`;
	});
}

function normalizeForMatch(text: string): string {
	return normalizeFlagClusters(collapseWhitespace(text));
}

/** Resolves a leading `/some/path/cmd` (or `./cmd`, `../cmd`) first token down to its bare basename. */
function resolveBasenameOfFirstToken(text: string): string {
	const leadingWs = text.slice(0, text.length - text.trimStart().length);
	const trimmed = text.trimStart();
	const match = trimmed.match(/^(\S+)([\s\S]*)$/);
	if (!match) return text;
	const [, firstToken, rest] = match;
	if (!firstToken.includes("/")) return text;
	const basename = firstToken.slice(firstToken.lastIndexOf("/") + 1);
	return leadingWs + basename + rest;
}

function stripLeadingBackslashEscape(text: string): string {
	return text.replace(/^(\s*)\\(?=[A-Za-z])/, "$1");
}

function stripEnvAssignments(text: string): string {
	return text.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
}

/** Strips one leading passthrough-wrapper command (e.g. `sudo`, `env FOO=1`) and its own flags, if present. */
function stripPassthroughPrefix(text: string): { stripped: string; changed: boolean } {
	const trimmed = text.replace(/^\s+/, "");
	const match = trimmed.match(/^(\S+)((?:\s+-\S+)*)\s+/);
	if (!match) return { stripped: text, changed: false };
	const token = match[1];
	const basename = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
	if (!PASSTHROUGH_PREFIXES.has(basename.toLowerCase())) return { stripped: text, changed: false };
	return { stripped: trimmed.slice(match[0].length), changed: true };
}

/** Extracts the inner command line from a `bash -c "..."` / `sh -c '...'` style wrapper, if present. */
function extractShellDashC(text: string): string | undefined {
	const trimmed = text.trim();
	const match = trimmed.match(/^(\S+)(?:\s+-\S+)*\s+-c\s+(['"])([\s\S]*)\2\s*$/);
	if (!match) return undefined;
	const token = match[1];
	const basename = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
	if (!SHELL_C_WRAPPERS.has(basename.toLowerCase())) return undefined;
	return match[3];
}

/** Extracts the inner command line from an `eval "..."` / `eval '...'` wrapper, if present. */
function extractEvalArg(text: string): string | undefined {
	const match = text.trim().match(/^eval\s+(['"])([\s\S]*)\1\s*$/i);
	return match ? match[2] : undefined;
}

/** Extracts the contents of every `$(...)` and `` `...` `` command substitution found anywhere in `text`. */
function extractSubstitutions(text: string): string[] {
	const results: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === "$" && text[i + 1] === "(") {
			let depth = 1;
			let j = i + 2;
			while (j < text.length && depth > 0) {
				if (text[j] === "(") depth++;
				else if (text[j] === ")") depth--;
				j++;
			}
			results.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
			i = j;
			continue;
		}
		i++;
	}
	const backtickMatches = text.match(/`([^`]*)`/g);
	if (backtickMatches) {
		for (const m of backtickMatches) results.push(m.slice(1, -1));
	}
	return results;
}

const MAX_DENY_CANDIDATES = 50;
const MAX_DENY_DEPTH = 4;

/**
 * Paranoidly enumerates every independently-executed "piece" of `command` a
 * `deny` rule should be checked against: the raw command, each chained
 * segment, prefix/wrapper-stripped variants of each segment, and the bodies
 * of any `bash -c` / `eval` / `$(...)` / backtick constructs — recursively,
 * bounded so adversarial input can't cause unbounded work.
 */
function collectDenyCandidates(command: string): string[] {
	const seen = new Set<string>();
	const queue: Array<{ text: string; depth: number }> = [{ text: command, depth: 0 }];

	while (queue.length > 0 && seen.size < MAX_DENY_CANDIDATES) {
		const next = queue.shift();
		if (!next) break;
		const { text, depth } = next;
		if (seen.has(text)) continue;
		seen.add(text);
		if (depth >= MAX_DENY_DEPTH) continue;

		const enqueue = (candidate: string) => {
			if (!seen.has(candidate) && seen.size + queue.length < MAX_DENY_CANDIDATES) {
				queue.push({ text: candidate, depth: depth + 1 });
			}
		};

		const segments = splitChain(text).map((s) => s.text);
		const pieces = segments.length > 1 ? segments : [text];
		for (const seg of segments) enqueue(seg);

		for (const piece of pieces) {
			let working = stripLeadingBackslashEscape(piece);
			working = stripEnvAssignments(working);
			for (let guard = 0; guard < 5; guard++) {
				const { stripped, changed } = stripPassthroughPrefix(working);
				if (!changed) break;
				working = stripped;
			}
			enqueue(working);

			const basenameResolved = resolveBasenameOfFirstToken(working);
			enqueue(basenameResolved);

			const shellC = extractShellDashC(working) ?? extractShellDashC(basenameResolved);
			if (shellC !== undefined) enqueue(shellC);

			const evalArg = extractEvalArg(working) ?? extractEvalArg(basenameResolved);
			if (evalArg !== undefined) enqueue(evalArg);

			for (const sub of extractSubstitutions(piece)) enqueue(sub);
		}
	}

	return [...seen];
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (const ch of pattern) {
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "is");
}

function matchDenyPattern(command: string, pattern: string): boolean {
	const regex = globToRegExp(normalizeForMatch(pattern));
	return collectDenyCandidates(command).some((candidate) => regex.test(normalizeForMatch(candidate)));
}

/**
 * Strictly matches `command` against an `allow`/`approve` `pattern`: any
 * dynamic/opaque construct disqualifies the match outright, and the command
 * must have the same chain shape (segment count and operators) as the
 * pattern, with every segment matching independently. This is what stops a
 * rule like `{ pattern: "npm test*", action: "allow" }` from also
 * authorizing `npm test; rm -rf /` or `` npm test `rm -rf /` ``.
 */
function matchAllowPattern(command: string, pattern: string): boolean {
	if (DANGEROUS_CONSTRUCT_RE.test(command)) return false;

	const commandSegments = splitChain(command);
	const patternSegments = splitChain(pattern);
	if (commandSegments.length !== patternSegments.length) return false;

	for (let i = 0; i < commandSegments.length; i++) {
		if (commandSegments[i].operator !== patternSegments[i].operator) return false;
		const cmdText = normalizeForMatch(commandSegments[i].text);
		const cmdResolved = normalizeForMatch(resolveBasenameOfFirstToken(commandSegments[i].text));
		const regex = globToRegExp(normalizeForMatch(patternSegments[i].text));
		if (!regex.test(cmdText) && !regex.test(cmdResolved)) return false;
	}
	return true;
}

function matchCommandPattern(command: string, pattern: string, action: PermissionAction): boolean {
	return action === "deny" ? matchDenyPattern(command, pattern) : matchAllowPattern(command, pattern);
}

/**
 * Built-in danger filter backing `auto` mode. These are matched with the
 * same paranoid strategy as `deny` rules (chain splitting, wrapper
 * unwrapping, substitution extraction), so `echo hi && rm -rf /` or
 * `bash -c "sudo dd ..."` still trip the filter.
 *
 * This is a *prompt* heuristic, not a security boundary: it decides which
 * unmatched commands fall back to approval instead of auto-allow. It can
 * never enumerate every destructive command — anything that must be hard
 * blocked belongs in a `deny` rule in `permissions.yml`.
 */
export const DANGEROUS_COMMAND_PATTERNS: readonly string[] = [
	// recursive/forced deletion (flag clusters normalize to sorted letters,
	// so `-rf`/`-fr` become `-fr` and are caught by the `-f*` prefix; bare
	// `-r`/`-R` by the `-r*` prefix via case-insensitive matching)
	"rm -r*",
	"rm -f*",
	// privilege escalation
	"sudo *",
	"doas *",
	"su *",
	// raw disk / filesystem surgery
	"dd *",
	"mkfs*",
	// system state
	"shutdown*",
	"reboot*",
	"halt*",
	"poweroff*",
	// blanket permission changes
	"chmod 777 *",
	"chmod -R *",
	"chown -R *",
	// outward-facing / history-rewriting git and publishing
	"git push*",
	"git reset --hard*",
	"git clean*",
	"npm publish*",
	"yarn publish*",
	"pnpm publish*",
	// pipe-to-shell installers
	"curl * | *",
	"wget * | *",
	// inline interpreter eval — the code payload is another language the gate
	// cannot parse, so `python -c "os.system('rm -rf /')"` would otherwise
	// sail through as "not shell-dangerous". Running a script *file*
	// (`python script.py`) is deliberately NOT flagged: it is everyday dev
	// work, and the gate cannot see file contents anyway (see the module doc
	// on interpreter escape hatches).
	"python* -c*",
	"node -e*",
	"node --eval*",
	"node -p*",
	"bun -e*",
	"bun --eval*",
	"deno eval*",
	"ruby -e*",
	"perl -e*",
	"php -r*",
];

/**
 * Returns the first built-in dangerous pattern the command matches, or
 * `undefined` if the command passes the filter.
 */
export function findDangerousPattern(command: string): string | undefined {
	return DANGEROUS_COMMAND_PATTERNS.find((pattern) => matchDenyPattern(command, pattern));
}

/** Normalize a (possibly relative or absolute) path into a forward-slash path relative to `cwd`, for glob matching. */
function toMatchablePath(filePath: string, cwd: string): string {
	const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const rel = relative(cwd, resolved);
	return rel.split(sep).join("/");
}

/** Whether `filePath` (relative or absolute) resolves to a location inside `cwd`. */
function isWithinProject(filePath: string, cwd: string): boolean {
	const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const rel = relative(cwd, resolved);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * NOTE: this assumes the tool-call args carry a `command` string under the
 * exact key `command`. If/when this gate is wired into actual tool
 * dispatch, verify every gated tool's argument shape matches these
 * hardcoded key names — a mismatch doesn't error, it just silently fails to
 * match any `pattern`/`paths` rule and falls through to the (fail-safe)
 * default decision. Not currently exploitable: nothing outside this module
 * and its test calls `PermissionGate`/`loadRules` yet.
 */
function getCommandArg(args: Record<string, unknown>): string | undefined {
	return typeof args.command === "string" ? args.command : undefined;
}

/** Prefers `file_path` over `path` when both are present; see the note on `getCommandArg` above. */
function getPathArg(args: Record<string, unknown>): string | undefined {
	if (typeof args.file_path === "string") return args.file_path;
	if (typeof args.path === "string") return args.path;
	return undefined;
}

function describeMatch(rule: PermissionRule): string {
	const parts = [`tool=${rule.tool}`];
	if (rule.pattern !== undefined) parts.push(`pattern=${JSON.stringify(rule.pattern)}`);
	if (rule.paths !== undefined) parts.push(`paths=${JSON.stringify(rule.paths)}`);
	return `matched rule (${parts.join(", ")}) -> ${rule.action}`;
}

function ruleMatches(rule: PermissionRule, toolName: string, args: Record<string, unknown>, cwd: string): boolean {
	if (rule.tool !== "*" && rule.tool.toLowerCase() !== toolName) return false;

	if (rule.pattern !== undefined) {
		const command = getCommandArg(args);
		if (command === undefined || !matchCommandPattern(command, rule.pattern, rule.action)) return false;
	}

	if (rule.paths !== undefined) {
		const filePath = getPathArg(args);
		if (filePath === undefined) return false;
		const matchable = toMatchablePath(filePath, cwd);
		if (!rule.paths.some((pattern) => minimatch(matchable, pattern, { dot: true }))) return false;
	}

	return true;
}

export interface PermissionGateOptions {
	/** Project root used to determine whether a path is "within the project" for default decisions. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Session permission mode; see `PermissionMode`. Defaults to `"default"`. */
	mode?: PermissionMode;
}

/**
 * Evaluates tool calls against an ordered list of permission rules,
 * returning a `deny` / `allow` / `approve` decision.
 */
export class PermissionGate {
	private readonly rules: PermissionRule[];
	private readonly cwd: string;
	private readonly mode: PermissionMode;

	constructor(rules: PermissionRule[] = [], options: PermissionGateOptions = {}) {
		this.rules = rules;
		this.cwd = options.cwd ?? process.cwd();
		this.mode = options.mode ?? "default";
	}

	/** Evaluate a tool call. `args` should carry `command` for bash, or `path`/`file_path` for read/write/edit. */
	evaluate(toolName: string, args: Record<string, unknown> = {}): PermissionDecision {
		const normalizedTool = toolName.toLowerCase();

		for (const rule of this.rules) {
			if (ruleMatches(rule, normalizedTool, args, this.cwd)) {
				return this.applyMode({ action: rule.action, reason: describeMatch(rule) });
			}
		}

		return this.applyMode(this.defaultDecision(normalizedTool, args));
	}

	/**
	 * Applies the session mode to a decision. `deny` is never relaxed by any
	 * mode; `yolo` downgrades every `approve` to `allow`.
	 */
	private applyMode(decision: PermissionDecision): PermissionDecision {
		if (this.mode === "yolo" && decision.action === "approve") {
			return { action: "allow", reason: `yolo mode: auto-allowed (${decision.reason})` };
		}
		return decision;
	}

	private defaultDecision(toolName: string, args: Record<string, unknown>): PermissionDecision {
		if (toolName === "bash") {
			if (this.mode === "auto") {
				const command = getCommandArg(args);
				if (command === undefined) {
					return { action: "approve", reason: "auto mode: bash call without a command string requires approval" };
				}
				const dangerous = findDangerousPattern(command);
				if (dangerous !== undefined) {
					return {
						action: "approve",
						reason: `auto mode: command matched dangerous pattern ${JSON.stringify(dangerous)}, requires approval`,
					};
				}
				return { action: "allow", reason: "auto mode: no rule matched and command passed the danger filter" };
			}
			return { action: "approve", reason: "no rule matched; bash commands require approval by default" };
		}

		if (PATH_SCOPED_TOOLS.has(toolName)) {
			const filePath = getPathArg(args);
			if (filePath !== undefined && isWithinProject(filePath, this.cwd)) {
				return { action: "allow", reason: "no rule matched; allowed by default within the project" };
			}
			return {
				action: "approve",
				reason: "no rule matched; path is outside the project (or missing), requires approval",
			};
		}

		return { action: "approve", reason: `no rule matched for tool "${toolName}"; defaults to approve` };
	}
}
