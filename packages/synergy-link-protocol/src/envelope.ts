import z from "zod"
import { SynergyLinkError } from "./error"
import { SynergyLinkIdentity } from "./identity"

export namespace SynergyLinkEnvelope {
  export const VERSION = 2

  export const Tool = z.enum(["bash", "process", "session"])
  export type Tool = z.infer<typeof Tool>

  export const RequestBase = z
    .object({
      version: z.literal(VERSION),
      requestID: z.string().min(1),
      linkID: SynergyLinkIdentity.LinkID,
      tool: Tool,
      action: z.string().min(1),
    })
    .strict()
  export type RequestBase = z.infer<typeof RequestBase>

  export const ResultBase = z
    .object({
      version: z.literal(VERSION),
      requestID: z.string().min(1),
      ok: z.boolean(),
    })
    .strict()
  export type ResultBase = z.infer<typeof ResultBase>

  export const TypedResultBase = ResultBase.extend({
    tool: Tool,
    action: z.string().min(1),
  }).strict()
  export type TypedResultBase = z.infer<typeof TypedResultBase>

  export const ErrorResult = ResultBase.extend({
    ok: z.literal(false),
    tool: Tool.optional(),
    action: z.string().min(1).optional(),
    error: SynergyLinkError.Shape,
  }).strict()
  export type ErrorResult = z.infer<typeof ErrorResult>
}
