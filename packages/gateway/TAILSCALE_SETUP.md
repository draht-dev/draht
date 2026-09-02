# Tailscale Setup for draht-gateway

The daemon binds **loopback (`127.0.0.1`) only** and stays there. A phone, a
Quest 3 or a second laptop reaches it through `tailscale serve`, which
terminates TLS with a real certificate on a stable MagicDNS name and proxies to
that loopback listener.

This is not an inconvenience to route around. `POST /sessions/:id/input` drives
a `draht` agent process with your user's privileges and that agent runs tools on
your behalf, so a daemon on a reachable interface is remote code execution for
whoever holds a credential. Loopback plus `tailscale serve` is the only
supported exposure.

Everything on this page is either a command this repo implements or a fact about
code in it. Where something has **not** been verified on real hardware, it says
so in the same breath rather than in a footnote.

---

## Scope: which half of `GSEC-04` this closes

The finding was split (see the re-ownership table in
`.planning/geist/SECURITY-2026-07-13.md`). Its **bind half** — the pairing
server's hostname-less `Bun.serve({ port })`, which bound every interface —
closed in Phase 32, and the gateway's loopback default does not close it on its
own: what closes it is `createPairingServer()` routing its bind through
`assertBindHostAllowed` on a `127.0.0.1` default
(`packages/geist/src/pairing/server.ts`), plus `npm run
check:bun-serve-hostname`, which fails repo-wide on any `Bun.serve` that does
not name a hostname. Its **credential half** is what the pairing flow on this
page closes: a single-use bootstrap token exchanged for a rotated, device-bound
credential, individually revocable — `geist pair` and `geist devices`,
documented below.

So the sentence this page used to carry — that the bind posture closes nothing —
was true and useless, because it named no owner for what was left. Both halves
now have one.

---

## A tailnet is an ACL. It is **never an authentication boundary**

Every credential check on this daemon runs on the assumption that the caller is
already inside the tailnet. Reachability decides *who may knock*; it decides
nothing about who gets in. Three consequences, and none of them is theoretical.

**The daemon cannot tell a proxied request from a local one.** It listens on
`127.0.0.1`. A request arriving there carries no evidence of whether it came
through `tailscale serve` or from a process on this machine that wrote the
proxy's headers itself. That is why the identity-header check
(`packages/gateway/src/gateway/middleware/tailnet-identity.ts`) is deny-only: a
value naming somebody other than the configured owner is refused, and every
other outcome —
including a value naming the owner — falls through to the credential check that
was going to run anyway. Nothing in that module can grant.

**What a compromised tailnet node gains**: the ability to reach
`https://<magicdns>/` subject to your ACL, which means the public routes —
`/health` and the `/ui` bundle bytes, both intentionally unauthenticated so a
browser can load the page before it has a credential — and the ability to open
`/attach` and be refused on the wire. **What it does not gain**: a device
credential. It has none, it cannot read one out of a URL or a log because none
is ever put there, and `/attach` withholds the fleet listing until a connection
has authenticated.

**What a compromised coordination server gains**: more, and it is worth being
honest about. Tailscale's control plane distributes node keys and drives the
DNS-01 challenge for your `*.ts.net` name, so a compromised one can add a node
to your tailnet and can, in principle, obtain a certificate for the MagicDNS
name — which is reachability *and* a position to intercept. **What it still does
not gain**: a bypass of the device credential. Reaching the daemon is not
authenticating to it; every frame is authorized in both directions; and any
credential that is exposed is individually revocable with `geist devices revoke`
and refused at that device's next frame. Treat the tailnet as a narrowing of who
can attempt authentication, never as the authentication.

### Narrowing the serve ACL to your own devices

`tailscale serve` publishes on this node's `tcp:443`, and who may reach that is
your tailnet's Access Controls policy — Tailscale admin console → **Access
controls**. A default `autogroup:member` → `*:*` policy lets every node on the
tailnet knock. Narrow it to the devices you actually pair:

```json
{
  "tagOwners": { "tag:draht-daemon": ["autogroup:admin"] },
  "grants": [
    {
      "src": ["your-login@example.com"],
      "dst": ["tag:draht-daemon"],
      "ip":  ["tcp:443"]
    }
  ]
}
```

Tag the machine running the daemon `tag:draht-daemon`, and leave no broader rule
whose `dst` covers it — ACL rules are additive, so a surviving `*:*` grant makes
the narrow one decorative. Verify the narrowing empirically rather than by
reading it back: run the two-node drive below from a device that *should* reach
it, then from one that should not. The second must fail.

