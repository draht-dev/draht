import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GRAPH_PLATFORMS = Object.freeze([
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"windows-x64",
]);

const GRAPH_PLATFORM_METADATA = Object.freeze({
	"darwin-arm64": { goos: "darwin", goarch: "arm64", binary: "draht-graph" },
	"darwin-x64": { goos: "darwin", goarch: "amd64", binary: "draht-graph" },
	"linux-x64": { goos: "linux", goarch: "amd64", binary: "draht-graph" },
	"linux-arm64": { goos: "linux", goarch: "arm64", binary: "draht-graph" },
	"windows-x64": { goos: "windows", goarch: "amd64", binary: "draht-graph.exe" },
});

export const EXPECTED_RELEASE_ASSETS = Object.freeze([
	"draht-darwin-arm64.tar.gz",
	"draht-darwin-x64.tar.gz",
	"draht-linux-x64.tar.gz",
	"draht-linux-arm64.tar.gz",
	"draht-windows-x64.zip",
	"manifest.json",
	"SHA256SUMS",
	"draht-graph-darwin-arm64.tar.gz",
	"draht-graph-darwin-x64.tar.gz",
	"draht-graph-linux-x64.tar.gz",
	"draht-graph-linux-arm64.tar.gz",
	"draht-graph-windows-x64.zip",
]);

export const SCOPE_TO_PACKAGES = Object.freeze({
	ai: ["ai"],
	tui: ["tui"],
	agent: ["agent"],
	"agent-core": ["agent"],
	"coding-agent": ["coding-agent"],
	"draht-claude": ["draht-claude"],
	mom: ["mom"],
	pods: ["pods"],
	"web-ui": ["web-ui"],
	landing: ["landing"],
	infra: ["infra"],
	templates: ["templates"],
	go: ["coding-agent", "draht-claude", "draht-codex"],
});

