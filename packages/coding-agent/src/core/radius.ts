import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@draht/ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "DRAHT_RADIUS_GATEWAY";

/** Radius gateway origin, honoring the `DRAHT_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}

/**
 * Gateway that accepts `/bug` uploads, or `undefined` when none is configured.
 *
 * draht has no default bug report service: the upstream default gateway would send draht users'
 * reports to a third party, so uploads require an explicit `DRAHT_RADIUS_GATEWAY`.
 */
export function getBugReportGatewayUrl(): string | undefined {
	const configured = process.env[ENV_RADIUS_GATEWAY]?.trim();
	return configured ? normalizeRadiusGatewayUrl(configured) : undefined;
}
