import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"

const REFERENCE_EXTENSIONS = [".txt", ".md", ".mdx", ".json", ".yaml", ".yml"]

/**
 * Resolve a built-in skill reference by key with fuzzy fallback.
 * Tries: exact match → basename match → basename without extension match.
 */
function resolveBuiltinReference(references: Record<string, string>, name: string): string | undefined {
  // 1. Exact match
  if (references[name]) return references[name]

  // 2. Try matching by basename (e.g., "providers.txt" matches "references/providers.txt")
  const keys = Object.keys(references)
  const byBasename = keys.find((k) => path.basename(k) === name || path.basename(k) === path.basename(name))
  if (byBasename) return references[byBasename]

  // 3. Try matching without extension (e.g., "providers" matches "references/providers.txt")
  const nameNoExt = name.replace(/\.\w+$/, "")
  const baseName = path.basename(nameNoExt)
  const byNoExt = keys.find((k) => {
    const kNoExt = path.basename(k).replace(/\.\w+$/, "")
    return kNoExt === baseName
  })
  if (byNoExt) return references[byNoExt]

  return undefined
}

/**
 * Resolve a user skill reference file with fuzzy fallback.
 * Tries: exact path → with common extensions → in references/ subdirectory.
 * All resolved paths are validated to stay within the skill directory.
 */
async function resolveUserReference(dir: string, name: string): Promise<string | undefined> {
  const candidates: string[] = []

  // 1. Exact path
  candidates.push(path.resolve(dir, name))

  // 2. Try with common extensions if no extension
  if (!path.extname(name)) {
    for (const ext of REFERENCE_EXTENSIONS) {
      candidates.push(path.resolve(dir, name + ext))
    }
  }

  // 3. Try in references/ subdirectory
  const basename = path.basename(name)
  if (!name.startsWith("references/") && !name.startsWith("references\\")) {
    candidates.push(path.resolve(dir, "references", basename))
    if (!path.extname(basename)) {
      for (const ext of REFERENCE_EXTENSIONS) {
        candidates.push(path.resolve(dir, "references", basename + ext))
      }
    }
  }

  for (const candidate of candidates) {
    // Security: ensure resolved path is within skill directory
    if (!candidate.startsWith(dir)) continue
    const file = Bun.file(candidate)
    if (await file.exists()) {
      return await file.text()
    }
  }

  return undefined
}

const parameters = z.object({
  name: z.string().describe("The skill identifier from available_skills (e.g., 'code-review' or 'category/helper')"),
  reference: z
    .string()
    .optional()
    .describe("Load a specific reference file instead of the main skill content (e.g., 'references/providers.txt')"),
})