const PLUGIN_MANIFESTS = Object.freeze([
	"packages/draht-claude/.claude-plugin/plugin.json",
	"packages/draht-codex/.codex-plugin/plugin.json",
]);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value, indent = "\t") {
	writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`);
}

export function getScopePackages(scope) {
	return SCOPE_TO_PACKAGES[scope] ? [...SCOPE_TO_PACKAGES[scope]] : [];
}

export function assertReleaseVersions(root, version) {
	const stale = [];
	const rootPackage = join(root, "package.json");
	if (readJson(rootPackage).version !== version) stale.push(`${rootPackage} is not ${version}`);
	for (const dirent of readdirSync(join(root, "packages"), { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const packagePath = join(root, "packages", dirent.name, "package.json");
		if (existsSync(packagePath)) {
			const pkg = readJson(packagePath);
			const actual = pkg.version;

			if (actual !== version) stale.push(`${packagePath} has ${actual}; expected ${version}`);
		}
	}
	for (const relativePath of PLUGIN_MANIFESTS) {
		const manifestPath = join(root, relativePath);
		const actual = readJson(manifestPath).version;
		if (actual !== version) stale.push(`${manifestPath} has ${actual}; expected ${version}`);
	}

	if (stale.length) throw new Error(`Release version surfaces are stale:\n${stale.join("\n")}`);
}

export function setVersion(root, version) {
	const packagesDir = join(root, "packages");
	const packageDirs = readdirSync(packagesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	const packages = [];
	const versionMap = {};
	for (const dir of packageDirs) {
		const packagePath = join(packagesDir, dir.name, "package.json");
		if (!existsSync(packagePath)) continue;
		const pkg = readJson(packagePath);
		pkg.version = version;
		versionMap[pkg.name] = version;
		packages.push({ packagePath, pkg });
	}
	for (const { packagePath, pkg } of packages) {
		for (const field of ["dependencies", "devDependencies"]) {
			for (const [name, current] of Object.entries(pkg[field] ?? {})) {
				if (versionMap[name] && typeof current === "string" && !current.startsWith("workspace:")) pkg[field][name] = `^${version}`;
			}
		}
		writeJson(packagePath, pkg);
	}
	const rootPackagePath = join(root, "package.json");
	const rootPackage = readJson(rootPackagePath);
	rootPackage.version = version;
	writeJson(rootPackagePath, rootPackage, 2);

	for (const relativePath of PLUGIN_MANIFESTS) {
		const manifestPath = join(root, relativePath);
		const manifest = readJson(manifestPath);
		manifest.version = version;
		writeJson(manifestPath, manifest, 2);
	}
}

export function missingReleaseAssets(assets) {
	const names = new Set(assets.map((asset) => (typeof asset === "string" ? asset : asset.name)));
	return EXPECTED_RELEASE_ASSETS.filter((name) => !names.has(name));
}

function githubDownloadHeaders(token) {
	const headers = { Accept: "application/octet-stream", "User-Agent": "draht-release" };
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function downloadReleaseAsset(asset, { fetchImpl, token }) {
	if (!asset) throw new Error("Required release asset is missing");
	const url = asset.url ?? asset.browser_download_url;
	if (!url) throw new Error(`Release asset ${asset.name} has no download URL`);
	const response = await fetchImpl(url, { headers: githubDownloadHeaders(token) });
	if (!response.ok) {
		throw new Error(`Downloading release asset ${asset.name} returned ${response.status} ${response.statusText}`.trim());
	}
	return Buffer.from(await response.arrayBuffer());
}

export async function validateReleaseArtifacts({
	tag,
	version,
	release,
	fetchImpl = globalThis.fetch,
	token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
}) {
	if (release.tag_name !== tag) throw new Error(`GitHub release tag ${release.tag_name} does not match requested ${tag}`);
	if (!Array.isArray(release.assets)) throw new Error("GitHub release has no assets array");
	const missing = missingReleaseAssets(release.assets);
	if (missing.length) throw new Error(`GitHub release is missing required assets: ${missing.join(", ")}`);
	const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
	const manifestAsset = assets.get("manifest.json");
	const manifestBytes = await downloadReleaseAsset(manifestAsset, { fetchImpl, token });
	let manifest;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch (error) {
		throw new Error(`Graph manifest is not valid JSON: ${error.message}`, { cause: error });
	}
	if (manifest.schemaVersion !== 1) {
		throw new Error(`Graph manifest schemaVersion ${manifest.schemaVersion} does not match supported 1`);
	}
	if (manifest.name !== "draht-graph") {
		throw new Error(`Graph manifest name ${manifest.name} does not match expected draht-graph`);
	}
	if (manifest.version !== version) {
		throw new Error(`Graph manifest version ${manifest.version} does not match requested ${version}`);
	}
	if (manifest.tag !== tag) throw new Error(`Graph manifest tag ${manifest.tag} does not match requested ${tag}`);
	if (!Array.isArray(manifest.artifacts)) throw new Error("Graph manifest artifacts must be an array");
	const seenPlatforms = new Set();
	for (const artifact of manifest.artifacts) {
		if (seenPlatforms.has(artifact.platform)) throw new Error(`Graph manifest has duplicate platform ${artifact.platform}`);
		seenPlatforms.add(artifact.platform);
	}
	const unexpectedPlatforms = [...seenPlatforms].filter((platform) => !GRAPH_PLATFORMS.includes(platform));
	if (unexpectedPlatforms.length) {
		throw new Error(`Graph manifest has unexpected platforms: ${unexpectedPlatforms.join(", ")}`);
	}
	const missingPlatforms = GRAPH_PLATFORMS.filter((platform) => !seenPlatforms.has(platform));
	if (missingPlatforms.length) throw new Error(`Graph manifest is missing platforms: ${missingPlatforms.join(", ")}`);
	await Promise.all(
		manifest.artifacts.map(async (artifact) => {
			const metadata = GRAPH_PLATFORM_METADATA[artifact.platform];
			const expectedArchive = `draht-graph-${artifact.platform}${artifact.platform === "windows-x64" ? ".zip" : ".tar.gz"}`;
			if (artifact.archive !== expectedArchive) {
				throw new Error(`Graph platform ${artifact.platform} archive must be ${expectedArchive}; got ${artifact.archive}`);
			}
			if (!Number.isSafeInteger(artifact.archiveBytes) || artifact.archiveBytes < 0) {
				throw new Error(`Graph platform ${artifact.platform} archiveBytes must be a non-negative integer`);
			}
			if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256)) {
				throw new Error(`Graph platform ${artifact.platform} archiveSha256 must be a lowercase SHA-256 digest`);
			}
			if (artifact.goos !== metadata.goos || artifact.goarch !== metadata.goarch || artifact.binary !== metadata.binary) {
				throw new Error(`Graph platform ${artifact.platform} metadata must be ${metadata.goos}/${metadata.goarch}/${metadata.binary}`);
			}
			if (!Number.isSafeInteger(artifact.binaryBytes) || artifact.binaryBytes < 0) {
				throw new Error(`Graph platform ${artifact.platform} binaryBytes must be a non-negative integer`);
			}
			if (!/^[0-9a-f]{64}$/.test(artifact.binarySha256)) {
				throw new Error(`Graph platform ${artifact.platform} binarySha256 must be a lowercase SHA-256 digest`);
			}
			const releaseAsset = assets.get(artifact.archive);
			if (!releaseAsset) throw new Error(`Required release asset ${artifact.archive} is missing`);
			if (releaseAsset.size !== artifact.archiveBytes) {
				throw new Error(
					`Archive size for ${artifact.platform}: GitHub reports ${releaseAsset.size}, manifest reports ${artifact.archiveBytes}`,
				);
			}
			const bytes = await downloadReleaseAsset(releaseAsset, { fetchImpl, token });
			if (bytes.length !== artifact.archiveBytes) {
				throw new Error(
					`Downloaded size for ${artifact.platform} is ${bytes.length}; manifest reports ${artifact.archiveBytes}`,
				);
			}
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== artifact.archiveSha256) {
				throw new Error(`Downloaded SHA-256 for ${artifact.platform} is ${digest}; manifest reports ${artifact.archiveSha256}`);
			}
		}),
	);
	return manifest;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForVerifiedRelease({
	tag,
	version,
	getRelease = getGithubRelease,
	attempts = 60,
	intervalMs = 10_000,
	sleep = delay,
	fetchImpl = globalThis.fetch,
	token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const release = await getRelease(tag, { fetchImpl, token });
			return await validateReleaseArtifacts({ tag, version, release, fetchImpl, token });
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) await sleep(intervalMs);
	}
	throw new Error(`Release ${tag} did not pass artifact verification: ${lastError.message}`, { cause: lastError });
}

export async function getGithubRelease(
	tag,
	{ fetchImpl = globalThis.fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN } = {},
) {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "draht-release",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchImpl(`https://api.github.com/repos/draht-dev/draht/releases/tags/${encodeURIComponent(tag)}`, {
		headers,
	});
	if (!response.ok) {
		throw new Error(`GitHub release API returned ${response.status} ${response.statusText}`.trim());
	}
	const release = await response.json();
	if (!Array.isArray(release.assets)) throw new Error("GitHub release API response has no assets array");
	return release;
}

export async function listGithubReleaseAssets(tag, options = {}) {
	return (await getGithubRelease(tag, options)).assets;
}
