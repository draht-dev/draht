import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export interface FixturePackageVersion {
	version: string;
	tarball: Buffer;
	/** Overrides the served `dist.integrity`; omit to serve the true sha512 of `tarball`. */
	integrity?: string;
}

export interface FixturePackage {
	name: string;
	distTags: Record<string, string>;
	versions: FixturePackageVersion[];
}

export function ssriIntegrity(buffer: Buffer): string {
	return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

export interface FixtureRegistry {
	url: string;
	/** Every request path the server has served, in order — proves dry-run makes no calls. */
	requests: string[];
	close: () => Promise<void>;
}

/**
 * A loopback npm registry serving fixture packuments and tarballs.
 *
 * Binds 127.0.0.1:0 — no DNS, no external host, nothing leaves the machine —
 * so the npm client's real code path (packument fetch, dist-tag resolution,
 * tarball download, integrity verification, size bounds) is exercised without
 * any live network.
 */
export async function startFixtureRegistry(packages: FixturePackage[]): Promise<FixtureRegistry> {
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	const requests: string[] = [];

	const server: Server = createServer((req, res) => {
		const path = decodeURIComponent(req.url ?? "");
		requests.push(path);

		const tarballMatch = /^\/(.+)\/-\/([^/]+)\.tgz$/.exec(path);
		if (tarballMatch) {
			const pkg = byName.get(tarballMatch[1]);
			const version = pkg?.versions.find((candidate) => tarballMatch[2].endsWith(candidate.version));
			if (!pkg || !version) {
				res.writeHead(404).end("no such tarball");
				return;
			}
			res.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": String(version.tarball.length),
			});
			res.end(version.tarball);
			return;
		}

		const pkg = byName.get(path.replace(/^\//, ""));
		if (!pkg) {
			res.writeHead(404).end("no such package");
			return;
		}
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const packument = {
			name: pkg.name,
			"dist-tags": pkg.distTags,
			versions: Object.fromEntries(
				pkg.versions.map((version) => [
					version.version,
					{
						name: pkg.name,
						version: version.version,
						dist: {
							tarball: `${base}/${pkg.name}/-/${pkg.name.replace(/^@[^/]+\//, "")}-${version.version}.tgz`,
							integrity: version.integrity ?? ssriIntegrity(version.tarball),
						},
					},
				]),
			),
		};
		const body = JSON.stringify(packument);
		res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
		res.end(body);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

/**
 * Writes the on-disk layout `createLocalRegistryClient` reads: an `index.json`
 * of dist-tags and versions plus the tarball files beside it.
 */
export function writeLocalRegistry(dir: string, packages: FixturePackage[]): string {
	mkdirSync(dir, { recursive: true });
	const index: Record<string, unknown> = {};
	for (const pkg of packages) {
		const versions: Record<string, unknown> = {};
		for (const version of pkg.versions) {
			const file = `${pkg.name.replace(/[@/]/g, "_")}-${version.version}.tgz`;
			writeFileSync(join(dir, file), version.tarball);
			versions[version.version] = {
				tarball: file,
				integrity: version.integrity ?? ssriIntegrity(version.tarball),
			};
		}
		index[pkg.name] = { distTags: pkg.distTags, versions };
	}
	const indexPath = join(dir, "index.json");
	writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
	return indexPath;
}
