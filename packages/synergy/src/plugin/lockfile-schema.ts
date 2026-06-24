import z from "zod"

export const PluginLockEntry = z
  .object({
    spec: z.string(),
    version: z.string(),
    resolved: z.string(),
    integrity: z.string().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    signature: z.object({ algorithm: z.string(), signature: z.string(), signer: z.string() }).optional(),
    permissionsHash: z.string().optional(),
    manifestHash: z.string().optional(),
    approvalId: z.string().optional(),
    runtimeMode: z.enum(["in-process", "worker", "process"]).optional(),
  })
  .strict()

export const PluginLockfile = z
  .object({
    version: z.literal(1),
    plugins: z.record(z.string(), PluginLockEntry),
  })
  .strict()

export type PluginLockEntry = z.infer<typeof PluginLockEntry>
export type PluginLockfile = z.infer<typeof PluginLockfile>
