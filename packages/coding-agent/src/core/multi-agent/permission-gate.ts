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
 * - `default`: rules as authored; unmatched bash/powershell requires approval.
 * - `auto`: unmatched bash is auto-allowed unless it trips the built-in
 *   danger filter (`DANGEROUS_COMMAND_PATTERNS`), in which case it still
 *   requires approval. `powershell` is excluded from this auto-allow — the
 *   danger filter is bash-shaped and has no powershell-specific coverage, so
 *   unmatched powershell calls always require approval, even in auto mode.
 *   Explicit `deny`/`approve` rules behave as authored.
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
/** Read-only tools whose optional `path` arg defaults to the cwd when omitted. */
const READ_ONLY_PATH_TOOLS = new Set(["grep", "find", "ls"]);
/**
 * Tools that are safe to run without confirmation because the call itself
 * only delegates: spawned child processes run this same gate over every tool
 * call they actually make. Explicit rules can still `deny`/`approve` these.
 * Duet delegation is deliberately not included because it fans out paid model
 * requests; unmatched duet batches require explicit approval.
 */
const DEFAULT_ALLOWED_TOOLS = new Set(["subagent"]);

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
	"timeout",
	// busybox dispatches to its builtin applet by the same name and arguments
	// it was given (`busybox rm -rf /` behaves exactly like `rm -rf /`), so it
	// is a pure passthrough for deny-scan purposes.
	"busybox",
]);

/** Shells whose `-c <command>` argument is itself a full command line to unwrap and re-check. */
const SHELL_C_WRAPPERS = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish"]);

/**
 * Non-POSIX shells whose command-line argument is itself a full command line
 * to unwrap and re-check. Catches bash wrapping another shell, e.g.
 * `bash -c "pwsh -c 'rm -rf ~'"`.
 */
const OTHER_SHELL_WRAPPERS = new Set(["pwsh", "powershell", "powershell.exe", "cmd", "cmd.exe"]);

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

/**
 * Canonicalizes combined single-dash short-flag clusters (`-rf` / `-fr`) by
 * sorting their letters. The sort is case-insensitive: matching elsewhere is
 * already case-insensitive (`globToRegExp`'s `i` flag), but a case-sensitive
 * sort would put uppercase letters before lowercase ones (ASCII order), so a
 * mixed-case cluster like `-Rf` would canonicalize to `-Rf` while `-rf`
 * canonicalizes to `-fr` — different letter *order*, which the `i` flag
 * can't paper over. Sorting case-insensitively (while keeping each letter's
 * original case) gives `-Rf` and `-rf` the same order (`-fR` / `-fr`), so
 * `-Rf`/`-fR`/`-RF`/... all canonicalize to match a plain `-rf` pattern.
 */
function normalizeFlagClusters(text: string): string {
	return text.replace(/(^|\s)-([A-Za-z]{2,})(?=\s|$)/g, (_match, pre: string, letters: string) => {
		const sorted = [...letters].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		return `${pre}-${sorted.join("")}`;
	});
}

function normalizeForMatch(text: string): string {
	return normalizeFlagClusters(collapseWhitespace(text));
}

