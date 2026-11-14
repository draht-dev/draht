export const meta = {
  name: "rebase-upstream-polyphase",
  description:
    "Rebase draht on upstream pi: find unapplied upstream commits, classify them in parallel, cherry-pick in sequential batches, then run branding, customization and verification gates until a clean round, then merge into main (never pushes).",
  whenToUse: "Syncing draht-mono with the pi remote; the polyphase form of /rebase-upstream.",
  phases: [
    { title: "Recon", detail: "fetch pi/main, find sync point, list unapplied commits", model: "anthropic/claude-fable-5-1" },
    { title: "Classify", detail: "take / skip / adapt, parallel chunks", model: "anthropic/claude-fable-5-1" },
    { title: "Reconcile", detail: "dependency-consistent final list, create work branch", model: "anthropic/claude-fable-5-1" },
    { title: "Cherry-pick", detail: "sequential batches, oldest first", model: "anthropic/claude-sonnet-5-5" },
    { title: "Branding sweep", model: "anthropic/claude-sonnet-5-5" },
    { title: "Customization guard", model: "anthropic/claude-fable-5-1" },
    { title: "Verify", detail: "bun run check until clean", model: "anthropic/claude-sonnet-5-5" },
    { title: "Final branding audit", model: "anthropic/claude-sonnet-5-5" },
    { title: "Final customization guard", model: "anthropic/claude-fable-5-1" },
    { title: "Merge", detail: "work branch into main, no push", model: "anthropic/claude-fable-5-1" },
  ],
};

// ---------------------------------------------------------------- constants
const FABLE = "anthropic/claude-fable-5-1";
const SONNET = "anthropic/claude-sonnet-5-5";
const REPO = "/srv/work/draht/draht-mono";
const POLICY = ".draht/prompts/rebase-upstream.md";
const GUARD = "node scripts/check-draht-customizations.mjs";
const CLASSIFY_CHUNK = 40;
const PICK_BATCH = 10;
const MAX_GATE_ROUNDS = 5;

const PRE = [
  "CONTEXT (you have no other context; read it carefully)",
  "- Repo " + REPO + " (draht-mono), a rebranded fork of upstream pi-mono. Remote `pi` = https://github.com/badlogic/pi-mono.git; `pi/main` is already fetched unless your task says to fetch.",
  "- Read " + POLICY + " in full before doing anything. It is the policy for this whole operation: version, changelog, README and branding conflicts are always resolved in draht's favour.",
  "- Hard rules: NEVER push. NEVER edit any README.md (root, packages/*, apps/*). Never accept upstream `version` fields or CHANGELOG.md content. Stage by explicit path only; never `git add -A`, `git add .`, `git commit -a`, `git reset --hard`, `git checkout .`, `git clean`, `git stash`, `git commit --no-verify`. Never rebase, and never amend any commit except the cherry-pick commit you just created (reword only). Never run dev/build/test scripts.",
  "- Draht convention for cherry-picked commits: subject prefixed `upstream: `, body keeps the upstream body, a trailer `(cherry picked from commit <full upstream sha>)`, and `(#N)` in the subject rewritten to `(badlogic/pi-mono#N)`. This trailer is the ledger that later syncs use to know what was applied, so it must be present on every cherry-picked commit.",
  "- Toolchain: `node`, `bun`, `rg`, `git` are on PATH. Work in " + REPO + ".",
  "- Other agents may hold uncommitted files in this checkout: touch only files your task requires and never revert files you did not change.",
].join("\n");

// ------------------------------------------------------------------ schemas
const RECON_SCHEMA = {
  type: "object",
  properties: {
    sync_point: { type: "string", description: "full sha of the newest upstream commit already applied to draht" },
    total_since_sync: { type: "number" },
    already_applied: { type: "number" },
    candidates: {
      type: "array",
      description: "unapplied upstream commits, oldest first",
      items: {
        type: "object",
        properties: {
          hash: { type: "string", description: "full 40-char sha" },
          subject: { type: "string" },
          dirs: { type: "string", description: "top-level dirs touched, comma separated, e.g. packages/coding-agent, apps/p2" },
          stat: { type: "string", description: "e.g. 5 files, +120/-30" },
        },
        required: ["hash", "subject", "dirs", "stat"],
      },
    },
    upstream_only_paths: {
      type: "array",
      items: { type: "string" },
      description: "top-level dirs touched by candidates that do not exist in draht main",
    },
    notes: { type: "string" },
  },
  required: ["sync_point", "total_since_sync", "already_applied", "candidates", "upstream_only_paths", "notes"],
};

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hash: { type: "string" },
          classification: { type: "string", description: "take | skip | adapt" },
          reason: { type: "string" },
          provides: { type: "string", description: "new packages/dirs/exports this commit introduces that later commits may depend on, or empty" },
          depends_on_new: { type: "string", description: "new upstream packages/dirs this commit needs (imports, workspace deps), or empty" },
        },
        required: ["hash", "classification", "reason", "provides", "depends_on_new"],
      },
    },
    notes: { type: "string" },
  },
  required: ["items", "notes"],
};

