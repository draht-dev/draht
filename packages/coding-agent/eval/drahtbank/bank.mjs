import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { buildInvocation, parseOutput } from "./adapters.mjs";
import { CASES, SUITE_VERSION } from "./cases.mjs";

export const HOSTS = ["coding-agent", "draht-claude", "draht-codex"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const suiteHash = () => hash(JSON.stringify({ version: SUITE_VERSION, cases: CASES }));
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => { throw new Error(message); };
const caseById = (id) => CASES.find((entry) => entry.id === id) ?? fail(`Unknown case: ${id}`);
const relativePath = (value) => typeof value === "string" && value.length > 0 && !value.includes("\\") &&
	!value.startsWith("/") && !value.split("/").some((part) => !part || part === "." || part === "..");
const GIT_REPOSITORY_VARIABLES = new Set([
	"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
	"GIT_NAMESPACE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_INTERNAL_SUPER_PREFIX",
	"GIT_SUPER_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
]);

function fixtureEnvironment(cwd, overrides) {
	const env = { ...process.env, ...overrides };
	for (const key of Object.keys(env)) {
		const name = key.toUpperCase();
		if (GIT_REPOSITORY_VARIABLES.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete env[key];
	}
	let physicalDirectory;
	try { physicalDirectory = realpathSync(cwd); } catch { physicalDirectory = resolve(cwd); }
	// Git ignores a ceiling equal to its initial cwd; stop before entering its parent.
	const ceilingDirectory = dirname(physicalDirectory);
	if (ceilingDirectory.includes(delimiter)) fail("Fixture path contains the Git ceiling path-list delimiter");
	env.GIT_CEILING_DIRECTORIES = ceilingDirectory;
	return { env, gitEnvironment: { policy: "fixture-ceiling-v1", ceilingDirectory } };
}

function matrix(hosts, caseIds, repeats) {
	const trials = [];
	for (let repetition = 1; repetition <= repeats; repetition++) {
		for (const host of hosts) {
			for (const [index, caseId] of caseIds.entries()) {
				const variants = (repetition + index) % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"];
				for (const variant of variants) trials.push({
					id: `${String(repetition).padStart(3, "0")}-${host}-${caseId}-${variant}`,
					host, caseId, repetition, variant,
				});
			}
		}
	}
	return trials;
}

function paths(output, trial) {
	const control = join(output, "control", trial.id);
	return { control, workspace: join(output, "workspaces", trial.id),
		promptFile: join(control, "prompt.md"), taskFile: join(control, "task.md") };
}

function validateSelection(hosts, caseIds, repeats) {
	if (!Array.isArray(hosts) || !hosts.length || hosts.some((host) => !HOSTS.includes(host)) || new Set(hosts).size !== hosts.length) fail("Choose unique known hosts");
	if (!Array.isArray(caseIds) || !caseIds.length || new Set(caseIds).size !== caseIds.length) fail("Choose unique cases");
	for (const id of caseIds) caseById(id);
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) fail("repeats must be an integer from 1 to 100");
}

export function prepareBank(output, options = {}) {
	output = resolve(output);
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: options.root ?? process.cwd(), encoding: "utf8" }).trim();
	const hosts = options.hosts ?? ["coding-agent"];
	const caseIds = options.cases ?? CASES.map(({ id }) => id);
	const repeats = options.repeats ?? 1;
	validateSelection(hosts, caseIds, repeats);
	if (options.prompt && !relativePath(options.prompt)) fail("prompt must be a repository-relative path without parent segments");
	if (existsSync(output) && readdirSync(output).length) fail("Choose an empty output directory; existing benchmark work will not be overwritten");
	const revision = (ref) => execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
	const baselineCommit = revision(options.baseline ?? "HEAD");
	const candidateCommit = options.candidate ? revision(options.candidate) : null;
	const trials = matrix(hosts, caseIds, repeats).map((trial) => {
		const promptPath = options.prompt ?? `packages/${trial.host}/agents/${caseById(trial.caseId).role}.md`;
		const commit = trial.variant === "baseline" ? baselineCommit : candidateCommit;
		const prompt = commit ? execFileSync("git", ["show", `${commit}:${promptPath}`], { cwd: root, encoding: "utf8" }) : readFileSync(join(root, promptPath), "utf8");
		return { ...trial, promptPath, promptSha256: hash(prompt), promptBytes: Buffer.byteLength(prompt), prompt };
	});
	mkdirSync(output, { recursive: true });
	for (const trial of trials) {
		const locations = paths(output, trial);
		mkdirSync(locations.control, { recursive: true });
		mkdirSync(locations.workspace, { recursive: true });
		const entry = caseById(trial.caseId);
		for (const [name, contents] of Object.entries(entry.files)) {
			if (!relativePath(name)) fail(`Unsafe fixture path: ${name}`);
			const file = join(locations.workspace, name);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}
		const task = `Work in ${locations.workspace}. This is an isolated Drahtbank fixture. Do not use the network, delegate, commit, or modify files outside this workspace.\nAllowed edits: ${entry.writable.join(", ") || "none (read-only)"}. Allowed new files: ${entry.allowedNewFiles.join(", ") || "none"}. Preserve all other files.\nEnd your response with exactly one status line using the appropriate outcome: STATUS: DONE, STATUS: DONE_WITH_CONCERNS, STATUS: NEEDS_CONTEXT, or STATUS: BLOCKED.\n\n${entry.task}\n`;
		writeFileSync(locations.promptFile, trial.prompt);
		writeFileSync(locations.taskFile, task);
		trial.taskSha256 = hash(task);
		trial.initialWorkspaceSha256 = workspaceDigest(locations.workspace);
		delete trial.prompt;
	}
	const manifest = { schemaVersion: 1, suiteVersion: SUITE_VERSION, suiteSha256: suiteHash(), createdAt: new Date().toISOString(),
		root, baselineCommit, candidateCommit, hosts, caseIds, repeats, trials };
	json(join(output, "manifest.json"), manifest);
	return manifest;
}

