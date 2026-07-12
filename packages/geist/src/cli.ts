#!/usr/bin/env node
import { resolveConfigPath } from "./index.js";

interface ParsedArgs {
	config?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = {};

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--config" && i + 1 < argv.length) {
			parsed.config = argv[i + 1];
			i++;
		}
	}

	return parsed;
}

const args = parseArgs(process.argv.slice(2));
const configPath = resolveConfigPath({ explicit: args.config });

console.log(`geist: not implemented yet — geist bridge lands in later phases (would use config: ${configPath})`);
process.exit(0);