const RECONCILE_SCHEMA = {
  type: "object",
  properties: {
    final: {
      type: "array",
      description: "every candidate exactly once, oldest first",
      items: {
        type: "object",
        properties: {
          hash: { type: "string" },
          subject: { type: "string" },
          classification: { type: "string", description: "take | skip | adapt" },
          reason: { type: "string" },
        },
        required: ["hash", "subject", "classification", "reason"],
      },
    },
    branch: { type: "string", description: "name of the created work branch, or empty when nothing is picked" },
    branch_created: { type: "boolean" },
    skipped_groups: { type: "string", description: "human summary of what was skipped and why" },
    notes: { type: "string" },
  },
  required: ["final", "branch", "branch_created", "skipped_groups", "notes"],
};

const PICK_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hash: { type: "string" },
          status: { type: "string", description: "success | adapted | failed | skipped" },
          reason: { type: "string" },
        },
        required: ["hash", "status", "reason"],
      },
    },
    head: { type: "string" },
    clean: { type: "boolean", description: "git status clean and no cherry-pick in progress" },
    notes: { type: "string" },
  },
  required: ["results", "head", "clean", "notes"],
};

const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    clean: { type: "boolean" },
    applied: { type: "array", items: { type: "string" }, description: "full upstream shas applied on the work branch, from the cherry-pick trailers" },
    notes: { type: "string" },
  },
  required: ["clean", "applied", "notes"],
};

const BRANDING_SCHEMA = {
  type: "object",
  properties: {
    files_changed: { type: "array", items: { type: "string" } },
    committed: { type: "boolean" },
    zero_hits: { type: "boolean", description: "final scans show zero branding hits" },
    notes: { type: "string" },
  },
  required: ["files_changed", "committed", "zero_hits", "notes"],
};

const GATE_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    fixes: { type: "array", items: { type: "string" }, description: "files fixed, empty when nothing was needed" },
    committed: { type: "boolean" },
    notes: { type: "string" },
  },
  required: ["pass", "fixes", "committed", "notes"],
};

const MERGE_SCHEMA = {
  type: "object",
  properties: {
    merged: { type: "boolean" },
    head: { type: "string" },
    commits_merged: { type: "number" },
    branch_deleted: { type: "boolean" },
    notes: { type: "string" },
  },
  required: ["merged", "head", "commits_merged", "branch_deleted", "notes"],
};

// ------------------------------------------------------------------ helpers
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function normalizeClass(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "take" || v === "adapt" || v === "skip" ? v : "skip";
}

function fmtCommit(c) {
  return c.hash + " " + c.subject + " [" + c.dirs + "; " + c.stat + "]";
}

function fmtPick(c) {
  return c.hash + " " + c.subject + " — " + c.classification;
}

function stopped(reason, extra) {
  return "STOPPED: " + reason + (extra ? "\n" + extra : "");
}

