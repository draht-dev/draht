"""Gate judging: is the test the agent just wrote a real gate, or a rubber stamp?

The agent writing a test is the same probabilistic process the test is meant to
constrain, so a test it wrote is a claim, not evidence. This module turns that
claim into evidence wherever a machine can, and leaves exactly one question for
the human: is this the right thing to gate, and is the bar high enough.

Two stages, because the two questions can only be answered at different moments:

  red   — the test exists, the implementation does not. Run the test against the
          code as it stands. It MUST fail, and how it fails matters: an assertion
          failure is a real red, an import or compile error is a weak one (it
          proves a module is missing, not that behaviour is wrong), and a pass
          proves the test is not a gate at all.
  green — the implementation landed and the test passes. Now mutate the source
          lines the change touched and re-run: a test that survives every
          mutation does not bite.

Everything here is best-effort and fail-open. A repo with no runnable test
command, no git, or a wedged suite produces a card with less evidence on it,
never a blocked session.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import judgelib as J

LEDGER = J.ROOT / "gates.jsonl"
SESSIONS = J.ROOT / "sessions"

# Defaults; overridden per repo by .planning/config.json → "gates".
DEFAULTS = {
    "enabled": True,
    "testCommand": None,   # "{file}" is substituted; falls back to inference
    "timeout": 180,        # seconds per test run
    "mutants": 5,          # how many mutations to try at the green stage
    "budget": 600,         # seconds for a whole verification pass
}

# --------------------------------------------------------------------------- #
# file classification
# --------------------------------------------------------------------------- #

TEST_PATH_RE = re.compile(r"(^|/)(tests?|specs?|__tests__|testdata)(/|$)")
TEST_FILE_RE = re.compile(
    r"(^|/)(test_[^/]+\.py"
    r"|[^/]+_test\.(py|go|rs|ts|js|mjs|cjs)"
    r"|[^/]+[._-](test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php)"
    r"|[^/]+Test\.(java|kt|scala|cs)"
    r"|[^/]+Tests\.(cs|swift))$"
)
CODE_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".rb",
    ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php",
    ".scala", ".ex", ".exs", ".zig", ".lua",
}


def is_test_file(path):
    p = str(path).replace("\\", "/")
    return bool(TEST_FILE_RE.search(p) or (TEST_PATH_RE.search(p) and Path(p).suffix in CODE_SUFFIXES))


def is_code_file(path):
    return Path(str(path)).suffix in CODE_SUFFIXES


def is_gateable_source(path):
    """A source edit that a gate should have preceded: code, and not a test."""
    return is_code_file(path) and not is_test_file(path)


# --------------------------------------------------------------------------- #
# per-session state: which tests have been written but not yet judged
# --------------------------------------------------------------------------- #

def _session_path(sid):
    return SESSIONS / f"{(sid or 'unknown').replace('/', '_')}.json"


def load_session(sid):
    data = J._read_json(_session_path(sid))
    if not isinstance(data, dict):
        data = {}
    data.setdefault("pending", {})   # test path → first-seen timestamp
    data.setdefault("gates", {})     # card id → {"files": [...], "stage": "red"}
    return data


def save_session(sid, data):
    SESSIONS.mkdir(parents=True, exist_ok=True)
    J._write_json(_session_path(sid), data)


def record_test_edit(sid, path):
    data = load_session(sid)
    data["pending"].setdefault(os.path.realpath(str(path)), time.time())
    save_session(sid, data)


def take_pending(sid):
    data = load_session(sid)
    files = sorted(data["pending"])
    data["pending"] = {}
    save_session(sid, data)
    return files


def remember_gate(sid, card_id, files, stage):
    data = load_session(sid)
    data["gates"][card_id] = {"files": files, "stage": stage, "ts": time.time()}
    save_session(sid, data)


def awaiting_green(sid):
    """Gates approved at red whose mutation pass has not run yet."""
    data = load_session(sid)
    return {cid: g for cid, g in data["gates"].items() if g.get("stage") == "red"}


def mark_green_done(sid, card_id):
    data = load_session(sid)
    if card_id in data["gates"]:
        data["gates"][card_id]["stage"] = "green"
        save_session(sid, data)


# --------------------------------------------------------------------------- #
# repo helpers
# --------------------------------------------------------------------------- #

def _run(args, cwd=None, timeout=60, env=None):
    try:
        p = subprocess.run(args, cwd=cwd, timeout=timeout, capture_output=True, text=True, env=env)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timed out"
    except OSError as exc:
        return 127, str(exc)


def repo_root(cwd):
    """The repo containing `cwd`, as a real path.

    Hosts hand over a cwd that may travel through symlinks (`/var/...` for
    `/private/var/...` on macOS, a symlinked home, `/tmp`), while git always
    answers with the real one. Mixing the two silently produces `../../..`
    paths that point outside the repo, so every path this module handles is
    resolved once, here and in `rel_in_repo`.
    """
    code, out = _run(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
    if code != 0 or not out.strip():
        return None
    return os.path.realpath(out.strip())


def rel_in_repo(repo, path):
    """`path` relative to `repo`, or None when it is not inside it."""
    if not repo or not path:
        return None
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(repo))
    if rel.startswith("..") or os.path.isabs(rel):
        return None
    return rel


def config(repo):
    cfg = dict(DEFAULTS)
    if os.environ.get("JUDGE_GATES") in ("0", "false", "off"):
        cfg["enabled"] = False
    if not repo:
        return cfg
    data = J._read_json(Path(repo) / ".planning" / "config.json") or {}
    gates = data.get("gates")
    if isinstance(gates, dict):
        for key in DEFAULTS:
            if key in gates:
                cfg[key] = gates[key]
    return cfg


def changed_files(repo):
    code, out = _run(["git", "status", "--porcelain=1", "-z"], cwd=repo)
    if code != 0:
        return []
    files = []
    for entry in out.split("\0"):
        if len(entry) > 3:
            files.append(entry[3:])
    return files


def changed_lines(repo, path):
    """1-based line numbers added or changed in `path` versus HEAD."""
    code, out = _run(["git", "diff", "-U0", "HEAD", "--", path], cwd=repo)
    if code != 0:
        return []
    lines, current = [], 0
    for line in out.split("\n"):
        head = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
        if head:
            current = int(head.group(1))
            continue
        if line.startswith("+") and not line.startswith("+++"):
            lines.append(current)
            current += 1
    return lines


def added_test_names(repo, paths):
    """The `it(...)` / `def test_...` names this change introduces — the claims."""
    names = []
    patterns = [
        re.compile(r"""(?:it|test|describe)\s*(?:\.\w+)?\s*\(\s*[\"'`](.+?)[\"'`]"""),
        re.compile(r"""def\s+(test_[A-Za-z0-9_]+)"""),
        re.compile(r"""func\s+(Test[A-Za-z0-9_]+)"""),
        re.compile(r"""fn\s+(\w+)\s*\(\s*\)\s*\{?\s*(?://.*)?$"""),
    ]
    for path in paths:
        code, out = _run(["git", "diff", "HEAD", "--", path], cwd=repo)
        if code != 0 or not out.strip():
            try:
                out = "\n".join("+" + ln for ln in Path(repo, path).read_text().split("\n"))
            except OSError:
                continue
        for line in out.split("\n"):
            if not line.startswith("+") or line.startswith("+++"):
                continue
            body = line[1:]
            for pattern in patterns:
                found = pattern.search(body)
                if found:
                    names.append(found.group(1).strip())
                    break
    seen, unique = set(), []
    for name in names:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return unique