### Never Funnel

`tailscale funnel` publishes to the *public internet*, which turns a credential
leak into world-reachable code execution for anyone who finds the name. The
publish script refuses it structurally: `assertNoFunnel` in
`scripts/geist-tailscale-serve.mjs` kills the run if `funnel` appears anywhere
in the argv or in the binary's own path, at parse time and again at spawn time.
There is **no override for this**, no flag, and no supported reason to want one.

---

## The procedure

Every command below runs from the **repo root** — the `draht-mono/` directory
that holds `scripts/` and the workspace `package.json` — unless its own block
says otherwise. This is not housekeeping: every relative path below resolves
against the directory you are standing in, and nothing warns you when that is
the wrong one. `scripts/geist-tailscale-serve.mjs` resolves `--out` with
`resolve(process.cwd(), …)` and creates whatever directory that names, so the
same command run one level down still succeeds — it just writes the file where
nothing reads it.

### 1. Start the daemon on loopback

The daemon is the one thing that runs from the package directory, because
`start` is a script in `packages/gateway/package.json`:

```bash
cd packages/gateway
bun start --auth YOUR_SECRET_TOKEN
```

```json
{"level":"info","timestamp":"2026-03-09T21:37:40.361Z","message":"draht-gateway listening","host":"127.0.0.1","port":7878}
```

`"host":"127.0.0.1"` is the only correct value. Nothing off this machine can
reach it yet.

That terminal now belongs to the daemon. Open a second one and `cd` back to the
repo root for everything below.

### 2. Check the posture before publishing anything

```bash
node scripts/geist-tailscale-serve.mjs --doctor
```

`--doctor` prints the tailscale binary and version, the backend state, this
node's MagicDNS name, the live serve mapping, and — the part worth running it
for — reads `~/.draht/gateway.config.json` and prints the exact replacement file
if it still binds a non-loopback host. It exits `76` in that case rather than
letting you publish a wide bind onto a tailnet.

### 3. Publish the loopback listener

```bash
node scripts/geist-tailscale-serve.mjs --port 7878
```

Idempotent: the mapping is read out of `tailscale serve status --json` before
anything is published, so a second run reports `no change` instead of stacking a
duplicate handler. The origin it prints is parsed from the live serve config,
never from a config file — a name in a file can be stale, the serve config is
what tailscaled is actually doing.

Take it down again with Tailscale's own command:

```bash
tailscale serve --https=443 off
```

### 4. Prove the published surface works, from a second node

```bash
node scripts/geist-tailscale-serve.mjs --verify --peer OTHER-NODE
```

The drive genuinely originates on `OTHER-NODE` over Tailscale SSH — driving it
from this machine would prove only that the loopback listener answers, which was
never in doubt. It probes `https://…/health` and a real `wss://` upgrade, and it
names its failures apart: `72` DNS, `71` certificate, `73` upgrade, `78` no such
peer. Three different problems with three different fixes.

### 5. Pair a phone

`@draht/geist` ships its CLI as `dist/cli.js`, so build the package once before
the `geist` binary exists on your path:

```bash
npm run build --workspace @draht/geist
```

```bash
geist pair
```

Prints a QR and the same URL as copyable text:

```
https://your-machine.your-tailnet.ts.net/ui#token=<bootstrap>
```

Four properties of that link matter:

- **The token is in the fragment, never the query.** A fragment is not sent to
  the server, so it cannot land in an access log, is not part of a `Referer`,
  and never reaches the proxy's request line. `assertNoQueryCredential` in
  `packages/geist/src/commands/pair.ts` refuses to print a link containing `?`
  at all, so a later edit cannot quietly reintroduce the leak. The `?token=`
  credential source is deleted daemon-side too.
- **The origin comes from the live serve mapping**, not from config. `geist
  pair` resolves it before minting anything, so a failed resolve leaves no
  spendable token in the store with nobody holding it.
- **The token is single-use and short-TTL** — two minutes by default
  (`DEFAULT_BOOTSTRAP_TTL_MS`). Override with `geist pair --ttl 300`. It is
  invalidated at the moment it is exchanged, and a replay of it is refused on
  the replaying connection while the device that spent it stays bound and
  undisturbed.
- **What comes back is not the token.** On first connect the phone sends
  `pair_device` carrying the bootstrap; the daemon answers `device_credential`
  with a device id and a fresh per-device credential. Every later connect sends
  `authenticate` and is answered with a *rotated* credential — the predecessor
  is dead the instant the new one is issued. Up to eight rotated-away
  credentials stay recognisable per device so a reuse attempt is raised as an
  audit event rather than merely refused.

