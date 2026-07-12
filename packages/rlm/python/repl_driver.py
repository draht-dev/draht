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

Stdlib only: sys, json, io, contextlib, traceback, uuid, ast, builtins.

Security model (see .planning/phases/28-repl-sandbox-safety/28-01-PLAN.md,
the plan's "IMPORTANT" section and Architecture sections 1-2): the REAL
security boundary for this driver is the OS-level process sandbox it is
spawned inside of (`packages/rlm/src/sandbox.ts` -- `sandbox-exec` on macOS,
`unshare`/`bwrap` on Linux), established by the caller *before* this script
ever runs. Everything below this point in the file -- the restricted
builtins dict, the restricted `__import__`, and the AST pre-screen -- is
Python-level defense-in-depth for a confused/prompt-injected root LLM (clean
`ImportError`/guardrail errors instead of a raw crash, keeps it on the
rails), NOT a claim that arbitrary adversarial Python is safely confined by
this layer alone. It provably is not: any function/generator object reachable
through the live Python object graph (e.g.
`(_ for _ in ()).gi_frame.f_builtins['__import__']`) carries its own
`__globals__`/`f_builtins` pointing at the process's *real* unrestricted
builtins, independent of what this module binds as `__builtins__` in the
exec globals dict. Swapping `__builtins__` here narrows the *names visible
by direct lookup* in step code; it does not narrow what's reachable via
attribute traversal. That's exactly why the OS sandbox --  not this file --
is what actually stops a deliberately adversarial payload.
"""

import ast
import builtins
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


# ---------------------------------------------------------------------------
# Python-level guardrails (defense-in-depth -- NOT the security boundary).
#
# See the module docstring above: the OS-level sandbox (sandbox.ts) is what
# actually stops an adversarial payload. This section exists to give a
# confused/prompt-injected root LLM a clean, actionable error and to keep
# ordinary generated code from wandering into obviously-unsafe territory --
# not to make in-process execution of arbitrary Python safe.
# ---------------------------------------------------------------------------

# Allowlist, not blocklist: only these names are reachable by direct lookup
# in step code's exec() globals. Deliberately omits `open`, `exec`, `eval`,
# `compile`, `input`, `breakpoint`, `help`, `getattr`, `setattr`, `vars`,
# `globals`, `locals`, `type`, and the raw `__import__` (replaced below with
# a restricted version) per Architecture section 2 of the Phase 28 plan --
# "prefer omitting" over trying to wrap any of these into a restricted-safe
# form.
_ALLOWED_BUILTIN_NAMES = (
    # Types
    "bool",
    "int",
    "float",
    "complex",
    "str",
    "bytes",
    "bytearray",
    "list",
    "tuple",
    "dict",
    "set",
    "frozenset",
    "object",
    "slice",
    # Functions
    "print",
    "len",
    "range",
    "enumerate",
    "zip",
    "map",
    "filter",
    "sorted",
    "reversed",
    "min",
    "max",
    "sum",
    "abs",
    "round",
    "pow",
    "divmod",
    "all",
    "any",
    "iter",
    "next",
    "isinstance",
    "issubclass",
    "repr",
    "format",
    "hash",
    "chr",
    "ord",
    "hex",
    "oct",
    "bin",
    "callable",
    "id",
    # Constants
    "NotImplemented",
    # Exception family -- deliberately excludes BaseException, SystemExit,
    # KeyboardInterrupt, and GeneratorExit, none of which a normal data-
    # processing step legitimately needs by name, and all of which could
    # otherwise be used to unwind past this driver's own exec() wrapper (see
    # run_exec's `except Exception`, not `except BaseException`, below).
    "Exception",
    "ArithmeticError",
    "AssertionError",
    "AttributeError",
    "BufferError",
    "EOFError",
    "FileExistsError",
    "FileNotFoundError",
    "FloatingPointError",
    "ImportError",
    "IndentationError",
    "IndexError",
    "IOError",
    "KeyError",
    "LookupError",
    "MemoryError",
    "ModuleNotFoundError",
    "NameError",
    "NotImplementedError",
    "OSError",
    "OverflowError",
    "PermissionError",
    "RecursionError",
    "ReferenceError",
    "RuntimeError",
    "StopAsyncIteration",
    "StopIteration",
    "SyntaxError",
    "SystemError",
    "TabError",
    "TypeError",
    "UnboundLocalError",
    "UnicodeDecodeError",
    "UnicodeEncodeError",
    "UnicodeError",
    "UnicodeTranslateError",
    "ValueError",
    "ZeroDivisionError",
)

# Import allowlist per R28-SBX.1 / Architecture section 2: only these
# top-level stdlib modules may be imported from step code. Anything else
# (most notably `os`, `sys`, `subprocess`, `socket`, `urllib`, `shutil`,
# `pathlib`, `ctypes`) raises a clear ImportError instead of a raw crash.
_ALLOWED_IMPORT_MODULES = frozenset(
    {"re", "json", "math", "itertools", "collections", "statistics"}
)


def _restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
    """Replacement for `__import__` bound into the restricted builtins dict.

    Checks only the top-level package name (`"os.path"` -> `"os"`) against
    `_ALLOWED_IMPORT_MODULES` so `import collections` / `from collections
    import OrderedDict` / `import itertools as it` all resolve normally for
    allowed modules, while anything outside the allowlist -- including
    submodules of a disallowed package -- is rejected before the real
    `__import__` (captured via the top-level `import builtins` above, which
    this function itself is not going through) ever runs.
    """
    top_level = name.split(".", 1)[0]
    if top_level not in _ALLOWED_IMPORT_MODULES:
        raise ImportError(
            f"import of {name!r} is not allowed in the RLM sandbox guardrail "
            f"layer; allowed modules: {sorted(_ALLOWED_IMPORT_MODULES)}"
        )
    return builtins.__import__(name, globals, locals, fromlist, level)


def _build_restricted_builtins():
    """Constructs the exec globals' `__builtins__` dict from the allowlist.

    CPython honors a plain dict (not just a module) bound to `__builtins__`
    in an exec() globals dict as the builtins namespace directly, so any
    name not explicitly copied in here (or `_restricted_import`, bound to
    `__import__` below) is simply unresolvable by direct name lookup from
    step code -- it raises `NameError`, not a permission error, which is the
    correct/expected shape for an allowlist.
    """
    restricted = {name: getattr(builtins, name) for name in _ALLOWED_BUILTIN_NAMES}
    restricted["__import__"] = _restricted_import
    return restricted


# Attribute names that are the well-known object-graph escape routes flagged
# by the security consult behind this plan (see the plan's "IMPORTANT"
# section) -- reaching any of these from a step is rejected outright,
# regardless of how the attribute is reached (dotted access on any
# expression, not just a literal name).
_DUNDER_ESCAPE_ATTRS = frozenset(
    {
        "__class__",
        "__subclasses__",
        "__bases__",
        "__base__",
        "__globals__",
        "__builtins__",
        "__import__",
        "__mro__",
    }
)

# Non-dunder frame-related attribute names that are equally dangerous --
# required because the litmus case
# `(_ for _ in ()).gi_frame.f_builtins['__import__']('os')` reaches the real
# builtins without touching a single dunder, so a dunder-only check would
# miss it entirely.
_FRAME_ESCAPE_ATTRS = frozenset(
    {"gi_frame", "f_builtins", "f_globals", "f_back", "cr_frame", "ag_frame"}
)

# Names that are dangerous purely by being called/referenced directly, even
# though they're already omitted from the restricted builtins dict above --
# the AST screen catches these as a *pre*-exec, clear-error rejection (see
# _GuardrailViolation) instead of letting a step partially execute up to the
# point where it would otherwise hit a NameError.
_BANNED_NAMES = frozenset(
    {
        "eval",
        "exec",
        "compile",
        "getattr",
        "setattr",
        "vars",
        "globals",
        "locals",
        "__import__",
    }
)


class _GuardrailViolation(Exception):
    """Raised by `_screen_code` when the AST pre-screen rejects a step.

    Caught in `run_exec` and turned into a plain `exec_result.error` string
    -- a driver-level guardrail rejection, not a raw Python exception -- and
    raised *before* any exec() call, so a rejected step has zero side
    effects (nothing it contains ever runs, not even the part before the
    offending construct).
    """


def _screen_code(code):
    """AST pre-screen: rejects known escape-technique shapes before exec().

    Parses `code` and walks every node, rejecting (via `_GuardrailViolation`)
    if it finds:
      - Attribute access naming a dunder escape route (`_DUNDER_ESCAPE_ATTRS`).
      - Attribute access naming a non-dunder frame escape route
        (`_FRAME_ESCAPE_ATTRS`).
      - A direct `Name` reference to a banned name (`_BANNED_NAMES`) --
        covers both bare references and calls, since `foo(...)` parses as a
        `Call` node whose `func` is itself a `Name` node that `ast.walk`
        visits independently.

    A `SyntaxError` from `ast.parse` itself is deliberately NOT a guardrail
    rejection -- that's not an escape attempt, just invalid code, and letting
    it fall through to the normal `exec()` call preserves Phase 26's existing
    `exec_result.error` reporting for plain syntax errors.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            if node.attr in _DUNDER_ESCAPE_ATTRS:
                raise _GuardrailViolation(
                    f"blocked by RLM sandbox guardrail: attribute access to "
                    f"{node.attr!r} is not allowed (object-graph escape risk)"
                )
            if node.attr in _FRAME_ESCAPE_ATTRS:
                raise _GuardrailViolation(
                    f"blocked by RLM sandbox guardrail: attribute access to "
                    f"{node.attr!r} is not allowed (frame escape risk)"
                )
        elif isinstance(node, ast.Name):
            if node.id in _BANNED_NAMES:
                raise _GuardrailViolation(
                    f"blocked by RLM sandbox guardrail: use of {node.id!r} "
                    "is not allowed"
                )


def build_globals():
    globals_dict = {
        "__name__": "__rlm_repl__",
        "__builtins__": _build_restricted_builtins(),
    }
    globals_dict["FINAL"] = FINAL
    globals_dict["FINAL_VAR"] = make_final_var(globals_dict)
    globals_dict["llm_query"] = make_llm_query()
    return globals_dict


def run_exec(code, globals_dict):
    """Execute one step's code against the persistent globals dict.

    Runs the AST pre-screen (`_screen_code`) first -- a rejection there
    short-circuits before `exec()` is ever called, so a rejected step has no
    side effects at all (see `_GuardrailViolation`'s docstring).

    Returns (stdout, error, final):
      - stdout: captured print()/stdout output as a str.
      - error: traceback string (or a guardrail-rejection message), or None
        if no (non-FINAL) exception/rejection occurred.
      - final: the FINAL/FINAL_VAR payload dict, or None if neither was
        called.
    """
    try:
        _screen_code(code)
    except _GuardrailViolation as guardrail_exc:
        return "", str(guardrail_exc), None

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
