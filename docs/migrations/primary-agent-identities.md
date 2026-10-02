# Primary agent identities

Synergy's primary agents now use responsibility-independent runtime names:

| Previous name   | Runtime name | Display name | Responsibility     |
| --------------- | ------------ | ------------ | ------------------ |
| `synergy`       | `atlas`      | Atlas        | General assistance |
| `synergy-max`   | `forge`      | Forge        | Coding             |
| `synergy-flash` | `pico`       | Pico         | Lightweight work   |

Update execution scripts to use the current names, for example `synergy send --agent forge "Fix the failing test"`. CLI and API execution reject previous names. The product name, `synergy` executable, `.synergy` directories, `SYNERGY_HOME`, package names, model selection, permissions, delegation catalogs and tool behavior remain unchanged.

Startup upgrades registered configuration, Session, Workflows, Note and Connections records. Configuration upgrades include default selection, built-in keys, agent and command Markdown definitions, visibility and explicit delegation permissions. Session upgrades cover overrides, Cortex identities, message identities, queued input and explicit delegation rules. Workflows upgrade execution and review selection, Blueprint defaults and loops, scheduled executors and Session trigger filters. Channel account configuration follows the same mapping.

The central runner records completion only after an owner succeeds. Interrupted upgrades can retry, and repeated upgrades preserve the result. Late project discovery, configuration imports, Session imports and Home merges reuse the owning transformations even after startup completed. Home imports invalidate derived Note metadata so it rebuilds from the upgraded documents.

Only fields with agent semantics change. Prompt bodies, messages, logs, experiment evidence, unknown metadata and raw usage records retain their contents. Usage grouping and agent filters associate previous and current identities; purpose filters preserve recorded values. Existing custom agents keep their names except for the three previous built-in keys.

If a configuration contains both a previous key and its replacement, or both Markdown filenames exist, the upgrade stops with an identity conflict and preserves that configuration or both files. Rename the independent custom agent and its references, or combine the intended definitions under the current name before retrying. Delegation permissions also require an explicit resolution; their order must not decide which conflicting rule disappears. An interrupted Markdown publication can leave both files intact, so inspect both definitions before resolving that conflict.

See the [identity decision](../decisions/implemented/architecture/2026-10-02-primary-agent-identity-upgrades.md) and [agent and tool catalog](../product/agents-and-tools.md).
