import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { PermissionNext } from "../permission/next"

const REFERENCE_EXTENSIONS = [".txt", ".md", ".mdx", ".json", ".yaml", ".yml"]
const REFERENCE_GLOB = new Bun.Glob("**/*")

function resolveMemoryReference(references: Record<string, string>, name: string) {
  if (references[name]) return references[name]
  const keys = Object.keys(references)
  const byBasename = keys.find((key) => path.basename(key) === name || path.basename(key) === path.basename(name))
  if (byBasename) return references[byBasename]
  const basename = path.basename(name.replace(/\.\w+$/, ""))
  const byStem = keys.find((key) => path.basename(key).replace(/\.\w+$/, "") === basename)
  return byStem ? references[byStem] : undefined
}

function isWithinDirectory(directory: string, candidate: string) {
  const relative = path.relative(directory, candidate)
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

async function resolveFileReference(directory: string, name: string) {
  const baseDir = await fs.realpath(directory).catch(() => undefined)
  if (!baseDir) return undefined
  const candidates = [path.resolve(baseDir, name)]
  if (!path.extname(name)) {
    for (const extension of REFERENCE_EXTENSIONS) candidates.push(path.resolve(baseDir, name + extension))
  }
  const basename = path.basename(name)
  if (!name.startsWith("references/") && !name.startsWith("references\\")) {
    candidates.push(path.resolve(baseDir, "references", basename))
    if (!path.extname(basename)) {
      for (const extension of REFERENCE_EXTENSIONS) {
        candidates.push(path.resolve(baseDir, "references", basename + extension))
      }
    }
  }

  for (const candidate of candidates) {
    if (!isWithinDirectory(baseDir, candidate)) continue
    const realCandidate = await fs.realpath(candidate).catch(() => undefined)
    if (!realCandidate || !isWithinDirectory(baseDir, realCandidate)) continue
    const file = Bun.file(realCandidate)
    if (await file.exists()) return file.text()
  }
  return undefined
}

async function referenceNames(skill: Skill.Info) {
  if (skill.backing.kind === "memory") return Object.keys(skill.backing.references ?? {})
  const referenceDir = path.join(skill.backing.baseDir, "references")
  const referenceStat = await fs.stat(referenceDir).catch(() => undefined)
  if (!referenceStat?.isDirectory()) return []
  const names: string[] = []
  for await (const file of REFERENCE_GLOB.scan({ cwd: referenceDir, absolute: false, onlyFiles: true })) {
    names.push(`references/${file.replace(/\\/g, "/")}`)
    if (names.length === 100) break
  }
  return names.sort()
}

function sourceAndScope(skill: Skill.Info) {
  if (skill.origin.kind === "filesystem") {
    return { source: skill.origin.source, scope: skill.origin.scope }
  }
  return { source: skill.origin.kind, scope: skill.origin.kind }
}

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
    const skills = (await Skill.all()).filter((skill) => skill.invocation.model)
    const agent = ctx?.agent
    const accessible = agent
      ? skills.filter((skill) => PermissionNext.evaluate("skill", skill.name, agent.permission).action !== "deny")
      : skills
    description =
      accessible.length === 0
        ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
        : [
            "Load a skill to get detailed instructions for a specific task.",
            "Skills provide specialized knowledge and step-by-step guidance.",
            "Use this when a task matches an available skill's description.",
            "<available_skills>",
            ...accessible.flatMap((skill) => [
              "  <skill>",
              `    <name>${skill.name}</name>`,
              `    <description>${skill.description}</description>`,
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
      let skill: Skill.Info | undefined
      try {
        skill = await Skill.get(params.name)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Skill "${params.name}" not found. Skills catalog is unavailable: ${message}`)
      }

      if (!skill) {
        const diagnostics = await Skill.diagnostics().catch(() => [])
        const relevant = diagnostics.filter(
          (diagnostic) => diagnostic.name === params.name || diagnostic.path?.includes(`/${params.name}/`),
        )
        const detail = relevant.length
          ? `\nRelated diagnostics:\n${relevant.map((diagnostic) => `  - [${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path ?? ""}: ${diagnostic.message}`).join("\n")}`
          : ""
        throw new Error(`Skill "${params.name}" not found.${detail}`)
      }
      if (!skill.invocation.model) throw new Error(`Skill "${params.name}" is not available for model invocation.`)

      await ctx.ask({ permission: "skill", patterns: [params.name], metadata: {} })

      if (params.reference) {
        const content =
          skill.backing.kind === "memory"
            ? resolveMemoryReference(skill.backing.references ?? {}, params.reference)
            : await resolveFileReference(skill.backing.baseDir, params.reference)
        if (!content) throw new Error(`Reference "${params.reference}" not found in skill "${params.name}".`)
        return {
          title: `Loaded reference: ${params.name}/${params.reference}`,
          output: content.trim(),
          metadata: {
            name: params.name,
            dir: skill.backing.kind === "file" ? skill.backing.baseDir : skill.origin.kind,
          },
        }
      }

      const { source, scope } = sourceAndScope(skill)
      const directory = skill.backing.kind === "file" ? skill.backing.baseDir : skill.origin.kind
      const parts = [
        `## Skill: ${skill.name}`,
        "",
        `**Source**: ${source}`,
        `**Scope**: ${scope}`,
        `**Compatibility**: ${Skill.runtimeCompatibility(skill)}`,
        `**Base directory**: ${directory}`,
      ]
      const references = await referenceNames(skill)
      if (references.length > 0) {
        parts.push(
          "",
          `**References** (load via \`skill(name: "${skill.name}", reference: "<name>")\`): ${references.join(", ")}`,
        )
      }
      const warnings = skill.diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
      if (warnings.length > 0) {
        parts.push("", "**Warnings**:", ...warnings.map((diagnostic) => `- ${diagnostic.message}`))
      }
      const unsupported = skill.diagnostics.filter((diagnostic) => diagnostic.code === "skill.vendor_field_unsupported")
      if (unsupported.length > 0) {
        parts.push("", "**Unsupported**:", ...unsupported.map((diagnostic) => `- ${diagnostic.message}`))
      }
      parts.push("", (await Skill.content(skill)).trim())
      return {
        title: `Loaded skill: ${skill.name}`,
        output: parts.join("\n"),
        metadata: { name: skill.name, dir: directory },
      }
    },
  }
})
