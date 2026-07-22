import { z } from "zod"
import { Skill } from "./skill"

export namespace SkillSummary {
  export const Scope = z.enum(["builtin", "project", "global", "workspace", "external"])
  export const Compatibility = z.object({
    level: z.enum(["native", "compatible", "partial"]),
    warnings: z.array(z.string()),
    unsupported: z.array(z.string()),
  })
  export const Info = z
    .object({
      name: z.string(),
      description: z.string(),
      location: z.string(),
      builtin: z.boolean().optional(),
      source: z.enum(["builtin", "plugin", "synergy", "agents", "claude", "codex", "openclaw"]),
      scope: Scope,
      compatibility: Compatibility,
      declaredCompatibility: z.string().optional(),
      invocation: z.object({ user: z.boolean(), model: z.boolean() }),
      exportable: z.boolean(),
      diagnostics: Skill.Diagnostic.array(),
      entryFile: z.string().optional(),
      baseDir: z.string().optional(),
      pluginId: z.string().optional(),
    })
    .meta({ ref: "SkillSummary" })
  export type Info = z.infer<typeof Info>

  export const List = z
    .object({
      items: z.array(Info),
      diagnostics: Skill.Diagnostic.array(),
    })
    .meta({ ref: "SkillList" })

  export function from(skill: Skill.Info): Info {
    const warnings = skill.diagnostics
      .filter((diagnostic) => diagnostic.severity === "warning")
      .map((diagnostic) => diagnostic.message)
    const unsupported = skill.diagnostics
      .filter((diagnostic) => diagnostic.code === "skill.vendor_field_unsupported")
      .map((diagnostic) => diagnostic.message)
    return {
      name: skill.name,
      description: skill.description,
      location: skill.backing.kind === "file" ? skill.backing.entryFile : skill.origin.kind,
      builtin: skill.origin.kind === "builtin" || undefined,
      source: skill.origin.kind === "filesystem" ? skill.origin.source : skill.origin.kind,
      scope:
        skill.origin.kind === "filesystem"
          ? skill.origin.scope
          : skill.origin.kind === "plugin"
            ? "external"
            : "builtin",
      compatibility: {
        level: Skill.runtimeCompatibility(skill),
        warnings,
        unsupported,
      },
      declaredCompatibility: skill.declaredCompatibility,
      invocation: skill.invocation,
      exportable: Skill.isExportable(skill),
      diagnostics: skill.diagnostics,
      entryFile: skill.backing.kind === "file" ? skill.backing.entryFile : undefined,
      baseDir: skill.backing.kind === "file" ? skill.backing.baseDir : undefined,
      pluginId: skill.origin.kind === "plugin" ? skill.origin.pluginID : undefined,
    }
  }
}
