import { isDeepStrictEqual } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const textOutput = (event) => (event.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

function terminalStatus(entry, finalText, requiredCheckFailed) {
	const pattern = entry.outputContract === "triage"
		? /^\[triage:(bug|performance|other)\]\s*$/gm
		: /^STATUS:\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\s*$/gm;
	const matches = [...finalText.matchAll(pattern)];
	const opposing = entry.outputContract === "triage" ? /^STATUS:/m.test(finalText) : /^\[triage:/m.test(finalText);
	const markerCount = finalText.split(/\r?\n/).filter((line) => entry.outputContract === "triage" ? line.startsWith("[triage:") : line.startsWith("STATUS:")).length;
	const valid = !opposing && markerCount === 1 && matches.length === 1 && finalText.trimEnd().endsWith(matches[0][0].trimEnd());
	const status = valid ? (entry.outputContract === "triage" ? `triage:${matches[0][1]}` : matches[0][1]) : null;
	const expected = requiredCheckFailed && entry.outputContract !== "triage" ? ["BLOCKED"] : entry.expectedStatuses;
	return { status, statusSyntaxPassed: valid, statusSemanticPassed: expected.includes(status) };
}

function structuredResponse(entry, finalText) {
	if (!entry.responseContract) return { responseFormatPassed: true, findingsPassed: null, reasons: [] };
	const lines = finalText.split(/\r?\n/).filter((line) => line.startsWith("RESULT:"));
	let response;
	try { if (lines.length === 1) response = JSON.parse(lines[0].slice(7).trim()); } catch {}
	const valid = object(response) && typeof response.verdict === "string" && object(response.facts) &&
		Array.isArray(response.findings) && response.findings.every((finding) => object(finding) &&
			typeof finding.file === "string" && Number.isSafeInteger(finding.line) && finding.line > 0);
	if (!valid) return { responseFormatPassed: false, findingsPassed: false, reasons: ["Missing or malformed RESULT record"] };
	const expected = entry.responseContract;
	// A nearby valid source citation is not a semantic failure. The exact faulty
	// expression and explanation remain part of blinded review.
	const locationsValid = response.findings.every(({ file, line }) => typeof entry.files[file] === "string" &&
		Boolean(entry.files[file].split(/\r?\n/)[line - 1]?.trim()));
	const actualFiles = response.findings.map(({ file }) => file).sort();
	const expectedFiles = expected.findings.map(({ file }) => file).sort();
	const factsMatch = Object.keys(response.facts).length === Object.keys(expected.facts).length &&
		Object.entries(expected.facts).every(([key, value]) => isDeepStrictEqual(response.facts[key], value));
	const passed = response.verdict === expected.verdict && factsMatch && locationsValid && isDeepStrictEqual(actualFiles, expectedFiles);
	return { responseFormatPassed: true, findingsPassed: passed,
		reasons: passed ? [] : ["Structured verdict, source locations, or observable facts differ from the fixture oracle"] };
}

function outputMatches(requirement, output) {
	if (requirement.outputLine !== undefined && !output.split(/\r?\n/).includes(requirement.outputLine)) return false;
	if (requirement.outputJson !== undefined) {
		return output.split(/\r?\n/).some((line) => {
			try { return isDeepStrictEqual(JSON.parse(line), requirement.outputJson); } catch { return false; }
		});
	}
	return true;
}

function literalShell(command) {
	// Parse only literal words and sequence separators. Never expand input or
	// execute a shell to decide whether it counts as verification.
	if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(command)) return null;
	const tokens = [];
	let word = "", active = false, quote = null;
	const flush = () => { if (active) tokens.push({ word }); word = ""; active = false; };
	for (let index = 0; index < command.length; index++) {
		const char = command[index], next = command[index + 1];
		if (quote === "'") {
			if (char === "'") quote = null; else word += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "$" || char === "`") return null;
			else if (char === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
				if (next !== "\n") word += next;
				index++;
			} else word += char;
			continue;
		}
		if (char === "\\") {
			if (next === undefined) return null;
			if (next !== "\n") { word += next; active = true; }
			index++;
		} else if (char === "'" || char === '"') {
			quote = char; active = true;
		} else if (char === " " || char === "\t") flush();
		else if (char === ";" || char === "\n" || (char === "&" && next === "&")) {
			flush();
			tokens.push(char === "&" ? "&&" : char);
			if (char === "&") index++;
		} else if (/[|&<>()$`*?[\]{}~#]/.test(char)) return null;
		else { word += char; active = true; }
	}
	if (quote !== null) return null;
	flush();
	const commands = [[]], separators = [];
	for (const token of tokens) {
		if (typeof token === "object") commands.at(-1).push(token.word);
		else {
			if (!commands.at(-1).length) return null;
			separators.push(token);
			commands.push([]);
		}
	}
	return commands.at(-1).length ? { commands, separators } : null;
}

function literalPath(path, workspace) {
	// Resolving "link/.." lexically could identify a different file than the
	// shell. Such paths need filesystem evidence, not string normalization.
	if (!path || path.split("/").includes("..")) return null;
	return resolve(workspace, path);
}

function matchingRequirements(shell, requirements, workspace) {
	if (!shell) return [];
	let argv = shell.commands[0];
	if (shell.commands.length === 2) {
		const cd = argv[0] === "cd" && (argv.length === 2 ? argv[1] : argv.length === 3 && argv[1] === "--" ? argv[2] : null);
		if (!cd || shell.separators[0] !== "&&" || literalPath(cd, workspace) !== resolve(workspace)) return [];
		argv = shell.commands[1];
	} else if (shell.commands.length !== 1) return [];
	return requirements.filter((requirement) => {
		const expected = literalShell(requirement.command);
		if (!expected || expected.commands.length !== 1) return false;
		const words = expected.commands[0];
		if (argv.length !== words.length || argv[0] !== words[0]) return false;
		if (words[0] === "node" && words.length === 2 && !words[1].startsWith("-")) {
			return !argv[1].startsWith("-") && literalPath(argv[1], workspace) === literalPath(words[1], workspace);
		}
		return words.every((word, index) => word === argv[index]);
	}).map((requirement) => requirement.id);
}

function knownReadOnlyShell(shell) {
	// These programs have no execution/write options. Literal-only sequences
	// can be classified without inferring the exit of an intermediate command.
	return shell?.commands.every(([program, ...args]) => ["pwd", "ls", "cat", "head", "tail", "wc", "nl"].includes(program) &&
		args.every((arg) => /^[A-Za-z0-9_./:@=+, -]+$/.test(arg))) ?? false;
}

/** Interpret observable native events; never treat reported commands as execution. */
function executionEvidence(entry, { stdout, format, workspace }) {
	const matched = [], missing = [], denied = [], unverifiable = [], traceScopeViolations = [];
	const requirements = entry.evidenceRequirements;
	if (format !== "draht-jsonl") return { evidencePassed: requirements.length ? null : true,
		evidence: { matched, missing, denied, unverifiable: ["Runner exposes no native tool-execution evidence"] }, traceScopeViolations, requiredCheckFailed: false };
	const starts = new Map(), seen = new Set(), calls = [];
	let lastEdit = -1;
	try {
		for (const [index, line] of stdout.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			const event = JSON.parse(line);
			if (!object(event) || typeof event.type !== "string") throw new Error("Malformed event");
			if (event.type === "tool_execution_start") {
				if (typeof event.toolCallId !== "string" || seen.has(event.toolCallId)) throw new Error("Missing or duplicate tool call ID");
				seen.add(event.toolCallId);
				starts.set(event.toolCallId, { ...event, index });
			}
			if (event.type !== "tool_execution_end") continue;
			const start = starts.get(event.toolCallId);
			if (!start || start.toolName !== event.toolName) throw new Error("Tool completion lacks a matching start");
			if (typeof event.isError !== "boolean") throw new Error("Tool completion lacks an outcome");
			starts.delete(event.toolCallId);
			const output = textOutput(event), args = start.args;
			const exitCode = event.result?.structuredContent?.exit_code;
			// An observed process exit is execution evidence even when assertion
			// text happens to contain approval-related wording.
			const isDenied = event.isError === true && (exitCode === undefined || exitCode === null) &&
				/requires approval|no UI available to request approval|denied by.*rule/i.test(output);
			if (isDenied) { denied.push({ toolCallId: event.toolCallId, tool: event.toolName }); continue; }
			const command = typeof args?.command === "string" ? args.command.trim() : null;
			// Native bash receives its cwd from the runner, not from model args.
			// Unexpected directory fields cannot establish another execution cwd.
			const shell = command && !Object.hasOwn(args, "cwd") && !Object.hasOwn(args, "workdir") ? literalShell(command) : null;
			const requirementIds = matchingRequirements(shell, requirements, workspace);
			calls.push({ startIndex: start.index, endIndex: index, toolCallId: event.toolCallId, tool: event.toolName, requirementIds, exitCode, output, isError: event.isError });
			if (["write", "edit"].includes(event.toolName) && event.isError === false) {
				lastEdit = index;
				if (typeof args?.path !== "string") { unverifiable.push(`Write path unavailable: ${event.toolCallId}`); continue; }
				if (/^(?:@|~|file:)|[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(args.path)) {
					unverifiable.push(`Native path alias requires normalized trace audit: ${event.toolCallId}`);
					continue;
				}
				const path = relative(resolve(workspace), isAbsolute(args.path) ? args.path : resolve(workspace, args.path));
				if (![...entry.writable, ...entry.allowedNewFiles].includes(path)) traceScopeViolations.push(`${event.toolCallId}: wrote ${args.path}`);
			}
			if (["write", "edit"].includes(event.toolName) && event.isError) {
				unverifiable.push(`Failed write may have partial effects: ${event.toolCallId}`);
			}
			if (event.toolName === "bash" && (!requirementIds.length && !knownReadOnlyShell(shell))) {
				unverifiable.push(`Unrecognized shell effects require trace audit: ${event.toolCallId}`);
			}
			if (!["read", "ls", "grep", "find", "bash", "write", "edit"].includes(event.toolName)) {
				unverifiable.push(`Unrecognized tool effects require trace audit: ${event.toolCallId}`);
			}
		}
		if (starts.size) throw new Error("Incomplete tool executions");
	} catch (error) {
		unverifiable.push(`Invalid native trace: ${error.message}`);
		return { evidencePassed: null, evidence: { matched, missing, denied, unverifiable }, traceScopeViolations, requiredCheckFailed: false };
	}
	let requiredCheckFailed = false;
	for (const requirement of requirements) {
		const attempts = calls.filter((candidate) => candidate.tool === "bash" && candidate.requirementIds.includes(requirement.id));
		// Calls are collected in completion order. An earlier passing attempt must
		// not conceal a later failure or an invocation with missing evidence.
		const latest = attempts.at(-1);
		const fresh = latest && (!requirement.afterEdits || latest.startIndex > lastEdit);
		const successful = fresh && latest.exitCode === 0 && latest.isError === false && outputMatches(requirement, latest.output);
		if (attempts.some((attempt) => Number.isInteger(attempt.exitCode) && attempt.exitCode !== 0 &&
			(!successful || latest.startIndex <= attempt.endIndex))) requiredCheckFailed = true;
		if (latest && attempts.some((attempt) => attempt !== latest && attempt.endIndex >= latest.startIndex)) {
			unverifiable.push(`Overlapping required-check attempts require trace audit: ${requirement.id}`);
		}
		if (fresh && latest.exitCode === requirement.exitCode && (requirement.exitCode !== 0 || latest.isError === false) &&
			outputMatches(requirement, latest.output)) matched.push({ id: requirement.id, toolCallId: latest.toolCallId });
		else missing.push(requirement.id);
	}
	return { evidencePassed: missing.length ? false : unverifiable.length ? null : true,
		evidence: { matched, missing, denied, unverifiable }, traceScopeViolations, requiredCheckFailed };
}

export function gradeResponse(entry, input) {
	const structured = structuredResponse(entry, input.finalText);
	const { requiredCheckFailed, ...execution } = executionEvidence(entry, input);
	const auditReasons = [...structured.reasons, ...execution.evidence.unverifiable];
	if (entry.responseContract) auditReasons.push("Natural-language reasoning and any additional claims require blinded semantic audit");
	return { ...terminalStatus(entry, input.finalText, requiredCheckFailed), responseFormatPassed: structured.responseFormatPassed,
		findingsPassed: structured.findingsPassed, ...execution, auditEligible: Boolean(entry.responseContract) || auditReasons.length > 0,
		auditReasons };
}
