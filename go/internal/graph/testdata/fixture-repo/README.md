# fixture-repo

A small, hand-built multi-language repo used by
`internal/graph/pipeline_test.go`'s end-to-end golden test. Not real code —
every file exists only to exercise one specific pipeline behaviour (see each
file's header comment). This file itself exercises the non-code "asset"
path (`stats.languages`/`assets.byLanguage` count it; it never becomes a
`modules[]` entry).
