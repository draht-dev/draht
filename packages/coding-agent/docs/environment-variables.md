# Environment Variables

draht uses environment variables in three ways:

- Variables such as `DRAHT_OFFLINE` configure the draht process.
- draht sets process markers so child processes can identify draht as the launching agent.
- Commands run by the LLM-callable shell tools receive `DRAHT_*` variables describing the current session.

Provider API-key variables are documented separately in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=draht` is a generic marker that lets tooling identify draht as the agent that launched the process.
- `DRAHT_CODING_AGENT=true` is draht-specific and lets child processes detect that they run inside draht.

Child processes inherit both markers. They are not session-specific and are not set automatically when draht is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current draht session state:

| Variable | Description |
|----------|-------------|
| `DRAHT_SESSION_ID` | Current session ID |
| `DRAHT_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `DRAHT_PROVIDER` | Currently selected model provider |
| `DRAHT_MODEL` | Currently selected model ID |
| `DRAHT_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting draht. `DRAHT_PROVIDER` and `DRAHT_MODEL` identify the selected draht model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$DRAHT_PROVIDER" "$DRAHT_MODEL"
printf 'reasoning=%s session=%s\n' "$DRAHT_REASONING_LEVEL" "$DRAHT_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$DRAHT_SESSION_FILE" ]; then
  tail -n 1 "$DRAHT_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with draht. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, draht removes inherited values for these variables so nested draht processes do not expose stale parent-session metadata.

## Polyphase Child Coordination

These two variables are internal: draht sets them on a subagent/workflow child process it spawns
and reads them back in that child; they are not meant to be set by hand. See
[Orchestrate Agents with Polyphase](polyphase.md).

| Variable | Description |
|----------|-------------|
| `DRAHT_POLYPHASE_DEPTH` | Nesting depth of this process: unset or `0` for the user's session, `n` in a child spawned by a process at depth `n-1`. Used to enforce `polyphase.maxDepth` and to exclude the `subagent` tool once the limit is reached. |
| `DRAHT_POLYPHASE_SCHEMA_FILE` | Path to a JSON Schema file for this agent's structured result. When set, the child registers a `polyphase_result` tool matching that schema; unset in every other process, including a child whose parent did not request structured output. |

## draht Process Configuration

These variables are read by draht itself:

| Variable | Description |
|----------|-------------|
| `DRAHT_CODING_AGENT_DIR` | Override the config directory; default is `~/.draht/agent` |
| `DRAHT_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `DRAHT_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `DRAHT_OFFLINE` | Disable automatic network activity, including version checks, package updates, and model catalog refreshes |
| `DRAHT_SKIP_VERSION_CHECK` | Disable the latest-version request to the npm registry entry for `@draht/coding-agent` |
| `DRAHT_MODEL_CATALOG_BASE_URL` | Enable the remote model catalog overlay from a self-hosted endpoint; the overlay is off when unset |
| `DRAHT_TELEMETRY` | Override provider attribution headers (OpenRouter, NVIDIA NIM, Cloudflare): `1`/`true`/`yes` or `0`/`false`/`no` |
| `DRAHT_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `DRAHT_SHARE_VIEWER_URL` | Base URL of a share viewer for `/share`; when unset, `/share` prints the gist URL |
| `DRAHT_RADIUS_GATEWAY` | Not consulted by the builtin Radius model provider (which always uses `https://radius.pi.dev`, or a per-provider `baseUrl` from provider config) or by `/bug`; currently has no effect on behavior |
| `DRAHT_BUG_REPORT_GATEWAY` | Override the `/bug` upload destination; default is `https://radius.draht.dev` |
| `DRAHT_NO_ATTACHABLE` | Set to `1`/`true`/`yes` to stop sessions from registering an attach socket; overridden by `--attachable` |
| `DRAHT_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `DRAHT_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `DRAHT_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `DRAHT_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `DRAHT_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).