// ======================================================================= run
phase("Recon");
log("fetching pi/main and computing the unapplied set");
const recon = await agent(
  [
    PRE,
    "",
    "TASK: Recon. Read-only except `git fetch pi main`. Do not create branches, do not commit.",
    "",
    "Draht's history does not share hashes with upstream, so `git log HEAD..pi/main` is useless (thousands of commits). Applied commits are recorded by `(cherry picked from commit <sha>)` trailers in draht commit bodies and by `upstream: <subject>` subjects. Compute:",
    "1. `git fetch pi main`.",
    "2. PICKED = all shas from `git log --format=%b main | grep -oE 'cherry picked from commit [0-9a-f]{40}' | awk '{print $5}' | sort -u`.",
    "3. SYNC_POINT = the first sha in `git rev-list pi/main` that is in PICKED (newest applied upstream commit).",
    "4. RANGE = `git rev-list --reverse --no-merges SYNC_POINT..pi/main`.",
    "5. CANDIDATES = RANGE minus PICKED minus subject-matched commits. Subject match: normalise both sides by stripping a leading `upstream: `, a trailing ` (#N)` or ` (badlogic/pi-mono#N)`, and whitespace; an upstream commit whose normalised subject equals that of any draht commit since SYNC_POINT's draht-side date (use `git log --format=%s main` over, say, the last 1500 commits) is already applied.",
    "6. For every candidate record: full sha, subject, top-level dirs touched (first two path components, e.g. `packages/coding-agent`, `apps/p2`, or the bare file name for root files), and a short stat (`N files, +A/-D`). Use `git show --stat=200 --format='' <sha>` or `git diff-tree --no-commit-id -r --numstat <sha>`; batch the git calls, do not run one process per commit where a single `git log --numstat` over the range does the job.",
    "7. upstream_only_paths = the top-level dirs touched by candidates that do not exist in draht main (`git ls-tree main <dir>` is empty).",
    "",
    "Return the structured result (candidates oldest first). In notes, state SYNC_POINT's subject, the counts, and anything odd (e.g. an in-progress cherry-pick, dirty tree, missing remote). End with a line `STATUS: OK` or `STATUS: FAIL <reason>`.",
  ].join("\n"),
  { label: "recon", phase: "Recon", model: FABLE, schema: RECON_SCHEMA },
);

if (!recon) return stopped("recon agent failed or produced no structured result");
const candidates = (recon.candidates || []).filter((c) => c && c.hash && c.subject);
log("sync point " + recon.sync_point.slice(0, 10) + ": " + recon.total_since_sync + " upstream commits since, " + recon.already_applied + " already applied, " + candidates.length + " candidates");
if (recon.upstream_only_paths && recon.upstream_only_paths.length) log("upstream-only paths: " + recon.upstream_only_paths.join(", "));
if (candidates.length === 0) return "Already up to date with pi/main (sync point " + recon.sync_point + ").\n" + recon.notes;

// ----------------------------------------------------------------- classify
phase("Classify");
const chunks = chunk(candidates, CLASSIFY_CHUNK);
log("classifying " + candidates.length + " candidates in " + chunks.length + " parallel chunk(s)");
const classified = await parallel(
  chunks.map((part, i) => () =>
    agent(
      [
        PRE,
        "",
        "TASK: Classify upstream commits as take / skip / adapt. Read-only: inspect with `git show --stat <sha>` and `git show <sha>` (or `git diff-tree`), never check out, cherry-pick or commit.",
        "",
        "Rules (from " + POLICY + "):",
        "- skip: release/version commits, changelog-only commits, commits that only bump `version` in package.json, commits that only touch CHANGELOG.md, any commit whose sole effect is version bookkeeping. Also skip commits that only touch README.md files, and chore commits that only touch upstream-only bookkeeping (e.g. scripts/issues, .pi/ assets, nix pins, contributor approvals) with no code effect for draht.",
        "- take: meaningful code changes: bug fixes, features, refactors, dependency updates, test improvements.",
        "- adapt: useful code mixed with version/changelog/README noise (the cherry-picker drops those hunks).",
        "- Upstream-only subsystems: these top-level paths exist upstream but not in draht main: " + (recon.upstream_only_paths && recon.upstream_only_paths.length ? recon.upstream_only_paths.join(", ") : "(none)") + ". A commit confined to such paths is an upstream experiment draht does not carry (apps/p2 is documented upstream as a throwaway prototype): classify it `skip` with reason `upstream-only path: <dir>`. EXCEPTION: if such a path is a new package that code draht does carry depends on (workspace dependency or import from packages/coding-agent, packages/ai, packages/agent, packages/tui, packages/mcp, packages/schema, packages/chord, packages/codemode, packages/telemetry ...), say so in depends_on_new / provides so the reconcile step can take it; check with `git show <sha> -- '**/package.json'` and grep the diff for import paths.",
        "- Commits that touch both draht-carried paths and upstream-only paths: `adapt`, reason must say which path hunks to drop.",
        "- When in doubt between take and adapt, choose adapt and say why.",
        "",
        "Fill `provides` (new package names / dirs / exported modules this commit introduces that later commits may build on) and `depends_on_new` (new upstream packages or dirs this commit requires). Empty string when none.",
        "",
        "Chunk " + (i + 1) + "/" + chunks.length + " (" + part.length + " commits, oldest first):",
        part.map(fmtCommit).join("\n"),
        "",
        "Return one item per commit above, same hashes, same order. End with `STATUS: OK`.",
      ].join("\n"),
      { label: "classify " + (i + 1) + "/" + chunks.length, phase: "Classify", model: FABLE, schema: CLASSIFY_SCHEMA },
    ),
  ),
);

