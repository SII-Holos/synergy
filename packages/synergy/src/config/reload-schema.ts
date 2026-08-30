/**
 * Pure zod schemas for the runtime reload pipeline, colocated with config so
 * L1 consumers (tool write paths, config import/setup, provider auth) can
 * classify and format reloads without importing the L4 orchestrator. Also
 * exports `formatCompactReloadResult`, the compact reload summary shared by
 * the write tools' auto-reload output.
 */
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
  export const ReloadInput = z.object({
    targets: z.array(ReloadTarget).min(1),
    scope: ReloadScope.optional(),
    force: z.boolean().optional(),
    reason: z.string().optional(),
  })
  export type ReloadInput = z.infer<typeof ReloadInput>
}

/** Format a compact summary of reload diagnostics suitable for auto-reload tool output. */
export function formatCompactReloadResult(result: RuntimeSchema.ReloadResult): string {
  const lines: string[] = [
    `Runtime reload applied`,
    `<runtime_reload>`,
    `targets=${result.requested.join(",")}`,
    `executed=${result.executed.join(",")}`,
  ]
  if (result.failed.length > 0) {
    lines.push(`failed=${result.failed.join(",")}`)
  }
  lines.push(`</runtime_reload>`)

  if (result.failures.length > 0) {
    for (const f of result.failures) {
      lines.push(`  - [failure] ${f.target} ${f.code ?? "unknown"}: ${f.message}`)
    }
  }
  const maxDiagnostics = 5
  if (result.diagnostics.length > 0) {
    const shown = result.diagnostics.slice(0, maxDiagnostics)
    for (const d of shown) {
      const loc = d.name ? ` ${d.name}` : d.path ? ` at ${d.path}` : ""
      lines.push(`  - [${d.severity}] ${d.target}${d.code ? ` ${d.code}` : ""}${loc}: ${d.message}`)
    }
    if (result.diagnostics.length > maxDiagnostics) {
      lines.push(`  ... and ${result.diagnostics.length - maxDiagnostics} more diagnostics in metadata.runtimeReload`)
    }
  }

  return lines.join("\n")
}
