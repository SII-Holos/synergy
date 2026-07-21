import z from "zod"

export const PluginLockEntry = z
  .object({
    spec: z.string(),
    source: z.enum(["local", "official", "npm", "git", "url", "builtin"]),
    version: z.string(),
    apiVersion: z.string(),
    generation: z.string(),
    resolved: z.string(),
    integrity: z.string().optional(),
    manifestHash: z.string(),
    approvalId: z.string().optional(),
  })
  .strict()

export const PluginLockfile = z
  .object({
    version: z.literal(2),
    plugins: z.record(z.string(), PluginLockEntry),
  })
  .strict()

export type PluginLockEntry = z.infer<typeof PluginLockEntry>
export type PluginLockfile = z.infer<typeof PluginLockfile>
