export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.DRAHT_EXPERIMENTAL === "1";
}
