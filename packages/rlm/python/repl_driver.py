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
    {"type": "configure", "stdoutTruncateChars": <int>}
    {"type": "self_test"}

Driver -> Node:
    {"type": "llm_query_request", "id": "<uuid>", "prompt": "<prompt>"}
    {"type": "exec_result", "stdout": "<captured stdout>",
     "error": "<traceback or null>",
     "final": null | {"kind": "value", "value": "<str>"}
            | {"kind": "var", "name": "<var name>", "value": "<repr'd value>"}}
    {"type": "self_test_result", "networkBlocked": <bool>, "networkError": <str|null>,
     "fileReadBlocked": <bool>, "fileReadError": <str|null>}

`configure` is new in Phase 28 (see Architecture section 5 of
.planning/phases/28-repl-sandbox-safety/28-01-PLAN.md): `RlmSession` sends
exactly one right after spawn, before any `exec`, to set the incremental
stdout cap. It produces no response (fire-and-forget) -- writes to stdin
are delivered strictly in order, so it's always applied before the first
real `exec` that follows it.

`self_test` is also new in Phase 28 (Architecture section 1's "startup
self-test"): `RlmSession` sends exactly one, after `configure` and before
seeding `context` or accepting any root-LLM-authored `exec`, and refuses to
run at all unless the response's `networkBlocked`/`fileReadBlocked` are both
`true`. See `_run_self_test`'s docstring for why this deliberately bypasses
this file's own Python-level guardrails rather than running through the
normal guarded `exec()` path.

Stdlib only: sys, json, io, contextlib, traceback, uuid, ast, builtins, and
(Linux only, best-effort) resource.

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

Resource limits (see the same plan's Architecture sections 3-5, Phase 28
task 3): the REAL memory/time enforcement mechanisms -- RSS polling and a
wall-clock per-step timeout -- live Node-side in `../src/session.ts`, which
hard-kills this whole process when either is exceeded. Nothing in this file
can protect itself from that kill, nor should it try to; there is no
in-process rollback for a hard kill, only for a recoverable Python exception
(see `_rollback_step` below). What *does* live here, as the corresponding
Python-side half of Phase 28 task 3:
  - `_TruncatingStdout`: caps captured stdout incrementally, per `write()`
    call, instead of the old design of buffering everything in a plain
    `io.StringIO()` and truncating Node-side only after the full string
    already arrived (which a step doing many `print()` calls in a loop could
    use to OOM this process before Node ever got a chance to truncate).
  - `_rollback_step`: diff-based (added/changed top-level names), not a
    deepcopy of the whole globals dict -- see its own docstring for why.
  - `_apply_linux_rlimit_as_backstop`: Linux-only, best-effort `RLIMIT_AS`
    backstop. Explicitly NOT the primary memory mechanism (Node's RSS
    polling is) and NOT used on macOS at all -- Darwin's `RLIMIT_AS`
    enforcement is unreliable and a tight limit can itself break interpreter
    startup on arm64.
"""

import ast
import builtins
import contextlib
import json
import sys
import traceback
import uuid

try:
    import resource
except ImportError:  # not available on Windows; this driver only ever runs
    # under the macOS/Linux sandbox wrappers in ../src/sandbox.ts, but stay
    # import-safe regardless.
    resource = None

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


def _run_self_test():
    """Runtime proof that the OS-level sandbox is actually enforcing for
    *this* process (Phase 28 Architecture section 1's "startup self-test"),
    handled for the `{"type": "self_test"}` wire message.

    Deliberately does NOT go through `run_exec`/`_screen_code`/the restricted
    builtins dict -- this is fixed, driver-authored code (not root-LLM
    step code), so it uses `import socket` / `open(...)` directly with the
    real, unrestricted builtins already available to this module. That's
    intentional, not an oversight: a self-test routed through the guarded
    `exec()` path would be a false positive -- e.g. `import socket` would be
    rejected by `_restricted_import`'s allowlist regardless of whether the OS
    sandbox is even present, so "the guarded exec() raised" would look
    identical whether the sandbox is enforcing or completely disabled. The
    whole point of this probe is to observe the OS boundary itself, so it
    must run on a route the Python-level guardrails never touch.

    Returns a dict with both checks' outcomes; never raises -- a failure to
    run either check *is* a finding (sandbox not enforcing), not a driver
    crash.
    """
    network_blocked = False
    network_error = None
    try:
        import socket

        probe_socket = socket.create_connection(("1.1.1.1", 80), timeout=2)
        probe_socket.close()
    except Exception as exc:  # noqa: BLE001 - any failure means "blocked", which is the desired outcome
        network_blocked = True
        network_error = repr(exc)

    file_read_blocked = False
    file_read_error = None
    try:
        with open("/etc/passwd") as handle:
            handle.read()
    except Exception as exc:  # noqa: BLE001 - ditto
        file_read_blocked = True
        file_read_error = repr(exc)

    return {
        "type": "self_test_result",
        "networkBlocked": network_blocked,
        "networkError": network_error,
        "fileReadBlocked": file_read_blocked,
        "fileReadError": file_read_error,
    }


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
# Resource limits (Phase 28 Architecture sections 3 and 5) -- the Python-side
# half only. The REAL wall-clock/memory enforcement is Node-side (RSS
# polling + step timeout in ../src/session.ts, which hard-kills this whole
# process); nothing here can substitute for that, and none of it runs after
# a hard kill (there's no in-process code left to run at that point).
# ---------------------------------------------------------------------------

# Default matches RlmSession's DEFAULT_STDOUT_TRUNCATE_CHARS (session.ts) --
# only relevant if a driver is ever spawned/exercised without a `configure`
# message first (e.g. the other Phase 26/28 test harnesses that talk to this
# driver directly), so normal short-output test cases aren't affected.
_DEFAULT_STDOUT_TRUNCATE_CHARS = 2000
_stdout_truncate_chars = _DEFAULT_STDOUT_TRUNCATE_CHARS

# Best-effort Linux-only RLIMIT_AS backstop (Phase 28 Architecture section 3)
# -- deliberately generous and NOT tied to any per-session RSS ceiling
# configured Node-side: it only needs to catch truly runaway allocation
# before the kernel OOM-killer would, as a second line of defense behind
# Node's RSS polling, which remains the real/primary mechanism everywhere
# (and the *only* one on macOS -- see the module docstring for why this is
# skipped there entirely).
_LINUX_RLIMIT_AS_BYTES = 1536 * 1024 * 1024


def _apply_linux_rlimit_as_backstop():
    """Sets a generous `RLIMIT_AS` on Linux only. A no-op everywhere else.

    Best-effort: any failure to read/set the limit is swallowed rather than
    crashing driver startup over a backstop that was never the primary
    mechanism to begin with.
    """
    if resource is None or not sys.platform.startswith("linux"):
        return
    try:
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        new_limit = (
            _LINUX_RLIMIT_AS_BYTES
            if hard == resource.RLIM_INFINITY
            else min(_LINUX_RLIMIT_AS_BYTES, hard)
        )
        resource.setrlimit(resource.RLIMIT_AS, (new_limit, hard))
    except (ValueError, OSError):
        pass


class _TruncatingStdout:
    """A `contextlib.redirect_stdout` target that caps itself incrementally.

    Replaces a plain `io.StringIO()` (Phase 26's original design): that
    approach captured the *entire* stdout in memory and relied on Node to
    truncate it after the full string already arrived over the wire --
    meaning a step that does many `print()` calls in a loop could balloon
    this process's memory (and the size of the JSON message written back to
    Node) well before Node ever got a chance to cut it down. This class stops
    accumulating once `limit` characters have been captured; every
    subsequent `write()` is O(1) (just an integer increment), never appended
    to any growing buffer, so the *captured* memory stays bounded regardless
    of how many more times the step calls `print()`.

    Only implements what `contextlib.redirect_stdout` + `print()` actually
    use (`write`, `flush`) plus `getvalue()` to retrieve the final string --
    not a general `io` implementation.

    Note this does NOT bound the memory of any single huge value passed to
    `print()` in one call (e.g. `print("x" * 10**9)` builds that 1GB string
    before `write()` ever sees it) -- that's exactly what Node's RSS polling
    (the real memory backstop, see session.ts) exists to catch instead.
    """

    def __init__(self, limit):
        self._limit = max(0, limit)
        self._chunks = []
        self._length = 0
        self._truncated_chars = 0

    def write(self, s):
        if not s:
            return 0
        remaining = self._limit - self._length
        if remaining <= 0:
            self._truncated_chars += len(s)
            return len(s)
        if len(s) <= remaining:
            self._chunks.append(s)
            self._length += len(s)
            return len(s)
        keep = s[:remaining]
        self._chunks.append(keep)
        self._length += len(keep)
        self._truncated_chars += len(s) - len(keep)
        return len(s)

    def flush(self):
        pass

    def getvalue(self):
        value = "".join(self._chunks)
        if self._truncated_chars > 0:
            value += f"\n[truncated {self._truncated_chars} chars]"
        return value


def _rollback_step(globals_dict, pre_keys, pre_values):
    """Diff-based rollback after a recoverable in-process exception.

    Corrected design per Phase 28 Architecture section 4 -- the plan's
    "IMPORTANT" section explicitly rejects a deepcopy-of-`globals()`
    approach (doesn't scale to a `context` value that can be arbitrarily
    large, copied on every single step regardless of whether it's ever
    touched). Instead: `pre_keys`/`pre_values` are a *shallow* snapshot taken
    before `exec()` (see `run_exec`) -- `dict(globals_dict)` copies key/value
    *references* only, which is O(number of globals), never O(size of any
    individual value) -- and this function does two things with them:
      - Removes every key present now that wasn't present before the step
        (new names the step created).
      - Restores the prior value (by reference, not by copy) for every key
        that existed before and is either missing now (`del`eted by the
        step) or rebound to a different object now (`is not` its prior
        value).

    Deliberately shallow: an in-place mutation of an existing object (e.g.
    `some_list.append(x)`, with `some_list` never rebound) is NOT rolled
    back -- only name rebindings are. That's the explicit trade-off the plan
    makes in exchange for not deep-copying the whole namespace every step.

    Never called after a hard kill (timeout/OOM/sandbox failure) -- those
    terminate this whole process from the outside (Node-side); there is no
    Python left running to roll anything back, and no attempt is made to.
    Only reachable from `run_exec`'s `except Exception` branch, i.e. a
    genuinely recoverable in-process exception.
    """
    post_keys = set(globals_dict.keys())
    for key in post_keys - pre_keys:
        del globals_dict[key]
    for key in pre_keys:
        if key not in globals_dict or globals_dict[key] is not pre_values[key]:
            globals_dict[key] = pre_values[key]


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

    Takes a shallow pre-exec snapshot (`pre_keys`/`pre_values`, see
    `_rollback_step`'s docstring for why this is O(number of globals), not
    O(size of `context` or anything else)) and, on a recoverable in-process
    exception, rolls the step back via `_rollback_step` (Phase 28
    Architecture section 4) before returning. No rollback is attempted for
    `FINAL`/`FINAL_VAR` (that's the normal termination path, not an error) --
    only for the `except Exception` branch below.

    Returns (stdout, error, final):
      - stdout: captured print()/stdout output as a str, already capped +
        marked by `_TruncatingStdout` (Phase 28 Architecture section 5) at
        `_stdout_truncate_chars`.
      - error: traceback string (or a guardrail-rejection message), or None
        if no (non-FINAL) exception/rejection occurred.
      - final: the FINAL/FINAL_VAR payload dict, or None if neither was
        called.
    """
    try:
        _screen_code(code)
    except _GuardrailViolation as guardrail_exc:
        return "", str(guardrail_exc), None

    pre_keys = set(globals_dict.keys())
    pre_values = dict(globals_dict)  # shallow -- see _rollback_step's docstring

    stdout_buffer = _TruncatingStdout(_stdout_truncate_chars)
    error = None
    final = None
    try:
        with contextlib.redirect_stdout(stdout_buffer):
            exec(code, globals_dict)
    except _RlmFinal as final_exc:
        final = final_exc.payload
    except Exception:
        error = traceback.format_exc()
        _rollback_step(globals_dict, pre_keys, pre_values)
    return stdout_buffer.getvalue(), error, final


def main():
    global _stdout_truncate_chars
    _apply_linux_rlimit_as_backstop()
    globals_dict = build_globals()
    while True:
        message = _read_message()
        if message is None:
            break
        msg_type = message.get("type")
        if msg_type == "configure":
            value = message.get("stdoutTruncateChars")
            if isinstance(value, int) and value > 0:
                _stdout_truncate_chars = value
            continue
        if msg_type == "self_test":
            _write_message(_run_self_test())
            continue
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
