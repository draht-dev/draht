/**
 * Child-side structured output (§14.4, D1/D3): the parent writes the prepared result schema to a
 * temp file and sets `DRAHT_POLYPHASE_SCHEMA_FILE`; the child reads it once at extension-load time
 * and, when present, registers `polyphase_result` so the agent can hand back a validated value.
 */

import * as fs from "node:fs";
import type { JsonObject, JsonValue } from "@draht/ai";
import type { TSchema } from "typebox";
import type { ExtensionAPI } from "../../extensions/types.ts";
import { POLYPHASE_RESULT_TOOL_NAME, POLYPHASE_SCHEMA_FILE_ENV } from "../types.ts";

export const STRUCTURED_OUTPUT_INSTRUCTION =
	"When you have finished, call the polyphase_result tool exactly once with your final answer as " +
	"its arguments, matching its schema exactly. Call it as your last action: once it has run, your " +
	"turn ends and nothing you say afterward is seen by the orchestrating script.";

export interface PreparedResultSchema {
	toolSchema: JsonObject;
	unwrap(value: JsonValue): JsonValue;
}

function isObjectSchema(schema: JsonObject): boolean {
	return schema.type === "object";
}

/** Object schemas pass through unchanged; any other schema is wrapped as `{value: <schema>}` so the
 * tool call always has an object shape, and unwrapped back to the bare value on the way out. */
export function prepareResultSchema(schema: JsonObject): PreparedResultSchema {
	if (isObjectSchema(schema)) {
		return { toolSchema: schema, unwrap: (value) => value };
	}
	const toolSchema: JsonObject = { type: "object", properties: { value: schema }, required: ["value"] };
	return {
		toolSchema,
		unwrap: (value) => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			return (value as JsonObject).value ?? null;
		},
	};
}

/** Reads `DRAHT_POLYPHASE_SCHEMA_FILE` synchronously. Never throws: an unset or unreadable file is `undefined`. */
function readChildResultSchema(env: NodeJS.ProcessEnv = process.env): JsonObject | undefined {
	const file = env[POLYPHASE_SCHEMA_FILE_ENV];
	if (!file) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as JsonObject;
	} catch {
		return undefined;
	}
}

/**
 * Registers `polyphase_result` when (and only when) this process was spawned with a schema file
 * (`DRAHT_POLYPHASE_SCHEMA_FILE`): a no-op in every other process, including a child whose parent
 * did not request structured output.
 */
export function registerChildResultTool(pi: ExtensionAPI): void {
	const schema = readChildResultSchema();
	if (!schema) return;
	pi.registerTool({
		name: POLYPHASE_RESULT_TOOL_NAME,
		label: "Polyphase Result",
		description:
			"Records this agent's final structured result for the orchestrating workflow script. Call it exactly once, as the last thing you do.",
		parameters: schema as unknown as TSchema,
		execute: async () => ({
			content: [{ type: "text", text: "Result recorded." }],
			details: {},
			terminate: true,
		}),
	});
}