export function readManifest(output) {
	const manifest = readJson(join(output, "manifest.json"));
	if (manifest.schemaVersion !== 1 || manifest.suiteSha256 !== suiteHash()) fail("Unsupported or changed benchmark suite; prepare a fresh bank with this version");
	validateSelection(manifest.hosts, manifest.caseIds, manifest.repeats);
	const expected = matrix(manifest.hosts, manifest.caseIds, manifest.repeats);
	if (!Array.isArray(manifest.trials) || manifest.trials.length !== expected.length) fail("Incomplete benchmark matrix");
	for (const [index, trial] of manifest.trials.entries()) {
		for (const key of ["id", "host", "caseId", "repetition", "variant"]) if (trial[key] !== expected[index][key]) fail("Invalid benchmark matrix");
		for (const key of ["promptSha256", "taskSha256", "initialWorkspaceSha256"]) if (!/^[a-f0-9]{64}$/.test(trial[key])) fail(`Invalid ${key}`);
		if (!relativePath(trial.promptPath) || !Number.isSafeInteger(trial.promptBytes) || trial.promptBytes < 1) fail("Invalid prompt metadata");
	}
	return manifest;
}

export function validateAdapter(config) {
	if (!config || !["json", "draht-jsonl"].includes(config.format)) fail("Adapter format must be json or draht-jsonl");
	for (const key of Object.keys(config)) if (!["format", "command", "provider", "model", "settings", "timeoutMs"].includes(key)) fail(`Unknown adapter configuration field: ${key}`);
	if (!Array.isArray(config.command) || !config.command.length || config.command.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0"))) fail("Adapter command must be a nonempty argv array");
	for (const key of ["provider", "model"]) if (typeof config[key] !== "string" || !config[key].trim()) fail(`Adapter ${key} is required`);
	if (config.settings !== undefined && (!config.settings || typeof config.settings !== "object" || Array.isArray(config.settings) || Object.values(config.settings).some((value) => !["string", "boolean", "number"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))))) fail("Adapter settings must contain primitive values");
	const timeoutMs = config.timeoutMs ?? 300_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) fail("Adapter timeoutMs must be from 1 to 3600000");
	return { ...config, settings: config.settings ?? {}, timeoutMs };
}

