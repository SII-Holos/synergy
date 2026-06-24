# External Agent Guide

This directory explains how an external coding agent should use the Synergy repository without confusing plugin authoring with Synergy source development.

## Pick The Right Path

### Build A Synergy Plugin

Use this path when the task is to create or maintain a plugin that runs on Synergy.

Read:

- [../plugins/agent-quickstart.md](../plugins/agent-quickstart.md)
- [../plugins/development-kit.md](../plugins/development-kit.md)
- [../../packages/plugin/README.md](../../packages/plugin/README.md)
- [../plugin/toolchain.md](../plugin/toolchain.md)

Do not read `AGENTS.md` for normal plugin authoring. `AGENTS.md` is about modifying this Synergy source repository.

### Modify Synergy Itself

Use this path when the task changes the server runtime, Web app, SDK, plugin platform internals, docs, tests, release scripts, or repository configuration.

Read:

- [../../AGENTS.md](../../AGENTS.md)
- [../../README.md](../../README.md)
- [../../CONTRIBUTING.md](../../CONTRIBUTING.md)
- package-specific `AGENTS.md` files when touching `packages/synergy` or `packages/app`

## Source Checkout Boundary

Plugin authors should not need a Synergy source checkout. They should use `@ericsanchezok/synergy-plugin-kit`, the `synergy-plugin ...` commands, and the `@ericsanchezok/synergy-plugin` SDK.

A source checkout is only needed when:

- changing Synergy core behavior
- changing the plugin loader, runtime isolation, permissions, marketplace, or Web host
- debugging a platform bug that cannot be isolated from an external plugin project
- testing unreleased Synergy changes before a CLI/SDK release exists

## LLM Entry Point

When an agent receives only the GitHub repository URL, start with [../../llms.txt](../../llms.txt). It routes plugin authors, source contributors, architecture readers, and SDK users to different document sets.
