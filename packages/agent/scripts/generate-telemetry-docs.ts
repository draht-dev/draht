import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateTelemetryDocs } from "../../ai/scripts/generate-telemetry-docs.ts";
import { HARNESS_TELEMETRY_SCHEMA } from "../src/harness/telemetry.ts";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	generateTelemetryDocs(
		HARNESS_TELEMETRY_SCHEMA,
		"Pi Agent Harness Telemetry Schema",
		resolve(import.meta.dirname, "../docs/telemetry-schema.md"),
		process.argv.includes("--check"),
	);
}
