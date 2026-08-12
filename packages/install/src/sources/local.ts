import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { verifyIntegrity } from "../hash.ts";
import { type RegistryClient, type ResolvedPackage, SourceError } from "./types.ts";

const LocalIndexSchema = z.record(
	z.string(),
	z.object({
		distTags: z.record(z.string(), z.string()),
		versions: z.record(
			z.string(),
			z.object({
				/** Tarball filename relative to the index directory. */
				tarball: z.string().min(1),
				integrity: z.string().min(1).optional(),
			}),
		),
	}),
);

/**
 * A package source backed by a directory instead of a network.
 *
 * This is what makes the engine's own tests hermetic without stubbing the
 * engine: adapters, the executor and the CLI all run their real code paths,
 * and only the bytes' origin changes. The same integrity verification applies,
 * so a fixture cannot accidentally pass a check the production client would
 * fail.
 */
export function createLocalRegistryClient(dir: string): RegistryClient {
	const indexPath = join(dir, "index.json");

	const readIndex = (): z.infer<typeof LocalIndexSchema> => {
		if (!existsSync(indexPath)) {
			throw new SourceError("registry-missing", `local registry index not found at ${indexPath}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(indexPath, "utf8"));
		} catch (error) {
			throw new SourceError("registry-invalid", `local registry index at ${indexPath} is not valid JSON`, error);
		}
		const result = LocalIndexSchema.safeParse(parsed);
		if (!result.success) {
			throw new SourceError(
				"registry-invalid",
				`local registry index at ${indexPath} is malformed: ${result.error.message}`,
			);
		}
		return result.data;
	};

	return {
		async resolve(packageName: string, channel: string): Promise<ResolvedPackage> {
			const index = readIndex();
			const entry = index[packageName];
			if (!entry) {
				throw new SourceError("package-missing", `local registry has no package ${packageName}`);
			}
			const version = entry.distTags[channel];
			if (!version) {
				throw new SourceError(
					"channel-missing",
					`local registry package ${packageName} has no "${channel}" dist-tag`,
				);
			}
			const manifest = entry.versions[version];
			if (!manifest) {
				throw new SourceError(
					"registry-invalid",
					`local registry package ${packageName} has no version ${version}`,
				);
			}
			if (isAbsolute(manifest.tarball) || manifest.tarball.includes("..")) {
				throw new SourceError(
					"registry-invalid",
					`local registry tarball path ${manifest.tarball} escapes the index directory`,
				);
			}
			return {
				name: packageName,
				version,
				tarballUrl: `file://${join(dir, manifest.tarball)}`,
				integrity: manifest.integrity,
			};
		},

		async fetchTarball(pkg: ResolvedPackage): Promise<Buffer> {
			if (!pkg.tarballUrl.startsWith("file://")) {
				throw new SourceError("registry-invalid", `local registry cannot fetch ${pkg.tarballUrl}`);
			}
			const path = pkg.tarballUrl.slice("file://".length);
			if (!existsSync(path)) {
				throw new SourceError("package-missing", `local registry tarball not found at ${path}`);
			}
			const bytes = readFileSync(path);
			if (pkg.integrity && !verifyIntegrity(bytes, pkg.integrity)) {
				throw new SourceError(
					"integrity-mismatch",
					`tarball for ${pkg.name}@${pkg.version} does not match the recorded integrity ${pkg.integrity}`,
				);
			}
			return bytes;
		},
	};
}
