import { CodexProvider } from "@ericsanchezok/synergy-harness/provider/codex"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
const descriptions: Record<string, string> = {
  codex:
    "OpenAI Codex agent. Strong at autonomous multi-step coding: implementing features, debugging, refactoring, and running shell commands. Best when the task is well-scoped and implementation-focused.",
  "claude-code":
    "Anthropic Claude Code agent. Excels at complex reasoning, nuanced code review, large-scale refactoring, and tasks requiring deep understanding of codebases. Supports extended thinking for hard problems.",
  openclaw:
    "OpenClaw multi-model agent platform. Versatile generalist with 39+ built-in tools including web search, browser, image generation, and multi-provider model routing. Good for tasks that need diverse tool access beyond pure coding.",
}

import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { AgentExternalSource } from "@ericsanchezok/synergy-harness/agent/external-source"
import { ExternalAgentDiscovery } from "./discovery"

/**
 * S9d source inversion: the L1 agent registry loads external-agent adapters
 * and discovers them through this registered source instead of importing the
 * external-agent product domain. Loaded through src/product-registration.ts.
 */
export function registerAgentExternalSource() {
  AgentExternalSource.register({
    async loadAdapters() {
      await import("./adapter/codex")
      await import("./adapter/claude-code")
      await import("./adapter/openclaw")
    },
    description: (name) => descriptions[name],
    async discover() {
      const log = Log.create({ service: "external-agent.discovery" })
      const externalConfig = (await Config.current()).external_agent ?? {}
      const discovered = await ExternalAgentDiscovery.discover(externalConfig)
      const result: typeof discovered = new Map()
      for (const [name, info] of discovered) {
        const overrides = externalConfig[name]
        if (overrides?.disabled) {
          log.info("external agent disabled by config", { name })
          continue
        }
        if (overrides?.auto_discover === false) {
          log.info("external agent auto_discover disabled", { name })
          continue
        }
        if (name === "codex") {
          const access = await CodexProvider.resolveToken({ allowMissing: true }).catch(() => undefined)
          if (!access) {
            log.info("codex external agent skipped until openai-codex provider is authenticated")
            continue
          }
        }
        const { disabled: _, path, model, auto_discover: __, ...adapterConfig } = overrides ?? {}
        const externalField = {
          adapter: info.adapter,
          path: path ?? info.path,
          version: info.version,
          config: {
            ...(model ? { model } : {}),
            ...(name === "codex" ? { nativeAuth: true } : {}),
            ...adapterConfig,
          },
        }
        result.set(name, externalField)
      }
      return result
    },
  })
}
