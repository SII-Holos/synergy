import z from "zod"
import { MetaProtocolEnv } from "./env"

export namespace MetaProtocolHost {
  export const Shell = z.enum(["none", "sh", "cmd", "powershell", "pwsh"])
  export type Shell = z.infer<typeof Shell>

  export const Runtime = z.enum(["node", "bun", "unknown"])
  export type Runtime = z.infer<typeof Runtime>

  export const Capabilities = z.object({
    platform: z.string(),
    arch: z.string(),
    hostname: z.string().optional(),
    runtime: Runtime,
    defaultShell: Shell,
    supportedShells: z.array(Shell),
    supportsPty: z.boolean(),
    supportsSendKeys: z.boolean(),
    supportsSoftKill: z.boolean(),
    supportsProcessGroups: z.boolean(),
    envCaseInsensitive: z.boolean(),
    lineEndings: z.enum(["lf", "crlf"]),
  })
  export type Capabilities = z.infer<typeof Capabilities>

  export const Hello = z.object({
    type: z.literal("host.hello"),
    envID: MetaProtocolEnv.EnvID,
    hostSessionID: MetaProtocolEnv.HostSessionID,
    capabilities: Capabilities,
  })
  export type Hello = z.infer<typeof Hello>
}
