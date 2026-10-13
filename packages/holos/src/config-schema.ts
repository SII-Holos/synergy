import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const Holos = z
  .object({
    enabled: z.boolean().optional().default(true).describe("Enable the Holos runtime connection"),
    apiUrl: z.string().optional().default("https://api.holosai.io").describe("Holos API base URL"),
    wsUrl: z.string().optional().default("wss://api.holosai.io").describe("Holos WebSocket base URL"),
    portalUrl: z
      .string()
      .optional()
      .default("https://www.holosai.io")
      .describe("Holos portal URL for browser-facing pages (bind/start)"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const checks: Array<{ path: string; url?: string; kind: "api" | "ws" | "portal" }> = [
      { path: "apiUrl", url: value.apiUrl, kind: "api" },
      { path: "wsUrl", url: value.wsUrl, kind: "ws" },
      { path: "portalUrl", url: value.portalUrl, kind: "portal" },
    ]
    for (const check of checks) {
      if (!check.url) continue
      try {
        if (check.kind === "portal") validateHolosPortalUrl(check.url)
        else validateHolosEndpoint(check.url, check.kind)
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [check.path],
          message: error instanceof Error ? error.message : `Invalid Holos ${check.kind} URL`,
        })
      }
    }
  })
  .meta({ ref: "HolosConfig" })

export type Holos = z.infer<typeof Holos>

import { validateHolosEndpoint, validateHolosPortalUrl } from "@ericsanchezok/synergy-holos/holos/util"
export const ConfigShape = { holos: Holos.optional(), enterprise: z.object({ url: z.string().optional() }).optional() }
type ConfigShapeType = typeof ConfigShape
export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
const contribution: ConfigExtensions.Contribution = { shape: ConfigShape }
export function registerConfig() {
  ConfigExtensions.register("holos", contribution)
  ConfigDomain.register({
    id: "holos",
    filename: "100-holos.jsonc",
    label: "Holos",
    ownedKeys: ["holos", "enterprise"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "holos",
    importable: true,
  })
}
export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
