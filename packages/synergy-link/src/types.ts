import z from "zod"
import type { SynergyLinkIdentity, SynergyLinkHost } from "@ericsanchezok/synergy-link-protocol"

export type LinkID = SynergyLinkIdentity.LinkID
export type RequestID = string

export interface RemoteHostIdentity {
  linkID: LinkID
  hostSessionID: SynergyLinkIdentity.HostSessionID
  capabilities: SynergyLinkHost.Capabilities
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
