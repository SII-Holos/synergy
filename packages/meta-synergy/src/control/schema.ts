import z from "zod"

export const ServiceSnapshotSchema = z.object({
  desiredState: z.enum(["running", "stopped"]),
  runtimeStatus: z.enum(["starting", "running", "stopping", "stopped"]),
  running: z.boolean(),
  pid: z.number().optional(),
  startedAt: z.number().optional(),
  stoppedAt: z.number().optional(),
  lastExitAt: z.number().optional(),
  printLogs: z.boolean(),
  logPath: z.string(),
})

export const LogsPayloadSchema = z.object({
  logPath: z.string(),
  content: z.string(),
  truncated: z.boolean(),
})

export const ControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ping") }),
  z.object({ action: z.literal("service.status") }),
  z.object({ action: z.literal("service.stop") }),
  z.object({ action: z.literal("runtime.status") }),
  z.object({ action: z.literal("runtime.mode") }),
  z.object({ action: z.literal("runtime.enter_managed") }),
  z.object({
    action: z.literal("runtime.enter_managed_mode"),
    owner: z.string().optional(),
    ownerAgentId: z.string().optional(),
    phase: z.number().optional(),
  }),
  z.object({
    action: z.literal("runtime.set_mode"),
    mode: z.enum(["managed", "standalone"]),
    owner: z.string().optional(),
    ownerAgentId: z.string().optional(),
  }),
  z.object({ action: z.literal("runtime.reconnect") }),
  z.object({ action: z.literal("collaboration.status") }),
  z.object({ action: z.literal("collaboration.set"), enabled: z.boolean() }),
  z.object({ action: z.literal("requests.list") }),
  z.object({ action: z.literal("requests.show"), requestID: z.string() }),
  z.object({ action: z.literal("requests.approve"), requestID: z.string() }),
  z.object({ action: z.literal("requests.deny"), requestID: z.string() }),
  z.object({ action: z.literal("session.status") }),
  z.object({ action: z.literal("session.kick"), block: z.boolean().optional() }),
  z.object({
    action: z.literal("meta.execute"),
    caller: z.unknown(),
    body: z.unknown(),
  }),
  z.object({ action: z.literal("approval.get") }),
  z.object({ action: z.literal("approval.set"), mode: z.enum(["auto", "manual", "trusted-only"]) }),
  z.object({ action: z.literal("trust.list") }),
  z.object({ action: z.literal("trust.add"), subject: z.enum(["agent", "user"]), value: z.string() }),
  z.object({ action: z.literal("trust.remove"), subject: z.enum(["agent", "user"]), value: z.string() }),
  z.object({ action: z.literal("label.get") }),
  z.object({ action: z.literal("label.set"), label: z.string().nullable() }),
  z.object({
    action: z.literal("logs.read"),
    tailLines: z.number().int().positive().optional(),
    since: z.string().optional(),
    maxBytes: z.number().int().positive().optional(),
  }),
])

export const ControlSuccessResponseSchema = z.object({
  ok: z.literal(true),
  payload: z.unknown(),
})

export const ControlErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export const ControlResponseSchema = z.union([ControlSuccessResponseSchema, ControlErrorResponseSchema])

export type MetaSynergyControlRequest = z.infer<typeof ControlRequestSchema>
export type MetaSynergyControlResponse = z.infer<typeof ControlResponseSchema>
export type MetaSynergyServiceSnapshot = z.infer<typeof ServiceSnapshotSchema>
export type MetaSynergyLogsPayload = z.infer<typeof LogsPayloadSchema>
