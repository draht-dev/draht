/**
 * Trajectory JSONL logging for RLM sessions.
 *
 * Every `RlmSession` created via `createRouterBackedSession` (router-session.ts,
 * Phase 27) already generates one `trajectoryId` (`randomUUID()`) shared with
 * every cost entry it logs via `@draht/router`'s `estimateCost`/`logCost`.
 * This module gives that same `trajectoryId` a second, complementary log: a
 * newline-delimited JSON file under `.draht/rlm/<trajectoryId>.jsonl`
 * recording one `TrajectoryStepEntry` per root-LLM step (plus the sub-calls
 * that step triggered) and one terminal `TrajectoryFinalEntry` once the
 * session resolves. Together with `readTrajectory`, this is what
 * `draht rlm replay <trajectory-id>` (Phase 30, task 4) reconstructs an
 * answer from, with zero LLM calls.
 *
 * See .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
 * section 1.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RlmResultKind } from "./types.js";

/** Default directory trajectory JSONL files are written under/read from, relative to `process.cwd()`. */
const DEFAULT_LOG_DIR = ".draht/rlm";

/** One root-LLM step recorded in a trajectory's JSONL log. */
export interface TrajectoryStepEntry {
	type: "step";
	trajectoryId: string;
	/** 1-indexed step number -- matches `RlmHistoryEntry.step`. */
	step: number;
	/** The Python source executed this step (post fence-extraction). */
	code: string;
	/** Captured stdout, already truncated -- matches `RlmHistoryEntry.truncatedStdout`. */
	truncatedStdout: string;
	/** Traceback/message if the executed code raised, else null. */
	error: string | null;
	/** Sub-LLM (`llm_query`) calls made *during* this step -- not attributed to any other step. */
	subCalls: Array<{ costUsd: number; provider: string; model: string }>;
	/** This step's own root-call cost plus the sum of its `subCalls`' costs. */
	costUsd: number;
	/** ISO 8601 timestamp -- matches `RlmHistoryEntry.timestamp`. */
	timestamp: string;
}

/** The terminal entry appended once a trajectory's `RlmSession.run()` resolves. */
export interface TrajectoryFinalEntry {
	type: "final";
	trajectoryId: string;
	kind: RlmResultKind;
	value: unknown;
	/** Sum of every step's `costUsd` in this trajectory. */
	totalCostUsd: number;
	totalSteps: number;
	timestamp: string;
}

/** Resolves the on-disk path of a trajectory's JSONL log file. */
function trajectoryFilePath(trajectoryId: string, logDir: string | undefined): string {
	return join(resolve(logDir ?? DEFAULT_LOG_DIR), `${trajectoryId}.jsonl`);
}

/**
 * Appends one entry (step or final) to `trajectoryId`'s JSONL log, creating
 * `logDir` (default `.draht/rlm/`) if it doesn't exist yet. Each call is one
 * `appendFileSync` of a single JSON-encoded line -- callers are responsible
 * for calling this once per step and once for the final entry, in order.
 */
export function appendTrajectoryEntry(
	trajectoryId: string,
	entry: TrajectoryStepEntry | TrajectoryFinalEntry,
	logDir?: string,
): void {
	const dir = resolve(logDir ?? DEFAULT_LOG_DIR);
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, `${trajectoryId}.jsonl`), `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * Reads back `trajectoryId`'s JSONL log, splitting it into its step entries
 * (in file order) and its final entry (`null` if the trajectory never
 * resolved -- e.g. the process was killed mid-run). Throws a clear error
 * (rather than a bare ENOENT) when no log file exists for `trajectoryId` at
 * `logDir`, so callers like `draht rlm replay` can surface it directly.
 */
export function readTrajectory(
	trajectoryId: string,
	logDir?: string,
): { steps: TrajectoryStepEntry[]; final: TrajectoryFinalEntry | null } {
	const filePath = trajectoryFilePath(trajectoryId, logDir);
	if (!existsSync(filePath)) {
		throw new Error(`readTrajectory: no trajectory log found for id "${trajectoryId}" at ${filePath}`);
	}
	const steps: TrajectoryStepEntry[] = [];
	let final: TrajectoryFinalEntry | null = null;
	const content = readFileSync(filePath, "utf-8");
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as TrajectoryStepEntry | TrajectoryFinalEntry;
		if (entry.type === "step") {
			steps.push(entry);
		} else if (entry.type === "final") {
			final = entry;
		}
	}
	return { steps, final };
}
