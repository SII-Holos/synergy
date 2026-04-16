# Synergy Ecosystem

Community projects that extend Synergy with specialized capabilities — skill packs, agent definitions, CLI tools, and integrations.

## Skill Packs

Pre-built collections of skills that add domain-specific workflows to Synergy.

| Project                                                                                 | Author                                                    | Description                                                                                                                                                          | Install                                                                                                               |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [ARIS for Synergy](https://github.com/EricSanchezok/Auto-claude-code-research-in-sleep) | Adapted from [@wanshuiyin](https://github.com/wanshuiyin) | Autonomous ML research workflows: idea discovery, experiment execution, paper writing, and adversarial review loops. 65 skills covering the full research lifecycle. | `curl -sL https://raw.githubusercontent.com/EricSanchezok/Auto-claude-code-research-in-sleep/main/install.sh \| bash` |

## MCP Servers

External MCP servers integrated into Synergy, extending its tool capabilities.

| Project                                         | Author                                   | Description                                                                                                                                           | Usage                                                                                                           |
| ----------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [qzcli](https://github.com/tianyilt/qzcli_tool) | [@tianyilt](https://github.com/tianyilt) | MCP server for the Qizhi (启智) GPU compute platform. Submit/monitor/track training jobs, query GPU availability, manage compute groups and HPC jobs. | Add as MCP server in Synergy config. Exposes tools like `qz_create_job`, `qz_list_jobs`, `qz_get_availability`. |

## Contributing

Built something that works with Synergy? Add it here:

1. Fork [synergy](https://github.com/EricSanchezok/synergy)
2. Add your project to the appropriate section in `ECOSYSTEM.md`
3. Open a PR

### What counts as ecosystem

- **Skill packs**: Collections of `SKILL.md` files that add workflows
- **Agents**: Custom agent definitions (`.md` files in `~/.synergy/config/agent/`)
- **CLI tools**: External tools that Synergy can invoke via skills or agents
- **MCP servers**: Model Context Protocol servers that extend Synergy's tool capabilities
- **Integrations**: Bridges between Synergy and other platforms (Feishu, Slack, etc.)

### Writing a good entry

- One-line description that tells users **what it does**, not just what it is
- Credit the original author when adapting from another project
- Include a one-click install command if possible
- Note if it's a built-in (shipped with Synergy) vs. external (separate install)
