import { ResourceSources } from "@ericsanchezok/synergy-harness/observability/resource-sources"
import { McpSupervisor } from "./supervisor"

async function snapshot(): Promise<ResourceSources.Snapshot> {
  const mcp = await McpSupervisor().resourceStats()
  return {
    owner: "mcp",
    ...mcp,
    source: "mcp_stdio",
    completeness: mcp.processCount === 0 || mcp.measuredProcessCount === mcp.processCount ? "full" : "partial",
    attributes: {
      stdioOpen: mcp.stdio.open,
      stdioClosing: mcp.stdio.closing,
      stdioClosed: mcp.stdio.closed,
      closeTimedOut: mcp.stdio.timedOut,
      descendantPipeGraceMs: 2_000,
    },
  }
}

export function registerResourceSource() {
  ResourceSources.register("mcp", snapshot)
}
