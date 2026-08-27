# Phase 36 Context

## Domain Boundary

Phase 36 establishes the typed, shell-free mobile control plane: a phone can discover configured
projects and fleet sessions, start a session, attach to it, observe its state, and send only
protocol-defined actions over the tailnet. The native iPhone application and its system extensions are
a separate presentation context built on that control plane; they do not substitute for Phase 36's
class-3 wire acceptance.

## Decisions

### Decided — use the maximum legitimate iPhone presence

- Drahtgeist will use every appropriate public iPhone surface instead of attempting a custom permanent
  overlay: a native app, one aggregate Live Activity, Dynamic Island presentations, Lock Screen and Home
  Screen widgets, StandBy, Control Center controls, Action Button integration, App Intents/Shortcuts,
  notifications, and deep links where the device and OS support them.
- Drahtgeist will not imitate AssistiveTouch, abuse accessibility privileges or Picture in Picture, use
  private APIs, or promise an always-visible overlay. iOS owns visibility, dismissal, placement, update
  budgets, and Live Activity lifetime.
- The aggregate Live Activity exists only while at least one Drahtgeist session is active. Its compact
  presentation shows fleet-level counts such as active and needs-attention; its expanded presentation
  shows a small prioritized subset. It is not a permanent launcher and not a complete fleet browser.
- The full Drahtgeist app is the canonical overview of every configured device and session. System
  surfaces are glanceable projections and entry points into that app.
- Lock Screen, Dynamic Island, notification, and widget content is privacy-minimized by default. No
  transcript, prompt, credential, command text, or sensitive project detail belongs on a system surface.
- Every remote action remains a typed Geist protocol operation. Neither the native app nor an App Intent
  may introduce a free-text command or remote-shell escape hatch.
- Foreground reads and actions use the configured Tailscale path to the Geist endpoint. All projections
  expose freshness and stale/offline state; a cached widget must never look live merely because it still
  renders.

### Assumed — implementation architecture pending its own phase discussion

- Drahtgeist gains a native SwiftUI target with WidgetKit, ActivityKit, and App Intents. A PWA alone is
  insufficient for the decided system surfaces.
- Background Live Activity updates use APNs through a trusted push coordinator because ordinary iPhone
  app execution and direct tailnet sockets are not continuously available in the background. The
  coordinator receives only the minimum redacted projection needed for the system surface.
- Credentials and enrollment material live in Keychain. Destructive actions require an authenticated
  handoff to the app or equivalent local confirmation rather than a one-tap Lock Screen action.
- Native iPhone work starts only after Phase 36 proves real `session_spawn` through the shipped daemon.
  Until then, the protocol and fleet registry must remain presentation-neutral and mobile-consumable.

## Claude's Discretion

- Exact compact symbols, widget density, ordering of non-urgent sessions, and visual transitions.
- Cache duration and refresh coalescing within Apple's public budgets, provided freshness remains visible.
- Whether read-only App Intents complete in place or deep-link into the app when execution time or
  authentication makes an in-place result unreliable.

## Deferred Ideas

- Minimum supported iOS version and the fallback matrix for iPhones without Dynamic Island.
- Push-coordinator placement, APNs credential operations, payload encryption, and privacy-mode settings.
- Exact notification policy and which typed operations, if any, are safe outside the foreground app.
- Apple Watch projections and an independent Android overlay policy.
- Native implementation tasks, acceptance evidence, and release sequencing belong to a follow-on phase;
  they must not expand Phase 36 waves 3–5 or weaken their class-3 acceptance.

---
Created: 2026-08-25 10:14:30
