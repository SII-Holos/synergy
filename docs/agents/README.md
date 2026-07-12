# Agent Entry Points

Choose documentation by the system you are changing. Plugin authoring and Synergy repository development have different contracts.

## Build a Plugin

For a plugin that runs on Synergy, start with:

- [Plugin platform](../plugins/README.md)
- [Getting started](../plugins/getting-started.md)
- [Manifest reference](../plugins/manifest.md)
- [Runtime and permissions](../plugins/runtime-and-permissions.md)
- [Public plugin SDK](../../packages/plugin/README.md)

Use the published plugin kit and SDK. A Synergy source checkout is needed only when changing the platform, testing unreleased platform behavior, or diagnosing a host bug that cannot be isolated in the plugin project.

## Modify Synergy

For the runtime, Web app, Desktop, SDK, plugin platform, repository tools, tests, or documentation, read:

- [Repository agent rules](../../AGENTS.md)
- [Documentation index](../README.md)
- [Development reference](../reference/development.md)
- [Contribution guide](../../CONTRIBUTING.md)

Then read the nearest package `AGENTS.md` and the architecture or product contract for the subsystem being changed.

Load the repository `development-standards` Skill when the change is cross-cutting or its workflow owner is unclear. It routes frontend, LLM, server API, persistence, agent, tool, CLI, testing, runtime, and Git work to focused Skills.

## Repository-only Workflows

The `.synergy/skill/` directory contains executable workflows for agents working in this repository. Those workflows link to canonical docs instead of repeating architecture knowledge. They are also where new reusable development conventions must be captured when implementation or review exposes a missing rule. They are not part of the public plugin-authoring contract.

When only a repository URL is available, [`llms.txt`](../../llms.txt) is the compact routing entry point.