def added_lines_text(repo, paths, limit=6000):
    chunks = []
    for path in paths:
        code, out = _run(["git", "diff", "HEAD", "--", path], cwd=repo)
        if code != 0 or not out.strip():
            try:
                out = Path(repo, path).read_text()
            except OSError:
                continue
        chunks.append(f"── {path}\n{out}")
    return "\n\n".join(chunks)[:limit]


# --------------------------------------------------------------------------- #
# static smells — cheap, no execution, work in any repo
# --------------------------------------------------------------------------- #

ASSERT_RE = re.compile(r"\b(expect|assert|assert_|should|require|assertEqual|assertThat|t\.(Error|Fatal))\b")
MOCK_ASSERT_RE = re.compile(r"(toHaveBeenCalled|toBeCalled|assert_called|assert_any_call|verify\(|\.called\b|calledWith)")
SNAPSHOT_RE = re.compile(r"toMatchSnapshot|toMatchInlineSnapshot|assert_snapshot")
SKIP_RE = re.compile(r"\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(")
ONLY_RE = re.compile(r"\b(it|test|describe)\.only\b|\bfit\(|\bfdescribe\(")
TAUTOLOGY_RE = re.compile(r"expect\(\s*(true|1|\"\w*\")\s*\)\s*\.\s*(toBe|toEqual)\s*\(\s*\1\s*\)|assert\s+True\b|assertTrue\(True\)")
PRIVATE_RE = re.compile(r"@ts-expect-error|@ts-ignore|\[[\"']_|\._[a-zA-Z]")
EMPTY_CATCH_RE = re.compile(r"catch\s*(\([^)]*\))?\s*\{\s*\}|except[^:]*:\s*(pass|\.\.\.)\s*$")


