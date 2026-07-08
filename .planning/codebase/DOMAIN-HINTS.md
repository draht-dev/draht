# Domain Model Hints

Generated: 2026-07-08 11:19:57

Extracted from codebase to help identify domain model.

## Types/Interfaces (potential entities)
```
./packages/landing/.astro/content.d.ts:2:	export interface RenderResult {
./packages/landing/.astro/content.d.ts:11:	export interface RenderedContent {
./packages/landing/.astro/content.d.ts:23:	export type CollectionKey = keyof AnyEntryMap;
./packages/landing/.astro/content.d.ts:24:	export type CollectionEntry<C extends CollectionKey> = Flatten<AnyEntryMap[C]>;
./packages/landing/.astro/content.d.ts:26:	export type ContentCollectionKey = keyof ContentEntryMap;
./packages/landing/.astro/content.d.ts:27:	export type DataCollectionKey = keyof DataEntryMap;
./packages/landing/.astro/content.d.ts:34:	export type ReferenceDataEntry<
./packages/landing/.astro/content.d.ts:41:	export type ReferenceContentEntry<
./packages/landing/.astro/content.d.ts:48:	export type ReferenceLiveEntry<C extends keyof LiveContentConfig['collections']> = {
./packages/landing/.astro/content.d.ts:205:	export type ContentConfig = typeof import("../src/content.config.js");
./packages/landing/.astro/content.d.ts:206:	export type LiveContentConfig = never;
./packages/landing/sst-env.d.ts:8:  export interface Resource {
./packages/landing/.sst/platform/functions/cf-ssr-site-router-worker/index.ts:5:export interface Env {
./packages/landing/.sst/platform/functions/cf-static-site-router-worker-experimental/index.ts:3:export interface Env {
./packages/landing/.sst/platform/functions/cf-static-site-router-worker/index.ts:5:export interface Env {
./packages/landing/.sst/platform/functions/vector-handler/index.ts:7:export type PutEvent = {
./packages/landing/.sst/platform/functions/vector-handler/index.ts:12:export type QueryEvent = {
./packages/landing/.sst/platform/functions/vector-handler/index.ts:20:export type RemoveEvent = {
./packages/landing/.sst/platform/src/util/semaphore.ts:1:export class Semaphore {
./packages/landing/.sst/platform/src/runtime/worker/unenv.d.ts:1:export interface CloudflareUnenvInput {
./packages/landing/.sst/platform/src/runtime/worker/unenv.d.ts:6:export interface CloudflareUnenvConfig {
./packages/landing/.sst/platform/src/components/experimental/dev-command.ts:6:export interface DevCommandArgs {
./packages/landing/.sst/platform/src/components/experimental/dev-command.ts:99:export class DevCommand extends Component {
./packages/landing/.sst/platform/src/components/component.ts:26:export type Prettify<T> = {
./packages/landing/.sst/platform/src/components/component.ts:30:export type Transform<T> =
./packages/landing/.sst/platform/src/components/component.ts:51:export class Component extends ComponentResource {
./packages/landing/.sst/platform/src/components/component.ts:514:export class Version extends ComponentResource {
./packages/landing/.sst/platform/src/components/component.ts:521:export type ComponentVersion = { major: number; minor: number };
./packages/landing/.sst/platform/src/components/vercel/providers/dns-record.ts:4:export interface DnsRecordInputs {
./packages/landing/.sst/platform/src/components/vercel/providers/dns-record.ts:12:export interface DnsRecord {
./packages/landing/.sst/platform/src/components/vercel/providers/dns-record.ts:16:export class DnsRecord extends dynamic.Resource {
./packages/landing/.sst/platform/src/components/vercel/dns.ts:48:export interface DnsArgs {
./packages/landing/.sst/platform/src/components/input.ts:2:export type Input<T> = PulumiInput<T>;
./packages/landing/.sst/platform/src/components/cloudflare/experimental/solid-start.ts:8:export interface SolidStartArgs extends SsrSiteArgs {
./packages/landing/.sst/platform/src/components/cloudflare/experimental/solid-start.ts:214:export class SolidStart extends SsrSite {
./packages/landing/.sst/platform/src/components/cloudflare/experimental/static-site.ts:4:export type { StaticSiteV2Args as StaticSiteArgs } from "../static-site-v2.js";
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:21:export interface AiBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:26:export interface KvBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:32:export interface SecretTextBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:38:export interface ServiceBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:44:export interface PlainTextBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:50:export interface QueueBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:56:export interface R2BucketBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:63:export interface D1DatabaseBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:70:export interface HyperdriveBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:77:export interface DurableObjectNamespaceBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:86:export interface VersionMetadataBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:91:export interface WorkflowBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:100:export interface RateLimitBinding {
./packages/landing/.sst/platform/src/components/cloudflare/binding.ts:111:export type Binding =
```

