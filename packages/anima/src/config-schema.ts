import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"

export const ConfigShape = {
  anima: z
    .object({
      enabled: z.boolean().optional().describe("Enable Anima daily journal routines (default: true)"),
    })
    .strict()
    .optional(),
}

type ConfigShapeType = typeof ConfigShape
export type ConfigValues = z.output<z.ZodObject<ConfigShapeType>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}

const contribution: ConfigExtensions.Contribution = { shape: ConfigShape }

export function registerConfig() {
  ConfigExtensions.register("anima", contribution)
  ConfigDomain.register({
    id: "anima",
    filename: "35-anima.jsonc",
    label: "Anima",
    ownedKeys: ["anima"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "anima",
    importable: true,
  })
}

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config")
  return Config.current()
}
