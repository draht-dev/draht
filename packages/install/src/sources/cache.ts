import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashTree } from "../hash.ts";
import { cacheDir } from "../paths.ts";
import { extractTarGz, type TarLimits } from "./tar.ts";
import type { RegistryClient, ResolvedPackage } from "./types.ts";

/** Written into a cache entry once extraction finished; its absence means the entry is torn and must be redone. */
const COMPLETE_MARKER = ".complete";

/**
 * The cache directory for one resolved package.
 *
 * Keyed by the registry-served integrity when there is one, so two packages
 * with identical bytes share an entry and two different builds of the same
 * version can never collide. Falls back to a hash of name+version+URL, which
 * is still collision-free for anything the engine resolves.
 */
export function payloadCachePath(root: string, pkg: ResolvedPackage): string {
	const material = pkg.integrity ?? `${pkg.name}@${pkg.version}#${pkg.tarballUrl}`;
	const key = createHash("sha256").update(material).digest("hex").slice(0, 32);
	return join(cacheDir(root), key);
}

export interface MaterializeOptions {
	limits?: TarLimits;
}

async function cacheEntryValid(target: string, pkg: ResolvedPackage): Promise<boolean> {
	const markerPath = join(target, COMPLETE_MARKER);
	if (!existsSync(markerPath)) return false;
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
			name?: unknown;
			version?: unknown;
			integrity?: unknown;
			files?: unknown;
		};
		if (marker.name !== pkg.name || marker.version !== pkg.version || marker.integrity !== (pkg.integrity ?? null)) {
			return false;
		}
		if (!Array.isArray(marker.files)) return false;
		const actual = (await hashTree(target)).filter((file) => file.path !== COMPLETE_MARKER);
		return JSON.stringify(actual) === JSON.stringify(marker.files);
	} catch {
		return false;
	}
}

/**
 * Returns a directory holding the package's extracted payload, downloading and
 * extracting it only if the cache does not already hold a *complete* entry.
 *
 * Extraction goes to a sibling temp directory and is renamed into place, so a
 * crash mid-extract leaves either nothing or a finished entry — never a
 * half-populated directory that a later run would mistake for a valid payload.
 */
export async function materializeFromCache(
	root: string,
	pkg: ResolvedPackage,
	client: RegistryClient,
	options: MaterializeOptions = {},
): Promise<string> {
	const target = payloadCachePath(root, pkg);
	if (await cacheEntryValid(target, pkg)) return target;

	// Either absent or torn: discard whatever is there and redo it.
	rmSync(target, { recursive: true, force: true });
	mkdirSync(cacheDir(root), { recursive: true, mode: 0o700 });

	const bytes = await client.fetchTarball(pkg);
	const staging = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	rmSync(staging, { recursive: true, force: true });

	try {
		extractTarGz(bytes, staging, options.limits);
		const files = await hashTree(staging);
		writeFileSync(
			join(staging, COMPLETE_MARKER),
			`${JSON.stringify({ name: pkg.name, version: pkg.version, integrity: pkg.integrity ?? null, files })}\n`,
			{
				mode: 0o600,
			},
		);
		try {
			renameSync(staging, target);
		} catch (error) {
			// Another writer may have atomically published the same integrity-keyed
			// payload first. Accept only a fully revalidated winner.
			if (await cacheEntryValid(target, pkg)) {
				rmSync(staging, { recursive: true, force: true });
				return target;
			}
			throw error;
		}
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}

	return target;
}

/** Files a cache entry contributes to a component payload — the completion marker is engine bookkeeping, not payload. */
export function isCacheBookkeepingFile(relativePath: string): boolean {
	return relativePath === COMPLETE_MARKER;
}
