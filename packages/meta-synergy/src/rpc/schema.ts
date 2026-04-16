import z from "zod"
import {
  MetaProtocolBash,
  MetaProtocolEnvelope,
  MetaProtocolProcess,
  MetaProtocolSession,
} from "@ericsanchezok/meta-protocol"

export const RPCRequestSchema = z.discriminatedUnion("tool", [
  MetaProtocolBash.ExecuteRequest,
  MetaProtocolProcess.ExecuteRequest,
  MetaProtocolSession.ExecuteRequest,
])

export const RPCResultSchema = z.discriminatedUnion("ok", [
  MetaProtocolBash.ExecuteResult,
  MetaProtocolProcess.ExecuteResult,
  MetaProtocolSession.ExecuteResult,
  MetaProtocolEnvelope.ErrorResult,
])

export type RPCRequest = z.infer<typeof RPCRequestSchema>
export type RPCResult = z.infer<typeof RPCResultSchema>
