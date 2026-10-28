# Release Evidence Contract

**Status:** active release-governance contract  
**Baseline:** `147e78929c6e83a98dc727e3de46026a7bb5dfc5`, assessed 2026-08-28  
**Applies to:** package status, composed feature status, public release claims, active deployments, and hardware/privacy acceptance

This contract separates what code exists from what has been integrated, released, activated, and observed. Historical phase records remain evidence of what their named harness exercised; they do not acquire a stronger meaning when this contract is adopted.

## Evidence levels

| Level | Name | Required proof | Does not prove |
|---|---|---|---|
| **E0** | Contract/unit | Deterministic unit, component, property, schema, static-boundary, or compile evidence. Substitutes and fixtures are allowed and must be named. | Composition, releaseability, live owners, deployment, or operational behavior. |
| **E1** | Disposable integration | A real process, protocol, browser, filesystem, package, or OS boundary is exercised in a disposable environment, while one or more domain owners, credentials, hosts, registries, devices, providers, or sinks remain substituted. | A fixture-free release candidate or behavior on the intended machine. |
| **E2** | Live candidate | The production entry path uses real canonical owners with no fixture/demo fallback; the built or packed candidate is exercised end to end and its meaningful result is independently read back. The candidate may be disposable or inactive. | Installation or activation on the intended machine, restart continuity there, or a soak result. |
| **E3** | Active deployment | The exact candidate is activated on the intended machine or service. Authentication, real state, restart/reconnect continuity, logs, rollback, and independent readback pass against that active deployment. | Time-based reliability, physical-device behavior, privacy/legal conclusions, or measured external outcomes. |
| **E4** | Soak/hardware/privacy/external | The applicable elapsed-time, multi-device, physical-hardware, privacy/deletion, legal/source, or measured-outcome protocol passes with archived provenance and an explicit denominator. | Unmeasured claims outside that protocol. |

Evidence is cumulative only when lower-level proof remains applicable to the exact candidate. A later level cannot be inferred from a green lower-level suite.

## Classification rules

1. **State the capability and boundary.** Evidence belongs to a named capability at a revision, not to a package family or milestone by association.
2. **Name substitutions.** Faux providers, fixture registries, stub CLIs, seeded homes, local TLS proxies, fixture repositories, in-memory stores, and simulated devices cap evidence at E1.
3. **Require meaningful readback.** A build, HTTP 200, connected socket, rendered sample, empty response, or process start is not E2 by itself.
4. **Separate built from active.** An emitted binary or packed tarball can reach E2. It reaches E3 only after activation and verification on the intended target.
5. **Use the weakest decisive leg.** A feature spanning E2 runtime code and an E0 renderer is E0 as a composed feature until the renderer path advances.
6. **Keep safety blockers visible.** Passing functional acceptance does not promote a candidate while a known data-loss, confinement, authentication, release-integrity, or privacy blocker remains.
7. **Do not average levels.** Record mixed capabilities separately; do not turn several E0/E1 results into one E2 claim.
8. **Preserve historical truth.** `complete` in an older phase means its written acceptance passed under the recorded harness. It means operational only if that record independently satisfies this contract.

## Completion boundaries

| Claim | Minimum evidence and boundary |
|---|---|
| Package or contract complete | E0 may close a package-scoped contract only when the acceptance explicitly requires no process/composition behavior. Public status must say `contract-complete` or `unit-complete`, not operational. |
| Disposable integration complete | E1 with named fixtures/substitutions, negative controls, and cleanup. Public status must say `integration-proven`, not production or operational. |
| Composed feature candidate | E2 for every release-critical leg, including production composition, supported entry point, real owner, failure states, and independent readback. |
| Public software release | E2 for every included release-critical capability, plus a clean immutable pre-tag release gate, exact-commit CI success, artifact integrity/provenance, rollback or uninstall path, changelog, and no unresolved release-blocking security finding. Publication itself does not confer E3. |
| Operational / active deployment | E3 for the named target and candidate. Documentation must name target, revision/version, activation time, verification, state/backup policy, logs, and rollback result. |
| Hardware-, soak-, privacy-, or external-outcome complete | E4 for each applicable claim. Hardware debt, elapsed-time debt, deletion/export debt, or legal/source review cannot be waived by E0–E3 software evidence. |

A phase can be `complete` within its declared boundary while the product remains below release or operational readiness. Conversely, a mature package cannot promote a composed feature whose production caller, renderer, deployment, or evidence gate is missing.

