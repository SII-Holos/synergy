import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import z from "zod"
export const ExternalAgentConfig = z
  .object({
    disabled: z.boolean().optional().describe("Disable this external agent"),
    path: z.string().optional().describe("Override path to the external agent binary"),
    model: z.string().optional().describe("Default model for this external agent"),
    auto_discover: z.boolean().optional().describe("Whether to auto-discover this agent on startup (default: true)"),
  })
  .catchall(z.unknown())
  .meta({
    ref: "ExternalAgentConfig",
  })

export type ExternalAgentConfig = z.infer<typeof ExternalAgentConfig>

export const ConfigShape = {
  external_agent: z
    .record(z.string(), ExternalAgentConfig)
    .optional()
    .describe("External agent configurations (e.g. codex, claude-code)"),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

const contribution: ConfigExtensions.Contribution = {
  shape: ConfigShape,
  references(raw, providerID) {
    const config = raw as ConfigValues
    return Object.entries(config.external_agent ?? {}).flatMap(([id, agent]) =>
      agent.model?.startsWith(`${providerID}/`) ? [`external_agent.${id}.model`] : [],
    )
  },
}

export function registerConfig() {
  ConfigExtensions.register("external-agents", contribution)
  ConfigDomain.register({
    id: "agents",
    filename: "60-agents.jsonc",
    label: "Agents",
    ownedKeys: ["external_agent"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "agents",
    importable: true,
  })
}
export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
