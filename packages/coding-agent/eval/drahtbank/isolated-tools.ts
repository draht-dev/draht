import { constants, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@draht/coding-agent";
import * as sdk from "@draht/coding-agent";
import { createIsolation } from "./isolation.mjs";

/** The provider runs on the host; every model-directed filesystem operation runs in a fresh confined child. */
export default async function isolatedTools(api: ExtensionAPI) {
	try {
		await initializeTools(api);
	} catch (error) {
		// The general extension loader records errors and continues. This
		// benchmark must stop before any provider request or unconfined tool.
		process.stderr.write(
			`Drahtbank isolated tools unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	}
}

async function initializeTools(api: ExtensionAPI) {
	if (sdk.DRAHTBANK_TOOL_OPERATIONS_VERSION !== "fixture-operations-v1") {
		throw new Error("Configured Draht runtime must support fixture-operations-v1");
	}
	const isolation = await createIsolation(process.cwd());
	const {
		createBashToolDefinition,
		createEditToolDefinition,
		createFindToolDefinition,
		createGrepToolDefinition,
		createLsToolDefinition,
		createReadToolDefinition,
		createWriteToolDefinition,
		detectSupportedImageMimeType,
	} = sdk;
	const dispose = () => isolation.dispose();
	process.once("exit", dispose);
	api.on("session_shutdown", () => {
		dispose();
		process.off("exit", dispose);
	});
	const workspace = isolation.workspace;
	const readFile = async (path: string) => Buffer.from(await isolation.fs({ op: "read", path }), "base64");
	const writeFile = async (path: string, content: string) => {
		await isolation.fs({ op: "write", path, content });
	};
	const access = async (path: string, mode = constants.R_OK) => {
		await isolation.fs({ op: "access", path, mode });
	};
	const exists = async (path: string) => {
		try {
			await isolation.fs({ op: "access", path });
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	};
	const stat = async (path: string) => {
		const result = await isolation.fs({ op: "stat", path });
		return { isDirectory: () => result.isDirectory };
	};

	api.registerTool(
		createReadToolDefinition(workspace, {
			operations: {
				readFile,
				access,
				detectImageMimeType: async (path) => detectSupportedImageMimeType(await readFile(path)),
			},
		}),
	);
	api.registerTool(
		createWriteToolDefinition(workspace, {
			operations: {
				writeFile,
				mkdir: async (path) => {
					await isolation.fs({ op: "mkdir", path });
				},
			},
		}),
	);
	api.registerTool(
		createEditToolDefinition(workspace, {
			operations: { readFile, writeFile, access: (path) => access(path, constants.R_OK | constants.W_OK) },
		}),
	);
	api.registerTool(
		createLsToolDefinition(workspace, {
			operations: { exists, stat, readdir: (path) => isolation.fs({ op: "readdir", path }) },
		}),
	);
	api.registerTool(
		createGrepToolDefinition(workspace, {
			operations: {
				isDirectory: async (path) => (await isolation.fs({ op: "stat", path })).isDirectory,
				readFile: async (path) => (await readFile(path)).toString("utf8"),
				spawn: (args) => {
					const child = isolation.spawn([isolation.resolveExecutable("rg"), ...args]);
					child.stdin.end();
					return child;
				},
			},
		}),
	);
	api.registerTool(
		createFindToolDefinition(workspace, {
			operations: {
				exists,
				glob: async (pattern, cwd, { limit }) => {
					const args = ["--glob", "--color=never", "--hidden"];
					let insideGitRepo = false;
					for (let directory = cwd; ; directory = dirname(directory)) {
						if (await exists(join(directory, ".git"))) {
							insideGitRepo = true;
							break;
						}
						if (directory === workspace) break;
					}
					if (!insideGitRepo) args.push("--no-require-git");
					args.push("--max-results", String(limit));
					if (pattern.includes("/")) {
						args.push("--full-path");
						if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**")
							pattern = `**/${pattern}`;
					}
					args.push("--", pattern, cwd);
					const result = await isolation.run([isolation.resolveExecutable("fd"), ...args]);
					if (result.error || result.exitCode !== 0) {
						throw new Error(result.error || result.stderr.trim() || `fd exited with code ${result.exitCode}`);
					}
					return result.stdout.split(/\r?\n/).filter(Boolean);
				},
			},
		}),
	);
	const bash = createBashToolDefinition(workspace, {
		exposeSessionEnvironment: false,
		operations: {
			exec: async (command, cwd, { signal, timeout, onData }) => {
				if (resolve(cwd) !== workspace) throw new Error("Drahtbank bash cwd must be the isolated fixture");
				if (signal?.aborted) throw new Error("aborted");
				const result = await isolation.run([isolation.shellPath, "--noprofile", "--norc", "-c", command], {
					signal,
					timeoutMs: timeout === undefined ? 300_000 : Math.ceil(timeout * 1000),
					onData,
				});
				if (signal?.aborted) throw new Error("aborted");
				if (result.timedOut) throw new Error(`timeout:${timeout ?? 300}`);
				if (result.error) throw new Error(result.error);
				return { exitCode: result.exitCode };
			},
		},
	});
	api.registerTool({
		...bash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const captures = new Set<string>();
			const retained = new Map<string, string>();
			const preserveCaptures = () => {
				for (const path of captures) retained.set(path, isolation.retainReadOnlyFile(path));
			};
			const rewrite = (text: string) => {
				for (const [hostPath, artifactPath] of retained) text = text.replaceAll(hostPath, artifactPath);
				return text;
			};
			let result: Awaited<ReturnType<typeof bash.execute>>;
			try {
				result = await bash.execute(
					toolCallId,
					params,
					signal,
					(update) => {
						if (update.details?.fullOutputPath) captures.add(update.details.fullOutputPath);
						// A native spill file is still being written. Publish its
						// readonly copy only after execute closes the capture.
						onUpdate?.({
							...update,
							details: update.details ? { ...update.details, fullOutputPath: undefined } : undefined,
						});
					},
					ctx,
				);
			} catch (error) {
				preserveCaptures();
				throw new Error(rewrite(error instanceof Error ? error.message : String(error)));
			}
			if (result.details?.fullOutputPath) captures.add(result.details.fullOutputPath);
			preserveCaptures();
			const structured = result.structuredContent;
			return {
				...result,
				content: result.content.map((part) =>
					part.type === "text" ? { ...part, text: rewrite(part.text) } : part,
				),
				details: result.details?.fullOutputPath
					? { ...result.details, fullOutputPath: rewrite(result.details.fullOutputPath) }
					: result.details,
				structuredContent:
					structured &&
					typeof structured === "object" &&
					!Array.isArray(structured) &&
					"full_output_path" in structured &&
					typeof structured.full_output_path === "string"
						? { ...structured, full_output_path: rewrite(structured.full_output_path) }
						: structured,
			};
		},
	});
	// JSON mode redirects console and process.stdout.write to stderr. This
	// trusted readiness record must precede agent events on the actual stdout.
	writeSync(
		1,
		`${JSON.stringify({
			type: "drahtbank_isolation",
			schemaVersion: 1,
			policy: "fixture-root-v1",
			toolOperationsVersion: sdk.DRAHTBANK_TOOL_OPERATIONS_VERSION,
			workspace,
			evidence: isolation.evidence,
		})}\n`,
	);
}
