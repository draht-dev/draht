---
description: Speak text aloud via ElevenLabs text-to-speech (voice output for summaries, status updates, or any message the user should hear)
allowed-tools: Bash, Read
---

# /speak

Speak text aloud to the user through the local audio device, using the ElevenLabs text-to-speech API.

> **Tool note**: Invoke the speak helper as `node "<PLUGIN_ROOT>/scripts/speak.cjs" [options] "text"` via the Bash tool.

## What to speak

- `$ARGUMENTS` is the text to speak. If it is empty, speak a short spoken-style summary of the most recent result or answer in the conversation.
- Rewrite for the ear before speaking: short sentences, no markdown, no code blocks, no raw URLs or file paths (say "the gateway config" instead of reading a path aloud). Keep it under roughly 60 seconds of speech (~1000 characters) unless the user asked for the full text.
- Speak in the language the user is currently using.

## Helper options

```
node "<PLUGIN_ROOT>/scripts/speak.cjs" [options] "text"
  --voice <id>    ElevenLabs voice id (default: $DRAHT_SPEAK_VOICE_ID or George)
  --model <id>    model id (default: $DRAHT_SPEAK_MODEL_ID or eleven_flash_v2_5)
  --speed <n>     speaking speed 0.25–4.0
  --lang <code>   ISO 639-1 language hint (e.g. de, en)
  --out <file>    also keep the mp3 at this path
  --no-play       synthesize only, do not play audio
  --force         bypass the 4000-character cost guard
```

Long text can also be piped on stdin instead of passed as an argument.

## API key

The helper resolves the key in this order: `$ELEVENLABS_API_KEY` → an `ELEVENLABS_API_KEY=` line in a `.env` file in the working directory → `$HOME/.draht/keys/elevenlabs.key`. If it reports no key, tell the user to store their ElevenLabs API key in one of those places (the `$HOME/.draht/keys/elevenlabs.key` file is the recommended persistent location) — never ask them to paste the key into the chat.

## Delegating

To speak without blocking the main conversation — or to voice progress updates during long-running work — spawn the `speaker` subagent with the text to speak and the helper path above.

## Steps

1. Determine the text (from `$ARGUMENTS` or by summarizing), rewrite it for the ear.
2. Run the helper via Bash. On error, relay the helper's message (missing key, rate limit, no audio player) — do not retry more than once.
3. Confirm briefly what was spoken (one line, e.g. "Spoke the phase summary, 12 seconds.").
