import { readFileSync } from "node:fs";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A package declares its extensions/skills/prompts/themes under a top-level
 * manifest key. draht reads `draht` first and falls back to upstream's `pi`,
 * mirroring CONFIG_DIR_NAME / LEGACY_CONFIG_DIR_NAME: packages authored for
 * upstream (or copied from its docs) keep working unchanged.
 */
export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg)) {
			return null;
		}
		const raw = isObject(pkg.draht) ? pkg.draht : isObject(pkg.pi) ? pkg.pi : null;
		if (!raw) {
			return null;
		}

		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = raw[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
