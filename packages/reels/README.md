# @draht/reels

Non-core example workflow. `@draht/reels` is private, not published, and not
part of the [Draht product support map](../../.planning/PRODUCT-MAP.md) — it
is a demonstration of what you can build on `@draht/ai` plus Remotion, not a
maintained product.

It turns a repo's git history into short narrated "reels" (vertical
1080x1920 video, optional ElevenLabs narration) and writes a `feed.json` per
repo for a small PWA (`app/`, built separately) to browse them like a feed.

## Privacy warning

`build` prints a one-line warning every run: its output is public-facing.

Code is never rewritten: a shown line is copied byte-for-byte from the
diff, or its whole hunk is withheld (see `src/privacy.ts`):

- **Path deny-list**: files matching `DEFAULT_DENY_GLOBS` (`.env`,
  `.env.*`, `.envrc`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `id_rsa*`,
  cloud credential files, Kubernetes and Docker config, Terraform state, and
  more) have every hunk withheld, including the old path of a rename. Only
  the path and line-count stats show. Extend or narrow the list with
  repeatable `--exclude <glob>` / `--include <glob>`.
- **Secret-shaped hunks**: a hunk is withheld when its header or any line
  looks like a secret: AWS, GitHub, OpenAI, Anthropic, Stripe, Google, or
  Slack tokens, PEM private keys, Bearer tokens, credentials in URLs, or a
  quoted or `.env`-style assignment whose key looks like a credential.
  Withheld hunks never reach a code scene, the LLM prompt, or `feed.json`.
- **Prose fields** (commit title, body, author names, narration) are not
  code, so a matched secret token in them is replaced with `[redacted]`.

Neither exception is a substitute for not committing secrets in the first
place, and the deny-list and secret patterns are best-effort, not exhaustive.

Publishing the generated site makes the surviving diffs publicly readable.
**GitHub Pages sites are publicly readable on most plans, even for private
repositories.** Do not use this on private code unless Pages access is
restricted to your org (GitHub Enterprise Cloud) or you deploy the output
somewhere access-controlled instead of plain GitHub Pages.

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

## Evidence rule

Every line of code a reel shows is copied verbatim from the real git diff.
Every diagram node and edge comes from changed file paths. The script writer
— template or LLM — only chooses which hunks to show and writes narration
text; it cannot invent code or structure that was not actually committed. See
`src/contract.ts` for the full data contract.

## How it works

```
collect (git) -> script (narration + hunk picks) -> tts (ElevenLabs|none)
  -> render (Remotion) -> publish (feed.json, media, repos.json)
```

- `collect.ts` — lists commit shas with `git rev-list` (validated against a
  strict sha regex before any further use — see "Security" below), folds
  merge commits and their branch commits into one change set, parses unified
  diffs.
- `privacy.ts` — path deny-list, secret-shaped hunk withholding, and prose redaction (see "Privacy warning").
- `diagram.ts` — deterministic Mermaid diagram of changed directories/files.
- `script.ts` — `templateWriter` (no network, deterministic) or `llmWriter`
  (calls an `@draht/ai` model; validates and rejects any hunk reference that
  does not exist in the real diff).
- `tts.ts` — `elevenLabsProvider` or `silentProvider` (duration estimated
  from word count, no audio). ElevenLabs scene timing comes from the real
  MP3 length (`mp3.ts` walks the frame headers), so captions stay in sync
  with the concatenated audio.
- `render.ts` — bundles and renders the Remotion composition to MP4 + a
  poster JPEG.
- `state.ts` — `<out>/<name>/.reels-state.json` sidecar tracking failed
  reels and attempt counts, so one bad commit does not stall every later run.
- `publish.ts` — merges new reels into `feed.json`/`repos.json` idempotently
  by reel id (atomic writes: temp file + rename), and copies the built PWA
  into the output site.

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

- [Bun](https://bun.sh) to run the CLI and tests.
- `ffmpeg` on `PATH` is optional: used to concatenate per-scene narration
  MP3s. Falls back to raw MP3 concatenation (valid for same-format CBR MP3s,
  which is what ElevenLabs returns per voice/model) when absent.
- Remotion downloads a headless Chrome shell on first render
  (`node_modules/.remotion/`). On NixOS or other non-FHS Linux, Chrome needs
  `libnspr4.so`/`libnss3.so`/`libexpat.so.1` available on `LD_LIBRARY_PATH`
  (e.g. via `nix-shell -p nspr nss expat`).
- `ELEVENLABS_API_KEY` for narration (`--tts elevenlabs`, the default). Use
  `--tts none` to render silent reels with estimated scene durations.
- `--writer llm` additionally requires `@draht/ai` to be built (`dist/`,
  not just `src/`) and `--model <provider/id>`; the provider's API key must
  be set in the environment for that provider's auth convention (e.g.
  `ANTHROPIC_API_KEY`). The example GitHub Actions workflow only builds
  `@draht/ai` and injects the key when the `writer` input is `llm`.