function tokenize(text: string): string[] {
	const trimmed = text.trim();
	return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/** A combined short-flag cluster token (`-rf`, `-R`), optionally glob-suffixed (`-r*`) by a danger-pattern author. */
function parseShortFlagClusterToken(token: string): string | undefined {
	return token.match(/^-([A-Za-z]+)\*?$/)?.[1];
}

function parseLongFlagToken(token: string): string | undefined {
	return token.match(/^--([A-Za-z][A-Za-z-]*)$/)?.[1]?.toLowerCase();
}

interface FlagSet {
	shortFlags: Set<string>;
	longFlags: Set<string>;
}

/** Collects every short/long flag found anywhere in `tokens`, regardless of order, clustering, or position. */
function extractFlagSet(tokens: string[]): FlagSet {
	const shortFlags = new Set<string>();
	const longFlags = new Set<string>();
	for (const token of tokens) {
		const letters = parseShortFlagClusterToken(token);
		if (letters !== undefined) {
			for (const ch of letters) shortFlags.add(ch.toLowerCase());
			continue;
		}
		const long = parseLongFlagToken(token);
		if (long !== undefined) longFlags.add(long);
	}
	return { shortFlags, longFlags };
}

interface FlagClusterDenyPattern {
	command: string;
	requiredShortFlags: Set<string>;
	requiredLongFlags: Set<string>;
}

/**
 * Parses a deny `pattern` of the shape `<command> <flags...> [*]` (e.g.
 * `rm -rf *`, `rm -r*`, `chmod -R *`) into a required flag set, for matching
 * by `flagClusterPatternMatchesCandidate` below. Returns `undefined` for any
 * pattern that doesn't have this exact "bare command name plus only
 * flags/wildcard" shape, so those patterns keep using the generic glob
 * matcher unchanged.
 */
function parseFlagClusterPattern(pattern: string): FlagClusterDenyPattern | undefined {
	const [command, ...rest] = tokenize(pattern);
	if (command === undefined || /[*?]/.test(command)) return undefined;

	const requiredShortFlags = new Set<string>();
	const requiredLongFlags = new Set<string>();
	let sawFlag = false;
	for (const token of rest) {
		if (token === "*") continue;
		const letters = parseShortFlagClusterToken(token);
		if (letters !== undefined) {
			sawFlag = true;
			for (const ch of letters) requiredShortFlags.add(ch.toLowerCase());
			continue;
		}
		const long = parseLongFlagToken(token);
		if (long !== undefined) {
			sawFlag = true;
			requiredLongFlags.add(long);
			continue;
		}
		return undefined;
	}
	if (!sawFlag) return undefined;
	return { command: command.toLowerCase(), requiredShortFlags, requiredLongFlags };
}

/** `rm`'s two spellings of "recursive"/"force" that are interchangeable for flag-set matching purposes. */
const SHORT_LONG_FLAG_EQUIVALENTS: ReadonlyMap<string, string> = new Map([
	["r", "recursive"],
	["f", "force"],
]);

function flagClusterPatternMatchesCandidate(flagPattern: FlagClusterDenyPattern, candidateText: string): boolean {
	const tokens = tokenize(candidateText);
	const commandToken = tokens[0];
	if (commandToken === undefined) return false;
	const commandName = (
		commandToken.includes("/") ? commandToken.slice(commandToken.lastIndexOf("/") + 1) : commandToken
	).toLowerCase();
	if (commandName !== flagPattern.command) return false;

	const { shortFlags, longFlags } = extractFlagSet(tokens.slice(1));
	const hasShort = (flag: string) =>
		shortFlags.has(flag) || longFlags.has(SHORT_LONG_FLAG_EQUIVALENTS.get(flag) ?? "");
	const hasLong = (flag: string) => {
		if (longFlags.has(flag)) return true;
		for (const [short, long] of SHORT_LONG_FLAG_EQUIVALENTS) {
			if (long === flag && shortFlags.has(short)) return true;
		}
		return false;
	};

	for (const flag of flagPattern.requiredShortFlags) if (!hasShort(flag)) return false;
	for (const flag of flagPattern.requiredLongFlags) if (!hasLong(flag)) return false;
	return true;
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

/**
 * Strips one leading passthrough-wrapper command (e.g. `sudo`, `env FOO=1`)
 * and its own flags, if present. `timeout DURATION cmd...` additionally
 * skips the required duration positional, which isn't a `-flag` token, so
 * `timeout 5 rm -rf /` unwraps down to `rm -rf /` instead of leaving the
 * bogus `5 rm -rf /` behind. (A `timeout -s KILL 30 cmd`-style separate-arg
 * flag is a known gap shared with every other wrapper here: only combined
 * `-flag` tokens are recognized, not flags with a separate argument.)
 */
function stripPassthroughPrefix(text: string): { stripped: string; changed: boolean } {
	const trimmed = text.replace(/^\s+/, "");
	const match = trimmed.match(/^(\S+)((?:\s+-\S+)*)\s+/);
	if (!match) return { stripped: text, changed: false };
	const token = match[1];
	const basename = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
	if (!PASSTHROUGH_PREFIXES.has(basename.toLowerCase())) return { stripped: text, changed: false };
	let rest = trimmed.slice(match[0].length);
	if (basename.toLowerCase() === "timeout") {
		const duration = rest.match(/^(\S+)\s+/);
		if (duration) rest = rest.slice(duration[0].length);
	}
	return { stripped: rest, changed: true };
}

/**
 * Minimal POSIX-ish shell word tokenizer: splits `text` on unquoted
 * whitespace, honoring single quotes (fully literal, no escapes), double
 * quotes (backslash escapes the next character), and a bare backslash
 * outside quotes (escapes the next character). This is only used to locate
 * wrapper flags and the command-body token that follows them, not to
 * implement real shell grammar (no variable expansion, globbing, etc.).
 */
function tokenizeShellWords(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let hasCurrent = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			if (hasCurrent) {
				tokens.push(current);
				current = "";
				hasCurrent = false;
			}
			i++;
			continue;
		}
		if (ch === "'") {
			hasCurrent = true;
			i++;
			while (i < text.length && text[i] !== "'") {
				current += text[i];
				i++;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			hasCurrent = true;
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length) {
					current += text[i + 1];
					i += 2;
				} else {
					current += text[i];
					i++;
				}
			}
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			hasCurrent = true;
			current += text[i + 1];
			i += 2;
			continue;
		}
		hasCurrent = true;
		current += ch;
		i++;
	}
	if (hasCurrent) tokens.push(current);
	return tokens;
}

