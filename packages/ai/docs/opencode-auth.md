# OpenCode Console authentication

The `opencode` (Zen) and `opencode-go` providers expose an OAuth login method labeled **Sign in with OpenCode Console**. The existing API-key method and `OPENCODE_API_KEY` remain available for service accounts.

Use `Models.login(providerId, "oauth", interaction)` with the application's credential store. The `auth_url` event includes the browser URL and device code. Completing authorization stores an expiring access token, refresh token, account metadata, and the selected organization under that provider ID. Zen and Go keep separate stored credentials and inference routes. Login does not create or change a subscription.

`Models.getAuth()` refreshes tokens through the existing serialized credential-store operation and persists rotation before releasing the lock. Revocation requires another browser login. Failed or cancelled login and failed refresh preserve the previously stored credential. API keys are not refresh tokens; older keys stored with an OAuth tag must be replaced through login if they expire.

## Protocol reference

The implementation follows OpenCode's [Console provider](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/core/src/plugin/provider/opencode.ts): JSON device authorization at `/console/auth/device/code`, token polling and refresh at `/console/auth/device/token`, client ID `opencode-cli`, and `supports_org_scope: true`. The browser chooses the organization; an unscoped token uses the upstream fallback of the first organization sorted by name and ID. Refresh does not depend on account discovery.

The existing `/zen/v1` and `/zen/go/v1` routes remain distinct. OpenCode's [compatibility proxy](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/console/app/src/lib/inference-proxy.ts) forwards them to the corresponding inference routes, carrying the bearer token and request headers. Organization selection is sent as `x-opencode-org-id`, as observed in [official-client request traces](https://github.com/anomalyco/opencode/issues/56397). The new inference service is not present in that public source snapshot; a live request is needed to verify account entitlement.

All authentication requests reject redirects. Device polling observes cancellation, expiry, and `slow_down`; requests have a timeout. Errors omit provider response bodies. Protocol and credential-store tests mock network calls and do not spend inference tokens.
