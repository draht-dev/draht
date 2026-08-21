/**
 * An extension may import any `@draht/ai` subpath the loader advertises.
 *
 * The loader's jiti alias table (Node) and virtualModules table (compiled Bun
 * binary) both carry a bare `"@draht/ai"` key, and jiti matches those keys by
 * PREFIX. An `@draht/ai/<subpath>` that has no entry of its own is therefore
 * rewritten onto the compat entrypoint — `<...>/ai/dist/compat.js/providers/faux`
 * — and the extension fails to load with "Cannot find module". The regression is
 * silent: `loadExtensions` reports it as a per-extension error, so a provider the
 * extension would have registered simply never exists.
 *
 * `providers/faux` is the subpath the shipped stub-provider builtin uses, so it
 * is the one asserted here; the loop covers the rest of the advertised surface.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";

/** Every `@draht/ai` entrypoint an extension is allowed to import. */
const AI_SUBPATHS = ["@draht/ai", "@draht/ai/compat", "@draht/ai/oauth", "@draht/ai/providers/all"] as const;

describe("extension imports of @draht/ai subpaths", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-ai-subpath-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeExtension(name: string, source: string): string {
		const file = path.join(tempDir, `${name}.ts`);
		fs.writeFileSync(file, source);
		return file;
	}

	it('resolves "@draht/ai/providers/faux", the subpath the stub-provider builtin uses', async () => {
		const file = writeExtension(
			"faux",
			`
			import { fauxAssistantMessage, fauxProvider } from "@draht/ai/providers/faux";
			export default function (pi) {
				pi.registerCommand("faux-probe", {
					handler: async () => {},
					description: typeof fauxProvider + "/" + typeof fauxAssistantMessage,
				});
			}
			`,
		);

		const result = await loadExtensions([file], tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		// Proof the module was really evaluated, not merely resolved to something.
		expect(result.extensions[0]?.commands.get("faux-probe")?.description).toBe("function/function");
	});

	it("resolves every other advertised @draht/ai entrypoint", async () => {
		const files = AI_SUBPATHS.map((specifier, index) =>
			writeExtension(
				`subpath-${index}`,
				`
				import * as mod from "${specifier}";
				export default function (pi) {
					pi.registerCommand("probe-${index}", { handler: async () => {}, description: typeof mod });
				}
				`,
			),
		);

		const result = await loadExtensions(files, tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(AI_SUBPATHS.length);
	});
});
