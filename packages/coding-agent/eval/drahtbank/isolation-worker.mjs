import { constants, readFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const workspace = await realpath(process.cwd());
const request = JSON.parse(readFileSync(0, "utf8"));
const path = typeof request.path === "string" ? resolve(workspace, request.path) : "";
const descendant = relative(workspace, path);
const artifact = /^\/\.drahtbank\/artifacts\/[a-f0-9-]+\.txt$/.test(path);
const artifactRead = artifact && ["read", "access", "stat"].includes(request.op);
if (!artifactRead && (!path || (descendant && (isAbsolute(descendant) || descendant === ".." || descendant.startsWith("../"))))) {
	throw new Error("Drahtbank filesystem operation is outside the fixture workspace");
}
try {
	let value = null;
	switch (request.op) {
		case "read":
			value = (await readFile(path)).toString("base64");
			break;
		case "write":
			if (typeof request.content !== "string" || !["utf8", "base64"].includes(request.encoding ?? "utf8")) {
				throw new Error("Invalid filesystem write request");
			}
			await writeFile(path, request.content, request.encoding ?? "utf8");
			break;
		case "mkdir":
			await mkdir(path, { recursive: true });
			break;
		case "access":
			if (!Number.isInteger(request.mode ?? 0) || ((request.mode ?? 0) & ~7) !== 0) {
				throw new Error("Invalid filesystem access mode");
			}
			await access(path, request.mode ?? constants.F_OK);
			break;
		case "stat": {
			const entry = await stat(path);
			value = { isDirectory: entry.isDirectory(), isFile: entry.isFile(), isSymbolicLink: entry.isSymbolicLink() };
			break;
		}
		case "readdir":
			value = await readdir(path);
			break;
		default:
			throw new Error("Unknown Drahtbank filesystem operation");
	}
	process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({
		ok: false,
		message: error instanceof Error ? error.message : "Filesystem operation failed",
		code: typeof error?.code === "string" ? error.code : undefined,
	})}\n`);
}
