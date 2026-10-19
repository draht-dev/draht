import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gradeBank, HOSTS, prepareBank, runBank } from "./bank.mjs";
import { CASES } from "./cases.mjs";

const HELP = `Drahtbank — compare Draht prompt snapshots on deterministic fixtures

  drahtbank list [--json]
  drahtbank prepare <directory> [--baseline <ref>] [--candidate <ref>]
      [--repo <path>] [--hosts coding-agent,draht-claude,draht-codex]
      [--cases <comma-separated IDs>] [--repeats <1-100>] [--prompt <repo-relative path>]
  drahtbank run <directory> --adapter <config.json> [--json]
  drahtbank grade <directory> [--json]
  drahtbank report <directory> [--json]

Defaults: baseline HEAD, candidate current worktree, coding-agent, all cases, one repetition.
Each trial starts a fresh runner process. Run uses the model configured in the adapter.
Preparation, grading, reporting, and fixture tests make no model API calls.
Reports preserve unknown telemetry as null. A failed case makes run/grade exit 1.
`;

function parse(args, permitted) {
	const values = {}, positional = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg.startsWith("--")) { positional.push(arg); continue; }
		const key = arg.slice(2);
		if (!permitted.includes(key)) throw new Error(`Unknown option: ${arg}`);
		if (Object.hasOwn(values, key)) throw new Error(`Repeated option: ${arg}`);
		if (key === "json") values[key] = true;
		else {
			if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
			values[key] = args[++index];
		}
	}
	return { values, positional };
}

function displayReport(report, asJson) {
	if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }
	for (const variant of ["baseline", "candidate"]) {
		const row = report.summary.variants[variant];
		console.log(`${variant}: ${row.passed}/${row.total} passed; ${row.promptBytes} prompt bytes across trials`);
		for (const name of ["elapsedMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "toolCalls"]) {
			const metric = row.metrics[name];
			console.log(`  ${name}: ${metric.observed ? `median ${metric.median}, total ${metric.total}, observed ${metric.observed}/${row.total}` : "unknown"}`);
		}
	}
	const paired = report.summary.paired;
	console.log(`Pairs: ${paired.bothPassed}/${paired.total} both passed; ${paired.regressions.length} regressions; ${paired.improvements.length} improvements`);
	if (!report.summary.comparableRunner) console.log("Runner identity is missing or differs; this is not a controlled prompt comparison.");
	for (const row of report.results.filter((result) => !result.passed)) {
		const reasons = [!row.executionPassed && "execution", !row.acceptancePassed && "acceptance", !row.statusPassed && "status", !row.scopePassed && "scope"].filter(Boolean);
		console.log(`  FAIL ${row.id}: ${reasons.join(", ")}${row.failure ? ` (${row.failure})` : ""}`);
	}
	console.log("UTF-8 prompt bytes are not tokens. Fixture results do not establish general model quality or a speed improvement.");
}

export async function main(args = process.argv.slice(2)) {
	try {
		const [command, ...rest] = args;
		if (!command || ["help", "--help", "-h"].includes(command)) { console.log(HELP); return 0; }
		const options = {
			list: ["json"], prepare: ["baseline", "candidate", "repo", "hosts", "cases", "repeats", "prompt", "json"],
			run: ["adapter", "json"], grade: ["json"], report: ["json"],
		}[command];
		if (!options) throw new Error(`Unknown command: ${command}`);
		const { values, positional } = parse(rest, options);
		if (command === "list") {
			if (positional.length) throw new Error("list takes no directory argument");
			const cases = CASES.map(({ id, role, rubric }) => ({ id, role, rubric }));
			if (values.json) console.log(JSON.stringify({ hosts: HOSTS, cases }, null, 2));
			else for (const entry of cases) console.log(`${entry.id} (${entry.role}): ${entry.rubric}`);
			return 0;
		}
		if (positional.length !== 1) throw new Error(`${command} requires exactly one directory`);
		const directory = resolve(positional[0]);
		if (command === "prepare") {
			const manifest = prepareBank(directory, { root: values.repo, baseline: values.baseline, candidate: values.candidate,
				hosts: values.hosts?.split(","), cases: values.cases?.split(","), repeats: values.repeats === undefined ? undefined : Number(values.repeats), prompt: values.prompt });
			console.log(values.json ? JSON.stringify(manifest, null, 2) : `Prepared ${manifest.trials.length} trials in ${directory}\nBaseline: ${manifest.baselineCommit}\nCandidate: ${manifest.candidateCommit ?? "worktree snapshot"}`);
			return 0;
		}
		let report;
		if (command === "run") {
			if (!values.adapter) throw new Error("run requires --adapter <config.json>");
			const adapter = JSON.parse(readFileSync(resolve(values.adapter), "utf8"));
			report = await runBank(directory, adapter, ({ index, total, trial }) => console.error(`[${index}/${total}] ${trial.id}`));
		} else if (command === "grade") report = await gradeBank(directory);
		else report = JSON.parse(readFileSync(resolve(directory, "report.json"), "utf8"));
		displayReport(report, values.json);
		return command !== "report" && report.results.some((result) => !result.passed) ? 1 : 0;
	} catch (error) {
		console.error(`drahtbank: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
