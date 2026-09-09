import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import z from "zod"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const SkillsCompatibility = z
  .object({
    agents: z.boolean().optional().describe("Load Agent Skills from .agents/skills directories (default: true)"),
    claude: z.boolean().optional().describe("Load Claude Code Skills from .claude/skills directories (default: true)"),
    codex: z.boolean().optional().describe("Load Codex Skills from .codex/skills directories (default: true)"),
    openclaw: z
      .boolean()
      .optional()
      .describe("Load OpenClaw Skills from .openclaw/skills and workspace skills directories (default: true)"),
  })
  .strict()
  .meta({ ref: "SkillsCompatibilityConfig" })

export type SkillsCompatibility = z.infer<typeof SkillsCompatibility>

export const SkillsConfig = z
  .object({
    compatibility: SkillsCompatibility.optional().describe(
      "Per-source compatibility toggles for discovering Skills from other agent tools",
    ),
  })
  .strict()
  .optional()
  .meta({ ref: "SkillsConfig" })

export type SkillsConfig = z.infer<typeof SkillsConfig>

export const ConfigShape = {
  skills: SkillsConfig,
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

export function registerConfig() {
  ConfigExtensions.register("runtime-local", { shape: ConfigShape })
  for (const domain of [
    {
      id: "skills",
      filename: "55-skills.jsonc",
      label: "Skills",
      ownedKeys: ["skills"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "skills",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}
registerConfig()

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
