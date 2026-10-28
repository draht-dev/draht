"use strict";

// A guard for literal shell commands, not a sandbox or a shell interpreter.
// Keep this dependency-free so native and plugin hosts use the same policy.
const path = require("node:path");

function shellCommands(source, depth = 0) {
	if (depth > 8 || source.length > 262144) return [];
	const commands = [];
	let words = [];
	let word = "";
	let started = false;
	let quote = "";
	const flushWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	const flushCommand = () => {
		flushWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quote === "'") {
			if (ch === "'") quote = "";
			else word += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < source.length) {
			const next = source[++i];
			if (next !== "\n") {
				word += quote === '"' && !['$', '`', '"', "\\"].includes(next) ? `\\${next}` : next;
				started = true;
			}
			continue;
		}
		if (ch === "`" || (ch === "$" && source[i + 1] === "(")) {
			const start = i + (ch === "`" ? 1 : 2);
			let end = start;
			let nesting = 1;
			let innerQuote = "";
			for (; end < source.length; end++) {
				const inner = source[end];
				if (inner === "\\" && innerQuote !== "'") { end++; continue; }
				if (innerQuote) { if (inner === innerQuote) innerQuote = ""; continue; }
				if (inner === "'" || inner === '"') { innerQuote = inner; continue; }
				if (ch === "`" && inner === "`") break;
				if (ch === "$" && inner === "(") nesting++;
				if (ch === "$" && inner === ")" && --nesting === 0) break;
			}
			commands.push(...shellCommands(source.slice(start, end), depth + 1));
			word += "<substitution>";
			started = true;
			i = end;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = "";
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
		if (ch === "#" && !started) {
			while (i < source.length && source[i] !== "\n") i++;
			flushCommand();
			continue;
		}
		if (/[;&|()\n]/.test(ch)) { flushCommand(); continue; }
		if (/\s/.test(ch)) { flushWord(); continue; }
		word += ch;
		started = true;
	}
	flushCommand();
	return commands;
}

function executable(word) {
	return path.posix.basename(word.replace(/\\/g, "/")).replace(/\.exe$/i, "");
}

function canonicalFlag(word) {
	const equals = word.indexOf("=");
	const option = equals < 0 ? word : word.slice(0, equals);
	// Git accepts unambiguous long-option prefixes, including hook bypasses.
	const guarded = ["--no-verify", "--force", "--force-with-lease", "--force-if-includes"];
	const full = guarded.find((flag) => option.startsWith("--") && option.length > 2 && flag.startsWith(option));
	return full ? full + (equals < 0 ? "" : word.slice(equals)) : word;
}

function gitArguments(words, subcommand) {
	const flags = [];
	const positional = [];
	const takesValue = new Set([
		"--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author", "--date",
		"--cleanup", "--fixup", "--squash", "--pathspec-from-file", "--push-option", "--receive-pack", "--exec", "--repo",
	]);
	const shortValues = subcommand === "push" ? "o" : "mFCct";
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === "--") { positional.push(...words.slice(i + 1)); break; }
		if (word.startsWith("--")) {
			flags.push(canonicalFlag(word));
			if (takesValue.has(word)) i++;
		} else if (word.startsWith("-")) {
			for (let j = 1; j < word.length; j++) {
				if (shortValues.includes(word[j])) { if (j === word.length - 1) i++; break; }
				flags.push(`-${word[j]}`);
			}
		} else positional.push(word);
	}
	return { flags, positional };
}

function inspectWords(original, depth) {
	const words = [...original];
	let bypassHooks = false;
	while (words.length) {
		if (["if", "then", "elif", "else", "while", "until", "do", "!"].includes(words[0])) {
			words.shift();
			continue;
		}
		if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0])) {
			if (words[0] === "HUSKY=0") bypassHooks = true;
			words.shift();
			continue;
		}
		const head = executable(words[0]);
		if (["command", "builtin", "exec", "nohup"].includes(head)) {
			words.shift();
			if (words[0] === "--") words.shift();
			continue;
		}
		if (head === "env") {
			words.shift();
			while (words[0]?.startsWith("-")) {
				const flag = words.shift();
				if (["-u", "--unset", "-C", "--chdir"].includes(flag)) words.shift();
			}
			continue;
		}
		if (head === "sudo") {
			words.shift();
			while (words[0]?.startsWith("-")) {
				if (["-u", "-g", "-h", "-p"].includes(words.shift())) words.shift();
			}
			continue;
		}
		break;
	}
	if (!words.length) return undefined;
	const head = executable(words.shift());
	if (["sh", "bash", "zsh", "dash", "ksh"].includes(head)) {
		const commandFlag = words.findIndex((word) => /^-[^-]*c/.test(word));
		return commandFlag >= 0 ? findGitSafetyViolation(words[commandFlag + 1] ?? "", depth + 1) : undefined;
	}
	if (head !== "git") return undefined;
	while (words[0]?.startsWith("-")) {
		const option = words.shift();
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) {
			const value = words.shift() ?? "";
			if ((option === "-c" || option === "--config-env") && /^core\.hooksPath=/i.test(value)) bypassHooks = true;
		} else if (/^-ccore\.hooksPath=|^--config-env=core\.hooksPath=/i.test(option)) bypassHooks = true;
	}
	const subcommand = words.shift();
	if (!["commit", "push", "merge", "rebase", "am"].includes(subcommand)) return undefined;
	const { flags, positional } = gitArguments(words, subcommand);
	if (bypassHooks || flags.includes("--no-verify") || (subcommand === "commit" && flags.includes("-n"))) {
		return "Git hook bypass is disabled. Run the required checks and keep commit/push hooks enabled.";
	}
	if (subcommand !== "push") return undefined;
	if (positional.some((word) => word.startsWith("+"))) return "Forced Git refspecs are disabled. Use a normal push.";
	for (const word of flags) {
		if (word === "--force" || word === "--force-if-includes" || word === "-f") {
			return "Forced Git updates are disabled. Reconcile the branch and use a normal push.";
		}
		if (word.startsWith("--force-with-lease")) {
			// A named ref with an empty expectation creates only an absent ref;
			// the saga lock uses this compare-and-set operation without rewriting history.
			if (!/^--force-with-lease=refs\/[A-Za-z0-9_./-]+:$/.test(word)) {
				return "Forced Git updates are disabled. Only an explicit create-if-absent ref lease is allowed.";
			}
		}
	}
	return undefined;
}

function findGitSafetyViolation(command, depth = 0) {
	if (typeof command !== "string" || depth > 8) return undefined;
	for (const words of shellCommands(command, depth)) {
		const violation = inspectWords(words, depth);
		if (violation) return violation;
	}
	return undefined;
}

module.exports = { findGitSafetyViolation };
