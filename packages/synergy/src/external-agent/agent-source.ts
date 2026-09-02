import { AgentExternalSource } from "../agent/external-source"
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
    discover: (config) => ExternalAgentDiscovery.discover(config),
  })
}