export function runProcess(command, options) {
	return new Promise((finish) => {
		const started = performance.now();
		let stdout = "", stderr = "", error = null, timedOut = false, bytes = 0, settled = false;
		const { env, gitEnvironment } = fixtureEnvironment(options.cwd, options.env);
		const child = spawn(command[0], command.slice(1), { cwd: options.cwd, env,
			stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", shell: false });
		const kill = () => {
			try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
		};
		const settle = (exitCode, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			finish({ exitCode, signal, error, timedOut, elapsedMs: Math.round(performance.now() - started), stdout, stderr, gitEnvironment });
		};
		const stop = () => {
			kill();
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			settle(null, "SIGKILL");
		};
		const timer = setTimeout(() => { timedOut = true; error = "Process timed out"; stop(); }, options.timeoutMs);
		for (const [stream, key] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				if (settled) return;
				bytes += Buffer.byteLength(chunk);
				if (bytes > 10 * 1024 * 1024) { error = "Process output exceeded 10 MiB"; stop(); return; }
				if (key === "stdout") stdout += chunk; else stderr += chunk;
			});
		}
		child.on("error", (cause) => { error = cause.message; });
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin ?? "");
		child.on("close", settle);
	});
}

function controlMatches(output, trial, manifestHash) {
	const locations = paths(output, trial);
	try {
		return hash(readFileSync(join(output, "manifest.json"))) === manifestHash &&
			hash(readFileSync(locations.promptFile)) === trial.promptSha256 &&
			hash(readFileSync(locations.taskFile)) === trial.taskSha256;
	} catch { return false; }
}

export async function runBank(output, config, onProgress = () => {}) {
	output = resolve(output);
	const manifest = readManifest(output);
	const adapter = validateAdapter(config);
	const manifestHash = hash(readFileSync(join(output, "manifest.json")));
	for (const trial of manifest.trials) {
		if (existsSync(join(paths(output, trial).control, "execution.json"))) fail("This bank has execution records; prepare a fresh bank rather than overwriting trials");
		if (!controlMatches(output, trial, manifestHash)) fail(`Changed control artifacts: ${trial.id}`);
		assertFreshWorkspace(output, trial);
	}
	// Validate adapter arguments before starting any run.
	const first = paths(output, manifest.trials[0]);
	buildInvocation(adapter, { ...first, prompt: readFileSync(first.promptFile, "utf8"), task: readFileSync(first.taskFile, "utf8") });
	for (const [index, trial] of manifest.trials.entries()) {
		const locations = paths(output, trial);
		onProgress({ index: index + 1, total: manifest.trials.length, trial });
		if (!controlMatches(output, trial, manifestHash)) fail(`Changed control artifacts: ${trial.id}`);
		assertFreshWorkspace(output, trial);
		const invocation = buildInvocation(adapter, { ...locations, prompt: readFileSync(locations.promptFile, "utf8"), task: readFileSync(locations.taskFile, "utf8") });
		json(join(locations.control, "execution.json"), { state: "running", adapter, manifestSha256: manifestHash });
		const processResult = await runProcess(invocation.command, { cwd: locations.workspace, timeoutMs: adapter.timeoutMs, stdin: invocation.stdin });
		writeFileSync(join(locations.control, "stdout.txt"), processResult.stdout);
		writeFileSync(join(locations.control, "stderr.txt"), processResult.stderr);
		let response;
		try { response = parseOutput(adapter.format, processResult.stdout); }
		catch (cause) { response = { finalText: "", usage: null, toolCalls: null, telemetrySource: adapter.format === "json" ? "adapter-reported" : "draht-events", error: cause.message }; }
		let workspaceSha256 = null, workspaceSnapshotError = null;
		try { workspaceSha256 = workspaceDigest(locations.workspace); } catch (cause) { workspaceSnapshotError = cause.message; }
		const { stdout: _stdout, stderr: _stderr, ...processEvidence } = processResult;
		json(join(locations.control, "execution.json"), { state: "finished", adapter, manifestSha256: manifestHash,
			command: invocation.command, process: processEvidence, response,
			workspaceSha256, workspaceSnapshotError, stdoutSha256: hash(processResult.stdout), stderrSha256: hash(processResult.stderr),
			controlIntact: controlMatches(output, trial, manifestHash) });
	}
	return gradeBank(output);
}

function scanWorkspace(workspace) {
	const actual = new Map();
	const modes = new Map();
	const violations = [];
	let bytes = 0, visited = 0;
	const rootStat = lstatSync(workspace);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("Workspace must be a regular directory");
	const walk = (dir, prefix = "", depth = 0) => {
		if (depth > 20) fail("Fixture exceeds grading depth limit");
		for (const name of readdirSync(dir)) {
			if (++visited > 1000) fail("Fixture exceeds grading file limit");
			const file = join(dir, name), relative = `${prefix}${name}`, stat = lstatSync(file);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { violations.push(`Unsupported file type: ${relative}`); continue; }
			if (stat.isDirectory()) { walk(file, `${relative}/`, depth + 1); continue; }
			bytes += stat.size;
			if (bytes > 20 * 1024 * 1024 || actual.size >= 1000) fail("Fixture exceeds grading size limit");
			actual.set(relative, readFileSync(file));
			modes.set(relative, stat.mode & 0o777);
		}
	};
	walk(workspace);
	return { actual, modes, violations };
}

