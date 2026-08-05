const MANIFEST_SCHEMA_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/i;

const PLATFORM_METADATA = Object.freeze({
	"darwin-arm64": { goos: "darwin", goarch: "arm64", archive: "draht-graph-darwin-arm64.tar.gz", binary: "draht-graph" },
	"darwin-x64": { goos: "darwin", goarch: "amd64", archive: "draht-graph-darwin-x64.tar.gz", binary: "draht-graph" },
	"linux-x64": { goos: "linux", goarch: "amd64", archive: "draht-graph-linux-x64.tar.gz", binary: "draht-graph" },
	"linux-arm64": { goos: "linux", goarch: "arm64", archive: "draht-graph-linux-arm64.tar.gz", binary: "draht-graph" },
	"windows-x64": { goos: "windows", goarch: "amd64", archive: "draht-graph-windows-x64.zip", binary: "draht-graph.exe" },
});

function invalid(detail) {
	throw new Error(`invalid graph release manifest: ${detail}`);
}

export function validateGraphManifest(manifest, { version, tag, platform }) {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) invalid("document must be an object");
	if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) invalid(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
	if (manifest.name !== "draht-graph") invalid("name must be draht-graph");
	const expectedVersion = version.startsWith("v") ? version.slice(1) : version;
	const expectedTag = tag || `v${expectedVersion}`;
	if (manifest.version !== expectedVersion) invalid(`version must be ${expectedVersion}`);
	if (manifest.tag !== expectedTag) invalid(`tag must be ${expectedTag}`);
	if (!Array.isArray(manifest.artifacts)) invalid("artifacts must be an array");
	const expected = PLATFORM_METADATA[platform];
	if (!expected) invalid(`unsupported platform ${platform}`);
	const entry = manifest.artifacts.find((artifact) => artifact?.platform === platform);
	if (!entry) invalid(`missing artifact for ${platform}`);
	for (const field of ["goos", "goarch", "archive", "binary"]) {
		if (entry[field] !== expected[field]) invalid(`${platform} ${field} must be ${expected[field]}`);
	}
	for (const field of ["archiveSha256", "binarySha256"]) {
		if (typeof entry[field] !== "string" || !SHA256_RE.test(entry[field])) invalid(`${platform} ${field} must be a SHA-256 digest`);
	}
	for (const field of ["archiveBytes", "binaryBytes"]) {
		if (!Number.isSafeInteger(entry[field]) || entry[field] <= 0) invalid(`${platform} ${field} must be a positive integer`);
	}
	return entry;
}
