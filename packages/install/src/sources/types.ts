/** One resolved package version, ready to download. */
export interface ResolvedPackage {
	name: string;
	version: string;
	/** Absolute URL, or a `file:` URL for the local fixture source. */
	tarballUrl: string;
	/**
	 * The registry-served `dist.integrity` (ssri, typically `sha512-<base64>`).
	 * This is the npm trust root: it comes from the registry's own metadata, not
	 * from the catalog we ship, so it cannot be forged by whoever controls the
	 * catalog. Absent only for sources that publish no integrity at all.
	 */
	integrity?: string;
}

/**
 * The engine's only route to package bytes. Injecting this interface is what
 * makes every other test hermetic: the production implementation talks to a
 * registry, the fixture implementation reads a directory, and nothing else in
 * the engine knows the difference.
 */
export interface RegistryClient {
	/** Resolves a dist-tag (`latest`) to a concrete version and tarball descriptor. */
	resolve(packageName: string, channel: string): Promise<ResolvedPackage>;
	/** Downloads the tarball bytes and verifies them against `pkg.integrity` when present. */
	fetchTarball(pkg: ResolvedPackage): Promise<Buffer>;
}

/** Thrown for every source-layer failure so callers can distinguish "registry problem" from "engine bug". */
export class SourceError extends Error {
	public readonly code: string;

	constructor(code: string, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SourceError";
		this.code = code;
	}
}
