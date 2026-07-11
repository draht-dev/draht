export type {
	ComposeElementContextInput,
	ElementBoundingRect,
	ElementContext,
	ElementContextPage,
	ElementDescriptor,
	SessionId,
} from "./composer/element-context.js";
export { buildCropPath, composeElementContext } from "./composer/element-context.js";
export type {
	SituationPrompt,
	SituationPromptBlock,
	SituationPromptImageBlock,
	SituationPromptPathReferenceBlock,
	SituationPromptTextBlock,
} from "./composer/situation-prompt.js";
export { composeSituationPrompt } from "./composer/situation-prompt.js";
export { FleetCapacityError, FleetRegistry, MAX_FLEET_SESSIONS } from "./fleet-registry.js";
export type { HarnessCapabilities, HarnessSession, HarnessSessionStatus } from "./harness-session.js";
export type {
	PairingAttemptResult,
	PairingStateOptions,
	PairingStatus,
	ReconnectAttemptResult,
} from "./pairing/pairing-state.js";
export { DEFAULT_RECONNECT_GRACE_MS, generatePairingToken, PairingState } from "./pairing/pairing-state.js";
export type { Project } from "./project.js";