## Remotion licensing

Remotion is free for individuals and companies up to 3 people. Larger
companies need a Remotion company license — see
<https://www.remotion.dev/license>. This package does not grant you a
license; check your own usage against Remotion's terms.

## CLI usage

```sh
bun run src/cli.ts build --repo <path> --out <dir> [options]
bun run src/cli.ts site --out <dir>
bun run src/cli.ts plan --repo <path> [options]
bun run src/cli.ts prune --repo <path> --out <dir> [--name <name>] [--ref <ref>]
```

`build` options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <path>` | cwd | git repo to read |
| `--name <name>` | basename of `--repo` | repo display name / feed slug; must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` |
| `--out <dir>` | `./reels-site` | output site directory |
| `--ref <ref>` | `HEAD` | git ref to walk |
| `--since <date>` | — | only commits authored since this **date** (passed straight to `git rev-list --since`; it does not accept a ref/sha — use `--ref`, or a `<sha>..<ref>` value for `--ref` itself, for that) |
| `--until <date>` | — | only commits authored until this date, same caveat as `--since` |
| `--limit <n>` | `10` | cap how many change sets to render this run (see range semantics below); must be a positive integer |
| `--all-history` | off | ignore the floor and the scan window and consider every unpublished first-parent change set, oldest first; `--limit` is uncapped unless given explicitly |
| `--scan <n>` | `500` | how many first-parent commits back from `--ref` to consider; must be a positive integer |
| `--force` | off | retry commits that hit the retry cap (3 failed attempts); published reels are never re-rendered |
| `--mode visual\|audio\|both` | `both` | `audio` skips Remotion rendering entirely |
| `--tts elevenlabs\|none` | `elevenlabs` | narration provider |
| `--voice <id>` | `$DRAHT_SPEAK_VOICE_ID` or George | ElevenLabs voice id |
| `--tts-model <id>` | `eleven_flash_v2_5` | ElevenLabs model id |
| `--writer template\|llm` | `template` | script writer |
| `--model <provider/id>` | — | required for `--writer llm`, e.g. `anthropic/claude-sonnet-5` |
| `--lang en\|de` | `en` | template narration language |
| `--repo-url <url>` | — | linked in the feed for commit URLs; omitting it on a later run keeps the previously stored value |
| `--concurrency <n>` | Remotion default | render concurrency; must be a positive integer |
| `--exclude <glob>` (repeatable) | — | additional path(s) whose content is withheld, on top of the default deny-list |
| `--include <glob>` (repeatable) | — | path(s) exempted from the deny-list (default or `--exclude`) |

Unknown flags, missing flag values, and invalid enum/integer values are
rejected with a clear error before anything runs.

`plan` takes the same collection/writer flags and prints the change sets and
scripts as JSON without calling TTS or Remotion — use it to inspect cost
before spending ElevenLabs characters or render time.

`site` copies the built PWA (`npm run build:app` output, `app/dist`) into
`--out` without touching `feed.json`/`repos.json`.

`prune` removes feed entries (and their media directories) no longer
reachable from `--ref`'s first-parent history — the tool for retracting
reels after a force-push. See "Privacy warning" for its limits.

## Output layout

```
<out>/
  repos.json               # RepoIndex: all repos published to this site
  <repo-name>/
    feed.json               # Feed: reels, newest first
    reels/<shortsha>/
      video.mp4              # absent in audio mode
      audio.mp3               # absent when --tts none
      poster.jpg              # absent in audio mode
  index.html, assets/...    # the built PWA, from `site`
```

### Incremental range semantics

Re-running `build` reads the existing `feed.json` and `.reels-state.json`
first. It never re-renders a published change set and never retries one that
hit the retry cap (3 failed attempts), unless `--force`. Selection comes from
one bounded `git rev-list --first-parent` scan of `--ref` (`--scan`
commits, default 500), in git order, never by author date:

- **A published commit is in the scan window**: the floor is the oldest
  published commit in the window. Candidates are the unpublished, uncapped
  commits newer than the floor, and the oldest `--limit` (default 10) render
  this run. A burst drains in order over successive runs, and a commit that
  failed between two published ones is retried on later runs until it
  succeeds or hits the cap.
- **No published commit is in the window** (first run, or history rewritten
  past the window): only the newest `--limit` commits render. Older history
  is never backfilled. Run `prune` to remove entries that are no longer
  reachable.
- **`--all-history`**: ignores the floor and the window; every unpublished,
  uncapped first-parent change set, oldest first, bounded only by an explicit
  `--limit`.
- **`--force`**: bypasses the retry cap, so capped commits become
  candidates again. Published commits are never re-rendered.
- During bootstrap, a commit that fails while newer ones in the same batch
  succeed falls below the new floor and is not retried. Use
  `--all-history` to pick it up.
