# Quickstart

draht runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install draht

Install draht from npm. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @draht/coding-agent
```

draht does not require dependency lifecycle scripts for a normal npm installation.

Verify the installation:

```bash
draht --version
```

## 2. Start draht

Change to the folder you want draht to work with, then start it:

```bash
cd /path/to/folder
draht
```

The working folder helps draht discover relevant files, instructions, and configuration. draht also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="draht running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use draht in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates draht's responses. A **provider** is the service or account draht uses to access that model.

In draht, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give draht a task

draht shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When draht finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

draht saves sessions automatically. Exit draht, then resume the most recent session for the same working folder with:

```bash
draht --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use draht interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that draht should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize draht

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give draht persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [draht package](packages.md) |

## Uninstall draht

Use the package manager that installed draht. For npm, run:

```bash
npm uninstall -g @draht/coding-agent
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g @draht/coding-agent`, `yarn global remove @draht/coding-agent`, or `bun uninstall -g @draht/coding-agent`.

Uninstalling does not remove configuration, credentials, sessions, or installed draht packages from `~/.draht/agent/`.
