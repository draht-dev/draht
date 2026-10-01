# RPC Mode

RPC mode runs draht as a long-lived subprocess controlled through JSON records on stdin and stdout. Use it for language-independent integrations, process isolation, IDEs, and custom user interfaces.

For an in-process Node.js or Bun integration, prefer the [SDK](sdk.md). For a subprocess-based TypeScript integration, prefer the exported `RpcClient`, which starts draht, correlates responses, exposes typed command methods, and delivers events to listeners.

| Interface | Process boundary | Control model | Best fit |
|---|---|---|---|
| [SDK](sdk.md) | In process | Direct TypeScript methods and events | Node.js or Bun hosts that want complete API access |
| RPC | Child process | JSONL commands, responses, and events | Other languages, isolated processes, IDEs, or custom clients |

## Start RPC mode

```bash
draht --mode rpc --no-session
```

Normal CLI options still select the working folder, model, tools, resources, and session behavior. Common choices include `--provider`, `--model`, `--name`, `--no-session`, and `--session-dir`. See [Command Line](cli.md) for the complete, version-specific interface; `draht --help` is authoritative for the installed version.

RPC mode rejects `@file` prompt arguments. Send prompts through the [`prompt`](rpc-commands.md#prompt) command instead.

## Protocol records

The protocol has four record families:

| Direction | Record | Purpose |
|---|---|---|
| stdin | Command | Ask draht to prompt, inspect state, change configuration, or manage the session |
| stdout | `response` | Report whether one command succeeded and return any command data |
| stdout | Session event | Stream run, message, tool, queue, compaction, and retry activity |
| Both | Extension UI record | Forward supported extension interactions between draht and the client |

See [RPC Commands](rpc-commands.md), [JSON Event Stream](json.md), and [RPC Extension UI](rpc-extension-ui.md) for the canonical record definitions.

### Correlate commands and responses

Every command accepts an optional string `id`. A matching response repeats it:

```json
{"id":"req-1","type":"get_state"}
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{"...":"..."}}
```

Use unique IDs whenever more than one command can be outstanding. Command handling is asynchronous, so clients should correlate by ID rather than response order.

Session events generally have no command ID because they describe session activity. `bash_execution_update` is the exception: when the originating [`bash`](rpc-commands.md#bash) command has an ID, its output events repeat that ID.

An `extension_ui_response` uses the ID supplied by its `extension_ui_request`. It does not produce a normal command response.

## Framing

RPC uses strict JSONL framing. Write one complete JSON object per record and terminate it with LF (`\n`). Read stdout as a byte or UTF-8 stream and split records only on LF. Strip an optional preceding carriage return to accept CRLF input.

Do not use a generic line reader that treats Unicode line or paragraph separators as record boundaries. In particular, Node.js `readline` also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

Read stdout continuously. draht honors stdout backpressure, but a client that stops reading can stall the process. Honor stdin backpressure when writing commands. Stdout is reserved for protocol records; diagnostics and application logging go to stderr.

## Run lifecycle

A successful `prompt` response means the prompt was accepted, queued, or handled. It does not mean model work completed:

```json
{"id":"req-2","type":"prompt","message":"Review this repository"}
{"id":"req-2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
```

`data.disposition` reports what happened to the prompt. If it is `"handled"`, no run started for this prompt, so don't wait for `agent_settled`. See [RPC Commands](rpc-commands.md#prompt) for all values.

Continue consuming [events](json.md) after that response. `agent_end` marks the end of one low-level agent run, but retries, overflow recovery, compaction, steering, or follow-up work can still follow. Wait for `agent_settled` when the client needs to know draht will not continue automatically.

Subscribe before sending a prompt to avoid missing a fast completion. `RpcClient.promptAndWait()` does this internally. If using separate `RpcClient` calls, install the event listener before `prompt()` and call `waitForIdle()` only while a run is active.

## Errors

A failed command returns one response with `success: false`:

```json
{"id":"req-3","type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}
```

Malformed JSON produces a parse response without a request ID:

```json
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token..."}
```

A success response only covers command handling. Provider failures and aborts after a prompt is accepted appear in the message and event stream.

Clients must also handle child-process startup failures, unexpected exits, stderr diagnostics, cancellation, and their own deadlines. Do not parse stderr as protocol data.

## Shutdown

Close the child's stdin to request an orderly shutdown. draht disposes the active runtime before exiting. Clients should still handle process signals and unexpected exits.

An extension can also request shutdown through its extension context. draht completes shutdown after the current command or after the active run emits `agent_settled`.

## Minimal client

This Python example uses a binary pipe reader, which splits on LF without treating Unicode separators as protocol boundaries:

```python
import json
import subprocess

process = subprocess.Popen(
    ["draht", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

assert process.stdin is not None
assert process.stdout is not None

command = {"id": "prompt-1", "type": "prompt", "message": "Hello"}
process.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
process.stdin.flush()

while line := process.stdout.readline():
    record = json.loads(line)
    if record.get("type") == "message_update":
        update = record["assistantMessageEvent"]
        if update["type"] == "text_delta":
            print(update["delta"], end="", flush=True)
    elif record.get("type") == "agent_settled":
        print()
        break

process.stdin.close()
process.wait()
```

For maintained TypeScript clients, use the checked [RPC client example](../examples/rpc-client.ts). It requires a built draht CLI because the repository example points to `dist/cli.js`.

## Extension UI option ids

[RPC Extension UI](rpc-extension-ui.md) defines the dialog requests and their `confirmed` / `value` / `cancelled` responses. draht extends dialog answers with an optional `optionId`, and an answer whose `id` matches no open dialog is silently dropped.

### Naming the option that was chosen (`optionId`)

A request may carry a `detail` object describing what is being decided. When it does, `detail.options`
is the immutable set of options that request offered, each stating its own meaning:

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Approve tool call?",
  "message": "bash wants to run a command",
  "detail": {
    "kind": "tool_permission",
    "toolCallId": "call-1",
    "toolName": "bash",
    "cwd": "/private/tmp/project",
    "command": "rm -rf build",
    "reason": "bash commands require approval by default",
    "options": [
      {"id": "approve", "label": "Yes", "decision": "approve"},
      {"id": "deny", "label": "No", "decision": "deny"}
    ]
  }
}
```

An answer may name which of those options was chosen by adding `optionId`:

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": false, "optionId": "deny"}
```

Rules, all enforced by the agent:

- `optionId` is **optional**. Clients that only know yes/no keep sending `confirmed` alone and are
  unaffected.
- When present, it **decides**: the named option's own `decision` (`"approve"` or `"deny"`) wins over
  `confirmed`, in both directions. `{"confirmed": true, "optionId": "deny"}` denies. Never infer an
  option's meaning from its position in the array, from the array's length, or from its id — read
  `decision`.
- When present, it must be **one of the ids that this request offered**. An id nobody offered, an id
  that appears twice in the offered set, and a present-but-non-string value such as
  `{"optionId": 123}` are all refused (see below). A wrongly-typed `optionId` is *not* treated as
  absent.
- When the matching request offered **no options** — any dialog raised without `detail`, such as
  `/rewind`'s "Restore files?" confirm or `/agent`'s picker — there is nothing to validate against,
  so `optionId` is ignored and the answer decides on `confirmed` / `value` as usual. A client may
  therefore attach `optionId` unconditionally without risk of stranding those dialogs.

### Refused response (`command: "extension_ui_response"`)

A rejected `optionId` is reported on stdout as an ordinary failed-command response — note that
`command` here is `"extension_ui_response"`, a value **no client ever sends as a command**. Clients
that switch exhaustively on `command` must expect it:

```json
{
  "id": "uuid-2",
  "type": "response",
  "command": "extension_ui_response",
  "success": false,
  "error": "optionId \"not-an-option\" is not one of the options offered for this request; the request is still pending"
}
```

The `id` is the **dialog request id**, not a command id. The refusal does **not** consume the
request: the dialog is still open and still answerable, and a subsequent valid answer — with a good
`optionId`, or with none at all — decides it. A client that receives this line should correct its
answer and send it again; ignoring it leaves the agent waiting.

## Reference

- [RPC Commands](rpc-commands.md): every stdin command and response
- [JSON Event Stream](json.md): shared stdout session events and streaming reconstruction
- [RPC Extension UI](rpc-extension-ui.md): dialogs, notifications, responses, and limitations
- [Message Types](message-types.md): messages and content blocks used by responses and events
- [Session File Format](session-format.md): entries returned by session commands
- [`rpc-types.ts`](https://github.com/draht-dev/draht/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts): exported TypeScript protocol definitions
- [`RpcClient`](https://github.com/draht-dev/draht/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts): subprocess client implementation

## Moved reference anchors

The detailed references formerly on this page now have dedicated pages. These anchors preserve existing links.

<a id="prompt"></a>
<a id="steer"></a>
<a id="follow_up"></a>
<a id="abort"></a>
<a id="clear_queue"></a>
<a id="new_session"></a>
<a id="get_state"></a>
<a id="get_messages"></a>
<a id="set_model"></a>
<a id="cycle_model"></a>
<a id="get_available_models"></a>
<a id="set_thinking_level"></a>
<a id="cycle_thinking_level"></a>
<a id="get_available_thinking_levels"></a>
<a id="set_steering_mode"></a>
<a id="set_follow_up_mode"></a>
<a id="compact"></a>
<a id="set_auto_compaction"></a>
<a id="set_auto_retry"></a>
<a id="abort_retry"></a>
<a id="bash"></a>
<a id="abort_bash"></a>
<a id="get_session_stats"></a>
<a id="export_html"></a>
<a id="switch_session"></a>
<a id="fork"></a>
<a id="clone"></a>
<a id="get_fork_messages"></a>
<a id="get_entries"></a>
<a id="get_tree"></a>
<a id="get_last_assistant_text"></a>
<a id="set_session_name"></a>
<a id="get_commands"></a>

Command details moved to [RPC Commands](rpc-commands.md).

<a id="message_update-streaming"></a>
<a id="bash_execution_update"></a>
<a id="compaction_start--compaction_end"></a>
<a id="summarization_retry_scheduled--summarization_retry_attempt_start--summarization_retry_finished"></a>

Event details moved to [JSON Event Stream](json.md).

<a id="extension-ui-protocol"></a>

Extension interaction details moved to [RPC Extension UI](rpc-extension-ui.md).
