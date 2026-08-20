export type {
	AttachBridgeOptions,
	AttachIdentity,
	AuthorizationRequest,
	AuthorizationVerdict,
	DeviceAuthenticator,
	DeviceAuthResult,
	PresentedCredential,
	RendererConnection,
} from "./attach/attach-bridge.js";
export { AttachBridge, DEFAULT_AUTH_DEADLINE_MS } from "./attach/attach-bridge.js";
export {
	AGENT_DIR_ENV,
	buildFleetFrame,
	listAttachableSessions,
	resolveSocketDir,
	SOCKETS_DIR_NAME,
} from "./attach/socket-sessions.js";
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
	GenericPlanEntry,
	GenericPlanUpdateEvent,
	GenericToolCallEvent,
	GenericToolLane,
	Lane,
	PlanLane,
	SubagentLane,
	ToolLaneBase,
} from "./lanes/lane.js";
export { toLane, toPlanLane, toToolLaneBase } from "./lanes/lane.js";
export type { LoopContext } from "./lanes/loop-context.js";
export { readLoopContext } from "./lanes/loop-context.js";
export type { SubagentRecognizer } from "./lanes/subagent-recognizer.js";
export { recognizeSubagentLane, SUBAGENT_RECOGNIZERS } from "./lanes/subagent-recognizer.js";
export type {
	ShaLedgerApproveResult,
	ShaLedgerEntry,
	ShaLedgerRecordResult,
	ShaLedgerUndoResult,
} from "./ledger/sha-ledger.js";
export { isDirtyOrAhead, ShaLedger, ShaLedgerError } from "./ledger/sha-ledger.js";
export type {
	BootstrapToken,
	DeviceMeta,
	DeviceRegistryEvent,
	DeviceRegistryOptions,
	DeviceSummary,
	ExchangeResult,
	RevokeResult,
	RotateResult,
	VerifyResult,
} from "./pairing/device-registry.js";
export {
	DEFAULT_BOOTSTRAP_TTL_MS,
	DEVICE_REGISTRY_PATH_ENV,
	DeviceRegistry,
	DeviceRegistryError,
	resolveDeviceRegistryPath,
} from "./pairing/device-registry.js";
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
export type { Variant, VariantStatus } from "./variants/index.js";
export {
	assignHarnessesRoundRobin,
	EmptyVariantSetError,
	NotAVariantError,
	VariantSet,
	VariantSetResolvedError,
} from "./variants/index.js";