def smells(text):
    """Structural tells that a test is not the gate it looks like."""
    added = [ln[1:] for ln in text.split("\n") if ln.startswith("+") and not ln.startswith("+++")]
    body = "\n".join(added) if added else text
    found = []

    def flag(code, note):
        found.append({"code": code, "note": note})

    asserts = [ln for ln in body.split("\n") if ASSERT_RE.search(ln)]
    if not asserts:
        flag("no-assertion", "no assertion in the added test body — it can only fail by throwing")
    elif all(MOCK_ASSERT_RE.search(ln) for ln in asserts):
        flag("mock-only", "every assertion is about a mock being called, not about a result")
    elif all(SNAPSHOT_RE.search(ln) for ln in asserts):
        flag("snapshot-only", "the only assertion is a snapshot — it ratifies whatever the code does")
    if TAUTOLOGY_RE.search(body):
        flag("tautology", "asserts a constant against itself — passes for any implementation")
    if SKIP_RE.search(body):
        flag("skipped", "the test is skipped or todo — a gate that never runs")
    if ONLY_RE.search(body):
        flag("only", "`.only` left in — it silences every other test in the file")
    if PRIVATE_RE.search(body):
        flag("internals", "reaches into private internals or suppresses the type checker")
    if EMPTY_CATCH_RE.search(body):
        flag("swallowed", "an empty catch/except in a test hides the failure it should report")
    return found


# --------------------------------------------------------------------------- #
# test command resolution
# --------------------------------------------------------------------------- #

def test_command(repo, cfg, test_file):
    """Argv for running one test file, or None when nothing can be inferred."""
    template = cfg.get("testCommand")
    if template:
        return ["sh", "-c", template.replace("{file}", test_file)]

    root = Path(repo)
    suffix = Path(test_file).suffix
    pkg = J._read_json(root / "package.json") or {}
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    scripts = pkg.get("scripts") or {}

    if suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
        if "vitest" in deps:
            return ["npx", "--no-install", "vitest", "run", test_file]
        if "jest" in deps:
            return ["npx", "--no-install", "jest", "--silent", test_file]
        if "bun test" in str(scripts.get("test", "")) or (root / "bun.lock").exists():
            return ["bun", "test", test_file]
        if "node --test" in str(scripts.get("test", "")) or test_file.endswith(".test.mjs"):
            return ["node", "--test", test_file]
    if suffix == ".py":
        if (root / "pyproject.toml").exists() or (root / "pytest.ini").exists() or "pytest" in str(scripts):
            return ["python3", "-m", "pytest", "-q", test_file]
        return ["python3", "-m", "unittest", test_file]
    if suffix == ".go":
        return ["go", "test", "./" + str(Path(test_file).parent)]
    if suffix == ".rs":
        return ["cargo", "test"]
    return None


# --------------------------------------------------------------------------- #
# isolated replay: a throwaway worktree, never the session's own files
# --------------------------------------------------------------------------- #

DEP_DIRS = ("node_modules", ".venv", "venv", "vendor")