function workspaceDigest(workspace) {
	const { actual, modes, violations } = scanWorkspace(workspace);
	if (violations.length) fail(violations.join("; "));
	return hash(JSON.stringify([...actual.keys()].sort().map((path) => [path, modes.get(path), hash(actual.get(path))])));
}

function inspectWorkspace(workspace, entry) {
	const { actual, violations } = scanWorkspace(workspace);
	for (const [name, original] of Object.entries(entry.files)) {
		if (!actual.has(name)) violations.push(`Missing original file: ${name}`);
		else if (!entry.writable.includes(name) && !actual.get(name).equals(Buffer.from(original))) violations.push(`Changed protected file: ${name}`);
	}
	for (const name of actual.keys()) if (!(name in entry.files) && !entry.allowedNewFiles.includes(name)) violations.push(`Out-of-scope file: ${name}`);
	for (const name of entry.requiredNewFiles ?? []) if (!actual.has(name)) violations.push(`Missing required file: ${name}`);
	return violations;
}

function assertFreshWorkspace(output, trial) {
	const entry = caseById(trial.caseId);
	const violations = inspectWorkspace(paths(output, trial).workspace, { ...entry, writable: [], allowedNewFiles: [], requiredNewFiles: [] });
	if (violations.length) fail(`Workspace differs from prepared fixture: ${trial.id}: ${violations.join("; ")}`);
	if (workspaceDigest(paths(output, trial).workspace) !== trial.initialWorkspaceSha256) fail(`Workspace differs from prepared fixture: ${trial.id}`);
}

async function gradeTrial(output, trial, manifestHash) {
	const locations = paths(output, trial), entry = caseById(trial.caseId);
	let execution = null;
	try { execution = readJson(join(locations.control, "execution.json")); } catch {}
	let evidenceIntact = false;
	try {
		const stdout = readFileSync(join(locations.control, "stdout.txt"), "utf8");
		evidenceIntact = hash(stdout) === execution.stdoutSha256 &&
			hash(readFileSync(join(locations.control, "stderr.txt"))) === execution.stderrSha256 &&
			JSON.stringify(parseOutput(execution.adapter.format, stdout)) === JSON.stringify(execution.response) &&
			workspaceDigest(locations.workspace) === execution.workspaceSha256;
	} catch {}
	const executionPassed = execution?.state === "finished" && execution?.process?.exitCode === 0 &&
		!execution.process.error && !execution.process.signal && !execution.process.timedOut &&
		!execution.response?.error && typeof execution.response?.finalText === "string" &&
		execution.controlIntact === true && execution.manifestSha256 === manifestHash && controlMatches(output, trial, manifestHash) && evidenceIntact;
	const finalText = typeof execution?.response?.finalText === "string" ? execution.response.finalText : "";
	const statuses = [...finalText.matchAll(/^STATUS:\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\s*$/gm)];
	const status = statuses.length === 1 && finalText.trimEnd().endsWith(statuses[0][0].trimEnd()) ? statuses[0][1] : null;
	let violations = [];
	let acceptance = null;
	let acceptancePassed = false;
	try {
		violations = inspectWorkspace(locations.workspace, entry);
		if (!violations.length) {
			const marker = `drahtbank:${randomUUID()}`;
			const source = `import assert from "node:assert/strict";\nconst finalText = ${JSON.stringify(finalText)};\n${entry.assertions}\nconsole.log(${JSON.stringify(marker)});\n`;
			acceptance = await runProcess([process.execPath, "--input-type=module", "-e", source], { cwd: locations.workspace, timeoutMs: 10_000 });
			acceptancePassed = acceptance.exitCode === 0 && !acceptance.signal && !acceptance.error && acceptance.stdout.split(/\r?\n/).includes(marker);
			// A grader must not leave protected files changed either.
			violations.push(...inspectWorkspace(locations.workspace, entry));
			if (execution?.workspaceSha256 && workspaceDigest(locations.workspace) !== execution.workspaceSha256) violations.push("Workspace changed after runner completion");
		}
	} catch (cause) { violations.push(cause.message); }
	const statusPassed = entry.expectedStatuses.includes(status);
	return { ...trial, passed: executionPassed && acceptancePassed && statusPassed && !violations.length,
		executionPassed, evidenceIntact, acceptancePassed, statusPassed, status, scopePassed: !violations.length, scopeViolations: violations,
		failure: execution?.process?.error ?? execution?.response?.error ?? (execution?.state !== "finished" ? "No completed execution" :
			execution?.process?.signal ? `Runner terminated by ${execution.process.signal}` : execution?.process?.exitCode !== 0 ? `Runner exited ${execution?.process?.exitCode}` : !evidenceIntact ? "Execution artifacts changed or incomplete" : null),
		acceptance, elapsedMs: execution?.process?.elapsedMs ?? null,
		usage: execution?.response?.usage ?? null, toolCalls: execution?.response?.toolCalls ?? null,
		telemetrySource: execution?.response?.telemetrySource ?? null, adapter: execution?.adapter ?? null };
}

