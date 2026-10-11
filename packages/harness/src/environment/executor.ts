import { createHash } from "node:crypto"
import { z } from "zod"
import { EnvironmentSchema } from "./schema"
import { WorkspaceProtocol, type WorkspaceFileHost } from "../workspace/protocol"
import { WorkspaceTree } from "../workspace/tree"
import { WorkspaceErrors } from "../workspace/errors"

export namespace ExecutionProtocol {
  export const version = 2
  export const Description = z
    .object({
      target: EnvironmentSchema.Target,
      platform: z.enum([
        "aix",
        "android",
        "darwin",
        "freebsd",
        "haiku",
        "linux",
        "openbsd",
        "sunos",
        "win32",
        "cygwin",
        "netbsd",
      ]),
      arch: z.string(),
      shell: z.string().min(1),
      directory: z.string().min(1),
      env: z.record(z.string(), z.string()),
    })
    .meta({ ref: "ExecutorDescription" })
  export type Description = z.infer<typeof Description>
  export const SandboxInput = z
    .object({
      command: z.string(),
      args: z.array(z.string()),
      workspace: z.string().min(1),
      originalCheckout: z.string().optional(),
      executionCwd: z.string().optional(),
      sandboxMode: z.enum(["none", "read_only", "workspace_write"]),
      backend: z.string().optional(),
      runtimeReadRoots: z.array(z.string()).optional(),
      extraReadRoots: z.array(z.string()).optional(),
      writableRoots: z.array(z.string()).optional(),
      extraWritableRoots: z.array(z.string()).optional(),
      protectedPaths: z.array(z.string()).optional(),
      dataDenyRoots: z.array(z.string()).optional(),
      stripDefaultHomeDenyRoot: z.boolean().optional(),
      networkMode: z.enum(["full", "restricted", "proxy_only"]).optional(),
    })
    .strict()
  export type SandboxInput = z.infer<typeof SandboxInput>
  export const Sandbox = z.object({
    id: z.string().uuid(),
    command: z.string(),
    args: z.array(z.string()),
    sandboxed: z.boolean(),
    skipReason: z.string().optional(),
    writeFootprint: z
      .union([
        z.object({ kind: z.literal("roots"), roots: z.array(z.string()) }),
        z.object({ kind: z.literal("host") }),
      ])
      .optional(),
  })
  export type Sandbox = z.infer<typeof Sandbox>
  export const ID = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]*$/)
  export const Inputs = z
    .object({
      id: ID,
      files: z
        .array(
          z
            .object({
              name: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/),
              data: z.string().max(12_000_000),
            })
            .strict(),
        )
        .max(16),
    })
    .strict()
  export type Inputs = z.infer<typeof Inputs>
  export const PreparedInputs = z.object({ paths: z.record(z.string(), z.string()), digest: z.string().length(64) })
  export type PreparedInputs = z.infer<typeof PreparedInputs>
  export const Command = z
    .object({
      command: z.string().min(1).max(32768),
      args: z.array(z.string().max(1_048_576)).max(4096),
      cwd: z.string().min(1),
      env: z.record(z.string(), z.string()).default({}),
      useRoots: z.array(z.string()),
      mutationRoots: z.array(z.string()).optional(),
      pty: z.object({ cols: z.number().int().min(1).max(65535), rows: z.number().int().min(1).max(65535) }).optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      sandboxID: z.string().uuid().optional(),
      cooperative: z.boolean().optional(),
      preconditions: z
        .array(
          z
            .object({
              path: z.string().min(1),
              canonical: z.string().min(1),
              version: z
                .string()
                .regex(/^sha256:[a-f0-9]{64}$/)
                .nullable(),
            })
            .strict(),
        )
        .max(1000)
        .optional(),
      capture: z.array(WorkspaceProtocol.Reference).max(1000).optional(),
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
      failure: WorkspaceErrors.Failure.optional(),
      outputTruncated: z.boolean().optional(),
      effectsStarted: z.boolean().optional(),
      contended: z.boolean().optional(),
      before: z.array(WorkspaceProtocol.Reference.extend({ manifest: WorkspaceTree.Hash })).optional(),
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

  export function shellArgs(shell: string, platform: string, command: string): string[] {
    const name = shell.split(/[\\/]/).at(-1)?.toLowerCase()
    if (platform === "win32" && ["cmd", "cmd.exe"].includes(name ?? "")) return ["/d", "/s", "/c", `"${command}"`]
    if (platform === "win32" && ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name ?? ""))
      return ["-NoProfile", "-Command", command]
    return ["-c", command]
  }
}

export interface Executor {
  prepareInputs?(input: ExecutionProtocol.Inputs): Promise<ExecutionProtocol.PreparedInputs>
  discardInputs?(id: string): Promise<void>
  prepareSandbox?(input: ExecutionProtocol.SandboxInput): Promise<ExecutionProtocol.Sandbox>
  releaseSandbox?(id: string): Promise<void>
  /** Direct native adapters only; remote process IDs must never become controller OS identities. */
  localPID?(id: string): number | undefined
  describe?(): Promise<ExecutionProtocol.Description>
  readonly files?: WorkspaceFileHost
  start(request: ExecutionProtocol.Request): Promise<ExecutionProtocol.Status>
  status(id: string): Promise<ExecutionProtocol.Status | undefined>
  output(id: string, after: number, limit: number): Promise<ExecutionProtocol.Chunk[]>
  stdin(id: string, data: Uint8Array, end?: boolean): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  cancel(id: string, digest: string): Promise<void>
  release(id: string): Promise<void>
}