const byHash = new Map();
for (const c of candidates) byHash.set(c.hash, { ...c, classification: "", reason: "", provides: "", depends_on_new: "" });
let classifiedCount = 0;
classified.forEach((res, i) => {
  if (!res) {
    log("classify chunk " + (i + 1) + " returned nothing; its commits go to reconcile unclassified");
    return;
  }
  for (const item of res.items || []) {
    const entry = byHash.get(item.hash);
    if (!entry) continue;
    entry.classification = normalizeClass(item.classification);
    entry.reason = item.reason || "";
    entry.provides = item.provides || "";
    entry.depends_on_new = item.depends_on_new || "";
    classifiedCount++;
  }
});
log(classifiedCount + "/" + candidates.length + " candidates classified");

// ---------------------------------------------------------------- reconcile
phase("Reconcile");
const draft = candidates.map((c) => {
  const e = byHash.get(c.hash);
  return (
    e.hash + " | " + e.subject + " | " + e.dirs + " | " + (e.classification || "UNCLASSIFIED") + " | " + e.reason +
    (e.provides ? " | provides: " + e.provides : "") +
    (e.depends_on_new ? " | depends_on_new: " + e.depends_on_new : "")
  );
});
const reconcile = await agent(
  [
    PRE,
    "",
    "TASK: Reconcile the draft classification into the final cherry-pick list, then create the work branch.",
    "",
    "Draft (oldest first; columns: sha | subject | dirs | classification | reason | provides | depends_on_new):",
    draft.join("\n"),
    "",
    "Do:",
    "1. Classify any UNCLASSIFIED entry yourself using the rules in " + POLICY + " and the same upstream-only-path rule the classifiers used (upstream-only paths: " + (recon.upstream_only_paths || []).join(", ") + ").",
    "2. Dependency consistency: a `skip` that `provides` something a later `take`/`adapt` `depends_on_new` is a contradiction. Resolve it deliberately: either take the provider (and every later commit to that provider that the dependents need) or downgrade the dependents to `skip`/`adapt` with a reason. Verify with `git show --stat`/`git show <sha> -- '**/package.json'` where the draft is vague. Upstream-only subsystems must be all-in or all-out per subsystem, and say which in skipped_groups.",
    "3. Sanity: every draft sha appears exactly once in `final`, order unchanged, classification in {take, skip, adapt}.",
    "4. If at least one commit is take/adapt: ensure `git status --porcelain` shows no staged or modified tracked files that would block a checkout, then create the work branch from main. Preferred name `upstream-sync`; if `git branch --list upstream-sync` or `git worktree list` shows it already exists (it is checked out in another worktree), use `upstream-sync-$(date +%Y%m%d)`, adding `-2`, `-3` ... until free. `git checkout -b <name> main`. Report the name in `branch`. If nothing is picked, create no branch and leave `branch` empty.",
    "",
    "End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
  ].join("\n"),
  { label: "reconcile", phase: "Reconcile", model: FABLE, schema: RECONCILE_SCHEMA },
);

if (!reconcile) return stopped("reconcile agent failed; no branch was created, nothing to clean up");
const finalList = (reconcile.final || []).map((e) => ({ ...e, classification: normalizeClass(e.classification) }));
const picks = finalList.filter((e) => e.classification !== "skip");
const skips = finalList.filter((e) => e.classification === "skip");
log("final: " + picks.length + " to cherry-pick (" + picks.filter((e) => e.classification === "adapt").length + " adapt), " + skips.length + " skipped");
if (picks.length === 0) {
  return "Nothing to cherry-pick: all " + finalList.length + " unapplied upstream commits were skipped.\n\n" + reconcile.skipped_groups + "\n\n" + reconcile.notes;
}
if (!reconcile.branch_created || !reconcile.branch) return stopped("reconcile did not create a work branch", reconcile.notes);
const BRANCH = reconcile.branch;
log("work branch: " + BRANCH);

