import z from "zod"

export namespace RuntimeSchema {
  export const ReloadTarget = z
    .enum([
      "config",
      "skill",
      "provider",
      "agent",
      "plugin",
      "mcp",
      "lsp",
      "formatter",
      "watcher",
      "channel",
      "holos",
      "command",
      "tool_registry",
      "all",
    ])
    .meta({ ref: "RuntimeReloadTarget" })
  export type ReloadTarget = z.infer<typeof ReloadTarget>

  export const ReloadScope = z.enum(["auto", "global", "project"]).meta({ ref: "RuntimeReloadScope" })
  export type ReloadScope = z.infer<typeof ReloadScope>

  export const ReloadResult = z
    .object({
      success: z.literal(true),
      requested: z.array(ReloadTarget),
      executed: z.array(ReloadTarget),
      cascaded: z.array(ReloadTarget),
      changedFields: z.array(z.string()),
      restartRequired: z.array(z.string()),
      liveApplied: z.array(z.string()),
      warnings: z.array(z.string()),
    })
    .meta({ ref: "RuntimeReloadResult" })
  export type ReloadResult = z.infer<typeof ReloadResult>
}
