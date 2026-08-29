import { z } from "zod"
import { InstructionRegistry } from "../instruction/registry"
import { PermissionNext } from "../permission/next"
import { Tool } from "./tool"

const parameters = z.object({
  name: z.string().describe("The skill identifier from available_skills (e.g., 'code-review' or 'category/helper')"),
  reference: z
    .string()
    .optional()
    .describe("Load a specific reference file instead of the main skill content (e.g., 'references/providers.txt')"),
})

export const SkillTool = Tool.define("skill", async (ctx) => {
  let description = "Load a skill to get detailed instructions for a specific task. Skills catalog is loading..."
  try {
    const entries = (await InstructionRegistry.get("skill")?.entries?.())?.filter((entry) => entry.model) ?? []
    const agent = ctx?.agent
    const accessible = agent
      ? entries.filter((entry) => PermissionNext.evaluate("skill", entry.name, agent.permission).action !== "deny")
      : entries
    description =
      accessible.length === 0
        ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
        : [
            "Load a skill to get detailed instructions for a specific task.",
            "Skills provide specialized knowledge and step-by-step guidance.",
            "Use this when a task matches an available skill's description.",
            "<available_skills>",
            ...accessible.flatMap((entry) => [
              "  <skill>",
              `    <name>${entry.name}</name>`,
              `    <description>${entry.description}</description>`,
              "  </skill>",
            ]),
            "</available_skills>",
          ].join(" ")
  } catch {
    description =
      "Load a skill to get detailed instructions for a specific task. Skills catalog unavailable due to loading error."
  }

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const source = InstructionRegistry.get("skill")
      if (!source?.entry) {
        throw new Error(`Skill "${params.name}" not found. Skills catalog is unavailable.`)
      }
      let entry
      try {
        entry = await source.entry(params.name)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Skill "${params.name}" not found. Skills catalog is unavailable: ${message}`)
      }

      if (!entry) {
        const diagnostics = (await source.diagnostics?.().catch(() => [])) ?? []
        const relevant = diagnostics.filter(
          (diagnostic) => diagnostic.name === params.name || diagnostic.path?.includes(`/${params.name}/`),
        )
        const detail = relevant.length
          ? `\nRelated diagnostics:\n${relevant.map((diagnostic) => `  - [${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path ?? ""}: ${diagnostic.message}`).join("\n")}`
          : ""
        throw new Error(`Skill "${params.name}" not found.${detail}`)
      }
      if (!entry.model) throw new Error(`Skill "${params.name}" is not available for model invocation.`)

      await ctx.ask({ permission: "skill", patterns: [params.name], metadata: {} })

      if (params.reference) {
        const content = await entry.reference(params.reference)
        if (!content) throw new Error(`Reference "${params.reference}" not found in skill "${params.name}".`)
        return {
          title: `Loaded reference: ${params.name}/${params.reference}`,
          output: content.trim(),
          metadata: { name: params.name, dir: entry.directory },
        }
      }

      const parts = [
        `## Skill: ${entry.name}`,
        "",
        `**Source**: ${entry.source}`,
        `**Scope**: ${entry.scope}`,
        `**Compatibility**: ${entry.compatibility}`,
        `**Base directory**: ${entry.directory}`,
      ]
      const references = await entry.references()
      if (references.length > 0) {
        parts.push(
          "",
          `**References** (load via \`skill(name: "${entry.name}", reference: "<name>")\`): ${references.join(", ")}`,
        )
      }
      if (entry.warnings.length > 0) {
        parts.push("", "**Warnings**:", ...entry.warnings.map((warning) => `- ${warning}`))
      }
      if (entry.unsupported.length > 0) {
        parts.push("", "**Unsupported**:", ...entry.unsupported.map((item) => `- ${item}`))
      }
      parts.push("", (await entry.content()).trim())
      return {
        title: `Loaded skill: ${entry.name}`,
        output: parts.join("\n"),
        metadata: { name: entry.name, dir: entry.directory },
      }
    },
  }
})