// -------------------------------------------------------------- cherry-pick
phase("Cherry-pick");
const batches = chunk(picks, PICK_BATCH);
const pickResults = [];
const applied = new Set();
let repairs = 0;

async function runBatch(list, label) {
  return agent(
    [
      PRE,
      "",
      "TASK: Cherry-pick upstream commits onto `" + BRANCH + "` (" + label + "). First `git branch --show-current` must print `" + BRANCH + "` and `git status --porcelain` must show no in-progress cherry-pick; otherwise stop with STATUS: FAIL and do nothing.",
      "",
      "Commits, oldest first (full sha, subject, classification):",
      list.map(fmtPick).join("\n"),
      "",
      "Per commit:",
      "- take: `git cherry-pick -x <sha>`. Then reword the subject to the draht convention: prefix `upstream: ` and rewrite a trailing `(#N)` to `(badlogic/pi-mono#N)` (`git commit --amend` immediately after your own cherry-pick commit is allowed for this reword only, never on older commits).",
      "- adapt: `git cherry-pick --no-commit <sha>`; unstage and drop every hunk that touches a `version` field in any package.json, any CHANGELOG.md, any README.md, and any upstream-only path named in the reason; then commit with subject `upstream: <subject with (#N) rewritten>`, the original body, a line `(cherry picked from commit <sha>)` and a line `Excluded: <what was dropped>`.",
      "- Any pick that touches a README.md: `git checkout HEAD -- README.md packages/*/README.md apps/*/README.md` before committing (never fail a pick over a README hunk).",
      "- Conflicts: resolve per policy (version/CHANGELOG/README: ours). `git cherry-pick --continue` keeps the -x trailer. If the conflict is substantive and you cannot resolve it with confidence, `git cherry-pick --abort` and report the commit as failed with the reason; do not leave partial state.",
      "- A commit that turns out to be empty on this branch (`git cherry-pick` says 'nothing to commit' / already applied): `git cherry-pick --skip` and report `skipped`.",
      "- After every commit: `git diff HEAD~1 --stat`, then `" + GUARD + "`. If the guard fails, fix per the policy document's section 5 and commit the fix (explicit paths) before the next commit; if the fix is not obvious, `git revert --no-edit HEAD` and report the commit as failed.",
      "",
      "When done: `git status --porcelain` must be empty and `git rev-parse --verify CHERRY_PICK_HEAD` must fail. Report one result per commit (same shas), `head` = `git rev-parse --short HEAD`, `clean` accordingly. End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
    ].join("\n"),
    { label: label, phase: "Cherry-pick", model: SONNET, agentType: "cherry-picker", schema: PICK_SCHEMA },
  );
}

async function repair(label) {
  repairs++;
  return agent(
    [
      PRE,
      "",
      "TASK: Repair the cherry-pick state on `" + BRANCH + "` after a batch agent died (" + label + ").",
      "1. `git branch --show-current` must be `" + BRANCH + "`; if main is checked out, `git checkout " + BRANCH + "` (only if the tree allows it).",
      "2. If a cherry-pick is in progress (`git rev-parse --verify CHERRY_PICK_HEAD` succeeds or `git status` says so): `git cherry-pick --abort`.",
      "3. Any leftover modified/staged tracked files from the dead batch that belong to the pick in progress: restore them with `git checkout HEAD -- <explicit paths>` only for paths touched by that upstream commit (`git diff-tree --no-commit-id -r --name-only <sha>` for the CHERRY_PICK_HEAD sha). Never touch untracked files.",
      "4. Run `" + GUARD + "`; if it fails, fix per policy and commit (explicit paths).",
      "5. List the upstream shas applied so far on this branch: `git log --format=%b main.." + BRANCH + " | grep -oE 'cherry picked from commit [0-9a-f]{40}' | awk '{print $5}'`.",
      "Report `clean` (tree clean, no cherry-pick in progress, branch checked out) and `applied`. End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
    ].join("\n"),
    { label: "repair " + label, phase: "Cherry-pick", model: FABLE, schema: REPAIR_SCHEMA },
  );
}

