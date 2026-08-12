# X Tweet Markdown

Use this skill when a task involves reading, summarizing, indexing, or citing a public X post from an agent.

## Workflow

1. Prefer the `x_tweet_markdown` draht tool when it is available.
2. Pass the full `https://x.com/.../status/...` or `https://x.com/.../article/...` URL.
3. Set `includeThread: true` when the surrounding same-author thread matters.
4. Read from the returned Markdown, not from raw screenshots or stale snippets.

## Limits

- The service only reads public, renderable X pages.
- It does not bypass login walls, protected accounts, deleted posts, paywalls, or private content.
- If extraction fails, report that X rendering or DOM selectors likely drifted instead of inventing post content.
- Do not use `twitter.com` or `mobile.x.com` URLs; ask for or normalize to an `x.com` URL first.
