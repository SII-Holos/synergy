import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const GithubIdentitySync = z
  .object({
    enabled: z.boolean().optional().describe("Sync git user.name/user.email from the connected GitHub account"),
    name: z
      .string()
      .nullable()
      .optional()
      .describe("Optional git user.name override (defaults to the GitHub account login). null clears the override"),
    email: z
      .string()
      .nullable()
      .optional()
      .describe("Optional git user.email override (defaults to the GitHub noreply email). null clears the override"),
  })
  .strict()
  .meta({ ref: "GithubIdentitySyncConfig" })

export type GithubIdentitySync = z.infer<typeof GithubIdentitySync>

export const GithubWatch = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("Allow GitHub agenda triggers (PR/issue/workflow status polling). Default: true"),
    defaultIntervalMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default poll interval for GitHub agenda triggers in milliseconds (default 300000)"),
  })
  .strict()
  .meta({ ref: "GithubWatchConfig" })

export type GithubWatch = z.infer<typeof GithubWatch>

export const Github = z
  .object({
    identitySync: GithubIdentitySync.optional().describe("Git identity sync settings"),
    watch: GithubWatch.optional().describe("GitHub agenda trigger settings"),
  })
  .strict()
  .meta({ ref: "GithubConfig" })

export type Github = z.infer<typeof Github>

export const ConfigShape = { github: Github.optional() }
type ConfigShapeType = typeof ConfigShape
export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
const contribution: ConfigExtensions.Contribution = { shape: ConfigShape }
export function registerConfig() {
  ConfigExtensions.register("github", contribution)
  ConfigDomain.register({
    id: "github",
    filename: "115-github.jsonc",
    label: "Github",
    ownedKeys: ["github"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "github",
    importable: true,
  })
}
export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
