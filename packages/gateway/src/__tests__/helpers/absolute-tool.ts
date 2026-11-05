/**
 * The child a daemon spawns has a PATH that holds only /bin/sh and /usr/bin/env on NixOS, so a fixture script that
 * calls a bare `mv`, `sleep` or `dd` finds none. Resolve the tool once, in the test process, and write its path in.
 */
export function absoluteTool(name: string): string {
	const found = Bun.which(name);
	if (found === null) throw new Error(`the fixture scripts need \`${name}\` and Bun.which found none on this PATH`);
	return found;
}
