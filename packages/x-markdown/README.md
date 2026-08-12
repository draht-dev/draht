# @draht/x-markdown

Convert public X status URLs into clean Markdown for agents.

The service is adapted from the MIT-licensed [`x2markdown`](https://github.com/RuochenLyu/x2markdown) Chrome extension. It uses the same visible-DOM extraction approach, but runs it inside a Cloudflare Browser Rendering session so agents can call an HTTP API instead of installing a browser extension.

## Shape

- Cloudflare Worker HTTP API: `POST /convert`
- draht extension: registers the `x_tweet_markdown` tool and `/x2md` command
- Agent skill: `skills/x-tweet-markdown/SKILL.md`

## Worker API

```bash
curl -X POST "$X2MARKDOWN_SERVICE_URL/convert" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $X2MARKDOWN_API_KEY" \
  -d '{"url":"https://x.com/user/status/123","includeThread":true}'
```

The response contains `markdown`, `metadata`, `source`, and `extractedAt`.

## Constraints

- Only `https://x.com/.../status/...` and `https://x.com/.../article/...` URLs are accepted.
- The worker does not bypass login walls, deleted posts, protected posts, paywalls, or private content.
- X DOM changes can break extraction; failures should be treated as retryable parser drift.
- `sst.config.ts` attaches a Cloudflare Browser Rendering binding named `BROWSER`.

## Deploy

```bash
cd packages/x-markdown
sst deploy --stage production
```

Set `X2MARKDOWN_API_KEY` if the API should require bearer auth.
