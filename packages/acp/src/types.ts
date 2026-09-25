import type { McpServer } from "@agentclientprotocol/sdk"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk"

export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: {
    providerID: string
    modelID: string
  }
  modeId?: string
}

export interface ACPConfig {
  sdk: SynergyClient
  defaultModel?: {
    providerID: string
    modelID: string
  }
}
