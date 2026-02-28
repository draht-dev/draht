/**
 * SST Resource Manager Extension
 *
 * Provides tools for querying SST v4 resource definitions and stack state
 * from within the coding agent. Reads local .sst/ metadata and sst.config.ts
 * — never triggers deployments.
 *
 * Tools:
 * - sst_status: Show current SST stack status from local metadata
 * - sst_resources: Parse and list resources defined in sst.config.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@draht/coding-agent";
import { Type } from "@sinclair/typebox";

/** Find the nearest directory containing sst.config.ts, walking up from cwd */
function findSstRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	while (dir !== "/") {
		if (existsSync(join(dir, "sst.config.ts"))) return dir;
		dir = resolve(dir, "..");
	}
	return undefined;
}

/** Parse resource definitions from sst.config.ts using regex (no eval) */
function parseResources(configPath: string): Array<{ type: string; name: string; line: number }> {
	const content = readFileSync(configPath, "utf-8");
	const resources: Array<{ type: string; name: string; line: number }> = [];
	const lines = content.split("\n");

	const resourcePattern = /new\s+sst\.aws\.(\w+)\(\s*["']([^"']+)["']/;
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(resourcePattern);
		if (match) {
			resources.push({ type: match[1], name: match[2], line: i + 1 });
		}
	}

	const routePattern = /\.route\(\s*["']([^"']+)["']/;
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(routePattern);
		if (match) {
			resources.push({ type: "Route", name: match[1], line: i + 1 });
		}
	}

	return resources;
}

/** Read .sst/ metadata if it exists */
function readSstMetadata(sstRoot: string): Record<string, unknown> | undefined {
	const metaDir = join(sstRoot, ".sst");
	if (!existsSync(metaDir)) return undefined;

	const result: Record<string, unknown> = {};

	const stageFile = join(metaDir, "stage");
	if (existsSync(stageFile)) {
		result.stage = readFileSync(stageFile, "utf-8").trim();
	}

	try {
		const entries = readdirSync(metaDir);
		result.files = entries;
		result.lastModified = entries.reduce(
			(latest, entry) => {
				try {
					const stat = statSync(join(metaDir, entry));
					return stat.mtimeMs > (latest ?? 0) ? stat.mtimeMs : latest;
				} catch {
					return latest;
				}
			},
			undefined as number | undefined,
		);
	} catch {
		// ignore
	}

	return result;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "sst_status",
		label: "SST Status",
		description:
			"Show the current SST stack status from local .sst/ metadata. " +
			"Reports stage, last activity, and whether the project has been initialized. " +
			"Does NOT deploy or connect to AWS.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const sstRoot = findSstRoot(ctx.cwd);

			if (!sstRoot) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No sst.config.ts found in current directory or any parent. This project may not use SST.",
						},
					],
					details: undefined,
				};
			}

			const configPath = join(sstRoot, "sst.config.ts");
			const metadata = readSstMetadata(sstRoot);
			const hasConfig = existsSync(configPath);
			const hasSstDir = existsSync(join(sstRoot, ".sst"));

			const lines: string[] = [];
			lines.push(`SST Project Root: ${sstRoot}`);
			lines.push(`Config: ${hasConfig ? "sst.config.ts found" : "MISSING"}`);
			lines.push(
				`Initialized: ${hasSstDir ? "yes (.sst/ exists)" : "no (.sst/ not found — run sst dev to initialize)"}`,
			);

			if (metadata) {
				if (metadata.stage) lines.push(`Stage: ${metadata.stage}`);
				if (metadata.lastModified) {
					lines.push(`Last Activity: ${new Date(metadata.lastModified as number).toISOString()}`);
				}
				if (metadata.files) {
					lines.push(`Metadata Files: ${(metadata.files as string[]).join(", ")}`);
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "sst_resources",
		label: "SST Resources",
		description:
			"Parse and list all SST resources defined in sst.config.ts. " +
			"Shows resource types (Dynamo, ApiGatewayV2, etc.), names, and line numbers. " +
			"Reads the config file statically — does NOT deploy or query AWS.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const sstRoot = findSstRoot(ctx.cwd);

			if (!sstRoot) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No sst.config.ts found in current directory or any parent.",
						},
					],
					details: undefined,
				};
			}

			const configPath = join(sstRoot, "sst.config.ts");
			const resources = parseResources(configPath);

			if (resources.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No SST resources found in sst.config.ts. The file may use a non-standard pattern.",
						},
					],
					details: undefined,
				};
			}

			const lines = [`SST Resources in ${configPath}:`, ""];
			const byType = new Map<string, typeof resources>();
			for (const r of resources) {
				const list = byType.get(r.type) ?? [];
				list.push(r);
				byType.set(r.type, list);
			}

			for (const [type, items] of byType) {
				lines.push(`${type}:`);
				for (const item of items) {
					lines.push(`  - ${item.name} (line ${item.line})`);
				}
			}

			lines.push("");
			lines.push(`Total: ${resources.length} resources`);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: undefined,
			};
		},
	});
}
