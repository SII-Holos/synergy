import { AgentPluginSource } from "../agent/plugin-source"
import { Plugin } from "./index"

/**
 * S9d source inversion: plugin-contributed agents flow into the L1 agent
 * registry through this registered source. Loaded through
 * src/product-registration.ts.
 */
export function registerAgentPluginSource() {
  AgentPluginSource.register({ agentEntries: () => Plugin.agentEntries() })
}
