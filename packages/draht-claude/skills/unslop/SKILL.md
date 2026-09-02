---
name: unslop
description: Cut AI tells from prose deliverables the agent produces — docs, READMEs, reports, summaries, UAT reports, handoff documents, commit bodies, PR descriptions, client-facing text — then add voice back so the result is neither slop nor sterile. Use when writing or substantially editing any prose deliverable, or when the user says "unslop", "de-AI-ify", "sounds like AI", "make it sound human", or asks to clean up slop. Covers German prose by analogy (Füllwörter, Werbesprache, Anglizismen). Never applies to code, code comments, quoted output or evidence, machine-parsed formats (commit subjects, STATUS lines, frontmatter), or draht's own prompt and skill corpus.
---

# Unslop

An editing pass over prose the agent produces. Run it while the deliverable is being written — as the report, doc, or handoff takes shape — never as a sweep over a repository. The job has two halves: cut the tells, then put voice back. Sterile prose is as recognizable as sloppy prose.

## Scope

Unslop governs prose draht produces: docs, READMEs, reports, UAT reports, summaries, handoff documents, specs, commit bodies, PR descriptions, client-facing text.

It never applies to code, identifiers, or code comments, and never to user-authored text uninvited. Draht's own prompts and skills are not a target: the corpus legitimately uses em dashes and bold lead-ins as house style. This skill governs work products, not the toolchain's instruction files.

Edit only text you are producing or were asked to edit. Never rewrite quoted command output, error messages, evidence, or the user's own words. Fixed formats stay fixed: conventional-commit subject lines, red:/green:/refactor: prefixes, STATUS: lines, frontmatter, verdict-first report ordering.

## Process

1. Scan the text for the patterns below.
2. Rewrite. Preserve meaning and register.
3. Add voice back — register-aware (see Adding Voice).
4. Self-audit: ask "What makes this obviously AI generated?" and fix the remaining tells.

## Patterns

Every entry pairs the tell with its fix.

### Content

- **Puffery and promotional language.** "pivotal moment", "testament to", "evolving landscape", "groundbreaking", "vibrant", "renowned", "stunning". Cut it; state what happened.
- **Superficial -ing phrases.** "highlighting...", "ensuring...", "showcasing...", "fostering...". Delete, or expand into a real statement with a real source.
- **Vague attributions.** "Experts believe", "reports suggest", "some argue". Name the source or delete. In a report this means citing the command or file, not "tests suggest".

### Language

- **AI vocabulary** (English-calibrated): additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Use the plain word.
- **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
- **"Not just X, but Y."** State the point directly.
- **Rule of three.** Ideas forced into groups of three. Use the natural number.
- **Synonym cycling.** Protagonist, main character, central figure, hero in one paragraph. Pick one term and repeat it — repeating the established name is precision, not monotony.
- **False ranges.** "from X to Y" where X and Y sit on no meaningful scale. List the items directly.

### Style

- **Dash moderation.** An em dash is punctuation, not a tell. Three per paragraph is. Do not chain them, do not let dashes replace every comma and period; vary the connective.
- **Colon crutches.** A colon is for a list or an example, not a mid-sentence connector. Rewrite so the point stands on its own.
- **Boldface spam.** Don't bold every noun, proper name, or acronym.
- **Inline-header lists.** The tell is a bold label and colon restating the line. A bold lead-in ending in a period, naming the item, followed by genuinely new detail is fine.
- **Headings** (English-only rule): sentence case, not title case.
- **Decorative emojis.** Remove from headings and bullets.
- **Curly quotes.** Replace with straight quotes.

### Communication Artifacts

The group most relevant to reports and handoffs.

- **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Certainly!", "Found the smoking gun!". Remove.
- **Cutoff disclaimers.** "While specific details are limited...". Find the fact or drop the sentence.
- **Sycophancy.** "Great question!", "You're absolutely right!". Respond directly.

### Filler

- **Filler phrases** (English-calibrated). "In order to" becomes "To". "Due to the fact that" becomes "Because". "It is important to note that" gets deleted.
- **Hedging stacks.** "could potentially possibly be argued that it might" becomes "may".
- **Generic conclusions.** "The future looks bright." State the specific plan or fact, or end one sentence earlier.

### Jargon

- **Abstract metaphor nouns.** Substrate, wedge, vector, nexus, bedrock, modality, paradigm, north star, flywheel, endgame. These sound technical but hide a plainer concrete word: "substrate" becomes "base", "wedge in" becomes "add", "north star" / "flywheel" / "endgame" become the plain phrase. Pick the concrete word.
- **Carve-out.** A term defined in .planning/DOMAIN.md or established in the project's vocabulary is never slop — the ubiquitous-language rule wins over this list.

### Plain Speech

- **Name the mechanism, not the feeling.** "the database stays close at hand" names a feeling; "a column rename fails the build" names a mechanism. Restate every claim as a concrete instruction, fact, or number — or cut it. If the sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
- **One idea per sentence.** If the reader has to backtrack to parse a sentence, split it or drop clauses.
- **Active voice with a named actor.** "queries are validated" becomes "the compiler validates queries". Passive is fine only when the actor is unknown or genuinely irrelevant.
- **Cut adverbs, or use the measured number.** "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.
- **Prefer the plain word** (English-calibrated). "utilize" becomes "use", "leverage" becomes "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if".

## Adding Voice

Removing patterns is half the job — voiceless prose is just as obviously machine-made. Register decides how much voice returns:

- **Docs and READMEs**: have opinions and react to facts instead of neutrally listing pros and cons; vary rhythm (short sentences, then longer ones that take their time); use "I" when it fits; be specific.
- **Reports, UAT reports, handoffs, client-facing text**: stay factual and concrete. Specificity is the voice there — name the file, the count, the command. No filler warmth, no manufactured mess.

## German Prose

The word lists above are English-calibrated. The discipline generalizes to German by category, not by translated catalog:

- **Füllwörter**: "im Grunde genommen", "quasi", "sozusagen" — streichen.
- **Werbesprache**: "innovativ", "ganzheitlich", "im heutigen digitalen Zeitalter", "spielt eine entscheidende Rolle" — sagen, was passiert ist.
- **Anglizismen-Slop**: "leveragen", "alignen" where a German word exists — use the German word.
- "nicht nur X, sondern auch Y" is the "not just X, but Y" tell verbatim: state the point directly.
- Style and format tells (dash chaining, bold spam, decorative emojis, curly quotes) and communication artifacts (chatbot phrases, disclaimers, sycophancy) are language-independent.
- The sentence-case-headings rule is English-only — German headings follow German orthography.

## Self-Audit

Before delivering, ask once more: "What makes this obviously AI generated?" Fix what you find.
