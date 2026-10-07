import { ChildEventReducer, type ChildWireRecord, toRunResult } from "../../../src/core/polyphase/child-events.ts";
import { validateStructuredOutput } from "../../../src/core/polyphase/child-process.ts";
import type {
	AgentConfig,
	AgentRunContext,
	AgentRunner,
	ChildStateChange,
	ProgressFn,
} from "../../../src/core/polyphase/types.ts";

/** One call the scripted runner's `AgentRunner` received, for assertions. */
export interface RecordedCall {
	cwd: string;
	agent: AgentConfig;
	task: string;
	step?: number;
	run?: AgentRunContext;
	signal?: AbortSignal;
	onProgress?: ProgressFn;
}

export interface ScriptResult {
	records: ChildWireRecord[];
	/** Default 0. */
	exitCode?: number;
	/** Pacing between records. Default: one `setImmediate` tick per record. */
	stepDelayMs?: number;
	/** After replaying `records`, wait for the signal to abort instead of finishing. */
	hangUntilAbort?: boolean;
	stderr?: string;
}

export interface ScriptedRunner {
	runner: AgentRunner;
	calls: RecordedCall[];
	maxConcurrent(): number;
	active(): number;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Races the per-record pacing delay against `aborted`, a single promise shared across every
 * record of one call, so a run-level signal passed to many agents accumulates at most one abort
 * listener per agent instead of one per record. */
function waitStep(ms: number | undefined, aborted: Promise<void> | undefined): Promise<void> {
	const step = ms !== undefined ? delay(ms) : tick();
	return aborted ? Promise.race([step, aborted]) : step;
}

/** A scripted `AgentRunner` for orchestration tests: no real process, a real `ChildEventReducer`. */
export function createScriptedRunner(script: (call: RecordedCall) => ScriptResult): ScriptedRunner {
	const calls: RecordedCall[] = [];
	let active = 0;
	let maxConcurrent = 0;

	const runner: AgentRunner = async (cwd, agent, task, signal, step, onProgress, run) => {
		const call: RecordedCall = { cwd, agent, task, step, run, signal, onProgress };
		calls.push(call);
		active++;
		maxConcurrent = Math.max(maxConcurrent, active);

		try {
			const reducer =
				run?.reducer ??
				new ChildEventReducer({
					model: run?.modelInfo ?? {
						source: agent.model ? "frontmatter" : "child-default",
						requested: agent.model,
						confirmed: false,
					},
				});

			// Mirrors child-process.ts's runChildAgent: an already-aborted signal resolves cancelled
			// without ever spawning (no markSpawning, no onStart).
			if (signal?.aborted) {
				const finish = reducer.finish({ code: null, signal: null, cancelled: true });
				return toRunResult(reducer.state, { agent: agent.name, task, step }, finish, {
					cancelled: true,
					durationMs: 0,
				});
			}

			const result = script(call);

			reducer.markSpawning();
			run?.onStart?.({ pid: undefined, argv: [] });
			if (result.stderr) reducer.noteStderr(result.stderr);

			const forward = (change: ChildStateChange) => {
				if (change !== "none") run?.onChange?.(change);
			};

			const aborted = signal ? waitForAbort(signal) : undefined;
			for (const record of result.records) {
				if (signal?.aborted) break;
				forward(reducer.apply(record));
				if (signal?.aborted) break;
				await waitStep(result.stepDelayMs, aborted);
			}

			if (result.hangUntilAbort && aborted) {
				await aborted;
			}

			const cancelled = signal?.aborted === true;
			const finish = reducer.finish({ code: cancelled ? null : (result.exitCode ?? 0), signal: null, cancelled });

			if (run?.schema) validateStructuredOutput(reducer, run.schema, run?.onChange);

			return toRunResult(reducer.state, { agent: agent.name, task, step }, finish, {
				cancelled,
				structured: reducer.state.structured,
				durationMs: 0,
			});
		} finally {
			active--;
		}
	};

	return {
		runner,
		calls,
		maxConcurrent: () => maxConcurrent,
		active: () => active,
	};
}
