import z from "zod"

export namespace MetaProtocolError {
  export const Code = z.enum([
    "env_not_found",
    "env_inactive",
    "device_offline",
    "request_timeout",
    "request_cancelled",
    "remote_execution_error",
    "invalid_request",
    "unsupported_tool",
    "unsupported_action",
    "unsupported_capability",
    "host_internal_error",
    "stale_process_handle",
    "stdin_unavailable",
    "session_required",
    "session_invalid",
    "session_busy",
    "session_refused",
    "session_caller_mismatch",
  ])
  export type Code = z.infer<typeof Code>

  export const Shape = z.object({
    code: Code,
    message: z.string(),
    details: z.unknown().optional(),
  })
  export type Shape = z.infer<typeof Shape>
}