/** Lowercased basename of a (possibly quoted/escaped, already-tokenized) command-head token, split on `/` and `\`. */
function basenameOfHeadToken(token: string): string {
	const parts = token.split(/[/\\]/);
	return (parts[parts.length - 1] ?? token).toLowerCase();
}

/** Wrapper flags that consume the following token as their own argument, not as part of the command. */
const SHELL_DASH_O_FLAGS = new Set(["-o", "-O"]);

/**
 * Extracts the command-body token following a `-c` flag from an
 * already-tokenized shell invocation, if `text`'s head is in `wrapperSet` and
 * a `-c` flag (bare or clustered with other short flags, e.g. `-lc`, `-cx`,
 * `-ce`) appears anywhere before the first non-flag token — including after
 * `-o pipefail`, `-O extglob`, `--`, or `-l`. Trailing positional arguments
 * after the body (e.g. `$0` in `bash -c '...' x`) are ignored.
 */
function extractShellBodyAfterDashC(text: string, wrapperSet: ReadonlySet<string>): string | undefined {
	const tokens = tokenizeShellWords(text.trim());
	const head = tokens[0];
	if (head === undefined || !wrapperSet.has(basenameOfHeadToken(head))) return undefined;

	let sawDashC = false;
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") continue;
		if (SHELL_DASH_O_FLAGS.has(token)) {
			i++;
			continue;
		}
		if (/^-[A-Za-z]+$/.test(token)) {
			if (token.includes("c")) sawDashC = true;
			continue;
		}
		return sawDashC ? token : undefined;
	}
	return undefined;
}