## Directory Structure (potential bounded contexts)
```
.
./.claude
./.draht
./.draht/agents
./.draht/extensions
./.draht/git
./.draht/npm
./.draht/prompts
./.git
./.github
./.github/ISSUE_TEMPLATE
./.github/workflows
./.husky
./.husky/_
./.pi
./.pi/extensions
./.pi/git
./.pi/npm
./.pi/prompts
./.planning
./.planning/codebase
./.planning/kg-integration
./.planning/phases
./.planning/phases/01-rebrand
./.planning/phases/02-sst-infra
./.planning/phases/03-sst-extension
./.planning/phases/04-agents-templates
./.planning/phases/05-client-knowledge-base
./.planning/phases/06-ci-review-pipeline
./.planning/phases/07-multi-agent-orchestration
./.planning/phases/08-n8n-workflows
./.planning/phases/09-deploy-guardian
./.planning/phases/10-phase-10
./.planning/phases/11-phase-11
./.planning/phases/12-phase-12
./.planning/phases/13-phase-13
./.planning/phases/14-phase-14
./.planning/phases/15-phase-15
./.planning/phases/16-phase-16
./.planning/phases/17-phase-17
./.planning/phases/18-phase-18
./.planning/phases/19-gsd-cli-integration
./.planning/phases/20-tdd-ddd-hook-hardening
./.planning/phases/21-phase-21
./.planning/phases/22-phase-22
./.planning/phases/23-multi-agent-layer
./.planning/quick
./.planning/quick/001-fix-quality-gate-failures
./.planning/quick/003-cmux-notification-system-is-not-working-
./.planning/specs
./docs
./node_modules
./packages
./packages/agent
./packages/agent/dist
./packages/agent/docs
./packages/agent/node_modules
./packages/agent/src
./packages/agent/test
./packages/ai
./packages/ai/dist
./packages/ai/node_modules
./packages/ai/scripts
./packages/ai/src
./packages/ai/test
./packages/ci
./packages/ci/node_modules
./packages/ci/src
./packages/ci/test
./packages/coding-agent
./packages/coding-agent/agents
./packages/coding-agent/bin
./packages/coding-agent/binaries
./packages/coding-agent/dist
./packages/coding-agent/docs
./packages/coding-agent/examples
./packages/coding-agent/hooks
./packages/coding-agent/node_modules
./packages/coding-agent/prompts
./packages/coding-agent/scripts
./packages/coding-agent/src
./packages/coding-agent/test
./packages/compliance
./packages/compliance/node_modules
./packages/compliance/src
./packages/compliance/templates
./packages/compliance/test
./packages/deploy-guardian
./packages/deploy-guardian/node_modules
./packages/deploy-guardian/src
./packages/deploy-guardian/test
./packages/draht-claude
./packages/draht-claude/.claude-plugin
./packages/draht-claude/agents
./packages/draht-claude/bin
./packages/draht-claude/commands
./packages/draht-claude/hooks
./packages/draht-claude/node_modules
./packages/draht-claude/scripts
./packages/draht-claude/skills
./packages/draht-codex
./packages/draht-codex/.codex-plugin
./packages/draht-codex/agents
./packages/draht-codex/bin
./packages/draht-codex/commands
./packages/draht-codex/hooks
./packages/draht-codex/node_modules
./packages/draht-codex/scripts
./packages/draht-codex/skills
./packages/draht-tools
./packages/draht-tools/bin
./packages/gateway
./packages/gateway/.planning
./packages/gateway/node_modules
./packages/gateway/src
./packages/infra
./packages/infra/node_modules
./packages/infra/src
./packages/invoice
./packages/invoice/node_modules
./packages/invoice/src
./packages/invoice/test
./packages/knowledge
./packages/knowledge/node_modules
./packages/knowledge/src
./packages/knowledge/test
./packages/landing
./packages/landing/.astro
./packages/landing/.sst
./packages/landing/dist
./packages/landing/drafts
./packages/landing/node_modules
./packages/landing/public
./packages/landing/src
./packages/mom
./packages/mom/dist
./packages/mom/docs
./packages/mom/node_modules
./packages/mom/scripts
./packages/mom/src
./packages/orchestrator
./packages/orchestrator/node_modules
./packages/orchestrator/src
./packages/orchestrator/test
./packages/pods
./packages/pods/dist
./packages/pods/docs
./packages/pods/node_modules
./packages/pods/scripts
./packages/pods/src
./packages/router
./packages/router/node_modules
./packages/router/src
./packages/router/test
./packages/templates
./packages/templates/src
./packages/tui
./packages/tui/dist
./packages/tui/native
./packages/tui/node_modules
./packages/tui/src
./packages/tui/test
./packages/web-ui
./packages/web-ui/dist
./packages/web-ui/example
./packages/web-ui/node_modules
./packages/web-ui/scripts
./packages/web-ui/src
./packages/workflows
./packages/workflows/src
./scripts
./templates
./templates/project
./templates/project/.draht
```

## TODO
- [ ] Identify entities vs value objects
- [ ] Map bounded contexts from directory structure
- [ ] Define ubiquitous language glossary
