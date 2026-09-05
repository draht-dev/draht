# Quickstart

This page gets you from install to a useful first draht session.

## Install

draht is distributed as an npm package:

```bash
npm install -g --ignore-scripts @draht/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. draht does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed draht. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
npm uninstall -g @draht/coding-agent

# pnpm
pnpm remove -g @draht/coding-agent

# Yarn
yarn global remove @draht/coding-agent

# Bun
bun uninstall -g @draht/coding-agent
```

Uninstalling draht leaves settings, credentials, sessions, and installed draht packages in `~/.draht/agent/`.

Then start draht in the project directory you want it to work on:

```bash
cd /path/to/project
draht
```

## Authenticate

draht can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start draht and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching draht:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
draht
```

You can also run `/login` and select an API-key provider to store the key in `~/.draht/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once draht starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, draht gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. draht runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give draht project instructions

draht loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

draht loads:

- `~/.draht/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart draht, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
draht @README.md "Summarize this"
draht @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
draht -c                  # Continue most recent session
draht -r                  # Browse previous sessions
draht --name "my task"    # Set session display name at startup
draht --session <path|id> # Open a specific session
```

Inside draht, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
draht -p "Summarize this codebase"
cat README.md | draht -p "Summarize this text"
draht -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using draht](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [draht Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
