import type { AgentHarnessOptions } from "../agent-harness.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { LaneConfiguration, Session } from "../session/types.ts";
import type { Lane } from "./lane.ts";
import { restoreSession } from "./restore.ts";

export class Runtime {
	readonly session: Session;
	readonly seed: LaneConfiguration;
	readonly lanes: ReadonlyMap<string, Lane>;

	constructor(session: Session, seed: LaneConfiguration, lanes: ReadonlyMap<string, Lane>) {
		this.session = session;
		this.seed = seed;
		this.lanes = lanes;
	}
}

/** Create an inert runtime2 shell over one open session. */
export async function createRuntime<TContext extends object | undefined = object | undefined>(
	options: AgentHarnessOptions<TContext>,
): Promise<Runtime> {
	const tools = options.tools ?? [];
	const toolNames = new Set<string>();
	for (const tool of tools) {
		if (toolNames.has(tool.name)) throw new TypeError(`Duplicate tool name: ${JSON.stringify(tool.name)}`);
		toolNames.add(tool.name);
	}
	const seed: LaneConfiguration = {
		model: { provider: options.model.provider, modelId: options.model.id },
		thinkingLevel: options.thinkingLevel ?? "off",
		activeToolNames: [...(options.activeToolNames ?? tools.map((tool) => tool.name))],
	};
	await seedMain(options.session, seed);
	return new Runtime(options.session, seed, await restoreSession(options.session));
}

async function seedMain(session: Session, seed: LaneConfiguration): Promise<void> {
	await session.mutate("main", async (mutator) => {
		const [leaf, state, configuration, lastResult] = await Promise.all([
			mutator.getRegister("lane.leaf", "main"),
			mutator.getRegister("lane.state", "main"),
			mutator.getRegister("lane.config", "main"),
			mutator.getRegister("lane.lastResult", "main"),
		]);
		if (leaf === undefined || state === undefined) {
			throw new SessionInvariantError("Session main lane has incomplete durable state");
		}
		if (configuration !== undefined) return;
		if (state.value.currentOperationId !== null || lastResult !== undefined) {
			throw new SessionInvariantError("Configured or active main lane is missing lane.config");
		}
		await mutator.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.config",
					key: "main",
					value: {
						...seed,
						model: { ...seed.model },
						activeToolNames: [...seed.activeToolNames],
					},
				},
			],
		});
	});
}
