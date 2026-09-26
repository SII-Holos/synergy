import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import z from "zod"
import { ConfigLspCatalog } from "@ericsanchezok/synergy-harness/config/lsp-catalog"
export const ConfigShape = {
  lsp: z
    .union([
      z.literal(false),
      z.record(
        z.string(),
        z.union([
          z.object({
            disabled: z.literal(true),
          }),
          z.object({
            command: z.array(z.string()).min(1).optional(),
            extensions: z.array(z.string()).optional(),
            disabled: z.boolean().optional(),
            env: z.record(z.string(), z.string()).optional(),
            initialization: z.record(z.string(), z.any()).optional(),
          }),
        ]),
      ),
    ])
    .optional()
    .refine(
      (data) => {
        if (!data) return true
        if (typeof data === "boolean") return true
        return Object.entries(data).every(([id, config]) => {
          if (config.disabled) return true
          if (ConfigLspCatalog.isKnownServer(id)) return !config.env || Boolean(config.command?.length)
          return Boolean(config.extensions && "command" in config && config.command?.length)
        })
      },
      {
        error: "Custom LSP servers require command and extensions; environment overrides require an explicit command.",
      },
    ),
  lspWriteDiagnostics: z
    .boolean()
    .optional()
    .describe("Include LSP diagnostics after file-writing tools complete (default: true)"),
  lspDiagnostics: z
    .object({
      severity: z.enum(["error", "warning"]).optional(),
      scope: z.enum(["delta", "file", "project"]).optional(),
    })
    .optional()
    .describe("Severity and scope policy for diagnostics returned after file-writing tools"),
  toolExposure: z
    .object({
      lsp: z.boolean().optional().describe("Expose the LSP tool; permission checks still apply (default: false)"),
    })
    .strict()
    .optional(),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

const contribution: ConfigExtensions.Contribution = {
  shape: ConfigShape,
  normalize(raw) {
    const result = raw as ConfigValues
    if (result.lspWriteDiagnostics === undefined) result.lspWriteDiagnostics = true
  },
}

export function registerConfig() {
  ConfigExtensions.register("lsp", contribution)
  ConfigDomain.register({
    id: "runtime",
    filename: "120-runtime.jsonc",
    label: "Runtime",
    ownedKeys: ["lsp", "lspWriteDiagnostics", "lspDiagnostics", "toolExposure"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "runtime",
    importable: true,
  })
}
export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
