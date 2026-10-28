/** Two-letter avatar initials from a repo or display name, e.g. "draht-mono" -> "DM". */
export function initials(name: string): string {
	return name
		.split(/[\s-_/]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");
}