for (let b = 0; b < batches.length; b++) {
  const label = "batch " + (b + 1) + "/" + batches.length;
  let batch = batches[b];
  log(label + ": " + batch.length + " commits");
  let res = await runBatch(batch, label);
  if (!res) {
    log(label + " returned nothing; repairing state");
    const fix = await repair(label);
    if (!fix || !fix.clean) {
      pickResults.push(...batch.map((c) => ({ hash: c.hash, status: "failed", reason: "batch agent died and repair could not restore a clean state" })));
      return stopped("cherry-pick state could not be repaired at " + label + "; branch " + BRANCH + " left as is", fix ? fix.notes : "");
    }
    for (const sha of fix.applied || []) applied.add(sha);
    const done = batch.filter((c) => applied.has(c.hash));
    pickResults.push(...done.map((c) => ({ hash: c.hash, status: "success", reason: "applied before the batch agent died" })));
    batch = batch.filter((c) => !applied.has(c.hash));
    if (batch.length === 0) continue;
    log(label + ": retrying " + batch.length + " remaining commit(s)");
    res = await runBatch(batch, label + " retry");
    if (!res) {
      const fix2 = await repair(label + " retry");
      for (const sha of (fix2 && fix2.applied) || []) applied.add(sha);
      pickResults.push(...batch.map((c) => ({ hash: c.hash, status: applied.has(c.hash) ? "success" : "failed", reason: applied.has(c.hash) ? "applied before the retry died" : "batch agent died twice" })));
      if (!fix2 || !fix2.clean) return stopped("cherry-pick state could not be repaired after retry at " + label + "; branch " + BRANCH + " left as is", fix2 ? fix2.notes : "");
      continue;
    }
  }
  for (const r of res.results || []) {
    pickResults.push(r);
    if (r.status === "success" || r.status === "adapted") applied.add(r.hash);
  }
  if (!res.clean) {
    log(label + " reported an unclean tree; repairing");
    const fix = await repair(label + " post");
    if (!fix || !fix.clean) return stopped("tree unclean after " + label + " and repair failed; branch " + BRANCH + " left as is", fix ? fix.notes : "");
  }
}

const failedPicks = pickResults.filter((r) => r.status === "failed");
log("cherry-pick done: " + pickResults.filter((r) => r.status === "success").length + " success, " + pickResults.filter((r) => r.status === "adapted").length + " adapted, " + pickResults.filter((r) => r.status === "skipped").length + " skipped, " + failedPicks.length + " failed" + (repairs ? ", " + repairs + " repair(s)" : ""));

// ---------------------------------------------------------- gate functions
function brandingTask(kind) {
  const scope =
    kind === "sweep"
      ? "Scan the codebase and the diff main.." + BRANCH + " for pi branding leaks. Fix all hits."
      : "Final audit. Scan the entire codebase for pi branding leaks. Fix all hits and confirm zero remaining.";
  return [
    PRE,
    "",
    "TASK (branding-guard): " + scope,
    "Branch `" + BRANCH + "` must be checked out (`git branch --show-current`). Never touch README.md files; a README hit means revert that README to main (`git checkout main -- <readme>`) and re-check, never an edit. Do not rename the `pi` git remote, `pi-test.sh`, `Math.PI`, upstream GitHub URLs used as remote refs, or references inside " + POLICY + " and .draht/agents/branding-guard.md.",
    "After fixing, run `" + GUARD + "`, then commit your fixes on `" + BRANCH + "` with explicit paths and subject `fix(branding): remove pi references leaked by upstream sync`. If nothing needed fixing, commit nothing.",
    "Report files_changed (empty when clean), committed, zero_hits (true only if the final re-scan shows zero hits), notes with the final scan output summary. End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
  ].join("\n");
}

