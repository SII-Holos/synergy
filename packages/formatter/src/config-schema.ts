import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import z from "zod"
export const ConfigShape = {
  formatter: z
    .union([
      z.literal(false),
      z.record(
        z.string(),
        z.object({
          disabled: z.boolean().optional(),
          command: z.array(z.string()).optional(),
          environment: z.record(z.string(), z.string()).optional(),
          extensions: z.array(z.string()).optional(),
        }),
      ),
    ])
    .optional(),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

const contribution: ConfigExtensions.Contribution = {
  shape: ConfigShape,
}

export function registerConfig() {
  ConfigExtensions.register("formatter", contribution)
  ConfigDomain.register({
    id: "runtime",
    filename: "120-runtime.jsonc",
    label: "Runtime",
    ownedKeys: ["formatter"],
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