# A test runner already in the environment poisons the replay: a nested
# `node --test` that inherits NODE_TEST_CONTEXT reports itself to the outer
# runner and exits 0 whatever happened, which would make every mutation look
# survived and every red look green. Whatever spawned this hook — a host, a CI
# step, another test runner — the replay gets a clean slate.
POISON_ENV_PREFIXES = ("NODE_TEST", "VITEST", "JEST", "NPM_CONFIG", "npm_", "MOCHA", "TAP_", "BUN_TEST")
POISON_ENV_KEYS = ("NODE_OPTIONS", "NODE_ENV", "TEST_ENV", "FORCE_COLOR")


def clean_env():
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in POISON_ENV_KEYS and not key.startswith(POISON_ENV_PREFIXES)
    }
    # CI keeps runners non-interactive; JUDGE_GATES stops a replayed suite from
    # gating itself if the repo under test happens to be this plugin.
    env.update({"CI": "1", "JUDGE_GATES": "0", "NO_COLOR": "1"})
    return env


class Replay:
    """A detached worktree at HEAD that the session's changes are copied into.

    The point is to run the suite against states the working tree is not in —
    the implementation reverted, or a mutation applied — without ever touching
    the files the session is editing.
    """

    def __init__(self, repo, cfg):
        self.repo = Path(repo)
        self.cfg = cfg
        self.dir = None
        self.deadline = time.time() + cfg["budget"]

    def __enter__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="judge-gate-"))
        target = self.dir / "tree"
        code, out = _run(["git", "worktree", "add", "--detach", str(target), "HEAD"], cwd=str(self.repo), timeout=120)
        if code != 0:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.dir = None
            raise RuntimeError(f"worktree failed: {out.strip()[:200]}")
        self.tree = target
        self._link_deps()
        return self

    def __exit__(self, *_):
        if self.dir:
            _run(["git", "worktree", "remove", "--force", str(self.tree)], cwd=str(self.repo), timeout=120)
            shutil.rmtree(self.dir, ignore_errors=True)
        return False

    def _link_deps(self):
        """Installed dependencies are symlinked in — reinstalling is not an option."""
        for name in DEP_DIRS:
            for source in [self.repo / name] + list(self.repo.glob(f"*/*/{name}")) + list(self.repo.glob(f"*/{name}")):
                if not source.is_dir():
                    continue
                link = self.tree / source.relative_to(self.repo)
                if link.exists() or link.is_symlink():
                    continue
                link.parent.mkdir(parents=True, exist_ok=True)
                try:
                    link.symlink_to(source, target_is_directory=True)
                except OSError:
                    pass

    def put_working(self, rel_paths):
        """Copy the session's current version of these files into the replay."""
        for rel in rel_paths:
            source, dest = self.repo / rel, self.tree / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if source.exists():
                shutil.copy2(source, dest)
            elif dest.exists():
                dest.unlink()

    def put_head(self, rel_paths):
        """Restore these files to their committed state inside the replay."""
        for rel in rel_paths:
            code, _ = _run(["git", "checkout", "HEAD", "--", rel], cwd=str(self.tree))
            if code != 0:
                dest = self.tree / rel
                if dest.exists():
                    dest.unlink()

    def read(self, rel):
        return (self.tree / rel).read_text()

    def write(self, rel, text):
        (self.tree / rel).write_text(text)

    def run_test(self, test_file):
        argv = test_command(str(self.repo), self.cfg, test_file)
        if argv is None:
            return None
        left = max(5, min(self.cfg["timeout"], int(self.deadline - time.time())))
        code, out = _run(argv, cwd=str(self.tree), timeout=left, env=clean_env())
        return {"exit": code, "output": out[-4000:], "argv": argv}


# --------------------------------------------------------------------------- #
# failure classification
# --------------------------------------------------------------------------- #

IMPORT_ERROR_RE = re.compile(
    r"cannot find module|module not found|modulenotfounderror|importerror|no module named"
    r"|is not defined|cannot find name|has no attribute|undefined: |unresolved import"
    r"|failed to resolve|collection error|error ts\d+|syntaxerror|parse error|build failed",
    re.I,
)