- `--since` and `--until` filter by date on top of any mode.

Metadata and diffs are fetched only for the selected commits, so a run stays
cheap in a large repository.

## CI usage

See `examples/github-actions.yml` for a GitHub Actions workflow and
`examples/run-anywhere.sh` for a minimal generic runner for cron or other CI.
Both live under `examples/`, not `.github/`, so they never run in this repo.
`node scripts/check-github-actions-security.mjs` (run from the worktree
root) only scans `.github/workflows/`, so it does not lint
`examples/github-actions.yml`; review it by hand before using it.

`@draht/reels` is private and depends on `@draht/ai: workspace:*`, which
only resolves inside the draht-mono workspace — you cannot vendor just
`packages/reels/` into another repo and `bun install` it. The example
workflow instead checks out the public `draht-dev/draht` monorepo at a
pinned commit into `.draht/`, installs its workspace there, and runs the CLI
from inside it.

The rendered site (feed.json, videos, audio) is committed to a `reels-site`
branch of your own repo, not `actions/cache` — a cache entry can be evicted
after 7 days unused or once the repo's cache storage cap is reached, which
would silently drop history that `draht-reels build` has no other record
of. Because `build` also skips already-published change sets and caps a
normal run at `--limit 10`, even a lost `reels-site` branch only costs a
bounded re-bootstrap (the newest 10 reels), never a runaway re-render of
(and re-paid-for-via-ElevenLabs) the entire history.

Unlike a normal branch, `reels-site` is force-pushed as a single **orphan**
commit every run — no commit history, just the current feed/media. That's
what makes `draht-reels prune` an effective retraction: a normal commit
history would keep every previously-published diff and media file reachable
forever, even after `prune` removed it from `feed.json`. See "Privacy
warning" for what the orphan force-push does and does not guarantee.

`.reels-state.json` (per-repo render state, including recent error strings)
is kept in the `reels-site` branch so runs stay incremental, but it is
deliberately **not** included in the artifact uploaded to GitHub Pages —
the workflow copies the site into a separate directory with that file
excluded before calling `actions/upload-pages-artifact`, so error text never
ends up on the public page.

### Job graph and permissions

The example workflow splits into four jobs so that only the job that
actually needs to push has `contents: write`:

- **`build`** (`contents: read` only, `persist-credentials: false` on every
  checkout) — installs `.draht`, optionally builds `@draht/ai` for
  `--writer llm`, runs `prune` (if requested) and `build`, then uploads two
  artifacts: the full site (with state, for `push`) and a Pages-only copy
  (without state, for `deploy`). `build` keeps publishing/uploading even if
  some reels failed to render (`if: ${{ !cancelled() }}` on the publish
  steps) — see "Partial success" below — but its render step still records
  and ultimately re-raises the real exit code.
- **`push`** (`contents: write`, the only job with it) — downloads the full
  site artifact, force-pushes it to `reels-site` as a single orphan commit.
  Its checkout is the only one with `persist-credentials: true`, so the
  token lives in git's config, not in a shell argument.
- **`deploy`** (`pages: write`, `id-token: write`) — deploys the Pages-only
  artifact `build` already uploaded.
- **`finalize`** — runs last regardless of the other jobs' outcome and fails
  the workflow run if `build`'s render step recorded a non-zero exit code,
  even though `push`/`deploy` already published whatever did succeed.

`build` also fetches the previous `reels-site` branch (read-only, via
`actions/checkout` with `persist-credentials: false`) so incremental range
selection and `prune` see the existing feed; a missing branch (first run) is
detected with `git ls-remote --exit-code` and is not treated as an error.

### Partial success

`build` exits non-zero when any reel failed to render, but it publishes
every reel that *did* render (feed entry, video, audio) before exiting —
see `state.ts`. The workflow is built around that: the `push` and `deploy`
jobs run even when `build`'s render step failed, as long as a site was
actually produced, so reels that were already rendered (and, for
ElevenLabs/LLM reels, already paid for) are never thrown away because a
later reel in the same run failed. The overall workflow run still ends up
red (via the `finalize` job) so failures aren't silently swallowed.
`examples/run-anywhere.sh` follows the same pattern: it always runs `site`
after `build`, then exits with `build`'s status.

### Optional inputs (`workflow_dispatch`)

- `backfill` — render the full history instead of just new commits.
- `prune` — run `draht-reels prune` before building, to drop feed entries no
  longer reachable from `HEAD` (e.g. after a force-push).
- `writer` / `model` — `--writer llm` plus `--model <provider/id>`; builds
  `@draht/ai` first (see "Requirements") and only exposes the provider's API
  key secret to the render step.

## Testing

```sh
cd packages/reels
bun test
```

Tests never call the real ElevenLabs API or a real LLM provider; `fetch` and
the model completer are always injected.