function guardTask(kind) {
  return [
    PRE,
    "",
    "TASK: " + (kind === "final" ? "Final draht customization guard." : "Draht customization guard after cherry-picks and branding sweep."),
    "Branch `" + BRANCH + "` must be checked out and `git status --porcelain` empty before you start; if not, stop with STATUS: FAIL.",
    "1. Run `" + GUARD + "` (full output). If it fails, fix per section 5 of " + POLICY + " (restore `YYYY.M.D` versions, `drahtConfig`, `workspace:*` deps, draht-only scripts, `dist/draht`, `.planning/` via `git checkout main -- .planning/`, `scripts/verify.sh` via `git checkout main -- scripts/verify.sh`, missing GSD/agent/prompt/hook files via `git checkout main -- <path>`, and the `CORE_BUILTIN_EXTENSIONS` import + spread wiring in `packages/coding-agent/src/core/builtins/index.ts` and `agent-session-services.ts`). Re-run until it passes.",
    "2. Independent checks against main, all must be empty:",
    "   - `git diff main..HEAD --stat -- README.md 'packages/*/README.md' 'apps/*/README.md'` (README untouched); if not empty: `git checkout main -- <those readmes>` and commit.",
    "   - `git diff main..HEAD -- '*package.json' | grep -E '^[-+]\\s*\"version\"'` (no version changes); if not empty, restore main's version values in those files and commit.",
    "   - `git diff main..HEAD --stat -- '*CHANGELOG.md'` (no changelog changes); if not empty: `git checkout main -- <those changelogs>` and commit.",
    "   - `git diff main..HEAD --stat -- '*package.json' | cat` reviewed for `@mariozechner/pi*` names or non-`workspace:*` `@draht/*` deps.",
    "3. Commit every fix with explicit paths, subject `fix(sync): restore draht customizations after upstream sync`.",
    "Report pass (guard passes and all checks empty at the end), fixes (files changed, empty if none), committed, notes with the final guard output's last lines. End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
  ].join("\n");
}

function verifyTask(round) {
  return [
    PRE,
    "",
    "TASK (verifier): Run `bun run check` from " + REPO + " and fix all errors, warnings, and infos until clean (round " + round + ").",
    "Branch `" + BRANCH + "` must be checked out. Capture the full output, no tail. Fix the actual issues; never remove or downgrade code to silence a type error, never delete intentional functionality, never touch README.md or CHANGELOG.md, never change `version` fields. If upstream code needs a draht-side adaptation (renamed package, `@draht/*` import, missing workspace dep), make it.",
    "Commit your fixes on `" + BRANCH + "` with explicit paths and subject `fix(sync): make bun run check pass after upstream sync`. If nothing needed fixing, commit nothing.",
    "Report pass (final `bun run check` exit code 0), fixes (files changed, empty if none), committed, notes with the final check output's last 30 lines. End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
  ].join("\n");
}

// ---------------------------------------------------------- branding sweep
phase("Branding sweep");
const sweep = await agent(brandingTask("sweep"), { label: "branding sweep", phase: "Branding sweep", model: SONNET, agentType: "branding-guard", schema: BRANDING_SCHEMA });
if (!sweep) return stopped("branding sweep agent failed; branch " + BRANCH + " left as is");
log("branding sweep: " + sweep.files_changed.length + " file(s) fixed, zero_hits=" + sweep.zero_hits);

// ------------------------------------------------------ customization guard
phase("Customization guard");
const guard1 = await agent(guardTask("first"), { label: "customization guard", phase: "Customization guard", model: FABLE, schema: GATE_SCHEMA });
if (!guard1) return stopped("customization guard agent failed; branch " + BRANCH + " left as is");
log("customization guard: pass=" + guard1.pass + ", " + guard1.fixes.length + " fix(es)");
if (!guard1.pass) return stopped("draht customization guard still failing after fixes; branch " + BRANCH + " left for manual repair", guard1.notes);

// ------------------------------------- verify / final audit / final guard
// Loop until one full round changes nothing: verify passes with no fixes,
// the final branding audit finds nothing, and the final guard applies no fix.
let verify = null;
let audit = null;
let guard2 = null;
let converged = false;
let round = 0;
while (!converged && round < MAX_GATE_ROUNDS) {
  round++;
  phase("Verify");
  verify = await agent(verifyTask(round), { label: "verify r" + round, phase: "Verify", model: SONNET, agentType: "verifier", schema: GATE_SCHEMA });
  if (!verify) return stopped("verifier agent failed in round " + round + "; branch " + BRANCH + " left as is");
  log("verify r" + round + ": pass=" + verify.pass + ", " + verify.fixes.length + " fix(es)");
  if (!verify.pass) return stopped("bun run check still failing after the verifier's fixes (round " + round + "); branch " + BRANCH + " left for manual repair", verify.notes);

  phase("Final branding audit");
  audit = await agent(brandingTask("final"), { label: "branding audit r" + round, phase: "Final branding audit", model: SONNET, agentType: "branding-guard", schema: BRANDING_SCHEMA });
  if (!audit) return stopped("final branding audit agent failed in round " + round + "; branch " + BRANCH + " left as is");
  log("branding audit r" + round + ": " + audit.files_changed.length + " file(s) fixed, zero_hits=" + audit.zero_hits);
  if (!audit.zero_hits) return stopped("branding audit cannot reach zero hits (round " + round + "); branch " + BRANCH + " left for manual repair", audit.notes);

  phase("Final customization guard");
  guard2 = await agent(guardTask("final"), { label: "final guard r" + round, phase: "Final customization guard", model: FABLE, schema: GATE_SCHEMA });
  if (!guard2) return stopped("final customization guard agent failed in round " + round + "; branch " + BRANCH + " left as is");
  log("final guard r" + round + ": pass=" + guard2.pass + ", " + guard2.fixes.length + " fix(es)");
  if (!guard2.pass) return stopped("final customization guard failing (round " + round + "); branch " + BRANCH + " left for manual repair", guard2.notes);

  const changedThisRound = audit.files_changed.length > 0 || guard2.fixes.length > 0;
  converged = !changedThisRound;
  if (!converged) log("round " + round + " changed files after verification; running another round");
}
if (!converged) return stopped("gates did not converge after " + MAX_GATE_ROUNDS + " rounds; branch " + BRANCH + " left for manual review");

