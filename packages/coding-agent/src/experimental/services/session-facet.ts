import type { AgentHarness } from "@draht/agent-core";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { Facet } from "../facets.ts";

/** Host capabilities added to the common environment for one Session facet. */
export interface SessionFacetAttributes {
	readonly harness: AgentHarness;
	readonly modelRuntime: ModelRuntime | undefined;
}

export type SessionFacet = Facet<SessionFacetAttributes>;