/** Extracts the payload of a `<<< '...'` here-string or a `<<DELIM ... DELIM` heredoc, if present anywhere in `text`. */
function extractHereStringOrHeredocPayload(text: string): string | undefined {
	const hereString = text.match(/<<<\s*(['"]?)([\s\S]*?)\1\s*$/);
	if (hereString) return hereString[2];
	const heredoc = text.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2\s*$/);
	return heredoc ? heredoc[3] : undefined;
}

/** `true` when `text` invokes a known shell with no `-c`, but feeds it a here-string or heredoc body. */
function feedsBareShellViaHereDocOrString(text: string): boolean {
	const trimmed = text.trim();
	const tokens = tokenizeShellWords(trimmed);
	const head = tokens[0];
	if (head === undefined || !SHELL_C_WRAPPERS.has(basenameOfHeadToken(head))) return false;
	if (extractShellBodyAfterDashC(trimmed, SHELL_C_WRAPPERS) !== undefined) return false;
	return /<<<|<</.test(trimmed);
}

/** `true` when any `|`-joined segment pipes into a known shell with no `-c` (`echo ... | bash`). */
function pipedIntoBareShell(segments: ChainSegment[]): boolean {
	return segments.some((seg) => {
		if (seg.operator !== "|") return false;
		const trimmed = seg.text.trim();
		const tokens = tokenizeShellWords(trimmed);
		const head = tokens[0];
		if (head === undefined || !SHELL_C_WRAPPERS.has(basenameOfHeadToken(head))) return false;
		return extractShellBodyAfterDashC(trimmed, SHELL_C_WRAPPERS) === undefined;
	});
}

/**
 * `true` when `command` feeds a bare shell interpreter (`bash`, `sh`, `zsh`,
 * `dash`, `ksh`, `fish`) via a pipe, here-string, or heredoc, with no `-c`
 * flag. The deny scan can extract and check the piped/here-doc text (see
 * `scanDenyCandidates`), but can't prove the absence of danger the way a
 * plain unwrapped command can — so auto mode must never silently allow it.
 */
function commandFeedsBareShellWithoutDashC(command: string): boolean {
	const segments = splitChain(command);
	if (pipedIntoBareShell(segments)) return true;
	return segments.some((seg) => feedsBareShellViaHereDocOrString(seg.text));
}

/**
 * Extracts the inner command line from a `pwsh -c "..."` / `powershell
 * -Command "..."` / `cmd /c "..."` style wrapper, if present. Accepts `-c`,
 * `-Command`, and `/c` case-insensitively rather than the exact flag each
 * shell prefers — for danger detection, over-matching is the safe direction.
 */
function extractOtherShellWrapperArg(text: string): string | undefined {
	const trimmed = text.trim();
	const match = trimmed.match(/^(\S+)(?:\s+-\S+)*\s+(?:-c|-command|\/c)\s+(['"])([\s\S]*)\2\s*$/i);
	if (!match) return undefined;
	const token = match[1];
	const basename = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
	if (!OTHER_SHELL_WRAPPERS.has(basename.toLowerCase())) return undefined;
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

/**
 * Returns the literal output of a simple `echo ...` command. This covers a
 * substitution used as a command position, such as `$(echo rm -rf /)`, where
 * the output is subsequently executed by the outer shell.
 */
function extractSimpleEchoOutput(text: string): string | undefined {
	const match = text.match(/^\s*echo\s+([^$`]+?)\s*$/i);
	if (!match) return undefined;
	const captured = match[1];
	const quoted = captured.match(/^(['"])([\s\S]*)\1$/);
	return quoted ? quoted[2] : captured;
}

const MAX_DENY_CANDIDATES = 50;
const MAX_DENY_DEPTH = 4;

interface DenyScanResult {
	candidates: string[];
	/**
	 * `true` when the candidate/depth cap cut the scan short before every
	 * piece of `command` could be enumerated. Callers MUST treat a truncated
	 * scan as "unknown, not denied" rather than "not denied" — see
	 * `commandDenyScanTruncated` below.
	 */
	truncated: boolean;
}

/**
 * Paranoidly enumerates every independently-executed "piece" of `command` a
 * `deny` rule should be checked against: the raw command, each chained
 * segment, prefix/wrapper-stripped variants of each segment, and the bodies
 * of any `bash -c` / `eval` / `$(...)` / backtick constructs — recursively,
 * bounded so adversarial input can't cause unbounded work.
 *
 * The bound is itself a fail-safe surface: a command with more pieces or
 * wrapper layers than the cap allows must not be treated as "scanned clean".
 * `truncated` on the result flags exactly that case.
 */
function scanDenyCandidates(command: string): DenyScanResult {
	const seen = new Set<string>();
	const queue: Array<{ text: string; depth: number }> = [{ text: command, depth: 0 }];
	let truncated = false;

	while (queue.length > 0) {
		if (seen.size >= MAX_DENY_CANDIDATES) {
			truncated = true;
			break;
		}
		const next = queue.shift();
		if (!next) break;
		const { text, depth } = next;
		if (seen.has(text)) continue;
		seen.add(text);
		if (depth >= MAX_DENY_DEPTH) {
			truncated = true;
			continue;
		}

		const enqueue = (candidate: string) => {
			if (seen.has(candidate)) return;
			if (seen.size + queue.length >= MAX_DENY_CANDIDATES) {
				truncated = true;
				return;
			}
			queue.push({ text: candidate, depth: depth + 1 });
		};

		const segmentObjs = splitChain(text);
		const segments = segmentObjs.map((s) => s.text);
		const pieces = segments.length > 1 ? segments : [text];
		for (const seg of segments) enqueue(seg);

		for (let i = 0; i < segmentObjs.length; i++) {
			if (segmentObjs[i].operator !== "|") continue;
			const prevText = segmentObjs[i - 1]?.text;
			if (prevText === undefined) continue;
			const echoOutput = extractSimpleEchoOutput(prevText);
			if (echoOutput !== undefined) enqueue(echoOutput);
		}

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

			const shellC =
				extractShellBodyAfterDashC(working, SHELL_C_WRAPPERS) ??
				extractShellBodyAfterDashC(basenameResolved, SHELL_C_WRAPPERS);
			if (shellC !== undefined) enqueue(shellC);

			const hereRedirect = extractHereStringOrHeredocPayload(piece);
			if (hereRedirect !== undefined) enqueue(hereRedirect);

			const otherShellArg = extractOtherShellWrapperArg(working) ?? extractOtherShellWrapperArg(basenameResolved);
			if (otherShellArg !== undefined) enqueue(otherShellArg);

			const evalArg = extractEvalArg(working) ?? extractEvalArg(basenameResolved);
			if (evalArg !== undefined) enqueue(evalArg);

			for (const sub of extractSubstitutions(piece)) {
				enqueue(sub);
				const echoOutput = extractSimpleEchoOutput(sub);
				if (echoOutput !== undefined) enqueue(echoOutput);
			}
		}
	}

	return { candidates: [...seen], truncated };
}

/** Candidate list only, for callers that don't need the truncation flag. */
function collectDenyCandidates(command: string): string[] {
	return scanDenyCandidates(command).candidates;
}

/**
 * `true` when `command` has more chained pieces or wrapper layers than
 * `scanDenyCandidates` could fully enumerate. A truncated scan can never be
 * trusted to say "no deny/danger match" — the unscanned remainder might hide
 * one — so callers must fail closed (deny or require approval) rather than
 * fall through to an auto-allow default.
 */
function commandDenyScanTruncated(command: string): boolean {
	return scanDenyCandidates(command).truncated;
}

/** Bare first-token command name of a candidate (lowercased, path-stripped), for interpreter checks. */
function firstTokenCommandName(text: string): string {
	const token = text.trimStart().match(/^\S+/)?.[0] ?? "";
	return (token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token).toLowerCase();
}

/**
 * `true` when `command` (bash tool) invokes `pwsh`/`powershell`/`cmd` at any
 * unwrapped layer, e.g. `pwsh -c "Remove-Item -Recurse ~"` or
 * `bash -c "cmd /c del ..."`. Auto mode's danger filter
 * (`DANGEROUS_COMMAND_PATTERNS`) is bash-shaped and has no coverage for these
 * interpreters' own syntax, the same reason unmatched `powershell` tool calls
 * always require approval — so a bash-tool call that merely shells out to one
 * of them must not get a free pass auto mode never meant to give it.
 */
function commandInvokesOtherShell(command: string): boolean {
	return collectDenyCandidates(command).some((candidate) =>
		OTHER_SHELL_WRAPPERS.has(firstTokenCommandName(candidate)),
	);
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
	const candidates = collectDenyCandidates(command);
	const flagPattern = parseFlagClusterPattern(pattern);
	if (
		flagPattern !== undefined &&
		candidates.some((candidate) => flagClusterPatternMatchesCandidate(flagPattern, candidate))
	) {
		return true;
	}
	const regex = globToRegExp(normalizeForMatch(pattern));
	return candidates.some((candidate) => regex.test(normalizeForMatch(candidate)));
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

/**
 * A `tool: bash` rule's `pattern` is authored against bash command shapes, so
 * only its `deny` half is safe to reuse for `powershell` calls: a bash `deny`
 * over-matching onto a powershell command is the fail-safe direction, while a
 * bash `allow`/`approve` pattern (e.g. `ls *`) under-matching real
 * powershell syntax would otherwise create the illusion of coverage without
 * actually vetting powershell-specific danger. `tool: powershell` rules
 * (and `tool: "*"`) are unaffected and keep matching normally.
 */
function bashDenyRuleAppliesToPowershell(rule: PermissionRule, toolName: string): boolean {
	return toolName === "powershell" && rule.tool.toLowerCase() === "bash" && rule.action === "deny";
}

function toolMatchesRule(rule: PermissionRule, toolName: string): boolean {
	return rule.tool === "*" || rule.tool.toLowerCase() === toolName || bashDenyRuleAppliesToPowershell(rule, toolName);
}

function ruleMatches(rule: PermissionRule, toolName: string, args: Record<string, unknown>, cwd: string): boolean {
	if (!toolMatchesRule(rule, toolName)) return false;

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

		if (normalizedTool === "bash" || normalizedTool === "powershell") {
			const command = getCommandArg(args);
			if (command !== undefined && commandDenyScanTruncated(command)) {
				const denyRuleApplies = this.rules.some(
					(rule) => rule.action === "deny" && toolMatchesRule(rule, normalizedTool),
				);
				if (denyRuleApplies) {
					return {
						action: "deny",
						reason:
							"command has more chained/wrapped pieces than the deny scan can fully cover, and a deny rule applies to this tool; failing closed rather than risk missing a match",
					};
				}
			}
		}

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
		if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
			return { action: "allow", reason: `no rule matched; "${toolName}" is allowed by default` };
		}

		if (toolName === "bash") {
			if (this.mode === "auto") {
				const command = getCommandArg(args);
				if (command === undefined) {
					return {
						action: "approve",
						reason: "auto mode: bash call without a command string requires approval",
					};
				}
				const dangerous = findDangerousPattern(command);
				if (dangerous !== undefined) {
					return {
						action: "approve",
						reason: `auto mode: command matched dangerous pattern ${JSON.stringify(dangerous)}, requires approval`,
					};
				}
				if (commandInvokesOtherShell(command)) {
					return {
						action: "approve",
						reason:
							"auto mode: command invokes a pwsh/powershell/cmd interpreter, which the bash-shaped danger filter has no coverage for; requires approval, same as the powershell tool",
					};
				}
				if (commandDenyScanTruncated(command)) {
					return {
						action: "approve",
						reason:
							"auto mode: command has more chained/wrapped pieces than the deny scan can fully cover, requires approval",
					};
				}
				if (commandFeedsBareShellWithoutDashC(command)) {
					return {
						action: "approve",
						reason:
							"auto mode: command feeds a bare shell interpreter via pipe/here-string/heredoc with no -c, which the deny scan can't fully vet; requires approval",
					};
				}
				return { action: "allow", reason: "auto mode: no rule matched and command passed the danger filter" };
			}
			return { action: "approve", reason: "no rule matched; bash commands require approval by default" };
		}

		if (toolName === "powershell") {
			// Unlike bash, powershell has no danger filter tuned for its own
			// syntax (DANGEROUS_COMMAND_PATTERNS is bash-shaped), so auto mode
			// cannot safely auto-allow it — every unmatched powershell call
			// requires approval in default and auto mode (yolo's applyMode still
			// turns this approve into allow, as for every tool).
			return { action: "approve", reason: "no rule matched; powershell commands always require approval" };
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

		if (READ_ONLY_PATH_TOOLS.has(toolName)) {
			// Unlike read/write/edit, these tools treat a missing `path` as the
			// cwd, so an absent path arg is within the project by definition.
			const filePath = getPathArg(args) ?? ".";
			if (isWithinProject(filePath, this.cwd)) {
				return { action: "allow", reason: "no rule matched; read-only tool allowed by default within the project" };
			}
			return {
				action: "approve",
				reason: "no rule matched; path is outside the project, requires approval",
			};
		}

		return { action: "approve", reason: `no rule matched for tool "${toolName}"; defaults to approve` };
	}
}