Other flags: `geist pair --port 7878`, `geist pair --serve-path /gateway`.
`geist pair --origin https://host` exists for tests only, announces itself on
stderr every single time, and bypasses the live mapping — do not use it to set
up a real device.

### 6. Enumerate and revoke

```bash
geist devices list
```

One row per device — id, `active`/`revoked`, platform, last seen, name. The rows
are built from the registry's `DeviceSummary`, which has no field capable of
carrying credential material, so this table cannot disclose a secret however it
is later edited.

```bash
geist devices revoke dev_abc123
```

Revocation is a write to `~/.geist/devices.json` (mode `0600`, in a `0700`
directory; `GEIST_DEVICES_PATH` overrides the location). The CLI deliberately
does not signal the daemon: a revocation that needed IPC would fail silently
exactly when the daemon is wedged, which is one of the moments you most want to
revoke. The daemon re-reads the store on an inode-freshness check, and the
authorization hook runs on **every inbound frame and before every outbound
emit** — which is what makes "refused at its next frame, not merely at its next
connect" true for a phone that is sitting there reading and sending nothing.

Revoking twice is success and says so. An unknown id is exit `1` with the id
quoted back, because the likely cause is a typo and you need to know the
revocation did *not* happen.

### 7. Prove no credential leaked into the transport or the logs

```bash
node scripts/geist-credential-scan.mjs --secret YOUR_BOOTSTRAP_TOKEN recorded-transport.ndjson gateway.log
```

Finds the secret raw, percent-encoded, base64 and base64url, plus any
`?token=`-shaped construct, and reports file, line and encoding. It exits
non-zero on an empty secret, so a vacuous invocation cannot be mistaken for a
clean result.

---

## The tailnet identity header: a contract to capture, not one to invent

> **The real header has never been captured on this machine.** This section
> documents how to capture it and where it is pinned. It deliberately does not
> print a header name, because a name written from memory would be fiction that
> the daemon then trusts as a contract.

When a deployment declares itself fronted, the daemon reads one request header
and refuses any value that is not the configured owner. Config:

```json
{
  "host": "127.0.0.1",
  "tailnet": {
    "fronted": true,
    "owner": "your-login@example.com",
    "header": "Tailscale-Header-Name-You-Captured"
  }
}
```

`fronted: false` (or no `tailnet` block) means the header is not consulted at
all — not that it is trusted. A malformed block is a config error, never a
silently-disabled check.

Omit `header` and the daemon falls back to
`DEFAULT_TAILNET_IDENTITY_HEADER` in
`packages/gateway/src/gateway/middleware/tailnet-identity.ts`, which currently
reads `X-Uncaptured-Tailnet-Identity-Header-Placeholder`. That is a placeholder
naming a header no proxy will ever send, so the check never fires. Safe — the
module cannot grant — but it is not the feature, and the intentionally failing
test `the pinned identity-header contract > is a real capture, not the
placeholder this repo ships` in
`packages/gateway/src/__tests__/tailnet-identity.test.ts` is what stops the
placeholder being mistaken for one.

### Capturing it

```bash
node scripts/geist-tailscale-serve.mjs --capture-identity --peer OTHER-NODE \
  --out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json
```

Run it from the repo root and pass that `--out` exactly. It is the one path the
failing test reads, and it is not optional: omit it and the script writes its
own default fixture next to itself, leaving the tripwire red with nothing to
show for a capture that worked. The failing test prints this same command.

This publishes a throwaway loopback recorder at a temporary path, drives exactly
one request to it from a real peer, records what arrived, and takes the
temporary mapping down again. The file it writes is the pin, and it records:

| field | what it holds |
|---|---|
| `capturedAt` | ISO timestamp of the observation |
| `origin`, `peer`, `path` | where it was observed and who drove it |
| `tailscaleVersion` | first line of `tailscale version` on this machine — the version the contract came from, without which the pin dates nothing |
| `identityHeaders` | every request header whose name begins `tailscale-`, with its value |
| `headers` | the full request headers, for context |

Then set `DEFAULT_TAILNET_IDENTITY_HEADER` to the header the capture recorded.
The two must agree: a second test fails whenever the constant and the pin
disagree, whatever the pin says, so replacing the file is a one-step operation
with a visible failure if the constant is left behind. If the capture records
more than one `tailscale-*` header the pin reader refuses to guess between them
and tells you to choose by hand — read
`packages/gateway/src/__tests__/tailnet-identity.test.ts` for the tie-breaker it
applies first.