def classify_failure(result):
    """'pass' | 'assertion' | 'error' | 'timeout' | 'unrunnable' for one run."""
    if result is None:
        return "unrunnable"
    if result["exit"] == 124:
        return "timeout"
    if result["exit"] == 127:
        return "unrunnable"
    if result["exit"] == 0:
        return "pass"
    return "error" if IMPORT_ERROR_RE.search(result["output"] or "") else "assertion"


# --------------------------------------------------------------------------- #
# mutation operators
# --------------------------------------------------------------------------- #

MUTATIONS = [
    (re.compile(r"==="), "!=="), (re.compile(r"!=="), "==="),
    (re.compile(r"(?<![=!<>])==(?!=)"), "!="), (re.compile(r"!=(?!=)"), "=="),
    (re.compile(r"<=(?!=)"), "<"), (re.compile(r">=(?!=)"), ">"),
    (re.compile(r"(?<![<>=])<(?![=<])"), "<="), (re.compile(r"(?<![<>=])>(?![=>])"), ">="),
    (re.compile(r"&&"), "||"), (re.compile(r"\|\|"), "&&"),
    (re.compile(r"\btrue\b"), "false"), (re.compile(r"\bfalse\b"), "true"),
    (re.compile(r"\bTrue\b"), "False"), (re.compile(r"\bFalse\b"), "True"),
    (re.compile(r"\band\b"), "or"), (re.compile(r"\bor\b"), "and"),
    (re.compile(r"(?<![\w.])0(?![\w.])"), "1"), (re.compile(r"(?<![\w.])1(?![\w.])"), "2"),
    (re.compile(r"\+(?![+=])"), "-"),
]

SKIP_MUTATION_RE = re.compile(r"^\s*(//|#|/\*|\*|import\b|from\b|export\s+(type|interface)\b)")


