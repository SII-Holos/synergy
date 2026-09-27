import { createHash } from "node:crypto"
import { z } from "zod"
import { EnvironmentSchema } from "./schema"

export namespace ExecutionProtocol {
  export const version = 1
  export const ID = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]*$/)
  export const Command = z
    .object({
      command: z.string().min(1).max(32768),
      args: z.array(z.string().max(1_048_576)).max(4096),
      cwd: z.string().min(1),
      env: z.record(z.string(), z.string()).default({}),
      writableRoots: z.array(z.string()).nullable(),
      pty: z.object({ cols: z.number().int().min(1).max(65535), rows: z.number().int().min(1).max(65535) }).optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
    })
    .strict()
    .meta({ ref: "EnvironmentCommand" })
  export type Command = z.infer<typeof Command>
  export const Request = z.object({
    id: ID,
    target: EnvironmentSchema.Target,
    digest: z.string().length(64),
    command: Command,
  })
  export type Request = z.infer<typeof Request>
  export const Status = z
    .object({
      id: ID,
      target: EnvironmentSchema.Target,
      digest: z.string(),
      state: z.enum(["accepted", "running", "exited", "cancelled", "unknown"]),
      cursor: z.number().int().nonnegative(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
      treeDrained: z.boolean().default(false),
      streamsDrained: z.boolean().default(false),
      error: z.string().optional(),
      outputTruncated: z.boolean().optional(),
    })
    .meta({ ref: "EnvironmentExecutionStatus" })
  export type Status = z.infer<typeof Status>
  export const Chunk = z.object({
    cursor: z.number().int().positive(),
    stream: z.enum(["stdout", "stderr"]),
    data: z.string().max(90_000),
  })
  export type Chunk = z.infer<typeof Chunk>

  export function digest(value: Command): string {
    const input = Command.parse(value)
    return createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          env: Object.fromEntries(Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))),
        }),
      )
      .digest("hex")
  }

  export function terminal(status: Status) {
    return (status.state === "exited" || status.state === "cancelled") && status.treeDrained && status.streamsDrained
  }
}

export interface Executor {
  start(request: ExecutionProtocol.Request): Promise<ExecutionProtocol.Status>
  status(id: string): Promise<ExecutionProtocol.Status | undefined>
  output(id: string, after: number, limit: number): Promise<ExecutionProtocol.Chunk[]>
  stdin(id: string, data: Uint8Array, end?: boolean): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  cancel(id: string, digest: string): Promise<void>
  release(id: string): Promise<void>
}