Until a real capture lands, treat the identity header as **not implemented in
practice**: the credential check is the only thing standing, which is exactly
the posture the deny-only design assumes anyway.

---

## The phone side: what is stored, and when it is thrown away

The served bundle (`@draht/geist-console`) keeps `{deviceId, credential}` in
**`localStorage`** under the key `geist.console.device`.

- **localStorage, not sessionStorage**, because the credential has to survive a
  tab close and an app restart — reopening the page must resume, not re-pair.
- **Written synchronously in the `device_credential` handler**, overwriting the
  value it supersedes. The predecessor is dead the instant the daemon sends the
  new one, so a deferred write would leave a reload holding a credential the
  daemon has already retired.
- **The bootstrap token is stripped from the address bar** with
  `history.replaceState` the moment it is read, so it does not survive into
  scrollback, screenshots or a shared URL.

Eviction is defined, not left to chance:

| trigger | what happens |
|---|---|
| a `not_authenticated` `protocol_error` — revoked, superseded, or never issued | the credential is removed, the reconnect loop stops, and the re-pair prompt is shown |
| a stored value that is not `{deviceId, credential}` (corrupt, truncated, hand-edited) | removed and treated as absent |
| the reconnect budget is spent (8 attempts) | the page stops and says it is disconnected — it never renders a silently dead transcript |
| the browser clears site data — private browsing, "Clear website data", or a storage-lifetime policy such as Safari's cap on script-writable storage for sites without recent interaction | the credential is gone and the page asks to be paired again |

The last row is browser behaviour this repo has not measured; it is written here
because the outcome is the same in every case and it is the one an operator
needs to expect. Measuring it on real devices is the class-4 evidence
R33-REACH.2 asks for and it has not been collected. In all four rows the
observable result is a re-pair prompt, never a broken page: run `geist pair`
again and scan.

Revocation reaches the phone through this same path — `geist devices revoke`
makes the daemon refuse the connection with `not_authenticated`, which the page
handles as the first row above.

---

## Sign-off conditions 5 and 6

The amendment recorded against `GSEC-04` replaces the original "wildcard bind
requires LAN mTLS 1.3" remediation, which rev 8 made unreachable by removing
wildcard bind entirely. Conditions 5 and 6 of the replacement — a rotated,
device-bound credential and revocation — are the two the pairing flow above
implements, and the loopback bind does not close them; steps 5 and 6 of the
procedure do. Conditions 1-4 (permanent loopback bind, serve-provided TLS,
tailnet identity assertion, one-time bootstrap) are covered by steps 1-3 and by
the identity-header section, whose assertion is **not yet in force** for the
reason given there.

### Known gap: the daemon's CLI does not construct the device store yet

`packages/gateway/src/cli.ts` does not build a `DeviceRegistry` and does not
pass `devices` to `startGateway`, so a daemon started with `bun start` runs in
the pre-pairing posture: `/attach` accepts the operator token on the upgrade
request and refuses everything else on the wire. You can tell which posture a
daemon is in from the refusal itself — a console that reports

```
this daemon does not exchange device credentials on the wire
```

is talking to a daemon with no device store, and no bootstrap token will be
accepted by it however correctly `geist pair` minted one. Embedders can pass
`devices` to `createServer` / `startGateway` today; the CLI wiring is what is
missing.

---

## Troubleshooting

**Connection refused or timeout.** Run `node scripts/geist-tailscale-serve.mjs
--doctor` first — it answers "is the daemon published", "is MagicDNS resolving",
and "is my config still binding a wide host" in one pass. Then check the local
listener directly:

```bash
curl http://127.0.0.1:7878/health
```

You should **not** need a macOS firewall exception. `tailscale serve` proxies
from the Tailscale daemon to loopback; no new socket is opened on an external
interface.

