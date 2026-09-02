---
name: epistemics
description: Confidence calibration for investigation findings — five tiers (Direct, Supported, Inferred, Speculative, Unknown) that determine both which output section a claim goes in and how it is phrased; cite-or-label-as-inference; null results as first-class evidence; competing hypotheses without forcing a winner; the Sources Consulted coverage map. Use whenever reporting why code exists, summarising an investigation, writing a postmortem, or presenting findings whose evidence is historical, fragmentary, or secondhand. Triggers on "why was this built", "what's the history", "design rationale", "how confident are we", or any moment the agent is about to present an intent claim it cannot cite.
---

# Epistemics

Code does not carry its own motivation. A diff shows what changed; nothing in it shows why. Every claim about intent, history, or rationale therefore rests on external evidence — a commit message, a PR description, a decision record, a planning note — and the honesty of a findings report lives in how precisely each claim's evidence is represented.

## The Core Rule

> **If you can't cite it, it's inference, not fact — and it must be labeled as such.**

A report that states inferences as facts is not a summary, it is fiction with a confident tone. The calibration below is the product; de-hedging it to sound authoritative is the exact failure this skill exists to prevent.

## The Five Tiers

The tier a claim earns determines **both** which output section it belongs in **and** the vocabulary allowed to phrase it.

1. **Direct** — an explicit statement of intent by someone in a position to know, citable verbatim. Phrase as fact with the citation adjacent.
   - A PR description: "Switching to cursor pagination because offset scans time out past 100k rows" (PR #212).
   - An ADR title and context section naming the decision and its forcing constraint.
   - A `.planning/STATE.md` `## Decisions` line, dated and attributed.
2. **Supported** — multiple independent indirect sources converge on the same reading. Phrase as fact with all citations, and say the support is convergent, not explicit.
   - A commit message names the symptom and the linked issue describes the incident it fixed.
   - An inline comment names an upstream constraint and the dependency's changelog confirms it existed at that date.
3. **Inferred** — one plausible reading of circumstantial evidence. Phrase with hedged vocabulary and show the inference chain: "Given A and B, C is likely because D."
   - The retry wrapper landed two days after a revert of the same call site — consistent with a reaction to a production failure, but nothing says so.
4. **Speculative** — a hypothesis the evidence neither supports nor rules out. Belongs only in a hypotheses section, phrased as a candidate, never in findings.
5. **Unknown** — the searches ran and came up empty, or the source that would know is unavailable. Reported explicitly, never silently omitted.

## Phrasing Guide

Confidence-carrying words assert knowledge of intent. Each one demands a citation immediately adjacent:

- "because", "the reason is", "was designed to", "fixes", "the team decided"

Hedge words mark inference and are the only vocabulary allowed for tier 3:

- "appears to", "likely", "suggests", "is consistent with", "one reading is"

Banned words: "obviously", "clearly", "of course", "just". And replace "I think" with "the evidence suggests" — the reader needs the evidence's confidence, not yours.

## Never Cite Code as Evidence of Its Own Intent

Code is mechanics; motivation is external. "The cache exists to reduce latency" cited to the cache implementation is circular — the code proves a cache exists, not why anyone wanted one. A performance rationale needs a source outside the code: a commit message, a benchmark in the PR, a decision record. Without one, it is an Inferred claim wearing a fact's clothes.

## Null Results Are Evidence; Skipped Searches Are Blind Spots

- A **null result** — "searched the review record for pagination discussion across the file's full history; nothing found" — is a data point. It rules readings out and belongs in the report.
- A **skipped search** is a blind spot. It rules nothing out and must be reported as a gap, not dressed up as a null result.

The reader cannot tell the two apart unless the report distinguishes them. Always state what was searched (queries verbatim) so an empty result is meaningful.

## Contradictions Are Findings

When two sources disagree — the commit message says performance, the linked ticket says a correctness bug — surface both with their citations. Do not pick the tidier narrative, do not average them into a vague middle. The historical record contradicts itself more often than it lies consistently, and the contradiction is usually the most informative thing the investigation found.

## The Sycophancy Trap

When the question embeds a hypothesis — "why did we switch to X, was it performance?" — the embedded guess is a candidate to check independently, not a conclusion to confirm. Search for evidence that would support it AND evidence that would contradict it, at equal effort.

> **The user's guess is a prompt for investigation, not a conclusion to validate.**

## Anti-Rationalization

- Never retrofit intent: "this must have been for scalability" is storytelling unless a source says so.
- A consistent pattern across files may be a deliberate convention — or copy-paste of the first instance. Investigate the origin, don't infer policy from repetition.
- Absence of evidence is not evidence of absence: "no discussion found" supports "we found no discussion", not "there was no discussion".

## The Coverage-Map Contract

Every findings report ends with a **Sources Consulted** map: one line per evidence category, including the empty ones. A category may be skipped only with a written justification, and only two justifications are valid:

1. **Unavailable in this runtime** — the source cannot be searched here. That is a coverage gap, not a choice, and is reported as one.
2. **Provably irrelevant, not probably.** A build-time script with no runtime path provably cannot appear in runtime error tracking. "It's feature code, error tracking won't have anything" is a probability judgment, not a proof — search it.

## Calibration Checklist

Before finalizing any findings report:

- Does every factual claim have a citation adjacent to it?
- Is every uncited claim phrased with tier-3 hedge vocabulary and filed in an inference section?
- Is any claim citing code as evidence of its own intent?
- Is the gaps section present and specific? **If no gaps are mentioned, that's suspicious** — every real investigation has them.

## Failure Modes

- **Confident storytelling** — a plausible narrative assembled from mechanics and phrased as history. The most common failure, and the hardest to spot from inside.
- **Citing code as evidence of its own intent** — circular sourcing dressed as citation.
- **Recency bias** — explaining the current shape as one decision when it is an accretion of many. Trace back through the history; the first version's rationale is usually not the current version's.
- **Sycophantic confirmation** — finding only the evidence that agrees with the asker's framing.
- **Skipping the gaps section** — shipping a coverage map with no empties is claiming a completeness no investigation has.

## Relationship to verification-gate

`verification-gate` governs claims about **present** state that a command can prove — run the command, read the output, then claim. Epistemics governs claims about **historical intent** that no command can prove: there is nothing to run, so the discipline is to tier and cite instead. The two compose; neither substitutes for the other.

One fixed-format carve-out: `verify-work`'s observed/derived/assumed labels and its verdict-first UAT ordering are fixed report formats — epistemics governs historical-intent claims and never rewords those labels or that ordering.
