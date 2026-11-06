import { LegacyExecutionConfig } from "@ericsanchezok/synergy-harness/config/legacy-execution"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import "./session-schema"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import z from "zod"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"

export const ConfigShape = {
  boss: z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe(
          "Enable Runtime Boss Mode: auto-provision a home-scope runtime boss session and route all Feishu messages to it",
        ),
      identityText: z
        .string()
        .nullable()
        .optional()
        .describe("Optional colleague identity description injected into the runtime boss session"),
      briefingIntervalDays: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Re-inject the versioned world-overview briefing every N days (default: disabled)"),
      persona: z
        .discriminatedUnion("preset", [
          z.object({
            preset: z.literal("project_manager"),
          }),
          z.object({
            preset: z.literal("ops_assistant"),
          }),
          z.object({
            preset: z.literal("custom"),
            formality: z.number().min(0).max(1),
            conciseness: z.number().min(0).max(1),
            proactiveness: z.number().min(0).max(1),
            warmth: z.number().min(0).max(1),
          }),
        ])
        .nullable()
        .optional()
        .describe(
          "Colleague persona preset for the runtime boss: a built-in personality (project_manager or ops_assistant) or a custom blend of four 0..1 traits. Pass null to clear. When unset, identityText (legacy) or the default colleague identity is used.",
        ),
    })
    .strict()
    .optional(),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

const contribution: ConfigExtensions.Contribution = { shape: ConfigShape }

const configMigrations: Migration[] = [
  {
    id: "20261012-boss-execution-config-owner",
    configuration: "files",
    description: "Restore retained Boss execution settings when its owner is installed",
    scope: "global",
    execution: "startup",
    upgradeConfig: LegacyExecutionConfig.upgradeConfig,
    up: LegacyExecutionConfig.up,
  },
]

export function registerConfig() {
  MigrationRegistry.register("boss-config", configMigrations)
  ConfigExtensions.register("boss", contribution)
  for (const domain of [
    {
      id: "runtime",
      filename: "120-runtime.jsonc",
      label: "Runtime",
      ownedKeys: ["boss"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "runtime",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
