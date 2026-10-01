import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const workflowDir = join(root, ".github", "workflows");
const workflowPaths = readdirSync(workflowDir)
	.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
	.map((name) => join(workflowDir, name))
	.sort();

function findActionManifests(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...findActionManifests(entryPath));
		} else if (entry.name === "action.yml" || entry.name === "action.yaml") {
			found.push(entryPath);
		}
	}
	return found;
}

const actionPaths = [...findActionManifests(join(root, ".github", "actions")), join(root, "packages", "ci", "action.yml")].sort();

const failures = [];

for (const path of [...workflowPaths, ...actionPaths]) {
	const source = readFileSync(path, "utf8");
	const displayPath = relative(root, path);
	for (const match of source.matchAll(/^[ \t]*-?[ \t]*uses:[ \t]*([^\s#]+)(?:[ \t]+#[ \t]*(.+))?$/gm)) {
		const target = match[1];
		if (target.startsWith("./") || target.startsWith("docker://")) continue;

		const separator = target.lastIndexOf("@");
		const ref = separator === -1 ? "" : target.slice(separator + 1);
		if (!/^[0-9a-f]{40}$/.test(ref)) {
			failures.push(`${displayPath}: external action must use a full commit SHA: ${target}`);
		}
	}
}

/** Indentation of the `jobs:` entries themselves is assumed to be the file's
 * step unit; a job's own `permissions:` key is expected one step deeper, which
 * this derives from the job key's own indentation rather than hardcoding it. */
for (const path of workflowPaths) {
	const source = readFileSync(path, "utf8");
	const displayPath = relative(root, path);
	if (!/^permissions:\s*\{\}\s*$/m.test(source)) {
		failures.push(`${displayPath}: workflow must deny permissions by default with top-level permissions: {}`);
	}

	const jobsMatch = source.match(/^jobs:[ \t]*$([\s\S]*)/m);
	if (!jobsMatch) {
		failures.push(`${displayPath}: missing jobs mapping`);
		continue;
	}

	const jobsSource = jobsMatch[1];
	const jobMatches = [...jobsSource.matchAll(/^([ \t]+)([A-Za-z0-9_-]+):[ \t]*$/gm)].filter((match, index, all) => {
		// Only the shallowest indentation seen in `jobs:` names a job; deeper
		// matches at that indentation are steps/keys within other job bodies,
		// not sibling jobs.
		const shallowest = Math.min(...all.map((m) => m[1].length));
		return match[1].length === shallowest;
	});

	for (let index = 0; index < jobMatches.length; index += 1) {
		const job = jobMatches[index];
		const jobIndent = job[1];
		const start = job.index + job[0].length;
		const end = jobMatches[index + 1]?.index ?? jobsSource.length;
		const body = jobsSource.slice(start, end);
		const permissionsPattern = new RegExp(`^${jobIndent}[ \\t]+permissions:(?:\\s*\\{\\})?\\s*$`, "m");
		if (!permissionsPattern.test(body)) {
			failures.push(`${displayPath}: job ${job[2]} must declare explicit permissions`);
		}
	}
}

const dependabotPath = join(root, ".github", "dependabot.yml");
let dependabotSource = "";
try {
	dependabotSource = readFileSync(dependabotPath, "utf8");
} catch {
	failures.push(".github/dependabot.yml: missing GitHub Actions update configuration");
}
if (dependabotSource && !/package-ecosystem:\s*["']?github-actions["']?/.test(dependabotSource)) {
	failures.push(".github/dependabot.yml: missing github-actions package ecosystem");
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}

console.log(
	`GitHub Actions security policy passed for ${workflowPaths.length} workflows and ${actionPaths.length} local action(s).`,
);
