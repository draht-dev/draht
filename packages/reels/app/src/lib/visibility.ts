/** The id with the highest intersection ratio, or `undefined` if nothing is visible. */
export function pickMostVisible(ratios: ReadonlyMap<string, number>): string | undefined {
	let bestId: string | undefined;
	let bestRatio = 0;
	for (const [id, ratio] of ratios) {
		if (ratio > bestRatio) {
			bestRatio = ratio;
			bestId = id;
		}
	}
	return bestId;
}
