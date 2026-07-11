#!/usr/bin/env python3
"""Persistent Python REPL driver for @draht/rlm.

Spawned once per `RlmSession` (`child_process.spawn("python3", [driverPath])`)
and kept alive for the session's lifetime so variables persist in one
`exec()` globals dict across steps.

Wire protocol: newline-delimited JSON on stdin/stdout. See the Architecture
section (2-3) of .planning/phases/26-rlm-core-primitives/26-01-PLAN.md for
the authoritative spec. Summary:

Node -> driver:
    {"type": "exec", "code": "<python source>"}
    {"type": "llm_query_response", "id": "<uuid>", "text": "<result>"}

Driver -> Node:
    {"type": "llm_query_request", "id": "<uuid>", "prompt": "<prompt>"}
    {"type": "exec_result", "stdout": "<captured stdout>",
     "error": "<traceback or null>",
     "final": null | {"kind": "value", "value": "<str>"}
            | {"kind": "var", "name": "<var name>", "value": "<repr'd value>"}}

Stdlib only: sys, json, io, contextlib, traceback, uuid.
"""

import contextlib
import io
import json
import sys
import traceback
import uuid

# Captured before any `exec()` call can redirect `sys.stdout` (see run_exec's
# `contextlib.redirect_stdout` below). Driver protocol messages -- including
# an `llm_query_request` written *during* a redirected exec() -- must always
# reach the real pipe Node is reading, never the StringIO buffer capturing
# the executed code's own print() output.
_REAL_STDOUT = sys.stdout


class _RlmFinal(Exception):
    """Internal control-flow exception raised by FINAL/FINAL_VAR.

    Carries the terminal payload as `.payload`. The exec wrapper below
    catches this exception class specifically -- never a bare
    `except Exception` -- so a real `FINAL(...)` call can never be confused
    with the text `FINAL(...)` appearing inside a string, a comment, or
    stdout the executed code happens to print. This is the "brittleness
    safeguard" the plan calls out: FINAL/FINAL_VAR are real function calls
    caught as a real exception, not a stdout text-pattern match.
    """

    def __init__(self, payload):
        super().__init__("RLM final result")
        self.payload = payload


def _write_message(message):
    _REAL_STDOUT.write(json.dumps(message) + "\n")
    _REAL_STDOUT.flush()


def _read_message():
    """Read and parse one newline-delimited JSON message from stdin.

    Returns None on EOF (stdin closed).
    """
    line = sys.stdin.readline()
    if line == "":
        return None
    line = line.strip()
    if not line:
        return _read_message()
    return json.loads(line)


def FINAL(answer):
    raise _RlmFinal({"kind": "value", "value": str(answer)})


def make_final_var(globals_dict):
    def FINAL_VAR(name):
        if name not in globals_dict:
            raise NameError(f"FINAL_VAR: name {name!r} is not defined")
        raise _RlmFinal(
            {"kind": "var", "name": name, "value": repr(globals_dict[name])}
        )

    return FINAL_VAR


def make_llm_query():
    """Build the injected `llm_query(prompt)` RPC client.

    Writes an `llm_query_request` to stdout, then blocks reading stdin for
    the matching `llm_query_response` (matched by `id`) before returning its
    `text`. This is the RPC-over-pipes mechanism that lets Python code call
    back into TypeScript (and therefore into a real or mocked LLM)
    mid-execution.
    """

    def llm_query(prompt):
        request_id = str(uuid.uuid4())
        _write_message(
            {"type": "llm_query_request", "id": request_id, "prompt": prompt}
        )
        while True:
            message = _read_message()
            if message is None:
                raise RuntimeError(
                    "llm_query: stdin closed while waiting for a response"
                )
            if (
                message.get("type") == "llm_query_response"
                and message.get("id") == request_id
            ):
                return message.get("text", "")
            # Anything else while blocked waiting for this specific response
            # is unexpected under the protocol; ignore rather than crash.

    return llm_query


def build_globals():
    globals_dict = {"__name__": "__rlm_repl__", "__builtins__": __builtins__}
    globals_dict["FINAL"] = FINAL
    globals_dict["FINAL_VAR"] = make_final_var(globals_dict)
    globals_dict["llm_query"] = make_llm_query()
    return globals_dict


def run_exec(code, globals_dict):
    """Execute one step's code against the persistent globals dict.

    Returns (stdout, error, final):
      - stdout: captured print()/stdout output as a str.
      - error: traceback string, or None if no (non-FINAL) exception raised.
      - final: the FINAL/FINAL_VAR payload dict, or None if neither was
        called.
    """
    stdout_buffer = io.StringIO()
    error = None
    final = None
    try:
        with contextlib.redirect_stdout(stdout_buffer):
            exec(code, globals_dict)
    except _RlmFinal as final_exc:
        final = final_exc.payload
    except Exception:
        error = traceback.format_exc()
    return stdout_buffer.getvalue(), error, final


def main():
    globals_dict = build_globals()
    while True:
        message = _read_message()
        if message is None:
            break
        msg_type = message.get("type")
        if msg_type == "exec":
            code = message.get("code", "")
            stdout, error, final = run_exec(code, globals_dict)
            _write_message(
                {
                    "type": "exec_result",
                    "stdout": stdout,
                    "error": error,
                    "final": final,
                }
            )
        elif msg_type == "llm_query_response":
            # Only meaningful while llm_query() is blocked reading stdin
            # directly (see make_llm_query above). If one reaches the main
            # loop there is no pending request awaiting it; ignore it rather
            # than crashing the driver.
            continue
        else:
            _write_message(
                {
                    "type": "exec_result",
                    "stdout": "",
                    "error": f"unknown message type: {msg_type!r}",
                    "final": None,
                }
            )


if __name__ == "__main__":
    main()
