import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./runtime-reload.txt"
import { RuntimeReload } from "../runtime/reload"
import { RuntimeSchema } from "../runtime/schema"

const parameters = z.object({
  target: z
    .union([RuntimeSchema.ReloadTarget, z.array(RuntimeSchema.ReloadTarget).min(1)])
    .describe("One target or an array of targets to reload"),
  scope: RuntimeSchema.ReloadScope.optional().describe("Config reload scope. Defaults to auto"),
  force: z.boolean().optional().describe("Reserved for future expansion"),
  reason: z.string().optional().describe("Optional short note about why the reload is happening"),
})

export const RuntimeReloadTool = Tool.define<typeof parameters, RuntimeSchema.ReloadResult>("runtime_reload", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const targets = Array.isArray(params.target) ? params.target : [params.target]
    const result = await RuntimeReload.reload({
      targets,
      scope: params.scope,
      force: params.force,
      reason: params.reason,
    })

    const lines = [
      "Runtime reload completed.",
      "",
      `Requested: ${result.requested.join(", ")}`,
      `Executed: ${result.executed.join(", ") || "none"}`,
    ]

    if (result.cascaded.length > 0) lines.push(`Cascaded: ${result.cascaded.join(", ")}`)
    if (result.failed.length > 0) lines.push(`Failed: ${result.failed.join(", ")}`)
    if (result.changedFields.length > 0) lines.push(`Changed fields: ${result.changedFields.join(", ")}`)
    if (result.liveApplied.length > 0) lines.push(`Live applied: ${result.liveApplied.join(", ")}`)
    if (result.restartRequired.length > 0) lines.push(`Restart required: ${result.restartRequired.join(", ")}`)

    if (result.failures.length > 0) {
      lines.push("")
      lines.push("Failures:")
      for (const f of result.failures) {
        const details = [f.code, f.name, f.path, f.phase].filter(Boolean).join(" ")
        lines.push(`  - ${f.target}${details ? ` ${details}` : ""}: ${f.message}`)
      }
    }

    const maxDiagnostics = 20
    if (result.diagnostics.length > 0) {
      lines.push("")
      lines.push("Diagnostics:")
      const shown = result.diagnostics.slice(0, maxDiagnostics)
      for (const d of shown) {
        const loc = d.name ? ` ${d.name}` : d.path ? ` at ${d.path}` : ""
        lines.push(`  - [${d.severity}] ${d.target}${d.code ? ` ${d.code}` : ""}${loc}: ${d.message}`)
      }
      if (result.diagnostics.length > maxDiagnostics) {
        lines.push(`  ... and ${result.diagnostics.length - maxDiagnostics} more diagnostics in metadata.diagnostics`)
      }
    }

    if (result.warnings.length > 0) lines.push(`\nWarnings: ${result.warnings.join(" | ")}`)

    return {
      title: "runtime_reload",
      output: lines.join("\n"),
      metadata: result,
    }
  },
})
