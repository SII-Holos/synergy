import { z } from "zod"

const TLSFiles = z.object({ cert: z.string(), key: z.string(), ca: z.string() }).strict()
export const RemoteLab = z
  .object({
    endpoint: z.url(),
    hostname: z.string().min(1),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    engineTLS: TLSFiles,
    executionTLS: TLSFiles,
  })
  .strict()
export type RemoteLab = z.infer<typeof RemoteLab>

export const Identity = z
  .object({
    scopeID: z.literal("home"),
    environmentID: z.string(),
    workspaceID: z.string(),
    sessionID: z.string(),
    operationID: z.string(),
    marker: z.string(),
  })
  .strict()
export type Identity = z.infer<typeof Identity>

export const Snapshot = z
  .object({
    identity: Identity,
    state: z.string(),
    allocationID: z.string(),
    uses: z.number().int().nonnegative(),
    directory: z.string(),
    output: z.string(),
    saved: z.boolean(),
    markerRecovered: z.boolean(),
  })
  .strict()
export type Snapshot = z.infer<typeof Snapshot>

export const Command = z.enum([
  "start",
  "inspect",
  "block-save",
  "restore-save",
  "complete",
  "continue",
  "replace",
  "reclaim",
  "close",
])
export type Command = z.infer<typeof Command>
export const Request = z.object({ id: z.string(), command: Command }).strict()
export const Reply = z.object({ id: z.string(), value: Snapshot.optional(), error: z.string().optional() }).strict()
