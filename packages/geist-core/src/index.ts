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
export type { FleetEntry } from "./fleet-registry.js";
export { FleetCapacityError, FleetRegistry, MAX_FLEET_SESSIONS, UnknownSessionError } from "./fleet-registry.js";
export type {
	AdvertisedCommand,
	ReservedVerb,
	ResolutionContext,
	ResolvedBoardNew,
	ResolvedBoardVariants,
	ResolvedCommand,
	ResolvedMessage,
	ResolvedPermission,
	ResolvedUtterance,
} from "./grammar/resolve-utterance.js";
export { resolveUtterance } from "./grammar/resolve-utterance.js";
export type { HarnessCapabilities, HarnessSession, HarnessSessionStatus } from "./harness-session.js";
export type {
	ShaLedgerApproveResult,
	ShaLedgerEntry,
	ShaLedgerRecordResult,
	ShaLedgerUndoResult,
} from "./ledger/sha-ledger.js";
export { isDirtyOrAhead, ShaLedger, ShaLedgerError } from "./ledger/sha-ledger.js";
export type {
	PairingAttemptResult,
	PairingStateOptions,
	PairingStatus,
	ReconnectAttemptResult,
} from "./pairing/pairing-state.js";
export { DEFAULT_RECONNECT_GRACE_MS, generatePairingToken, PairingState } from "./pairing/pairing-state.js";
export type { Project } from "./project.js";
export { buildFleetState } from "./registry/fleet-state-view.js";
export type { ProjectRegistryConfig, ProjectRegistryOptions } from "./registry/project-registry.js";
export { ProjectRegistry } from "./registry/project-registry.js";
export type { RecentsStore } from "./registry/recents-store.js";
export {
	DEFAULT_RECENTS_PATH,
	FileRecentsStore,
	InMemoryRecentsStore,
	RECENTS_CAP,
	touchRecents,
} from "./registry/recents-store.js";
export { discoverWorkspaceProjects, slugify } from "./registry/workspace-discovery.js";
