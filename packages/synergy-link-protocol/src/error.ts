import z from "zod"

export namespace SynergyLinkError {
  export const Code = z.enum([
    "invalid_request",
    "unsupported_tool",
    "unsupported_action",
    "link_not_found",
    "link_inactive",
    "session_not_found",
    "session_required",
    "session_invalid",
    "session_caller_mismatch",
    "host_internal_error",
    "process_not_found",
    "execution_failed",
    "transport_error",
  ])
  export type Code = z.infer<typeof Code>

  export const Shape = z.object({
    code: Code,
    message: z.string(),
    details: z.unknown().optional(),
  })
  export type Shape = z.infer<typeof Shape>

  export function create(code: Code, message: string, details?: unknown): Shape {
    return { code, message, ...(details === undefined ? {} : { details }) }
  }
}
