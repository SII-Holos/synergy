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

  export const ReloadFailure = z
    .object({
      target: ReloadTarget,
      message: z.string(),
      code: z.string().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      phase: z.string().optional(),
      recoverable: z.boolean().optional(),
    })
    .meta({ ref: "RuntimeReloadFailure" })
  export type ReloadFailure = z.infer<typeof ReloadFailure>

  export const ReloadDiagnostic = z
    .object({
      target: ReloadTarget,
      severity: z.enum(["error", "warning", "info"]),
      message: z.string(),
      code: z.string().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      phase: z.string().optional(),
      source: z.string().optional(),
    })
    .meta({ ref: "RuntimeReloadDiagnostic" })
  export type ReloadDiagnostic = z.infer<typeof ReloadDiagnostic>

  export const ReloadResult = z
    .object({
      success: z.boolean(),
      requested: z.array(ReloadTarget),
      executed: z.array(ReloadTarget),
      cascaded: z.array(ReloadTarget),
      changedFields: z.array(z.string()),
      restartRequired: z.array(z.string()),
      liveApplied: z.array(z.string()),
      warnings: z.array(z.string()),
      failed: z.array(ReloadTarget),
      failures: z.array(ReloadFailure),
      diagnostics: z.array(ReloadDiagnostic),
    })
    .meta({ ref: "RuntimeReloadResult" })
  export type ReloadResult = z.infer<typeof ReloadResult>
}
