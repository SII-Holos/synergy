import z from "zod"
import { MetaProtocolEnv } from "./env"
import { MetaProtocolError } from "./error"

export namespace MetaProtocolEnvelope {
  export const Tool = z.enum(["bash", "process", "session"])
  export type Tool = z.infer<typeof Tool>

  export const RequestBase = z.object({
    version: z.literal(1),
    requestID: z.string().min(1),
    envID: MetaProtocolEnv.EnvID,
    tool: Tool,
    action: z.string().min(1),
  })
  export type RequestBase = z.infer<typeof RequestBase>

  export const ResultBase = z.object({
    version: z.literal(1),
    requestID: z.string().min(1),
    ok: z.boolean(),
  })
  export type ResultBase = z.infer<typeof ResultBase>

  export const TypedResultBase = ResultBase.extend({
    tool: Tool,
    action: z.string().min(1),
  })
  export type TypedResultBase = z.infer<typeof TypedResultBase>

  export const ErrorResult = ResultBase.extend({
    ok: z.literal(false),
    tool: Tool.optional(),
    action: z.string().min(1).optional(),
    error: MetaProtocolError.Shape,
  })
  export type ErrorResult = z.infer<typeof ErrorResult>
}