**`Refusing to bind non-loopback host …`.** Intentional. You passed `--host`
with a non-loopback value, or `~/.draht/gateway.config.json` still holds an old
`"host": "0.0.0.0"`. `--doctor` prints the exact replacement file. If you
genuinely cannot use a tailnet, read [Escape
hatch](#escape-hatch---allow-non-loopback) in full first.

**A phone or Quest browser will not connect but `curl` does.** Those clients
require `wss://` with a certificate they trust. Confirm you are pointing them at
the `https://…ts.net` MagicDNS name and not at `http://100.x:7878`, which
cannot work for them however the daemon is bound. `--verify` reproduces the
upgrade from a second node and will tell you whether the failure is DNS, the
certificate or the upgrade.

**`Forbidden: tailnet identity does not match the configured owner`.** The
configured `tailnet.owner` does not equal the value in the identity header. Note
that with the placeholder header name shipped today this refusal cannot fire at
all; if you are seeing it, you have configured a real captured header.

**The Tailscale IP changed.** Stop using IPs. The MagicDNS name is stable and
survives address changes; that is half the reason `serve` is the supported path.

---

## Security posture, stated plainly

- **Loopback by default** — the process is unreachable off-box; `tailscale
  serve` is the only exposure.
- **WireGuard-encrypted transport**, TLS terminated by tailscaled with a real
  certificate.
- **`/health` and the `/ui` bundle are public** to anything that can reach the
  origin. The bundle is static bytes; it holds no credential and lists no
  session. The fleet listing is pushed on the wire only after a connection has
  authenticated — there is no HTTP `GET /fleet` for a browser to try.
- **The operator bearer token is root-equivalent.** `POST /sessions/:id/input`
  steers a `draht` agent, and the agent runs tools. `POST /sessions` no longer
  accepts a caller-supplied `command` array (removed in R32-FLEET.8; a body
  still carrying one is refused with 400) — that is a removed exposure, not a
  solved one.
- Generate the token with `openssl rand -base64 32`, never commit it, and rotate
  it. Per-device credentials are the phone's path; the bearer token is the
  operator's.

---

## Escape hatch: `--allow-non-loopback`

> ⚠️ **Read this whole section before using the flag.** It disables the only
> containment boundary the daemon has.

If you must bind a non-loopback interface — a hermetic CI box on an isolated
segment where a Tailscale daemon cannot run — pass it explicitly, from
`packages/gateway` as in step 1:

```bash
bun start --host 0.0.0.0 --auth YOUR_TOKEN --allow-non-loopback
```

The daemon starts and prints a loud warning. What you are accepting:

- every process and device that can route to that interface can reach
  `POST /sessions`;
- with a valid bearer token that is **arbitrary command execution as your
  user** — not by naming a command in the request, that path is gone, but by
  steering the `draht` agent `POST /sessions/:id/input` drives;
- the transport is plain `http://` / `ws://` unless you put your own TLS
  terminator in front, so the token crosses the wire in cleartext.

Loopback is exactly `127.0.0.1`, `::1` and `localhost`. Everything else,
including `0.0.0.0` and every Tailscale `100.x` address, requires this flag.
Embedding the gateway as a library is no way around it: `createServer` and
`startGateway` refuse the same hosts unless you pass `allowNonLoopback: true`,
and an app from `createServer` that you bind yourself still answers `403` to any
off-box request unless you passed it. Binding the Tailscale address directly is
**not** a shortcut: it gives you no TLS and no MagicDNS name, so phones and the
Quest browser still cannot use it.

---

## Config file reference

`~/.draht/gateway.config.json`:

```json
{
  "$schema": "https://draht.io/gateway.schema.json",
  "port": 7878,
  "host": "127.0.0.1",
  "tokens": {
    "default": "your-secret-token"
  },
  "allowedPaths": ["~/", "~/projects", "~/code"],
  "maxSessions": 100,
  "idleTimeout": 255
}
```

Keep `host` on `127.0.0.1`. Any other value is a non-loopback bind and the
daemon refuses to start without `--allow-non-loopback`, whether it came from
this file or from the `--host` flag.

## Keeping it up across reboots

`tailscale serve --bg` config persists across `tailscaled` restarts, so only the
daemon needs supervising.

```ini
[Unit]
Description=draht-gateway
After=network.target tailscaled.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/draht-mono/packages/gateway
ExecStart=/usr/bin/bun start --auth YOUR_TOKEN
ExecStartPost=/usr/bin/node /path/to/draht-mono/scripts/geist-tailscale-serve.mjs --port 7878
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

On macOS, run the daemon from launchd the same way and run the publish script
once by hand — the mapping persists, and the script is a no-op on a second run.

## Related documentation

- [Gateway README](README.md) — API surface
- [Gateway SPEC](SPEC.md) — architecture
- `scripts/geist-tailscale-serve.mjs` — publish, verify, capture, doctor
- `scripts/geist-credential-scan.mjs` — the leak scan

---

**Need help?** Open an issue: https://github.com/draht-dev/draht/issues
