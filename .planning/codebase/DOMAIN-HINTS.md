# Domain Model Hints

Generated: 2026-07-08 · Filtered during `/map-codebase` review.

Extracted from `packages/*/src` (excludes `node_modules`, `dist`, and vendored third-party code under `packages/landing/.sst/**` and `packages/landing/.astro/**`, which polluted the first auto-generated pass with framework internals like `DnsRecord`/`Binding`/`Component`). This raw sweep feeds `.planning/DOMAIN.md`, which is the canonical, synthesized domain model — read that first.

## Types/Interfaces (potential entities), first 220 real matches

```
./packages/agent/src/agent.ts:97:export interface AgentOptions {
./packages/agent/src/agent.ts:171:export class Agent {
./packages/agent/src/types.ts:41:export type ToolExecutionMode = "sequential" | "parallel";
./packages/agent/src/types.ts:49:export type QueueMode = "all" | "one-at-a-time";
./packages/agent/src/types.ts:129:export interface AgentLoopTurnUpdate {
./packages/agent/src/types.ts:140:export interface AgentLoopConfig extends SimpleStreamOptions {
./packages/agent/src/types.ts:289:export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
./packages/agent/src/types.ts:322:export interface AgentState {
./packages/agent/src/types.ts:350:export interface AgentToolResult<T> {
./packages/agent/src/types.ts:371:export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
./packages/agent/src/types.ts:397:export interface AgentContext {
./packages/agent/src/types.ts:413:export type AgentEvent =
./packages/agent/src/harness/messages.ts:19:export interface BashExecutionMessage {
./packages/agent/src/harness/messages.ts:40:export interface BranchSummaryMessage {
./packages/agent/src/harness/messages.ts:47:export interface CompactionSummaryMessage {
./packages/agent/src/harness/compaction/compaction.ts:21:export interface CompactionDetails {
./packages/agent/src/harness/compaction/compaction.ts:89:export interface CompactionResult<T = unknown> {
./packages/agent/src/harness/compaction/compaction.ts:101:export interface CompactionSettings {
./packages/agent/src/harness/compaction/compaction.ts:149:export interface ContextUsageEstimate {
./packages/agent/src/harness/compaction/branch-summarization.ts:23:export interface BranchSummaryDetails {
./packages/agent/src/harness/types.ts:46:export interface Skill {
./packages/agent/src/harness/types.ts:60:export interface PromptTemplate {
./packages/agent/src/harness/types.ts:122:export class FileError extends Error {
./packages/agent/src/harness/types.ts:146:export class ExecutionError extends Error {
./packages/agent/src/harness/types.ts:161:export class CompactionError extends Error {
./packages/agent/src/harness/types.ts:176:export class BranchSummaryError extends Error {
./packages/agent/src/harness/types.ts:196:export class SessionError extends Error {
./packages/agent/src/harness/types.ts:219:export class AgentHarnessError extends Error {
./packages/agent/src/harness/types.ts:334:export interface SessionTreeEntryBase {
./packages/agent/src/harness/types.ts:409:export type SessionTreeEntry =
./packages/agent/src/harness/types.ts:422:export interface SessionContext {
./packages/agent/src/harness/types.ts:429:export interface SessionMetadata {
./packages/agent/src/harness/types.ts:440:export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
./packages/agent/src/harness/types.ts:456:export type { Session } from "./session/session.ts";
./packages/agent/src/harness/types.ts:468:export interface SessionRepo<
./packages/agent/src/harness/types.ts:492:export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
./packages/agent/src/harness/agent-harness.ts:157:export class AgentHarness<
./packages/agent/src/harness/session/session.ts:82:export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
./packages/agent/src/harness/session/jsonl-repo.ts:38:export class JsonlSessionRepo implements JsonlSessionRepoApi {
./packages/agent/src/harness/session/memory-repo.ts:5:export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
./packages/ai/src/images-models.ts:12:export interface ImagesProvider {
./packages/ai/src/images-models.ts:49:export interface ImagesModels {
./packages/ai/src/auth/credential-store.ts:8:export class InMemoryCredentialStore implements CredentialStore {
./packages/ai/src/auth/types.ts:8:export interface ModelAuth {
./packages/ai/src/auth/types.ts:18:export interface ApiKeyCredential {
./packages/ai/src/auth/types.ts:25:export interface OAuthCredential extends OAuthCredentials {
./packages/ai/src/auth/types.ts:30:export type Credential = ApiKeyCredential | OAuthCredential;
./packages/ai/src/auth/types.ts:47:export interface CredentialStore {
./packages/ai/src/auth/types.ts:79:export interface AuthResult {
./packages/ai/src/auth/types.ts:179:export interface ProviderAuth {
./packages/ai/src/auth/resolve.ts:21:export class ModelsError extends Error {
./packages/ai/src/providers/faux.ts:37:export interface FauxModelDefinition {
./packages/ai/src/utils/event-stream.ts:4:export class EventStream<T, R = T> implements AsyncIterable<T> {
./packages/ai/src/types.ts:15:export type KnownApi =
./packages/ai/src/types.ts:26:export type Api = KnownApi | (string & {});
./packages/ai/src/types.ts:32:export type KnownProvider =
./packages/ai/src/types.ts:68:export type ProviderId = KnownProvider | string;
./packages/ai/src/types.ts:74:export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
./packages/ai/src/types.ts:88:export interface ThinkingBudgets {
./packages/ai/src/types.ts:96:export type CacheRetention = "none" | "short" | "long";
```

_(Full 220-line sweep available by re-running `draht-tools map-codebase`; truncated here for readability — the deduplicated entity list is already captured in `.planning/DOMAIN.md`.)_

## Directory Structure (bounded contexts)

See `.planning/DOMAIN.md` § Bounded Contexts for the synthesized tier breakdown (Platform Kernel / GSD / Business Capability / Delivery-Edge / Distribution). Raw `packages/*` listing:

```
packages/agent packages/ai packages/ci packages/coding-agent packages/compliance
packages/deploy-guardian packages/draht-claude packages/draht-codex packages/draht-tools
packages/gateway packages/infra packages/invoice packages/knowledge packages/landing
packages/mom packages/orchestrator packages/pods packages/router packages/templates
packages/tui packages/web-ui packages/workflows
```

## Notes

- `ThinkingLevel` appears with two different unions in `agent/src/types.ts` (includes `"off"`) and `ai/src/types.ts` (does not) — flagged as a vocabulary conflict in `.planning/DOMAIN.md` Concerns.
- `Session` / `SessionStorage` / `SessionRepo` are defined in `agent/src/harness/` and redefined independently in `coding-agent` and `gateway` — same name, not the same shared type.
