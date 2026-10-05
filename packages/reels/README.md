# @draht/reels

Non-core example workflow. `@draht/reels` is private, not published, and not
part of the [Draht product support map](../../.planning/PRODUCT-MAP.md) — it
is a demonstration of what you can build on `@draht/ai` plus Remotion, not a
maintained product.

It turns a repo's git history into short narrated "reels" (vertical
1080x1920 video, optional ElevenLabs narration) and writes a `feed.json` per
repo for a small PWA (`app/`, built separately) to browse them like a feed.

## What it is

The default unit is a **story**, not a commit: one reel per feature, release,
or upstream sync, not one reel per commit. A story's arc is the same whether
it was written by a human or an LLM:

1. **Hook** — what changed, in one line.
2. **What** — the code, shown verbatim.
3. **Why**/**effect** — why it was done, or what changed for someone, each
   claim tied to a cited source (a commit, a PR, a changelog line) or the one
   fixed "no source says" sentence (see "Evidence rule and validation").
4. Optionally a **deep dive**: a longer second reel with more scenes, for
   stories the writer judges worth it.

A release also gets a **release overview** reel (every story in the release,
plus any weakly-attributed changelog entries that did not get their own
reel) and, when the release carries upstream-sourced work, an **upstream
recap** reel. See "Units" below for what distinguishes each kind.

## Quick start

Prerequisites:

- [Bun](https://bun.sh).
- An ElevenLabs key, unless running with `--tts none` (see "TTS and video").
- An LLM provider key for `--model <provider/id>` (`--unit story`, the
  default, always needs a model — see "Owner decision" under "The publish
  gate").

Draft, review, approve:

```sh
bun run src/cli.ts build --repo <path> --out ./reels-site --model anthropic/claude-sonnet-5
bun run src/cli.ts review --repo <path> --out ./reels-site
bun run src/cli.ts review --repo <path> --out ./reels-site <id>
bun run src/cli.ts approve --repo <path> --out ./reels-site <id>
```

`build` only ever writes drafts, under `--drafts-dir`
(`<repo>/.reels-drafts` by default) — never the public feed. `review` lists
pending drafts, or prints one draft's `review.md` for human sign-off.
`approve` moves an approved draft's media and feed entry into `--out`;
`reject` discards one instead.

Open the PWA by running `site` once approvals exist, then serving `--out`
with any static file server:

```sh
npm run build:app
bun run src/cli.ts site --out ./reels-site
npx serve ./reels-site
```

## Units

`--unit story` (default) drafts four kinds of reel, keyed by how a story's
evidence is anchored:

- **PR-anchored** (`origin: "pr"`): a merged feature branch whose head sha
  resolves to a GitHub PR. Strong attribution by construction — the PR body
  and its commits are the evidence.
- **Branch-anchored** (`origin: "branch"`): a merged feature branch with no
  resolvable PR. Same evidence shape as a PR story, just without the PR body.
- **Changelog-anchored** (`origin: "commit"`): one changelog entry (an
  Added/Changed/Fixed/Removed line under a release section) that names
  direct-to-mainline work. The commit that added the changelog line is
  rarely the commit that did the work, so the pipeline extracts identifiers
  from the entry text (backticked tokens, `/commands`, `--flags`, env vars,
  symbols, file paths) and searches for them with `git log -S`/`-G` across
  the release range. Finding an implementing commit this way makes the story
  **strong**-attributed; falling back to the changelog commit itself makes it
  **weak**-attributed. `story.minAttribution` (default `"strong"`) decides
  whether weak stories get their own reel or are folded into the release
  overview instead — see `src/reels-config.ts`.
- **Release overview** (`kind: "release"`) and **upstream recap**
  (`kind: "recap"`): synthesized from a release's own stories, its weakly-
  attributed changelog entries, and (for the recap) its upstream-sync merges
  and `upstream:`-prefixed commits. Neither belongs to a single commit.

`--unit commit` is the legacy, per-commit path: one reel per change set
(a mainline commit, with its merged-branch commits folded in), template
narration only, no stories, no drafts, no publish gate — it writes straight
into `--out`. `--writer llm` is rejected outright for `--unit commit`: an
LLM-written reel must go through the draft/approve gate, and `--unit commit`
never offers one. Kept for repos that do not want release/story structure.
`--unit story` is the default for `build`, `plan`, and `release`.

## The publish gate

LLM-written reels can be wrong, or can be steered: commit messages and PR
bodies are attacker-controlled text that an LLM reads as part of its prompt,
so a crafted commit body is prompt-injection material, not just metadata.
`build` never writes directly to the public feed — it writes a draft under
`--drafts-dir`, with `entry.json` (the would-be feed entry), `script.json`
(the writer's internal notes and every source it was given, kept out of the
public feed), and `review.md`.

`review.md` is the human approval view: every scene, every beat, and for
each cited claim the exact source excerpt the beat is supposed to match,
plus a checklist ("every claim matches its cited source's text", "no
injected or promotional text", "nothing private"). A validator (see "Evidence
rule and validation") already rejects an uncited claim before the draft is
written; `review.md` exists for the kind of failure a validator cannot
catch — a plausible-sounding, correctly-cited sentence that is still wrong,
or narration that reads like an instruction because the source text it
quotes was written to look like one. That is why a human reviews every
LLM-written reel before it publishes: `approve <id>` or `reject <id>
[--reason <text>]` is the only way a story/release/recap draft reaches
`--out`. `--unit commit` has no LLM-written path to gate — `--writer llm` is
rejected for it — so its template reels publish straight into `--out`, with
no draft step.

## Commands and flags

```sh
bun run src/cli.ts build --repo <path> --out <dir> [options]
bun run src/cli.ts release [<tag>…] --model <provider/id> [options]
bun run src/cli.ts plan --repo <path> [options]
bun run src/cli.ts review [<id>] [--repo <path>] [--out <dir>] [--drafts-dir <dir>] [--config <path>]
bun run src/cli.ts approve <id>… [--repo <path>] [--out <dir>] [--drafts-dir <dir>] [--config <path>]
bun run src/cli.ts reject <id>… [--reason <text>] [--repo <path>] [--out <dir>] [--drafts-dir <dir>] [--config <path>]
bun run src/cli.ts site --out <dir>
bun run src/cli.ts prune --repo <path> --out <dir> [--name <name>] [--ref <ref>]
```

`build` options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <path>` | cwd | git repo to read |
| `--name <name>` | basename of `--repo` | repo display name / feed slug; must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` |
| `--out <dir>` | `./reels-site` | output site directory (the public feed) |
| `--drafts-dir <dir>` | `<repo>/.reels-drafts`, or `build.draftsDir` in `.reels.json` | where `--unit story` drafts live; refused if nested inside `--out`; resolved relative to cwd. `build.draftsDir` instead resolves relative to the config file's own directory, not cwd |
| `--config <path>` | `<repo>/.reels.json` if present, else built-in defaults | path to `.reels.json` |
| `--ref <ref>` | `HEAD` | git ref to walk |
| `--since <date>` | — | only commits authored since this **date** (`--unit commit` only; passed straight to `git rev-list --since`, not a ref/sha) |
| `--until <date>` | — | only commits authored until this date, same caveat as `--since` |
| `--limit <n>` | `10` | cap how many stories/change sets to draft or render this run; must be a positive integer |
| `--all-history` | off | ignore the floor and the scan window and consider every unpublished/undrafted unit, oldest first; `--limit` is uncapped unless given explicitly |
| `--scan <n>` | `500` for `--unit commit` (first-parent commits back from `--ref`), `6` for `--unit story` (releases back from `--ref`) | must be a positive integer |
| `--force` | off | retry units that hit the retry cap (3 failed attempts), and regenerate a pending draft in place; published/approved reels are never re-rendered |
| `--mode visual\|audio\|both` | `both` | `audio` skips Remotion rendering entirely |
| `--tts elevenlabs\|none` | `elevenlabs` | narration provider |
| `--unit commit\|story` | `story` | selection and writer path (see "Units") |
| `--writer template\|llm` | `template` | `--unit commit` only: script writer. `--unit commit --writer llm` is rejected — an LLM-written reel always needs the draft/approve gate, which `--unit commit` does not have; use `--unit story` for LLM narration |
| `--model <provider/id>` | — | required for `--unit story` (always), e.g. `anthropic/claude-sonnet-5`; unused and unneeded for `--unit commit`, since its only allowed writer is `template` |
| `--lang en\|de` | `en` | narration language |
| `--repo-url <url>` | — | linked in the feed for commit URLs; omitting it on a later run keeps the previously stored value |
| `--voice <id>` | `$DRAHT_SPEAK_VOICE_ID` or George | ElevenLabs voice id |
| `--tts-model <id>` | `eleven_flash_v2_5` (`--unit commit`) / `eleven_v4` (`--unit story`) | ElevenLabs model id |
| `--concurrency <n>` | Remotion default | render concurrency; must be a positive integer |
| `--exclude <glob>` (repeatable) | — | additional path(s) whose content is withheld, on top of the default deny-list |
| `--include <glob>` (repeatable) | — | path(s) exempted from the deny-list (default or `--exclude`) |
| `--tag-pattern <regex>` | `.reels.json`'s `tagPattern` (`^v`) | `--unit story` only: overrides which tags mark a release |
| `--deep-dive auto\|always\|never` | `auto` | `--unit story` only: whether a story also gets a deep-dive reel |
| `--max-cost-usd <n>` | `.reels.json`'s `build.maxCostUsd` (5) | `--unit story` only: per-run LLM USD cap |
| `--max-llm-tokens <n>` | `.reels.json`'s `build.maxLlmTokens` (2,000,000) | `--unit story` only: per-run LLM token cap |
| `--max-tts-chars <n>` | `.reels.json`'s `build.maxTtsChars` (50,000) | per-run ElevenLabs character cap |

Unknown flags, missing flag values, and invalid enum/integer values are
rejected with a clear error before anything runs.

Other commands:

- `release [<tag>…]` — drafts the release overview and upstream recap for
  the given tags (every non-tiny release in the scan when none are given),
  without re-drafting stories. Run it after approving a release's stories,
  to draft the overview over what is now approved. Requires `--model`;
  shares `build`'s flags.
- `plan` — `--unit story` (default): a read-only dry run of story
  selection, printed as a readable report or, with `--json`, the raw
  `StoryPlan`. Never calls TTS, Remotion, or the LLM. `--unit commit`: prints
  the selected change sets and scripts as JSON, calling the writer but not
  TTS/Remotion — use it to inspect cost before spending ElevenLabs characters
  or render time.
- `review [<id>]` — without an id, lists pending drafts (id, title,
  release, created, writer); with one, prints that draft's `review.md`.
- `approve <id>…` — publishes one or more drafts: media and feed entry into
  `--out`, release playlist updated, draft removed. Idempotent — approving
  an id with no pending draft is a no-op.
- `reject <id>… [--reason <text>]` — deletes the draft(s) and records the
  rejection, so a later `build` skips them unless `--force`.
- `site` — copies the built PWA (`npm run build:app` output, `app/dist`)
  into `--out` without touching `feed.json`/`repos.json`.
- `prune --repo <path> --out <dir> [--name <name>] [--ref <ref>]` — removes
  feed entries (and their media) no longer reachable from `--ref` — the tool
  for retracting reels after a force-push. See "Privacy" for its limits.

### Incremental range semantics

Re-running `build` reads the existing feed and drafts state first. It never
re-renders a published/approved unit and never retries one that hit the
retry cap (3 failed attempts), unless `--force`:

- **A published/approved unit is in the scan window**: the floor is the
  oldest published unit in the window. Candidates are the unpublished,
  undrafted, uncapped units newer than the floor, and the oldest `--limit`
  (default 10) are drafted/rendered this run.
- **No published unit is in the window** (first run, or history rewritten
  past the window): only the newest `--limit` units are drafted/rendered.
  Older history is never backfilled. Run `prune` to remove entries that are
  no longer reachable.
- **`--all-history`**: ignores the floor and the window; every unpublished,
  uncapped unit, oldest first, bounded only by an explicit `--limit`.
- **`--force`**: bypasses the retry cap, and regenerates a pending draft in
  place. Published/approved units are never re-rendered.
- During bootstrap, a unit that fails while newer ones in the same batch
  succeed falls below the new floor and is not retried. Use `--all-history`
  to pick it up.

Metadata and diffs are fetched only for the selected units, so a run stays
cheap in a large repository.

## Configuration reference

`.reels.json` at the repo root (or `--config <path>`). Unknown keys are
rejected, so a config written against a newer README does not silently
no-op on an older build. Every key is optional; omitted keys take the
default shown.

```json
{
  "tagPattern": "^v",
  "historyFloor": "<sha or tag>",
  "overrides": {},
  "upstream": {
    "subjectPatterns": ["sync upstream", "upstream[- ]sync"],
    "markerPaths": [],
    "foreignAuthorRatio": 0.6
  },
  "story": {
    "directCommitTypes": ["feat"],
    "maxBranchCommits": 150,
    "minAttribution": "strong",
    "model": "anthropic/claude-sonnet-5",
    "skipTypes": ["chore", "ci", "build", "deps", "style", "test", "release"],
    "skipAuthors": ["dependabot[bot]", "renovate[bot]", "github-actions[bot]", "*[bot]"]
  },
  "docs": {
    "allow": ["README.md", "**/README.md", "docs/**", "**/CHANGELOG.md"],
    "deny": [],
    "maxChunks": 8
  },
  "code": { "exclude": [], "include": [] },
  "prose": { "denyPatterns": [] },
  "build": { "maxCostUsd": 5, "maxLlmTokens": 2000000, "maxTtsChars": 50000 }
}
```

- `tagPattern` — regex (anchored, case-sensitive unless the string embeds
  flags) matched against tag names to find releases.
- `historyFloor` — a tag or sha that stops the walk; history before it
  never yields stories or syncs. Mandatory in practice for a long-lived
  repo: without it, `--all-history` walks every commit ever made.
- `overrides` — `{ "<sha>": "skip" | "feature" | "upstream-sync" |
  "back-merge" | "branch-sync" }`, for the rare merge the automatic
  classifier gets wrong.
- `upstream.subjectPatterns` — case-insensitive regexes matched against a
  merge subject to classify it as an upstream sync.
- `upstream.markerPaths` — paths that, when touched by a merge's diff, also
  mark it as an upstream sync.
- `upstream.foreignAuthorRatio` — share (0–1) of foreign-author branch
  commits (of at least 20 sampled) that marks a merge as an upstream sync.
- `story.directCommitTypes` — conventional-commit types that make a direct
  mainline commit eligible as its own story.
- `story.maxBranchCommits` — branch commit count above which a non-sync
  merge counts as "oversized" rather than a normal feature merge.
- `story.minAttribution` — `"strong"` (default) or `"weak"`: the minimum
  attribution confidence a changelog-anchored story needs to get its own
  reel. Branch/PR stories are always eligible regardless of this setting.
- `story.model` — default `--model` for `--unit story`, used when `--model`
  is not passed on the command line.
- `story.skipTypes` — conventional-commit types excluded from story
  candidacy outright (housekeeping that is never worth narrating). Default:
  `["chore", "ci", "build", "deps", "style", "test", "release"]`.
- `story.skipAuthors` — author names/logins excluded from story candidacy
  (bot commits). Default: `["dependabot[bot]", "renovate[bot]",
  "github-actions[bot]", "*[bot]"]` (`*[bot]` matches any `name[bot]`
  pattern).
- `docs.allow` / `docs.deny` — glob allowlist/denylist for prose the story
  writer may read as context. `.planning/**` is deliberately absent from the
  default allowlist: a repo must explicitly allowlist specific `.planning/`
  paths to make them readable (see "Privacy"). `deny` always extends the
  built-in deny list; it can never un-deny a default entry by omission.
  `docs.maxChunks` caps how many ranked doc chunks a story's context keeps.
- `code.exclude` / `code.include` — additional code deny/allow globs, on top
  of `src/privacy.ts`'s built-in deny-list; also applied to doc paths.
- `prose.denyPatterns` — regexes matched against narration/titles/captions;
  a match rejects that text (customer names, internal codenames).
- `build.maxCostUsd`, `build.maxLlmTokens`, `build.maxTtsChars` — per-run
  spend caps for `--unit story` (`--max-cost-usd`/`--max-llm-tokens`/
  `--max-tts-chars` override them per run). A run stops starting new
  stories the moment any cap is reached; stories already drafted are kept.
  `build.draftsDir` overrides the default `<repo>/.reels-drafts` location,
  resolved relative to the config file's own directory (`--drafts-dir`
  resolves relative to cwd instead).

A regex string anywhere in this config is checked for balanced syntax and a
conservative nested-quantifier shape before use (`ReelsConfigError` on
failure) — defense in depth, not a guarantee against every slow pattern;
repo maintainers are a trusted but not infinitely careful input.

In CI, the config path should be controlled by the runner, not by the
commit being processed: `examples/github-actions.yml` checks out
`.github/reels.json` from the repository's default branch in a separate
step, before the build step ever looks at the triggering ref, so a crafted
commit can never smuggle in a different `.reels.json`.

## Evidence rule and validation

Every line of code a reel shows is copied verbatim from the real git diff
or, for a deep dive, from the file at `HEAD`. Every diagram node and edge
comes from changed file paths. The writer — template or LLM — only chooses
which hunks and files to show and writes narration text; it cannot invent
code or structure that was not actually committed (see `src/contract.ts`
for the full data contract).

For `--unit story`, `src/story-validate.ts` enforces more before a draft is
ever written:

- Every "why" and "effect" beat must cite a source id from the registry and
  include a verbatim quote (4–25 words, or at least 20 characters for
  code-like text) that actually occurs in that source's text and shares a
  real word with the beat.
- A "what"/"how" beat inside a code or diagram scene must share a real word
  or identifier with the shown code lines, or name one of the diagram's own
  node labels; outside a code/diagram scene it is held to the same cite-and-
  quote rule as "why"/"effect".
- The one exception: when no source explains the reason, the beat's text
  must be exactly the fixed sentence "The commits do not record why." (or,
  for `--lang de`, "Die Commits dokumentieren den Grund nicht.") and nothing
  else — no cites, no quote. A true claim with a hedge tacked onto it is not
  exempt and is rejected the same as an invented one.
- Captions, edge labels, headings, the summary, and theme names all go
  through prose cleanup and `prose.denyPatterns` before they reach a scene.

A failed validation falls back to the template writer rather than publishing
an invalid draft; `review.md` still shows the human reviewer exactly what
was cited and quoted, for the class of error a validator cannot catch (see
"The publish gate").

## Privacy

`build` prints a one-line warning every run: its output is public-facing.

Code is never rewritten: a shown line is copied byte-for-byte from the diff
or the file at `HEAD`, or its whole hunk/file is withheld (see
`src/privacy.ts`):

- **Path deny-list**: files matching `DEFAULT_DENY_GLOBS` (`.env`,
  `.env.*`, `.envrc`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `id_rsa*`,
  cloud credential files, Kubernetes and Docker config, Terraform state, and
  more) have every hunk withheld, including the old path of a rename. Only
  the path and line-count stats show. Extend or narrow the list with
  repeatable `--exclude <glob>` / `--include <glob>`, or `code.exclude` /
  `code.include` in `.reels.json`.
- **Secret-shaped hunks**: a hunk is withheld when its header or any line
  looks like a secret: AWS, GitHub, OpenAI, Anthropic, Stripe, Google, or
  Slack tokens, PEM private keys, Bearer tokens, credentials in URLs, or a
  quoted or `.env`-style assignment whose key looks like a credential.
  Withheld hunks never reach a code scene, the LLM prompt, or `feed.json`.
- **Prose fields** (commit title, body, author names, narration) are not
  code, so a matched secret token in them is replaced with `[redacted]`.
- **`.planning/**`** is excluded from the story writer's doc context by
  default, even though `docs.allow` otherwise covers `docs/**`. A repo must
  explicitly allowlist specific `.planning/` paths to make them readable;
  `.planning/CONTINUE-HERE.md`, `.planning/DECISIONS-PENDING.md`,
  `.planning/STATE.md`, `.planning/execution-log.jsonl`, and
  `.planning/quick/**` stay denied even then (`docs.deny` only ever extends
  that list, never replaces it).

Neither exception is a substitute for not committing secrets in the first
place, and the deny-list and secret patterns are best-effort, not
exhaustive.

Publishing the generated site makes the surviving diffs publicly readable.
**GitHub Pages sites are publicly readable on most plans, even for private
repositories.** Do not use this on private code unless Pages access is
restricted to your org (GitHub Enterprise Cloud) or you deploy the output
somewhere access-controlled instead of plain GitHub Pages.

Drafts carry the same risk one step earlier: `examples/github-actions.yml`
uploads pending drafts to a `reels-drafts` branch/artifact for human review,
separately from the public `reels-site` branch and never copied into the
Pages artifact — but a `reels-drafts` branch on a public repo is itself
publicly readable the moment it exists, same as any other branch.

If a reel should never have been published (e.g. after a force-push rewrote
history, or a secret slipped past redaction), run `draht-reels prune` to
remove feed entries and media no longer reachable from `--ref`. Retraction
is `prune` plus actually dropping the old content from where it's served:
`examples/github-actions.yml` force-pushes the whole `reels-site` branch as
a single orphan commit every run (no branch history), so a pruned entry's
files are not sitting in some earlier commit on that branch either. Even so,
GitHub may keep unreachable git objects and CDN-cached pages around for a
while after a force-push, and anyone who already loaded the page has it.
Prune (plus the orphan force-push) is retraction, not erasure.

## Cost

Three independent per-run caps apply to `--unit story`: `--max-cost-usd`
(LLM USD), `--max-llm-tokens` (LLM tokens), and `--max-tts-chars` (ElevenLabs
characters). A run stops starting new stories, release overviews, and
recaps the moment any cap is reached; a story already finished and rendered
is kept, never discarded for a later cap hit.

Model choice: `--model` has no built-in default for `--unit story` — pass
one explicitly, or set `story.model` in `.reels.json`. TTS defaults to
`eleven_v4` for story/release/recap reels and `eleven_flash_v2_5` for legacy
`--unit commit` reels (`--tts-model` overrides either).

Real runs during development: a story script (one LLM call, occasionally
one repair call) cost about $0.03–$0.11 with `claude-sonnet-5` and heavy
prompt caching; a release overview plus its upstream recap together cost
about $0.03. Actual cost depends on repo size, provider, and cache hit rate
— treat these as a rough order of magnitude, not a quote.

## TTS and video

- ElevenLabs key: `$ELEVENLABS_API_KEY`, or failing that
  `~/.draht/keys/elevenlabs.key` (a file holding only the key, mode 600 —
  the same file the `speak` helper reads). The key file keeps the key out of
  shell environments and agent transcripts. `--tts none` renders silent
  reels with estimated scene durations instead.
- `ffmpeg` on `PATH` is optional: used to concatenate per-scene narration
  MP3s. Falls back to raw MP3 concatenation (valid for same-format CBR MP3s,
  which is what ElevenLabs returns per voice/model) when absent.
- Remotion downloads a headless Chrome shell on first render
  (`node_modules/.remotion/`). On NixOS or other non-FHS Linux, Chrome needs
  `libnspr4.so`/`libnss3.so`/`libexpat.so.1` available on `LD_LIBRARY_PATH`
  (e.g. via `nix-shell -p nspr nss expat`).
- Remotion is free for individuals and companies up to 3 people. Larger
  companies need a Remotion company license — see
  <https://www.remotion.dev/license>. This package does not grant you a
  license; check your own usage against Remotion's terms.
- `--unit story` additionally requires `@draht/ai` to be built (`dist/`,
  not just `src/`): run `npm run build` in `packages/ai` first. The
  provider's API key must be set for that provider's auth convention (e.g.
  `ANTHROPIC_API_KEY`).

## The PWA

`app/` is a small PWA built separately (`npm run build:app`, output
`app/dist`) and copied into `--out` by `site`. It reads `repos.json` and
each repo's `feed.json`:

- **Playlists**: a release's stories, overview, and recap grouped under one
  tag, in the order `feed.reels` already keeps.
- **Deep dives**: a story with a deep-dive reel shows a rail button that
  swaps the active card's media for the deep dive, in place, without
  leaving the feed.
- **Sources**: a rail button opens the public source list `toPublicSources`
  attached to the entry (the redacted, public-safe view of what the writer
  cited — not the full `script.json` snapshot kept with the draft).
- **Audio mode**: a rail toggle switches a card between the rendered video
  and audio-only playback (using the same narration/transcript either way).

## CI

`examples/github-actions.yml` (copy into `.github/workflows/reels.yml` in
your own repo) and `examples/run-anywhere.sh` (a minimal generic runner for
cron or other CI) live under `examples/`, not `.github/`, so they never run
in this repo. `node scripts/check-github-actions-security.mjs` (run from the
worktree root) only scans `.github/workflows/`, so it does not lint
`examples/github-actions.yml`; review it by hand before using it.

`@draht/reels` is private and depends on `@draht/ai: workspace:*`, which
only resolves inside the draht-mono workspace — you cannot vendor just
`packages/reels/` into another repo and `bun install` it. The example
workflow instead checks out the public `draht-dev/draht` monorepo at a
pinned commit into `.draht/`, installs its workspace there, and runs the CLI
from inside it.

Job graph (five jobs, minimal `permissions` per job):

- **`build`** (`contents: read`, push-triggered or a `workflow_dispatch`
  with no `approve`/`reject` input) — installs `.draht`, builds the PWA
  (`npm run build:app`) and runs `site` once, unconditionally, to publish the
  PWA shell into the site directory before anything else — this is what
  makes a site exist at all on a repo's first run, even if the story build
  below drafts nothing. It then builds `@draht/ai`, optionally runs `prune`,
  then `build --unit story` (omitting `--model` unless the `model` dispatch
  input was set, so `story.model` in `.github/reels.json` applies by
  default), and uploads two artifacts regardless of its own exit code
  (`if: !cancelled()`): the full site (for `push`) and the drafts directory
  (for `push`, and for human review via the artifact download). A failed
  story still leaves every already-drafted story saved.
- **`publish`** (`contents: read`, a `workflow_dispatch` with `approve`
  and/or `reject` set) — needs neither API key: it builds the PWA, runs
  `approve`/`reject` against drafts already rendered by an earlier `build`,
  runs `site` once (so an approval against a repo with no `reels-site`
  branch yet still gets the app shell), then re-uploads the updated
  site/drafts artifacts.
- **`push`** (`contents: write`, the only job with it) — runs whenever
  `build` produced a site or `publish` succeeded, regardless of whether
  `build`'s story drafting itself failed; downloads the site and drafts
  artifacts, force-pushes each to its own branch (`reels-site`,
  `reels-drafts`) as a single orphan commit.
- **`deploy`** (`pages: write`, `id-token: write`) — same gate as `push`;
  deploys the Pages-only artifact `build` or `publish` already uploaded
  (`.reels-state.json` excluded — see "Privacy" and "Partial success"
  below).
- **`finalize`** — runs last regardless of the other jobs' outcome and fails
  the workflow run if `build`'s render step recorded a non-zero exit code,
  even though `push`/`deploy` already published whatever did succeed — a
  failed story turns the overall run red without discarding the stories
  that did draft and the site/Pages update that did happen.

`workflow_dispatch` inputs: `backfill` (render full history instead of just
new releases/commits), `prune` (run `draht-reels prune` first), `model`
(defaults to empty — `--model` is then omitted entirely so `story.model` in
`.github/reels.json` applies instead)/`max_cost_usd`/`max_llm_tokens`/
`max_tts_chars` (override `build`'s defaults), and `approve`/`reject`
(space-separated draft ids — setting either skips the build job entirely and
runs the `publish` job instead).

### Partial success

`build` exits non-zero when any story failed to draft, but it saves every
story that *did* draft (and was already paid for via ElevenLabs/the LLM)
to the drafts artifact before exiting. `push`/`deploy` still run as long as
a site was produced, so a later failure in the same run never discards an
earlier, already-rendered story. The overall workflow run still ends up red
(via `finalize`) so failures are not silently swallowed.
`examples/run-anywhere.sh` follows the same pattern and exits with
`build`'s status.

## Troubleshooting

- **`--tts elevenlabs needs an ElevenLabs key`** — set `$ELEVENLABS_API_KEY`
  or write the key to `~/.draht/keys/elevenlabs.key` (mode 600), or pass
  `--tts none`.
- **`requires @draht/ai to be built first`** — run `npm run build` in
  `packages/ai` (and `packages/telemetry`, its own dependency) before
  `--unit story`.
- **`--unit story needs a model`** — pass `--model <provider/id>`, or set
  `story.model` in `.reels.json`.
- **`refusing --drafts-dir ... inside --out ...`** — drafts must live
  outside the public feed directory; point `--drafts-dir` elsewhere.
- **No commits found on ref** — the repo has no history reachable from
  `--ref`; make at least one commit first.
- **A draft never shows up in `review`** — check it was not already
  rejected (`state.rejected`, shown by `review`'s id listing only once
  resolved); `--force` re-selects a rejected or capped unit.
- **A unit keeps failing and gets skipped** — after 3 failed attempts a
  unit is capped and skipped with a warning; `--force` retries it. Published
  and approved units are never re-rendered, `--force` or not.

## Security

- Commit shas come only from `git rev-list` output, never from commit
  message/subject/body content (which is attacker-controlled), and are
  validated against `/^[0-9a-f]{40}([0-9a-f]{24})?$/` before any further git
  call or filesystem path. `--end-of-options` precedes every revision
  argument so a validated-but-unusual-looking string can never be parsed as
  a flag.
- `--name` and the derived repo directory name are validated against
  `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`.

## Requirements

See "TTS and video" for ElevenLabs/Remotion/ffmpeg requirements, and "Cost"
for `--unit story`'s model requirement.

## Output layout

```
<out>/
  repos.json               # RepoIndex: all repos published to this site
  <repo-name>/
    feed.json               # Feed: reels and playlists, newest first
    reels/<id>/
      video.mp4              # absent in audio mode
      audio.mp3               # absent when --tts none
      poster.jpg              # absent in audio mode
      deep/                   # a story's deep-dive media, same layout, if rendered
  index.html, assets/...    # the built PWA, from `site`
```

Drafts under `--drafts-dir/<repo-name>/<id>/` carry the same media plus
`entry.json`, `script.json`, and `review.md`, until `approve` moves the
media/`entry.json` into `<out>` and deletes the rest.

## Testing

```sh
cd packages/reels
bun test
```

Tests never call the real ElevenLabs API or a real LLM provider; `fetch` and
the model completer are always injected.
