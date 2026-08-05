#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const platforms = process.argv.slice(2);
if (platforms.length === 0) throw new Error("at least one runtime platform is required");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function filesUnder(root, prefix = "") {
  const result = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`runtime payload may not contain symlink ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const member = relative(root, absolute).split(sep).join(posix.sep);
        result.push(prefix ? `${prefix}/${member}` : member);
      } else throw new Error(`unsupported runtime payload entry ${absolute}`);
    }
  }
  visit(root);
  return result.sort();
}
const version = JSON.parse(readFileSync("../../../package.json", "utf8")).version;
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: "../../.." }).trim();
const artifacts = platforms.map((platform) => {
  const windows = platform === "windows-x64";
  const archive = `draht-${platform}${windows ? ".zip" : ".tar.gz"}`;
  const binary = windows ? "draht.exe" : "draht";
  const binaryPath = join(platform, binary);
  return {
    platform,
    archive,
    archiveSha256: sha256(archive),
    archiveBytes: statSync(archive).size,
    binary,
    binarySha256: sha256(binaryPath),
    binaryBytes: statSync(binaryPath).size,
    files: filesUnder(platform, windows ? "" : "draht"),
  };
});
writeFileSync("runtime-manifest.json", `${JSON.stringify({ schemaVersion: 1, name: "draht", version, tag: `v${version}`, gitCommit, artifacts }, null, 2)}\n`);
