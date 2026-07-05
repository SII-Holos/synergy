import z from "zod"
import {
  SynergyLinkBash,
  SynergyLinkEnvelope,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"

export const RPCRequestSchema = z.discriminatedUnion("tool", [
  SynergyLinkBash.ExecuteRequest,
  SynergyLinkProcess.ExecuteRequest,
  SynergyLinkSession.ExecuteRequest,
])

export const RPCResultSchema = z.discriminatedUnion("ok", [
  SynergyLinkBash.ExecuteResult,
  SynergyLinkProcess.ExecuteResult,
  SynergyLinkSession.ExecuteResult,
  SynergyLinkEnvelope.ErrorResult,
])

export type RPCRequest = z.infer<typeof RPCRequestSchema>
export type RPCResult = z.infer<typeof RPCResultSchema>
