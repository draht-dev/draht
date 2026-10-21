# Four-variant Drahtbank comparison

The implementation retains concise prompts, deterministic completion checks, and three selected changes from the Opus pruning branch: user instructions take precedence over advisor advice, bounded triage can finish without implementing a fix, and three discovery descriptions are shorter. The comparisons support retaining these changes for review; they do not demonstrate a universal quality or speed improvement.

## Variants and coverage

The frozen variants were verbose (`8705c2adcbf7bcf2ec6093ef48061b8c914729ca`), Opus pruning (`c31bd3e5534bab485df42af7bf41decbdba1ed0a`), frontier (`51a8e1707b3195e90ea3fda2aba7412302e4dcd2`), and hybrid (the frontier worktree plus the three ports). These identifiers describe the measured snapshots before PR integration.

Historical screening exercised ten OpenCode Go models. Two DeepSeek models were excluded to retain the workspace's privacy setting. Screening selected Kimi K3, Kimi K2.7 Code, HY3, and MiMo V2.6 Flash for the subsequent comparison, alongside `openai-codex/gpt-6-astra` and `anthropic/claude-opus-5-5` controls. Screening was incomplete under quota and is not a uniform model ranking.

The six-case comparison planned 576 trials across four variants and four repetitions. It finished 505: 503 were runtime-valid, two returned quota errors, and 71 were not run. All 192 implementation trials passed behavioral checks across two fixtures. Read-only findings exposed formatting, citation, explanation, and proposed-repair defects. The five exercised assets total 22,029 / 20,922 / 18,472 / 18,626 UTF-8 bytes for verbose / pruning / frontier / hybrid. Hybrid is 15.45% smaller than verbose in that subset; source bytes are not model tokens or whole-session input.

## Separate quota recovery, 2026-10-21

Recovery reran complete unfinished banks with fresh controls rather than replacing individual failed observations. All 144 planned trials finished, were graded, and were runtime-valid; integrity checks verified 413 sealed inputs. These results are not pooled with the earlier cohort.

Task acceptance requires valid execution, behavioral acceptance, scope compliance, and no failed structured finding. It excludes command-evidence and status requirements and is not a complete answer-quality assessment. In these read-only fixtures, behavioral acceptance checks fixture preservation.

| Model | Verbose triage | Pruning triage | Frontier triage | Hybrid triage |
|---|---:|---:|---:|---:|
| Kimi K3 | 4/4 | 4/4 | 4/4 | 4/4 |
| Kimi K2.7 Code | 4/4 | 4/4 | 4/4 | 4/4 |
| HY3 | 4/4 | 3/4 | 3/4 | 3/4 |
| MiMo V2.6 Flash | 4/4 | 4/4 | 3/4 | 4/4 |
| GPT-6 Astra | 4/4 | 4/4 | 4/4 | 4/4 |
| Claude Opus 5.5 | 4/4 | 4/4 | 4/4 | 4/4 |

MiMo, Astra, and Opus also ran security: each passed 4/4 for every variant. Total task acceptance was 140/144. All four failures were structured-response formatting defects; the prose classifications were correct.

Strict acceptance was 69/144. Command evidence passed in 72 trials, failed in 36, and remained unknown in 36. Every false row used an unsupported probe-plus-echo wrapper without an independently accepted probe. Every unknown row contained a matched required probe plus opaque ancillary commands. These grades do not establish 72 failing probes and were not retroactively promoted.

Identity-blinded, model-assisted review covered all 93 selected answers: the balanced first-repetition sample had 27 pass / 0 fail / 9 unknown; additional anomalies had 30 pass / 0 fail / 27 unknown. The remaining 51 answers were unreviewed. The differently selected samples cannot be pooled into a general quality rate. Two MiMo security answers cited incorrect source lines while reaching correct conclusions. Trace review found eight denied reads across six triage answers and one security call that enumerated parent scaffolding without returning external file contents. Passing scope predicates do not mean no outside-target access was attempted.

## Interpretation and reproducibility

Only triage differs between frontier and hybrid in recovery: a 154-byte addition in a debugger-dispatch block. The fixture forbids delegation and supplies the expected classification. Security prompts are identical between those variants. Advisor behavior, discovery activation, actual debugger dispatch, installed plugin routing, and full workflows are not exercised. The two recovery assets make hybrid larger than verbose; the five-asset reduction above does not apply to this subset.

Small previously exposed fixtures, four dependent repetitions, historical model selection, unequal case coverage, and uncontrolled service/cache conditions limit inference. Token and latency differences were mixed. No model-specific prompt routing is justified by this evidence.

The [Drahtbank guide](../packages/coding-agent/docs/drahtbank.md) documents running the committed harness. Raw prompts, traces, review records, frozen designs, and integrity receipts remain in local ignored archives rather than in the repository:

| Cohort | Local archive directory | Archive SHA-256 |
|---|---|---|
| Quota-limited comparison | `.artifacts/drahtbank/confined-receipt-v1-D9zgNb/` | `b4d6aba1c141add7fbbc14c1125dcb5229b0db0d7dd23207f605fe5a952d4bfe` |
| Completed recovery | `.artifacts/drahtbank/quota-recovery-v1-njuvhW/` | `7d54e7b52840fed2f0a66e380e805c48c4d44b930a55822a9908834ad3cc3a8d` |

These local archives are not publicly linked evidence. Each contains `run/RESULTS.md`, machine-readable analysis, trace interpretation, and an enclosing archive-verification receipt. Recovery also preserves the 63-file implementation manifest. PR preparation subsequently tightened malformed-token validation, commit-authorization wording, and session-disposal handling; the paid comparison was not rerun for those changes or integration with main.
