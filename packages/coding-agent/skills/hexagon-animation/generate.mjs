#!/usr/bin/env node
// Generates a self-contained, randomized 3D hexagon animation HTML file from template.html.
// No dependencies. See SKILL.md for usage.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function usage(code) {
	console.log(`Usage: node generate.mjs [options]

Options:
  --out <file>      Output HTML file (default: ./hexagon-animation.html)
  --seed <n>        Pin the random seed (default: random on every page load)
  --palette <n>     Pin the palette index 0-7 (default: derived from seed)
  --radius <n>      Hex grid radius, 3-16 (default: derived from seed)
  --speed <n>       Animation speed multiplier, e.g. 0.5 or 2 (default: derived from seed)
  --open            Open the generated file in the default browser
  --help            Show this help`);
	process.exit(code);
}

const opts = { out: "hexagon-animation.html", open: false, config: {} };
const numericKeys = new Set(["seed", "palette", "radius", "speed"]);

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--help" || arg === "-h") usage(0);
	else if (arg === "--open") opts.open = true;
	else if (arg === "--out") opts.out = args[++i];
	else if (arg.startsWith("--") && numericKeys.has(arg.slice(2))) {
		const key = arg.slice(2);
		const value = Number(args[++i]);
		if (!Number.isFinite(value)) {
			console.error(`Invalid value for --${key}`);
			process.exit(1);
		}
		opts.config[key] = value;
	} else {
		console.error(`Unknown option: ${arg}`);
		usage(1);
	}
}

if (!opts.out) {
	console.error("Missing value for --out");
	process.exit(1);
}

const templatePath = join(dirname(fileURLToPath(import.meta.url)), "template.html");
const template = readFileSync(templatePath, "utf-8");

const baked = Object.keys(opts.config).length > 0 ? JSON.stringify(opts.config) : "null";
const marker = /\/\*__CONFIG__\*\/[\s\S]*?\/\*__END_CONFIG__\*\//;
if (!marker.test(template)) {
	console.error("template.html is missing the __CONFIG__ marker");
	process.exit(1);
}
const html = template.replace(marker, `/*__CONFIG__*/ ${baked} /*__END_CONFIG__*/`);

const outPath = resolve(process.cwd(), opts.out);
writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
if (Object.keys(opts.config).length > 0) {
	console.log(`Pinned config: ${baked}`);
} else {
	console.log("Fully random: every page load picks a new seed, palette, and motion parameters.");
}

if (opts.open) {
	const [cmd, cmdArgs] =
		process.platform === "darwin"
			? ["open", [outPath]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", outPath]]
				: ["xdg-open", [outPath]];
	spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
}
