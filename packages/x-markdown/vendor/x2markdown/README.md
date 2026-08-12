# Vendored x2markdown source

This folder contains the upstream MIT-licensed Chrome extension sources used as the reference implementation for X DOM selectors and Markdown structure.

- Upstream: https://github.com/RuochenLyu/x2markdown
- License: MIT, see `LICENSE`
- Snapshot source files: `shared.js`, `content-x.js`

The Worker does not execute the MV3 extension directly. It runs an adapted browser-page extractor in Cloudflare Browser Rendering because Workers cannot load Chrome extensions as-is.
