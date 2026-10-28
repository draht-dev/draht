import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../../src/core/multi-agent/permission-gate.ts";
import {
	prepareResultSchema,
	registerChildResultTool,
	STRUCTURED_OUTPUT_INSTRUCTION,
} from "../../src/core/polyphase/workflow/structured-output.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";

describe("prepareResultSchema", () => {
	it("passes object schemas through unchanged and unwraps the identity value", () => {
		const schema = { type: "object", properties: { areas: { type: "array" } }, required: ["areas"] };
		const prepared = prepareResultSchema(schema);
		expect(prepared.toolSchema).toBe(schema);
		const value = { areas: ["a", "b"] };
		expect(prepared.unwrap(value)).toBe(value);
	});

	it("wraps a non-object schema as {value: <schema>} and unwraps back to the bare value", () => {
		const schema = { type: "array", items: { type: "string" } };
		const prepared = prepareResultSchema(schema);
		expect(prepared.toolSchema).toEqual({ type: "object", properties: { value: schema }, required: ["value"] });
		expect(prepared.unwrap({ value: ["a", "b"] })).toEqual(["a", "b"]);
	});

	it("wraps a string schema the same way", () => {
		const schema = { type: "string" };
		const prepared = prepareResultSchema(schema);
		expect(prepared.toolSchema.properties).toEqual({ value: schema });
		expect(prepared.unwrap({ value: "hello" })).toBe("hello");
	});
});

describe("STRUCTURED_OUTPUT_INSTRUCTION", () => {
	it("mentions the tool name", () => {
		expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain("polyphase_result");
	});
});

describe("registerChildResultTool", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
	});

	function writeSchemaFile(schema: unknown): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-polyphase-schema-"));
		tempDirs.push(dir);
		const file = path.join(dir, "schema.json");
		fs.writeFileSync(file, JSON.stringify(schema));
		return file;
	}

	it("is a no-op when DRAHT_POLYPHASE_SCHEMA_FILE is unset", async () => {
		vi.stubEnv("DRAHT_POLYPHASE_SCHEMA_FILE", "");
		const harness = await createHarness({ extensionFactories: [(pi) => registerChildResultTool(pi)] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getAllTools().some((tool) => tool.name === "polyphase_result")).toBe(false);
	});

	it("is a no-op when the schema file is unreadable", async () => {
		vi.stubEnv("DRAHT_POLYPHASE_SCHEMA_FILE", path.join(os.tmpdir(), "does-not-exist-schema.json"));
		const harness = await createHarness({ extensionFactories: [(pi) => registerChildResultTool(pi)] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getAllTools().some((tool) => tool.name === "polyphase_result")).toBe(false);
	});

	it("registers polyphase_result from the schema file and terminates the turn on a valid call", async () => {
		const schemaFile = writeSchemaFile({
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		});
		vi.stubEnv("DRAHT_POLYPHASE_SCHEMA_FILE", schemaFile);

		const harness = await createHarness({ extensionFactories: [(pi) => registerChildResultTool(pi)] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getAllTools().some((tool) => tool.name === "polyphase_result")).toBe(true);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("polyphase_result", { value: "ok" }, { id: "r1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("should not be reached", { stopReason: "stop" }),
		]);
		const before = harness.getPendingResponseCount();

		await harness.session.prompt("finish up");

		const after = harness.getPendingResponseCount();
		expect(after).toBe(before - 1);

		const result = getToolResult(harness, "polyphase_result");
		expect(result.isError).not.toBe(true);
	});

	it("gives a validation error for arguments that do not match the schema", async () => {
		const schemaFile = writeSchemaFile({
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		});
		vi.stubEnv("DRAHT_POLYPHASE_SCHEMA_FILE", schemaFile);

		const harness = await createHarness({ extensionFactories: [(pi) => registerChildResultTool(pi)] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.setResponses([
			// The field-coercion pass in validateToolArguments would turn a wrong-typed `value` into a
			// string, so this omits the required field entirely instead, which coercion cannot fabricate.
			fauxAssistantMessage([fauxToolCall("polyphase_result", {}, { id: "r2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("finish up");

		const result = getToolResult(harness, "polyphase_result");
		expect(result.isError).toBe(true);
	});
});

describe("PermissionGate default decisions", () => {
	it("allows polyphase_result, subagent and approves duet_delegate by default", () => {
		const gate = new PermissionGate();
		expect(gate.evaluate("polyphase_result").action).toBe("allow");
		expect(gate.evaluate("subagent").action).toBe("allow");
		expect(gate.evaluate("duet_delegate").action).toBe("approve");
	});
});