## Current truth-state baseline

The table records the strongest evidence found at the baseline revision. It is not a target-state roadmap and does not replace capability-specific blockers in `ROADMAP.md` or `STATE.md`.

| Product line | Strongest actual state | Evidence held | Boundary preventing promotion |
|---|---:|---|---|
| Core local runtime (`@draht/ai` → `@draht/agent-core` → `@draht/coding-agent`) | **E2 — live candidate** | Real CLI/SDK composition, public packages and compiled runtime artifacts, extensive tests, and emitted/packed-binary paths use canonical runtime owners. | No release record at this revision proves the new immutable check/CI contract; no named active-machine activation, restart, logs, and rollback record establishes E3. The repository-wide release baseline is currently red. |
| Geist browser/phone remote control | **E1 — disposable integration, partial** | An emitted daemon, real attached Draht session, served browser bundle, protocol frames, input/output, auth boundaries, and reconnect behavior have been exercised through the production composition path, but the provider and local TLS topology are substituted. | The real Tailscale identity capture, live tailnet/provider verification, iOS/Quest-browser device run, daemon ownership consolidation, phone-start path, protocol freeze, service activation, and soak remain open. The substituted provider/topology prevent E2; an inactive candidate cannot establish E3. |
| Rewind/checkpoints | **E1 — disposable integration, partial** | Real Git fixture repositories exercise checkpoint capture and the rewind acceptance path, including safety snapshots and failure injection. | Known data-loss/concurrency/performance/UX residuals remain; SIGKILL recovery and hardening are open. Fixture-repository success is not a safe live candidate or operational proof. |
| Transactional installer (`@draht/install`) | **E1 — disposable integration** | Packed-tarball lifecycle, sandbox HOME, transactional journal/rollback, fixture registries, and stub Claude/Codex/package-manager adapters exercise real process and filesystem boundaries. | The package is private; registry/host adapters and homes are substituted; JSON schema/docs residuals and publish decision remain. `install.sh` is a separate compiled-runtime bootstrap and does not promote `@draht/install`. |
| Bash sandbox confinement | **E1 — disposable integration, blocked** | Real macOS process/OS-boundary escape tests and startup self-test exercise the dormant executor. | No production caller enables it; the mandated writable-root/network policy has demonstrated critical escapes and Linux evidence is incomplete. A real sandbox process is not a safe composed feature. |
| SST infrastructure (`@draht/infra`) | **E0 — contract/scaffold** | TypeScript/SST resource definitions compile and define API Gateway, Lambda, and DynamoDB shapes. | Sessions/clients handlers return placeholder empty data; health is unconditional; auth, deployment workflow, active stack, readiness, observability, rollback, and readback are absent. It is not deployable or operational evidence. |
| Quest spatial renderer | **E0 — scaffold/unit** | Android/Kotlin foundation and isolated geometry/contract work exist. | Placeholder SDK levels, no Meta Spatial SDK client/panels/raycast flow, no frozen geist/1.0 consumption, and no archived Quest 3 hardware run. Historical unit evidence and recorded hardware debt satisfy no E3/E4 gate. |

## Promotion record

Every promotion claim must record:

- capability and explicit in-scope/excluded behavior;
- repository revision plus package/binary/image/APK version;
- target environment and whether it is disposable, inactive, or active;
- canonical owners and production entry point;
- exact commands/workflow run and archived outputs;
- fixtures, substitutions, credentials, devices, and providers used;
- positive control, negative control, and independent readback;
- known blockers, security exceptions, and expiry;
- activation, rollback, restart/reconnect, and cleanup outcome where applicable;
- reviewer and date.

If any field is unknown, the claim stays at the last level whose requirements are fully evidenced.

## Release decision rule

A Draht release is eligible only when the release checklist in [`docs/releasing.md`](../docs/releasing.md) records:

1. the exact release scope and required level per included capability;
2. E2 or stronger evidence for every release-critical capability;
3. a green immutable pre-tag gate and exact-commit required CI;
4. resolved or explicitly excluded E0/E1 product lines;
5. separate E3/E4 follow-up gates for operational, hardware, privacy, or soak claims.

The baseline revision does **not** satisfy this rule: canonical tests/checks have deterministic failures, the release path does not run the complete check gate or wait for exact-commit CI, and critical/high dependency findings lack a release policy. This statement is a current baseline, not a permanent judgment about the project.
