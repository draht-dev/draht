import { verifyIntegrity } from "../hash.ts";
import { type RegistryClient, type ResolvedPackage, SourceError } from "./types.ts";

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

export interface NpmClientOptions {
	/** Hard cap on a downloaded tarball. Anything larger is refused mid-stream. */
	maxTarballBytes?: number;
	/** Hard cap on a packument document. */
	maxPackumentBytes?: number;
	/** Per-request timeout. */
	timeoutMs?: number;
	/** Injected for tests; defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

export interface NpmRegistryClient extends RegistryClient {
	/** The base URL this client resolves against — surfaced so `doctor` and `--json` can report it. */
	registryUrl: string;
}

const DEFAULTS = {
	maxTarballBytes: 64 * 1024 * 1024,
	maxPackumentBytes: 32 * 1024 * 1024,
	timeoutMs: 30_000,
};

/** npm's own encoding: the scope slash is escaped, the leading `@` is not. */
function encodePackageName(name: string): string {
	return name.startsWith("@")
		? `@${encodeURIComponent(name.slice(1)).replace(/%2F/gi, "%2f")}`
		: encodeURIComponent(name);
}

function normalizeRegistryUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new SourceError("registry-invalid", `DRAHT_REGISTRY is not a valid URL: ${JSON.stringify(raw)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new SourceError(
			"registry-invalid",
			`DRAHT_REGISTRY must be an http(s) URL; refusing ${JSON.stringify(raw)}`,
		);
	}
	return parsed.toString().replace(/\/+$/, "");
}

/** Streams a response body, aborting as soon as it exceeds `limit` so an oversized response is never fully buffered. */
async function readBounded(response: Response, limit: number, label: string): Promise<Buffer> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		throw new SourceError("response-too-large", `${label} declares ${declared} bytes, over the ${limit} byte limit`);
	}
	if (!response.body) {
		throw new SourceError("response-invalid", `${label} returned no response body`);
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				throw new SourceError("response-too-large", `${label} exceeds the ${limit} byte limit`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}

interface Packument {
	"dist-tags"?: Record<string, string>;
	versions?: Record<string, { version?: string; dist?: { tarball?: string; integrity?: string } }>;
}

/**
 * The production package source: an npm registry over HTTP(S).
 *
 * Trust root is the **registry-served** `dist.integrity`, not any hash the
 * shipped catalog carries — a catalog-supplied digest would only prove the
 * catalog agrees with itself. `DRAHT_REGISTRY` redirects the base URL (for a
 * mirror or a fixture server) but is validated to be http(s), so it can never
 * turn a package fetch into a local file read.
 */
export function createNpmRegistryClient(env: NodeJS.ProcessEnv, options: NpmClientOptions = {}): NpmRegistryClient {
	const registryUrl = env.DRAHT_REGISTRY ? normalizeRegistryUrl(env.DRAHT_REGISTRY) : DEFAULT_REGISTRY_URL;
	const maxTarballBytes = options.maxTarballBytes ?? DEFAULTS.maxTarballBytes;
	const maxPackumentBytes = options.maxPackumentBytes ?? DEFAULTS.maxPackumentBytes;
	const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
	const doFetch = options.fetchImpl ?? fetch;

	const request = async (url: string, label: string): Promise<Response> => {
		let response: Response;
		try {
			response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
		} catch (error) {
			throw new SourceError("network", `${label} failed: ${(error as Error).message}`, error);
		}
		if (!response.ok) {
			throw new SourceError("http-error", `${label} failed: ${response.status} ${response.statusText}`);
		}
		return response;
	};

	return {
		registryUrl,

		async resolve(packageName: string, channel: string): Promise<ResolvedPackage> {
			const url = `${registryUrl}/${encodePackageName(packageName)}`;
			const response = await request(url, `packument fetch for ${packageName}`);
			const body = await readBounded(response, maxPackumentBytes, `packument for ${packageName}`);

			let packument: Packument;
			try {
				packument = JSON.parse(body.toString("utf8")) as Packument;
			} catch (error) {
				throw new SourceError("registry-invalid", `packument for ${packageName} is not valid JSON`, error);
			}

			const version = packument["dist-tags"]?.[channel];
			if (!version) {
				throw new SourceError(
					"channel-missing",
					`package ${packageName} has no "${channel}" dist-tag on ${registryUrl}`,
				);
			}
			const manifest = packument.versions?.[version];
			const tarball = manifest?.dist?.tarball;
			if (!tarball) {
				throw new SourceError(
					"registry-invalid",
					`package ${packageName}@${version} has no dist.tarball in the registry metadata`,
				);
			}
			const integrity = manifest?.dist?.integrity;
			if (!integrity) {
				throw new SourceError(
					"registry-invalid",
					`package ${packageName}@${version} has no dist.integrity in the registry metadata; refusing an unauthenticated payload`,
				);
			}

			return { name: packageName, version, tarballUrl: tarball, integrity };
		},

		async fetchTarball(pkg: ResolvedPackage): Promise<Buffer> {
			const response = await request(pkg.tarballUrl, `tarball download for ${pkg.name}@${pkg.version}`);
			const bytes = await readBounded(response, maxTarballBytes, `tarball for ${pkg.name}@${pkg.version}`);

			if (!pkg.integrity) {
				throw new SourceError(
					"integrity-missing",
					`tarball for ${pkg.name}@${pkg.version} has no registry-served integrity and was refused`,
				);
			}
			if (!verifyIntegrity(bytes, pkg.integrity)) {
				throw new SourceError(
					"integrity-mismatch",
					`tarball for ${pkg.name}@${pkg.version} does not match the registry-served integrity ${pkg.integrity}`,
				);
			}
			return bytes;
		},
	};
}