export const SkillTool = Tool.define("skill", async (ctx) => {
  let fallbackDescription =
    "Load a skill to get detailed instructions for a specific task. Skills catalog is loading..."

  try {
    const skills = await Skill.all()

    // Filter skills by agent permissions if agent provided
    const agent = ctx?.agent
    const accessibleSkills = agent
      ? skills.filter((skill) => {
          const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
          return rule.action !== "deny"
        })
      : skills

    fallbackDescription =
      accessibleSkills.length === 0
        ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
        : [
            "Load a skill to get detailed instructions for a specific task.",
            "Skills provide specialized knowledge and step-by-step guidance.",
            "Use this when a task matches an available skill's description.",
            "<available_skills>",
            ...accessibleSkills.flatMap((skill) => [
              `  <skill>`,
              `    <name>${skill.name}</name>`,
              `    <description>${skill.description}</description>`,
              `  </skill>`,
            ]),
            "</available_skills>",
          ].join(" ")
  } catch (error) {
    // Catalog loading failed - continue with fallback description
    fallbackDescription =
      "Load a skill to get detailed instructions for a specific task. Skills catalog unavailable due to loading error."
  }

  const description = fallbackDescription

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Always try direct lookup first (uses cached state, won't re-scan)
      let skill: Skill.Info | undefined
      try {
        skill = await Skill.get(params.name)
      } catch {
        // Skill.get can throw if catalog loading failed, ignore and try fallback
      }

      if (!skill) {
        // Fallback: try to load what we can
        try {
          const skills = await Skill.all()
          skill = skills.find((s) => s.name === params.name)
          if (!skill) {
            const available = skills.map((s) => s.name).join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }
        } catch {
          throw new Error(`Skill "${params.name}" not found. Skills catalog is unavailable.`)
        }
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        metadata: {},
      })

      // Handle reference loading
      if (params.reference) {
        const refName = params.reference

        if (skill.references) {
          // In-memory references present (builtin or plugin): serve from memory
          // Plugin skills pre-load all references/ files at registration time (resolvePluginSkill),
          // so disk location is irrelevant — use the in-memory map.
          const content = resolveBuiltinReference(skill.references, refName)
          if (!content) {
            const available = Object.keys(skill.references).join(", ")
            throw new Error(
              `Reference "${refName}" not found in skill "${params.name}". Available: ${available || "none"}`,
            )
          }
          return {
            title: `Loaded reference: ${params.name}/${refName}`,
            output: content.trim(),
            metadata: {
              name: params.name,
              dir: skill.builtin ? "builtin" : (skill.baseDir ?? "builtin"),
            },
          }
        } else if (skill.location && skill.location.startsWith("/")) {
          // User skill: read reference from filesystem
          const dir = path.dirname(skill.location)
          const resolved = await resolveUserReference(dir, refName)

          if (!resolved) {
            throw new Error(`Reference "${refName}" not found in skill directory: ${dir}`)
          }

          return {
            title: `Loaded reference: ${params.name}/${refName}`,
            output: resolved.trim(),
            metadata: {
              name: params.name,
              dir,
            },
          }
        } else {
          throw new Error(`Skill "${params.name}" has no references`)
        }
      }

      let output: string
      let dir: string

      if (skill.content) {
        dir = skill.builtin ? "builtin" : (skill.baseDir ?? "builtin")
        const parts = [
          `## Skill: ${skill.name}`,
          "",
          skill.builtin ? `**Type**: Built-in skill` : `**Type**: Plugin skill`,
        ]
        if (skill.source) parts.push(`**Source**: ${skill.source}`)
        if (skill.scope) parts.push(`**Scope**: ${skill.scope}`)
        if (skill.compatibility) parts.push(`**Compatibility**: ${skill.compatibility.level}`)
        parts.push("")

        if (skill.references && Object.keys(skill.references).length > 0) {
          parts.push(
            `**References** (load via \`skill(name: "${skill.name}", reference: "<name>")\`): ${Object.keys(skill.references).join(", ")}`,
            "",
          )
        }

        if (skill.scripts && Object.keys(skill.scripts).length > 0) {
          parts.push(`**Available scripts**:`)
          for (const [name, scriptPath] of Object.entries(skill.scripts)) {
            parts.push(`- \`${name}\`: built-in helper (${scriptPath})`)
          }
          parts.push(
            "",
            "Built-in helper scripts are implementation details of the installed Synergy runtime.",
            "Do not assume repository source paths exist in user installs.",
            "If you need to create, validate, or package a skill, follow the workflow described in this skill and use normal filesystem tools plus Synergy's skill import/reload flow.",
            "",
          )
        }

        parts.push(skill.content.trim())
        output = parts.join("\n")
      } else {
        const parsed = await ConfigMarkdown.parse(skill.location)
        dir = path.dirname(skill.location)
        const parts = [
          `## Skill: ${skill.name}`,
          "",
          `**Source**: ${skill.source ?? "generic"}`,
          `**Scope**: ${skill.scope ?? "external"}`,
          `**Compatibility**: ${skill.compatibility?.level ?? "compatible"}`,
          `**Base directory**: ${dir}`,
        ]

        if (skill.compatibility?.warnings.length) {
          parts.push("", "**Warnings**:")
          for (const warning of skill.compatibility.warnings) {
            parts.push(`- ${warning}`)
          }
        }

        if (skill.compatibility?.unsupported.length) {
          parts.push("", "**Unsupported**:")
          for (const item of skill.compatibility.unsupported) {
            parts.push(`- ${item}`)
          }
        }

        parts.push("", parsed.content.trim())
        output = parts.join("\n")
      }

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})
