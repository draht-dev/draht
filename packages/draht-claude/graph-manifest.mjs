const MANIFEST_SCHEMA_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

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

export function validateGraphManifest(manifest, { version, tag, platform, commit }) {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) invalid("document must be an object");
	if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) invalid(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
	if (manifest.name !== "draht-graph") invalid("name must be draht-graph");
	const expectedVersion = version.startsWith("v") ? version.slice(1) : version;
	const expectedTag = tag || `v${expectedVersion}`;
	if (manifest.version !== expectedVersion) invalid(`version must be ${expectedVersion}`);
	if (manifest.tag !== expectedTag) invalid(`tag must be ${expectedTag}`);
	if (typeof manifest.gitCommit !== "string" || !COMMIT_RE.test(manifest.gitCommit)) invalid("gitCommit must be a lowercase 40-character commit SHA");
	if (commit && manifest.gitCommit !== commit) invalid(`gitCommit must be the ${expectedTag} release commit ${commit}`);
	if (!Array.isArray(manifest.artifacts)) invalid("artifacts must be an array");
	const expected = PLATFORM_METADATA[platform];
	if (!expected) invalid(`unsupported platform ${platform}`);
	const entry = manifest.artifacts.find((artifact) => artifact?.platform === platform);
	if (!entry) invalid(`missing artifact for ${platform}`);
	for (const field of ["goos", "goarch", "archive", "binary"]) {
		if (entry[field] !== expected[field]) invalid(`${platform} ${field} must be ${expected[field]}`);
	}
	for (const field of ["archiveSha256", "binarySha256"]) {
		if (typeof entry[field] !== "string" || !SHA256_RE.test(entry[field])) invalid(`${platform} ${field} must be a lowercase SHA-256 digest`);
	}
	for (const field of ["archiveBytes", "binaryBytes"]) {
		if (!Number.isSafeInteger(entry[field]) || entry[field] <= 0) invalid(`${platform} ${field} must be a positive integer`);
	}
	return entry;
}

export function validateGraphChecksums(text, entry, platform) {
	const sums = new Map();
	for (const line of String(text).split(/\r?\n/)) {
		if (!line) continue;
		const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)$/.exec(line);
		if (!match || sums.has(match[2])) throw new Error("invalid graph SHA256SUMS");
		sums.set(match[2], match[1]);
	}
	if (sums.get(entry.archive) !== entry.archiveSha256) throw new Error(`SHA256SUMS is not bound to ${entry.archive}`);
	if (sums.get(`${platform}/${entry.binary}`) !== entry.binarySha256) throw new Error(`SHA256SUMS is not bound to ${platform}/${entry.binary}`);
}

export function validateGraphAttestation(output, { archive, digest, repo, commit }) {
	let records;
	try { records = JSON.parse(output); } catch { throw new Error("gh attestation output is not JSON"); }
	if (!Array.isArray(records)) records = [records];
	for (const record of records) {
		const extensions = record?.verificationResult?.signature?.certificate?.extensions;
		if (extensions?.sourceRepositoryURI !== `https://github.com/${repo}` || extensions?.sourceRepositoryDigest !== commit || extensions?.runnerEnvironment !== "github-hosted") continue;
		const envelope = record?.attestation?.bundle?.dsseEnvelope;
		if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") continue;
		let statement;
		try { statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")); } catch { continue; }
		if (!statement || !Array.isArray(statement.subject)) continue;
		const subject = statement.subject.find((item) => item?.name === archive && item?.digest?.sha256 === digest);
		const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
		const source = Array.isArray(dependencies) && dependencies.some((item) =>
			item?.uri === `git+https://github.com/${repo}` && item?.digest?.gitCommit === commit);
		if (subject && source) return;
	}
	throw new Error(`gh provenance attestation is not structurally bound to ${archive}, ${repo}, and ${commit}`);
}
