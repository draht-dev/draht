export function getDrahtUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `draht/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
