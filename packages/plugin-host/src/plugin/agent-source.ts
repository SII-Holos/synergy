import { AgentPluginSource } from "@ericsanchezok/synergy-harness/agent/plugin-source"
import { Plugin } from "."

/**
 * S9d source inversion: plugin-contributed agents flow into the L1 agent
 * registry through this registered source. Loaded through
 * src/product-registration.ts.
 */
export function registerAgentPluginSource() {
  AgentPluginSource.register({ agentEntries: () => Plugin.agentEntries() })
}
