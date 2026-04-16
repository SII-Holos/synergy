import z from "zod"
import type { MetaProtocolEnv, MetaProtocolHost } from "@ericsanchezok/meta-protocol"

export type EnvID = MetaProtocolEnv.EnvID
export type RequestID = string

export interface RemoteHostIdentity {
  envID: EnvID
  hostSessionID: MetaProtocolEnv.HostSessionID
  capabilities: MetaProtocolHost.Capabilities
  label?: string
}

export const HolosCallerSchema = z.object({
  type: z.string(),
  agentID: z.string(),
  ownerUserID: z.number(),
  profile: z.record(z.string(), z.unknown()).optional(),
})

export interface HolosCaller {
  type: string
  agentID: string
  ownerUserID: number
  profile?: Record<string, unknown>
}

export interface HostTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(message: unknown): Promise<void>
}