const median = (values) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarize(results) {
	const variants = {};
	for (const variant of ["baseline", "candidate"]) {
		const rows = results.filter((row) => row.variant === variant);
		const metrics = {};
		for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "toolCalls", "elapsedMs"]) {
			const values = rows.map((row) => key === "toolCalls" || key === "elapsedMs" ? row[key] : row.usage?.[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
			metrics[key] = { observed: values.length, total: values.length ? values.reduce((a, b) => a + b, 0) : null, median: median(values) };
		}
		variants[variant] = { passed: rows.filter((row) => row.passed).length, total: rows.length,
			promptBytes: rows.reduce((sum, row) => sum + row.promptBytes, 0), metrics };
	}
	const pairs = results.filter((row) => row.variant === "baseline").map((baseline) => {
		const candidate = results.find((row) => row.variant === "candidate" && row.host === baseline.host && row.caseId === baseline.caseId && row.repetition === baseline.repetition);
		return { host: baseline.host, caseId: baseline.caseId, repetition: baseline.repetition,
			baselinePassed: baseline.passed, candidatePassed: candidate?.passed ?? false,
			elapsedDeltaMs: baseline.passed && candidate?.passed && typeof baseline.elapsedMs === "number" && typeof candidate.elapsedMs === "number" ? candidate.elapsedMs - baseline.elapsedMs : null };
	});
	const identities = new Set(results.filter((row) => row.adapter).map((row) => JSON.stringify(row.adapter)));
	return { variants, paired: { total: pairs.length, bothPassed: pairs.filter((pair) => pair.baselinePassed && pair.candidatePassed).length,
		regressions: pairs.filter((pair) => pair.baselinePassed && !pair.candidatePassed), improvements: pairs.filter((pair) => !pair.baselinePassed && pair.candidatePassed),
		medianElapsedDeltaMsOnPairedPasses: median(pairs.map((pair) => pair.elapsedDeltaMs).filter((value) => value !== null)) },
		comparableRunner: identities.size === 1 && results.every((row) => row.adapter),
		limits: ["Fixture scores are not general model quality; text rubrics are narrow checks, not semantic judges.",
			"Prompt bytes are UTF-8 asset sizes, not model tokens. Missing usage remains unknown.",
			"Generic adapter telemetry is adapter-reported. Elapsed time is runner-measured and includes startup.",
			"Prompt text is tested on the selected runner; this does not test installed host skill routing or hooks.",
			"This is local process isolation, not a sandbox for hostile code. Cache state and external model nondeterminism are uncontrolled."] };
}

export async function gradeBank(output) {
	output = resolve(output);
	const manifest = readManifest(output), manifestHash = hash(readFileSync(join(output, "manifest.json")));
	const results = [];
	for (const trial of manifest.trials) results.push(await gradeTrial(output, trial, manifestHash));
	const report = { schemaVersion: 1, suiteVersion: SUITE_VERSION, suiteSha256: manifest.suiteSha256,
		baselineCommit: manifest.baselineCommit, candidateCommit: manifest.candidateCommit, gradedAt: new Date().toISOString(),
		gradingEnvironment: { node: process.version, platform: process.platform, arch: process.arch },
		results, summary: summarize(results) };
	json(join(output, "report.json"), report);
	return report;
}
