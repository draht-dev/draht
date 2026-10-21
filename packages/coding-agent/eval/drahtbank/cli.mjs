import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gradeBank, HOSTS, prepareBank, runBank } from "./bank.mjs";
import { CASES } from "./cases.mjs";
import { CASES as CASES_V2 } from "./cases-v2.mjs";

const HELP = `Drahtbank — compare Draht prompt snapshots on deterministic fixtures

  drahtbank list [--suite 1|2] [--split screen|holdout|all] [--json]
  drahtbank prepare <directory> [--baseline <ref>] [--candidate <ref>]
      [--repo <path>] [--hosts coding-agent,draht-claude,draht-codex]
      [--cases <comma-separated IDs>] [--repeats <1-100>] [--prompt <repo-relative path>]
      [--suite 2 --split screen|holdout|all --variants <variants.json> --order-offset <index>]
  drahtbank run <directory> --adapter <config.json> [--json]
  drahtbank grade <directory> [--json]
  drahtbank report <directory> [--json]

Defaults: baseline HEAD, candidate current worktree, coding-agent, all cases, one repetition.
Each trial starts a fresh runner process. Run uses the model configured in the adapter.
Preparation, grading, reporting, and fixture tests make no model API calls.
Reports preserve unknown telemetry as null. A failed case makes run/grade exit 1.
Suite 2 defaults to screen cases. Variants JSON: [{"id":"verbose","ref":"<commit>"},{"id":"hybrid","ref":null}].
Suite 2 reports behavior, observed verification, findings, status, and scope separately.
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
	for (const variant of Object.keys(report.summary.variants)) {
		const row = report.summary.variants[variant];
		console.log(`${variant}: ${row.passed}/${row.total} passed; ${row.promptBytes} prompt bytes across trials`);
		for (const name of ["elapsedMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "toolCalls"]) {
			const metric = row.metrics[name];
			console.log(`  ${name}: ${metric.observed ? `median ${metric.median}, total ${metric.total}, observed ${metric.observed}/${row.total}` : "unknown"}`);
		}
		if (row.axes) for (const [name, axis] of Object.entries(row.axes)) console.log(`  ${name}: ${axis.passed} passed, ${axis.failed} failed, ${axis.unknownOrNotApplicable} unknown/not applicable`);
	}
	const paired = report.summary.paired;
	if (report.suiteVersion === "1") console.log(`Pairs: ${paired.bothPassed}/${paired.total} both passed; ${paired.regressions.length} regressions; ${paired.improvements.length} improvements`);
	else {
		console.log("Suite 2 strict pass combines protocol and task checks; use the separate axes for interpretation.");
		for (const comparison of report.summary.comparisons ?? []) {
			console.log(`Compare ${comparison.baselineVariant} -> ${comparison.candidateVariant}: ${comparison.matchedPairs} matched pairs; strict ${comparison.strict.regressions.length} regressions, ${comparison.strict.improvements.length} improvements; unmatched ${comparison.unpairedBaseline}/${comparison.unpairedCandidate}`);
			for (const [name, axis] of Object.entries(comparison.axes)) console.log(`  ${name}: ${axis.regressions.length} regressions, ${axis.improvements.length} improvements, ${axis.unknownOrNotApplicable} unknown/not applicable pairs`);
		}
	}
	if (!report.summary.comparableRunner) console.log("Runner identity is missing or differs; this is not a controlled prompt comparison.");
	for (const row of report.results.filter((result) => !result.passed)) {
		const reasons = report.suiteVersion === "2"
			? [["executionPassed", "execution"], ["behaviorPassed", "behavior"], ["evidencePassed", "evidence"],
				["statusSyntaxPassed", "status syntax"], ["statusSemanticPassed", "status semantics"],
				["responseFormatPassed", "response format"], ["findingsPassed", "findings"], ["scopePassed", "scope"]]
				.filter(([key]) => row[key] === false).map(([, label]) => label)
			: [!row.executionPassed && "execution", !row.acceptancePassed && "acceptance", !row.statusPassed && "status", !row.scopePassed && "scope"].filter(Boolean);
		if (!reasons.length) reasons.push("strict gate (see JSON axes)");
		console.log(`  FAIL ${row.id}: ${reasons.join(", ")}${row.failure ? ` (${row.failure})` : ""}`);
	}
	console.log("UTF-8 prompt bytes are not tokens. Fixture results do not establish general model quality or a speed improvement.");
}

export async function main(args = process.argv.slice(2)) {
	try {
		const [command, ...rest] = args;
		if (!command || ["help", "--help", "-h"].includes(command)) { console.log(HELP); return 0; }
		const options = {
			list: ["suite", "split", "json"], prepare: ["baseline", "candidate", "repo", "hosts", "cases", "repeats", "prompt", "suite", "split", "variants", "order-offset", "json"],
			run: ["adapter", "json"], grade: ["json"], report: ["json"],
		}[command];
		if (!options) throw new Error(`Unknown command: ${command}`);
		const { values, positional } = parse(rest, options);
		if (command === "list") {
			if (positional.length) throw new Error("list takes no directory argument");
			if (values.suite && !["1", "2"].includes(values.suite)) throw new Error("Unknown suite");
			if (values.split && !["screen", "holdout", "all"].includes(values.split)) throw new Error("Unknown split");
			const cases = (values.suite === "2" ? CASES_V2 : CASES).filter((entry) => !values.split || values.split === "all" || entry.split === values.split)
				.map(({ id, role, rubric, split, promptKind, promptName }) => ({ id, role, rubric, ...(split ? { split, promptKind, promptName } : {}) }));
			if (values.json) console.log(JSON.stringify({ hosts: HOSTS, cases }, null, 2));
			else for (const entry of cases) console.log(`${entry.id} (${entry.role}): ${entry.rubric}`);
			return 0;
		}
		if (positional.length !== 1) throw new Error(`${command} requires exactly one directory`);
		const directory = resolve(positional[0]);
		if (command === "prepare") {
			const manifest = prepareBank(directory, { root: values.repo, baseline: values.baseline, candidate: values.candidate,
				hosts: values.hosts?.split(","), cases: values.cases?.split(","), repeats: values.repeats === undefined ? undefined : Number(values.repeats), prompt: values.prompt,
				suite: values.suite, split: values.split, orderOffset: values["order-offset"] === undefined ? undefined : Number(values["order-offset"]),
				variants: values.variants ? JSON.parse(readFileSync(resolve(values.variants), "utf8")) : undefined });
			console.log(values.json ? JSON.stringify(manifest, null, 2) : `Prepared ${manifest.trials.length} trials in ${directory}\n${manifest.variants ? JSON.stringify(manifest.variants) : `Baseline: ${manifest.baselineCommit}\nCandidate: ${manifest.candidateCommit ?? "worktree snapshot"}`}`);
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
