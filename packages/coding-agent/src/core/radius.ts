import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@draht/ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "DRAHT_RADIUS_GATEWAY";

/** Radius gateway origin, honoring the `DRAHT_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}

/** draht's own bug report intake; independent of the Radius model provider's gateway. */
export const DEFAULT_BUG_REPORT_GATEWAY = "https://radius.draht.dev";
export const ENV_BUG_REPORT_GATEWAY = "DRAHT_BUG_REPORT_GATEWAY";

/**
 * Gateway that accepts `/bug` uploads, honoring the `DRAHT_BUG_REPORT_GATEWAY` override.
 *
 * Bug reports go to the draht maintainers' own intake, not the Radius model provider's gateway:
 * configuring a Radius provider must never redirect bug reports to radius.pi.dev.
 */
export function getBugReportGatewayUrl(): string {
	const configured = process.env[ENV_BUG_REPORT_GATEWAY]?.trim();
	return normalizeRadiusGatewayUrl(configured || DEFAULT_BUG_REPORT_GATEWAY);
}
