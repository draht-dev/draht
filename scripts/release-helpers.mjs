import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

export const RELEASE_IO_LIMITS = Object.freeze({
	perAssetBytes: 256 * 1024 * 1024,
	manifestBytes: 2 * 1024 * 1024,
	checksumBytes: 2 * 1024 * 1024,
	archiveBytes: 256 * 1024 * 1024,
	extractedBinaryBytes: 256 * 1024 * 1024,
	decompressedBytes: 512 * 1024 * 1024,
	aggregateDownloadBytes: 1024 * 1024 * 1024,
});
const MAX_ARCHIVE_LISTING_BYTES = 16 * 1024 * 1024;

export const EXPECTED_RELEASE_ASSETS = Object.freeze([
	"draht-darwin-arm64.tar.gz",
	"draht-darwin-x64.tar.gz",
	"draht-linux-x64.tar.gz",
	"draht-linux-arm64.tar.gz",
	"draht-windows-x64.zip",
	"runtime-manifest.json",
	"DRAHT-SHA256SUMS",
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

export function requiredBunVersion(root) {
	const value = readJson(join(root, "package.json")).packageManager;
	const match = /^bun@(.+)$/.exec(value ?? "");
	if (!match) throw new Error("package.json packageManager must pin an exact Bun version");
	return match[1];
}

export function requiredBunRevision(root) {
	const value = readJson(join(root, "package.json")).drahtReleaseBunRevision;
	if (!/^\d+\.\d+\.\d+-canary\.\d+\+[0-9a-f]+$/.test(value ?? "")) {
		throw new Error("package.json drahtReleaseBunRevision must pin an exact Bun canary revision");
	}
	return value;
}

export function assertBunToolchain(
	root,
	getRevision = () => execFileSync("bun", ["--revision"], { encoding: "utf8" }).trim(),
) {
	const expected = requiredBunRevision(root);
	const actual = getRevision();
	if (actual !== expected) throw new Error(`Bun revision ${actual} does not match required ${expected}`);
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
	const lockPath = join(root, "bun.lock");
	if (existsSync(lockPath)) {
		const lock = readFileSync(lockPath, "utf8");
		for (const dirent of readdirSync(join(root, "packages"), { withFileTypes: true })) {
			if (!dirent.isDirectory() || !existsSync(join(root, "packages", dirent.name, "package.json"))) continue;
			const escaped = dirent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const match = lock.match(new RegExp(`"packages/${escaped}"\\s*:\\s*\\{[\\s\\S]{0,500}?"version"\\s*:\\s*"([^"]+)"`));
			if (!match || match[1] !== version) stale.push(`${lockPath} workspace packages/${dirent.name} has ${match?.[1] ?? "no version"}; expected ${version}`);
		}
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
	const lockPath = join(root, "bun.lock");
	if (existsSync(lockPath)) {
		let lock = readFileSync(lockPath, "utf8");
		for (const { packagePath } of packages) {
			const dir = packagePath.split(/[\\/]/).at(-2);
			const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`("packages/${escaped}"\\s*:\\s*\\{[\\s\\S]{0,500}?"version"\\s*:\\s*")[^"]+`);
			if (!pattern.test(lock)) throw new Error(`bun.lock has no versioned workspace entry for packages/${dir}`);
			lock = lock.replace(pattern, `$1${version}`);
		}
		writeFileSync(lockPath, lock);
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

function releaseAssetLimit(name) {
	if (name === "manifest.json" || name === "runtime-manifest.json") return RELEASE_IO_LIMITS.manifestBytes;
	if (name === "SHA256SUMS" || name === "DRAHT-SHA256SUMS") return RELEASE_IO_LIMITS.checksumBytes;
	return RELEASE_IO_LIMITS.archiveBytes;
}

async function downloadReleaseAsset(asset, { fetchImpl, token, limit, aggregate }) {
	if (!asset) throw new Error("Required release asset is missing");
	const url = asset.url ?? asset.browser_download_url;
	if (!url) throw new Error(`Release asset ${asset.name} has no download URL`);
	const response = await fetchImpl(url, { headers: githubDownloadHeaders(token) });
	if (!response.ok) {
		throw new Error(`Downloading release asset ${asset.name} returned ${response.status} ${response.statusText}`.trim());
	}
	const boundedLimit = Math.min(limit, asset.size);
	const contentLength = Number(response.headers?.get?.("content-length"));
	if (Number.isFinite(contentLength) && contentLength > boundedLimit) throw new Error(`Release asset ${asset.name} Content-Length exceeds its ${boundedLimit} byte limit`);
	if (!response.body?.getReader) throw new Error(`Release asset ${asset.name} response body is not a readable stream`);
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > boundedLimit) throw new Error(`Release asset ${asset.name} exceeds its declared ${boundedLimit} byte limit`);
			if (aggregate.bytes + size > RELEASE_IO_LIMITS.aggregateDownloadBytes) throw new Error("Release asset downloads exceed aggregate byte limit");
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	}
	aggregate.bytes += size;
	return Buffer.concat(chunks, size);
}

function digestBytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function parseChecksums(bytes, label) {
	const result = new Map();
	const text = bytes.toString("utf8");
	if (!text.endsWith("\n")) throw new Error(`${label} must end with a newline`);
	for (const line of text.split("\n").filter(Boolean)) {
		const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/);
		if (!match || result.has(match?.[2])) throw new Error(`${label} is malformed or has duplicate entries`);
		result.set(match[2], match[1]);
	}
	return result;
}

function inspectArchive(bytes, archive, { wrapper, binary, expectedFiles, maxExpandedBytes }) {
	const temp = mkdtempSync(join(tmpdir(), "draht-release-archive-"));
	const archivePath = join(temp, archive.endsWith(".zip") ? "asset.zip" : "asset.tar.gz");
	try {
		writeFileSync(archivePath, bytes);
		const zip = archive.endsWith(".zip");
		const listing = execFileSync(zip ? "unzip" : "tar", zip ? ["-Z1", archivePath] : ["-tzf", archivePath], {
			encoding: "utf8",
			maxBuffer: MAX_ARCHIVE_LISTING_BYTES,
		});
		const allMembers = listing.split("\n").filter(Boolean);
		if (new Set(allMembers).size !== allMembers.length) throw new Error("duplicate archive member names");
		const metadata = execFileSync(zip ? "zipinfo" : "tar", zip ? ["-l", archivePath] : ["-tvzf", archivePath], {
			encoding: "utf8",
			maxBuffer: MAX_ARCHIVE_LISTING_BYTES,
		});
		const expandedBytes = zip
			? execFileSync("unzip", ["-l", archivePath], { encoding: "utf8", maxBuffer: MAX_ARCHIVE_LISTING_BYTES })
				.split("\n").map((line) => /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s/.exec(line)?.[1]).filter(Boolean).reduce((sum, value) => sum + Number(value), 0)
			: metadata.split("\n").map((line) => /^\S+\s+\S+\s+(\d+)\s/.exec(line)?.[1]).filter(Boolean).reduce((sum, value) => sum + Number(value), 0);
		if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxExpandedBytes) throw new Error(`archive expanded size ${expandedBytes} exceeds decompression limit ${maxExpandedBytes}`);
		const entryTypes = zip
			? metadata.split("\n").filter((line) => /^[bcdlps-][rwxStTs-]{9}\s/.test(line)).map((line) => line[0])
			: metadata.split("\n").filter(Boolean).map((line) => line[0]);
		if (entryTypes.length !== allMembers.length || entryTypes.some((type) => type !== "-" && type !== "d")) {
			throw new Error("archive contains a link, device, FIFO, or other special entry type");
		}
		const members = allMembers.filter((name) => !name.endsWith("/"));
		if (!members.length || members.some((name) => name.startsWith("/") || name.split("/").includes(".."))) throw new Error("empty or unsafe payload");
		if (expectedFiles && JSON.stringify([...members].sort()) !== JSON.stringify([...expectedFiles].sort())) throw new Error("payload does not exactly match manifest contract");
		if (!expectedFiles && wrapper && members.some((name) => !name.startsWith(`${wrapper}/`))) throw new Error(`payload outside ${wrapper}/`);
		const binaryMember = wrapper ? `${wrapper}/${binary}` : binary;
		if (members.filter((name) => name === binaryMember).length !== 1) throw new Error(`expected exactly one ${binaryMember}`);
		const binaryBytes = execFileSync(
			zip ? "unzip" : "tar",
			zip ? ["-p", archivePath, binaryMember] : ["-xOzf", archivePath, binaryMember],
			{ maxBuffer: RELEASE_IO_LIMITS.extractedBinaryBytes },
		);
		return { members, binaryBytes };
	} catch (error) {
		throw new Error(`Invalid archive ${archive}: ${error.message}`, { cause: error });
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

const GITHUB_REPOSITORY_URL = "https://github.com/draht-dev/draht";
const GITHUB_SOURCE_URI = "git+https://github.com/draht-dev/draht";
const RELEASE_WORKFLOW_PATH = ".github/workflows/build-binaries.yml";

function isExpectedGithubProvenance(statement, { subjectDigest, commit, tag }) {
	const workflowRef = `refs/tags/${tag}`;
	const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
	const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
	return statement?._type === "https://in-toto.io/Statement/v1"
		&& statement?.predicateType === "https://slsa.dev/provenance/v1"
		&& statement?.predicate?.buildDefinition?.buildType === "https://actions.github.io/buildtypes/workflow/v1"
		&& Array.isArray(statement?.subject)
		&& statement.subject.some((subject) => subject?.digest?.sha256 === subjectDigest)
		&& workflow?.repository === GITHUB_REPOSITORY_URL
		&& workflow?.ref === workflowRef
		&& workflow?.path === RELEASE_WORKFLOW_PATH
		&& Array.isArray(dependencies)
		&& dependencies.some((dependency) => dependency?.uri === `${GITHUB_SOURCE_URI}@${workflowRef}` && dependency?.digest?.gitCommit === commit)
		&& statement?.predicate?.runDetails?.builder?.id === `${GITHUB_REPOSITORY_URL}/${RELEASE_WORKFLOW_PATH}@${workflowRef}`;
}

export async function verifyGithubAttestation({ name, digest: subjectDigest, commit, tag, fetchImpl, token }) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "draht-release", "X-GitHub-Api-Version": "2022-11-28" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchImpl(`https://api.github.com/repos/draht-dev/draht/attestations/sha256:${subjectDigest}`, { headers });
	if (!response.ok) throw new Error(`GitHub attestation lookup failed with ${response.status}`);
	const body = await response.json();
	if (!Array.isArray(body.attestations) || body.attestations.length === 0) throw new Error(`Required GitHub attestation is missing for sha256:${subjectDigest}`);
	const matches = body.attestations.some((attestation) => {
		try {
			const payload = attestation.bundle?.dsseEnvelope?.payload;
			const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
			return isExpectedGithubProvenance(statement, { subjectDigest, commit, tag });
		} catch {
			return false;
		}
	});
	if (!matches) throw new Error(`GitHub attestation for ${name} is not bound to draht-dev/draht commit ${commit} and ${RELEASE_WORKFLOW_PATH} at ${tag}`);
}

export async function validateReleaseArtifacts({
	tag,
	version,
	commit,
	release,
	fetchImpl = globalThis.fetch,
	token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
	verifyAttestation = verifyGithubAttestation,
}) {
	if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("Expected release commit must be an immutable 40-character Git SHA");
	if (release.tag_name !== tag) throw new Error(`GitHub release tag ${release.tag_name} does not match requested ${tag}`);
	if (!Array.isArray(release.assets)) throw new Error("GitHub release has no assets array");
	const assetNames = release.assets.map((asset) => asset?.name);
	const duplicateNames = [...new Set(assetNames.filter((name, index) => assetNames.indexOf(name) !== index))];
	if (duplicateNames.length) throw new Error(`GitHub release has duplicate asset names: ${duplicateNames.join(", ")}`);
	const unexpected = assetNames.filter((name) => !EXPECTED_RELEASE_ASSETS.includes(name));
	if (unexpected.length) throw new Error(`GitHub release has unexpected assets: ${unexpected.join(", ")}`);
	const missing = missingReleaseAssets(release.assets);
	if (missing.length) throw new Error(`GitHub release is missing required assets: ${missing.join(", ")}`);
	const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
	let declaredAggregate = 0;
	for (const name of EXPECTED_RELEASE_ASSETS) {
		const asset = assets.get(name);
		const limit = Math.min(RELEASE_IO_LIMITS.perAssetBytes, releaseAssetLimit(name));
		if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) {
			throw new Error(`Release asset ${name} must have a positive bounded size within its ${limit} byte limit`);
		}
		declaredAggregate += asset.size;
	}
	if (declaredAggregate > RELEASE_IO_LIMITS.aggregateDownloadBytes) throw new Error("Release asset declared sizes exceed aggregate byte limit");
	const aggregate = { bytes: 0 };
	const downloaded = new Map();
	const controlAssets = ["manifest.json", "runtime-manifest.json", "SHA256SUMS", "DRAHT-SHA256SUMS"];
	for (const name of controlAssets) {
		const asset = assets.get(name);
		const bytes = await downloadReleaseAsset(asset, { fetchImpl, token, limit: releaseAssetLimit(name), aggregate });
		downloaded.set(name, bytes);
	}
	const manifestAsset = assets.get("manifest.json");
	const manifestBytes = downloaded.get(manifestAsset.name);
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
	if (manifest.gitCommit !== commit) throw new Error(`Graph manifest gitCommit ${manifest.gitCommit} does not match release commit ${commit}`);
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
	for (const artifact of manifest.artifacts) {
			const metadata = GRAPH_PLATFORM_METADATA[artifact.platform];
			const expectedArchive = `draht-graph-${artifact.platform}${artifact.platform === "windows-x64" ? ".zip" : ".tar.gz"}`;
			if (artifact.archive !== expectedArchive) {
				throw new Error(`Graph platform ${artifact.platform} archive must be ${expectedArchive}; got ${artifact.archive}`);
			}
			if (!Number.isSafeInteger(artifact.archiveBytes) || artifact.archiveBytes <= 0 || artifact.archiveBytes > RELEASE_IO_LIMITS.archiveBytes) {
				throw new Error(`Graph platform ${artifact.platform} archiveBytes must be a positive integer`);
			}
			if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256)) {
				throw new Error(`Graph platform ${artifact.platform} archiveSha256 must be a lowercase SHA-256 digest`);
			}
			if (artifact.goos !== metadata.goos || artifact.goarch !== metadata.goarch || artifact.binary !== metadata.binary) {
				throw new Error(`Graph platform ${artifact.platform} metadata must be ${metadata.goos}/${metadata.goarch}/${metadata.binary}`);
			}
			if (!Number.isSafeInteger(artifact.binaryBytes) || artifact.binaryBytes <= 0 || artifact.binaryBytes > RELEASE_IO_LIMITS.extractedBinaryBytes) {
				throw new Error(`Graph platform ${artifact.platform} binaryBytes must be a positive integer`);
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
			const bytes = await downloadReleaseAsset(releaseAsset, { fetchImpl, token, limit: RELEASE_IO_LIMITS.archiveBytes, aggregate });
			if (bytes.length !== artifact.archiveBytes) {
				throw new Error(
					`Downloaded size for ${artifact.platform} is ${bytes.length}; manifest reports ${artifact.archiveBytes}`,
				);
			}
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== artifact.archiveSha256) {
				throw new Error(`Downloaded SHA-256 for ${artifact.platform} is ${digest}; manifest reports ${artifact.archiveSha256}`);
			}
			const exactFiles = [`draht-graph/${artifact.binary}`, "draht-graph/README.md", "draht-graph/LICENSE"];
			const inspected = inspectArchive(bytes, artifact.archive, {
				wrapper: "draht-graph",
				binary: artifact.binary,
				expectedFiles: exactFiles,
				maxExpandedBytes: Math.min(RELEASE_IO_LIMITS.decompressedBytes, artifact.binaryBytes + 16 * 1024 * 1024),
			});
			if (inspected.binaryBytes.length !== artifact.binaryBytes || digestBytes(inspected.binaryBytes) !== artifact.binarySha256) throw new Error(`Graph binary payload for ${artifact.platform} does not match manifest size/hash`);
			await verifyAttestation({ name: artifact.archive, digest, fetchImpl, token, tag, commit });
	}

	let runtimeManifest;
	try { runtimeManifest = JSON.parse(downloaded.get("runtime-manifest.json").toString("utf8")); }
	catch (error) { throw new Error(`Runtime manifest is not valid JSON: ${error.message}`, { cause: error }); }
	if (runtimeManifest.schemaVersion !== 1 || runtimeManifest.name !== "draht" || runtimeManifest.version !== version || runtimeManifest.tag !== tag || runtimeManifest.gitCommit !== commit) throw new Error("Runtime manifest identity does not match the immutable release tag/commit");
	if (!Array.isArray(runtimeManifest.artifacts) || runtimeManifest.artifacts.length !== GRAPH_PLATFORMS.length) throw new Error("Runtime manifest must contain exactly five platform artifacts");
	const runtimePlatforms = new Set();
	for (const artifact of runtimeManifest.artifacts) {
		if (!GRAPH_PLATFORMS.includes(artifact.platform) || runtimePlatforms.has(artifact.platform)) throw new Error(`Runtime manifest has invalid/duplicate platform ${artifact.platform}`);
		runtimePlatforms.add(artifact.platform);
		const expectedArchive = `draht-${artifact.platform}${artifact.platform === "windows-x64" ? ".zip" : ".tar.gz"}`;
		const expectedBinary = artifact.platform === "windows-x64" ? "draht.exe" : "draht";
		if (artifact.archive !== expectedArchive || artifact.binary !== expectedBinary) throw new Error(`Runtime platform ${artifact.platform} has non-canonical archive/binary names`);
		if (
			!Number.isSafeInteger(artifact.archiveBytes) || artifact.archiveBytes <= 0 || artifact.archiveBytes > RELEASE_IO_LIMITS.archiveBytes ||
			!Number.isSafeInteger(artifact.binaryBytes) || artifact.binaryBytes <= 0 || artifact.binaryBytes > RELEASE_IO_LIMITS.extractedBinaryBytes
		) throw new Error(`Runtime platform ${artifact.platform} sizes must be positive bounded integers`);
		if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256) || !/^[0-9a-f]{64}$/.test(artifact.binarySha256)) throw new Error(`Runtime platform ${artifact.platform} hashes must be SHA-256`);
		const bytes = await downloadReleaseAsset(assets.get(expectedArchive), { fetchImpl, token, limit: RELEASE_IO_LIMITS.archiveBytes, aggregate });
		if (assets.get(expectedArchive).size !== artifact.archiveBytes || bytes.length !== artifact.archiveBytes || digestBytes(bytes) !== artifact.archiveSha256) throw new Error(`Runtime archive ${expectedArchive} does not match GitHub size or manifest size/hash`);
		if (!Array.isArray(artifact.files) || artifact.files.length === 0 || artifact.files.some((file) => typeof file !== "string")) throw new Error(`Runtime platform ${artifact.platform} must declare its exact archive members`);
		const inspected = inspectArchive(bytes, expectedArchive, {
			wrapper: artifact.platform === "windows-x64" ? null : "draht",
			binary: expectedBinary,
			expectedFiles: artifact.files,
			maxExpandedBytes: Math.min(RELEASE_IO_LIMITS.decompressedBytes, artifact.binaryBytes + 16 * 1024 * 1024),
		});
		if (inspected.binaryBytes.length !== artifact.binaryBytes || digestBytes(inspected.binaryBytes) !== artifact.binarySha256) throw new Error(`Runtime binary ${expectedBinary} does not match manifest size/hash`);
		await verifyAttestation({ name: expectedArchive, digest: digestBytes(bytes), fetchImpl, token, tag, commit });
	}
	const graphSums = parseChecksums(downloaded.get("SHA256SUMS"), "SHA256SUMS");
	const runtimeSums = parseChecksums(downloaded.get("DRAHT-SHA256SUMS"), "DRAHT-SHA256SUMS");
	for (const artifact of manifest.artifacts) if (graphSums.get(artifact.archive) !== artifact.archiveSha256 || graphSums.get(`${artifact.platform}/${artifact.binary}`) !== artifact.binarySha256) throw new Error(`SHA256SUMS does not cross-check ${artifact.platform}`);
	for (const artifact of runtimeManifest.artifacts) if (runtimeSums.get(artifact.archive) !== artifact.archiveSha256) throw new Error(`DRAHT-SHA256SUMS does not cross-check ${artifact.platform}`);
	for (const name of controlAssets) await verifyAttestation({ name, digest: digestBytes(downloaded.get(name)), fetchImpl, token, tag, commit });
	return manifest;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForVerifiedRelease({
	tag,
	version,
	commit,
	getRelease = getGithubRelease,
	attempts = 60,
	intervalMs = 10_000,
	sleep = delay,
	fetchImpl = globalThis.fetch,
	token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
	verifyAttestation = verifyGithubAttestation,
}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const release = await getRelease(tag, { fetchImpl, token });
			return await validateReleaseArtifacts({ tag, version, commit, release, fetchImpl, token, verifyAttestation });
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