// -------------------------------------------------------------------- merge
phase("Merge");
const merge = await agent(
  [
    PRE,
    "",
    "TASK: Merge the upstream sync branch into main. Do NOT push.",
    "Preconditions (verify, stop with STATUS: FAIL if any fails): `git branch --show-current` is `" + BRANCH + "`, `git status --porcelain` is empty, `" + GUARD + "` passes.",
    "Then: `git checkout main`, `git merge " + BRANCH + "` (a fast-forward is expected; if main moved, use a normal merge commit with subject `Merge branch '" + BRANCH + "' (upstream pi sync)` and resolve any conflict in draht's favour, then re-run `" + GUARD + "`), `git branch -d " + BRANCH + "`.",
    "Report merged, head (`git rev-parse --short HEAD`), commits_merged (`git rev-list --count ORIG_HEAD..HEAD`), branch_deleted, notes with `git log --oneline ORIG_HEAD..HEAD | head -5`. End with `STATUS: OK` or `STATUS: FAIL <reason>`.",
  ].join("\n"),
  { label: "merge", phase: "Merge", model: FABLE, schema: MERGE_SCHEMA },
);
if (!merge) return stopped("merge agent failed; branch " + BRANCH + " is verified and ready, merge it manually");
if (!merge.merged) return stopped("merge not performed", merge.notes);
log("merged " + merge.commits_merged + " commit(s) into main at " + merge.head);

// ------------------------------------------------------------------ summary
const lines = [];
lines.push("Upstream sync complete: " + merge.commits_merged + " commit(s) merged into main at " + merge.head + ". Not pushed.");
lines.push("");
lines.push("Upstream: sync point " + recon.sync_point.slice(0, 10) + ", " + recon.total_since_sync + " commits since, " + recon.already_applied + " already applied, " + candidates.length + " candidates.");
lines.push("Classified: " + picks.filter((e) => e.classification === "take").length + " take, " + picks.filter((e) => e.classification === "adapt").length + " adapt, " + skips.length + " skip.");
lines.push("Cherry-pick: " + pickResults.filter((r) => r.status === "success").length + " success, " + pickResults.filter((r) => r.status === "adapted").length + " adapted, " + pickResults.filter((r) => r.status === "skipped").length + " skipped, " + failedPicks.length + " failed" + (repairs ? ", " + repairs + " repair(s)" : "") + ".");
lines.push("Gates: branding sweep fixed " + sweep.files_changed.length + ", guard fixed " + guard1.fixes.length + ", " + round + " verify round(s); final round clean.");
if (failedPicks.length) {
  lines.push("");
  lines.push("Failed cherry-picks (not applied, need manual handling):");
  for (const r of failedPicks) lines.push("- " + r.hash.slice(0, 10) + " " + r.reason);
}
lines.push("");
lines.push("Skipped groups: " + reconcile.skipped_groups);
if (skips.length) {
  lines.push("");
  lines.push("Skipped commits:");
  for (const s of skips) lines.push("- " + s.hash.slice(0, 10) + " " + s.subject + " — " + s.reason);
}
lines.push("");
lines.push("Branch " + BRANCH + " deleted: " + merge.branch_deleted + ". " + merge.notes);
return lines.join("\n");