def mutants_for(repo, path, lines, cap):
    """Candidate single-token mutations on the lines this change touched."""
    try:
        text = Path(repo, path).read_text()
    except OSError:
        return []
    source = text.split("\n")
    out = []
    for lineno in lines:
        if lineno < 1 or lineno > len(source):
            continue
        line = source[lineno - 1]
        if not line.strip() or SKIP_MUTATION_RE.match(line):
            continue
        for pattern, replacement in MUTATIONS:
            found = pattern.search(line)
            if not found:
                continue
            mutated = line[:found.start()] + replacement + line[found.end():]
            out.append({
                "file": path, "line": lineno,
                "op": f"{found.group(0)} → {replacement}",
                "before": line.strip()[:120], "after": mutated.strip()[:120],
            })
            break
    # Spread the sample across distinct lines rather than clustering on one.
    return out[:cap] if len(out) <= cap else [out[i] for i in range(0, len(out), max(1, len(out) // cap))][:cap]


def apply_mutant(replay, mutant):
    text = replay.read(mutant["file"]).split("\n")
    text[mutant["line"] - 1] = text[mutant["line"] - 1].replace(
        mutant["op"].split(" → ")[0], mutant["op"].split(" → ")[1], 1
    )
    replay.write(mutant["file"], "\n".join(text))


# --------------------------------------------------------------------------- #
# the two verification passes
# --------------------------------------------------------------------------- #

def verify_red(repo, cfg, test_files, source_files):
    """Does the new test fail against the code as it stands, and how?

    Reports the mechanical fact only: `passes`, `real-red`, `weak-red`,
    `timeout`, `unrunnable`. What a pass *means* depends on the moment and is
    the caller's call — at the red gate, where an implementation is about to be
    written, a passing test cannot constrain it and is a fake gate; at the end
    of a turn with no implementation coming, a test written for behaviour that
    already exists is expected to pass and only the mutation pass can score it.
    """
    result = {"stage": "red", "status": "done", "runs": [], "reverted": list(source_files)}
    try:
        with Replay(repo, cfg) as replay:
            replay.put_working(test_files)
            if source_files:
                # A gate is judged against the implementation it precedes, so any
                # source already written in this turn is reverted for the replay.
                replay.put_head(source_files)
            for test_file in test_files:
                run = replay.run_test(test_file)
                verdict = classify_failure(run)
                result["runs"].append({
                    "file": test_file, "verdict": verdict,
                    "command": " ".join(run["argv"]) if run else None,
                    "output": (run or {}).get("output", "")[-1500:],
                })
    except Exception as exc:
        return {"stage": "red", "status": "error", "error": str(exc)[:300], "runs": [],
                "reverted": list(source_files)}

    verdicts = [r["verdict"] for r in result["runs"]]
    if not verdicts or all(v == "unrunnable" for v in verdicts):
        result["conclusion"] = "unrunnable"
    elif "pass" in verdicts:
        result["conclusion"] = "passes"
    elif "assertion" in verdicts:
        result["conclusion"] = "real-red"
    elif "timeout" in verdicts:
        result["conclusion"] = "timeout"
    else:
        result["conclusion"] = "weak-red"
    return result


def verify_green(repo, cfg, test_files, source_files):
    """The test passes — now does it notice when the implementation is wrong?"""
    result = {"stage": "green", "status": "done", "mutants": [], "baseline": None}
    cap = int(cfg["mutants"])
    try:
        with Replay(repo, cfg) as replay:
            replay.put_working(test_files + source_files)
            baseline = replay.run_test(test_files[0])
            result["baseline"] = classify_failure(baseline)
            result["command"] = " ".join(baseline["argv"]) if baseline else None
            if result["baseline"] != "pass":
                result["note"] = "the suite does not pass in a clean replay, so mutation results would be noise"
                return result

            candidates = []
            for path in source_files:
                candidates += mutants_for(repo, path, changed_lines(repo, path), cap)
            candidates = candidates[:cap]
            if not candidates:
                result["note"] = "no single-token mutation applies to the lines this change touched"

            for mutant in candidates:
                if time.time() > replay.deadline:
                    result["note"] = "verification budget spent — partial result"
                    break
                apply_mutant(replay, mutant)
                run = replay.run_test(test_files[0])
                verdict = classify_failure(run)
                mutant["result"] = verdict
                # A mutant the suite cannot even load proves nothing about the test.
                mutant["killed"] = verdict in ("assertion", "timeout")
                mutant["invalid"] = verdict == "error"
                result["mutants"].append(mutant)
                replay.put_working([mutant["file"]])
    except Exception as exc:
        return {"stage": "green", "status": "error", "error": str(exc)[:300], "mutants": []}

    scored = [m for m in result["mutants"] if not m.get("invalid")]
    result["killed"] = sum(1 for m in scored if m["killed"])
    result["scored"] = len(scored)
    if result["baseline"] != "pass":
        result["conclusion"] = "unverified"
    elif not scored:
        result["conclusion"] = "unverified"
    elif result["killed"] == 0:
        result["conclusion"] = "rubber-stamp"
    elif result["killed"] < result["scored"]:
        result["conclusion"] = "partial"
    else:
        result["conclusion"] = "bites"
    return result


# --------------------------------------------------------------------------- #
# ledger — so "how good are our gates" is a trend, not a feeling
# --------------------------------------------------------------------------- #

def append_ledger(card):
    meta = card.get("meta") or {}
    verify = meta.get("verify") or {}
    record = {
        "ts": card.get("decided_at") or time.time(),
        "card": card["id"],
        "repo": Path(card.get("cwd") or ".").name,
        "branch": meta.get("branch", ""),
        "stage": meta.get("stage", ""),
        "files": meta.get("files", []),
        "claims": meta.get("claims", []),
        "conclusion": verify.get("conclusion", ""),
        "killed": verify.get("killed"),
        "scored": verify.get("scored"),
        "smells": [s["code"] for s in meta.get("smells", [])],
        "verdict": card.get("verdict", ""),
        "auto": bool(meta.get("auto")),
        "comment": card.get("comment", ""),
    }
    J.ensure_dirs()
    with LEDGER.open("a") as fh:
        fh.write(json.dumps(record) + "\n")


def read_ledger(limit=None):
    if not LEDGER.exists():
        return []
    records = []
    for line in LEDGER.read_text().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return records[-limit:] if limit else records
