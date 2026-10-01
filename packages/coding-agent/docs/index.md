# draht

draht is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use draht for software development, research notes, writing projects, data files, or hobby work. You can use draht as is, prompt it to adapt itself to your workflow, or build other applications powered by draht using the SDK.

## Start using draht

New to draht? Follow the [Quickstart](quickstart.md) to install draht, connect a model, and complete your first task.

If draht is already installed, choose what you want to do:

- [Use draht interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint. To run local models through a llama.cpp router and manage them with `/llama`, see [llama.cpp](llama-cpp.md).
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Attach to a running session](attachable-sessions.md) from another terminal, or let several models collaborate in one session with [Duet mode](duet.md).
- [Configure draht](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how draht works](how-pi-works.md), including tools, context, sessions, and the agent loop.

## Customize draht

draht can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-draht) to select the smallest mechanism that meets your need.

## Automate or embed draht

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate draht process.
- Use the [TypeScript SDK](sdk.md) to run draht inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [provider authentication](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

draht's tools and extensions run with the permissions of the draht process. Project trust controls which project resources draht loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
