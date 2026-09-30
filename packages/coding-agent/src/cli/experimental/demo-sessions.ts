// Prototype-only shared catalog. Remove this once parent and worker resolve
// sessions from the same durable repository.
export const DEMO_SESSION_IDS = ["demo-1", "demo-2"] as const;

export type DemoSessionId = (typeof DEMO_SESSION_IDS)[number];

export function isDemoSessionId(value: string): value is DemoSessionId {
	return DEMO_SESSION_IDS.some((sessionId) => sessionId === value);
}
