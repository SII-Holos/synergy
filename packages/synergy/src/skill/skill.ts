import path from "path"
import { existsSync } from "fs"
import z from "zod"
import { Instance } from "../scope/instance"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { BUILTIN_SKILLS } from "./builtin"
import { SkillPaths } from "./paths"

export namespace Skill {
  const log = Log.create({ service: "skill" })

  export const Source = z.enum(["builtin", "synergy", "claude", "openclaw", "codex", "generic"])
  export type Source = z.infer<typeof Source>

  export const Scope = z.enum(["builtin", "project", "global", "workspace", "external"])
  export type Scope = z.infer<typeof Scope>

  export const Compatibility = z.object({
    level: z.enum(["native", "compatible", "partial"]),
    warnings: z.array(z.string()).default([]),
    unsupported: z.array(z.string()).default([]),
  })
  export type Compatibility = z.infer<typeof Compatibility>

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    builtin: z.boolean().optional(),
    source: Source.optional(),
    scope: Scope.optional(),
    entryFile: z.string().optional(),
    baseDir: z.string().optional(),
    content: z.string().optional(),
    references: z.record(z.string(), z.string()).optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    rawFrontmatter: z.record(z.string(), z.unknown()).optional(),
    compatibility: Compatibility.optional(),
  })
  export type Info = z.infer<typeof Info>

  export const Diagnostic = z.object({
    path: z.string(),
    name: z.string(),
    message: z.string(),
  })
  export type Diagnostic = z.infer<typeof Diagnostic>

  export const State = z.object({
    skills: z.record(z.string(), Info),
    diagnostics: z.array(Diagnostic),
  })
  export type State = z.infer<typeof State>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const SYNERGY_ENTRY_GLOBS = [new Bun.Glob("{skill,skills}/**/SKILL.md"), new Bun.Glob("{skill,skills}/**/Skill.md")]
  const CLAUDE_ENTRY_GLOBS = [new Bun.Glob("skills/**/SKILL.md"), new Bun.Glob("skills/**/Skill.md")]
  const DEEP_ENTRY_GLOBS = [new Bun.Glob("**/SKILL.md"), new Bun.Glob("**/Skill.md")]

  type SkillCandidate = {
    source: Source
    location: string
    scope: Scope
    priority: number
  }

  function sourcePriority(source: Source) {
    switch (source) {
      case "synergy":
        return 100
      case "openclaw":
        return 80
      case "claude":
        return 70
      case "codex":
        return 60
      case "generic":
        return 50
      case "builtin":
        return 0
    }
  }

  function scopePriority(scope: Scope) {
    switch (scope) {
      case "project":
        return 40
      case "workspace":
        return 35
      case "global":
        return 20
      case "external":
        return 10
      case "builtin":
        return 0
    }
  }

  function computePriority(source: Source, scope: Scope) {
    return scopePriority(scope) * 100 + sourcePriority(source)
  }

  function analyzeCompatibility(source: Source, frontmatter: Record<string, unknown>): Compatibility {
    if (source === "builtin" || source === "synergy") {
      return {
        level: "native",
        warnings: [],
        unsupported: [],
      }
    }

    const warnings: string[] = []
    const unsupported: string[] = []

    if (source === "claude") {
      if ("disable-model-invocation" in frontmatter) {
        warnings.push("Claude field disable-model-invocation is preserved but not enforced by Synergy.")
      }
      if ("user-invocable" in frontmatter) {
        warnings.push("Claude field user-invocable is preserved but not mapped to Synergy visibility yet.")
      }
      return {
        level: warnings.length > 0 ? "partial" : "compatible",
        warnings,
        unsupported,
      }
    }

    if (source === "openclaw") {
      const metadata = frontmatter.metadata
      const openclawMeta =
        metadata && typeof metadata === "object" && !Array.isArray(metadata) && "openclaw" in metadata
          ? (metadata as Record<string, unknown>).openclaw
          : undefined

      if (openclawMeta) {
        warnings.push("OpenClaw metadata is preserved for future compatibility handling.")
      }
      if ("command-dispatch" in frontmatter) {
        unsupported.push("OpenClaw command-dispatch is not implemented in Synergy.")
      }
      if ("command-tool" in frontmatter) {
        unsupported.push("OpenClaw command-tool is not implemented in Synergy.")
      }
      if ("disable-model-invocation" in frontmatter) {
        warnings.push("OpenClaw disable-model-invocation is preserved but not enforced by Synergy.")
      }
      if ("user-invocable" in frontmatter) {
        warnings.push("OpenClaw user-invocable is preserved but not mapped to Synergy visibility yet.")
      }
      return {
        level: warnings.length > 0 || unsupported.length > 0 ? "partial" : "compatible",
        warnings,
        unsupported,
      }
    }

    if (source === "codex") {
      warnings.push(
        "Codex-local skills are loaded as generic markdown skills; Codex-specific behavior is not interpreted.",
      )
      return {
        level: "partial",
        warnings,
        unsupported,
      }
    }

    return {
      level: "compatible",
      warnings,
      unsupported,
    }
  }

  async function* scanWithGlobs(cwd: string, globs: Bun.Glob[]) {
    for (const glob of globs) {
      for await (const match of glob.scan({
        cwd,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
        dot: true,
      })) {
        yield match
      }
    }
  }

  async function scanRoots(roots: string[], source: Source, scope: Scope, globs: Bun.Glob[]) {
    const candidates = [] as SkillCandidate[]
    const seen = new Set<string>()

    for (const root of roots) {
      try {
        for await (const match of scanWithGlobs(root, globs)) {
          const normalized = path.resolve(match)
          if (seen.has(normalized)) continue
          seen.add(normalized)
          candidates.push({
            source,
            location: normalized,
            scope,
            priority: computePriority(source, scope),
          })
        }
      } catch (error) {
        log.error("failed skill directory scan", { root, source, error })
      }
    }

    return candidates
  }

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    const priorities: Record<string, number> = {}
    const diagnostics: Diagnostic[] = []

    const recordDiagnostic = (input: { path: string; name?: string; message: string }) => {
      diagnostics.push({
        path: input.path,
        name: input.name ?? path.basename(path.dirname(input.path)),
        message: input.message,
      })
    }

    for (const builtin of BUILTIN_SKILLS) {
      skills[builtin.name] = {
        name: builtin.name,
        description: builtin.description,
        location: "builtin",
        builtin: true,
        source: "builtin",
        scope: "builtin",
        entryFile: "builtin",
        baseDir: "builtin",
        content: builtin.content,
        references: builtin.references,
        scripts: builtin.scripts,
        rawFrontmatter: {},
        compatibility: {
          level: "native",
          warnings: [],
          unsupported: [],
        },
      }
      priorities[builtin.name] = computePriority("builtin", "builtin")
    }

    const addCandidate = async (candidate: SkillCandidate) => {
      let md: Awaited<ReturnType<typeof ConfigMarkdown.parse>>
      try {
        md = await ConfigMarkdown.parse(candidate.location)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn("skipping invalid skill frontmatter", { path: candidate.location, error })
        recordDiagnostic({ path: candidate.location, message })
        return
      }

      if (!md) {
        return
      }

      const frontmatter = (md.data ?? {}) as Record<string, unknown>
      const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined
      const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined

      if (!name || !description) {
        const issues = [] as string[]
        if (!name) issues.push("Missing required skill field: name")
        if (!description) issues.push("Missing required skill field: description")
        const message = issues.join("; ") || "Invalid skill frontmatter"
        log.warn("skipping invalid skill metadata", { path: candidate.location, issues })
        recordDiagnostic({ path: candidate.location, message })
        return
      }

      const { source, scope, priority } = candidate
      const compatibility = analyzeCompatibility(source, frontmatter)
      const entry = {
        name,
        description,
        location: candidate.location,
        source,
        scope,
        entryFile: candidate.location,
        baseDir: path.dirname(candidate.location),
        rawFrontmatter: frontmatter,
        compatibility,
      } satisfies Info

      const existing = skills[name]
      const existingPriority = priorities[name] ?? -1
      if (existing && priority < existingPriority) {
        recordDiagnostic({
          path: candidate.location,
          name,
          message: `Duplicate skill name ignored due to lower precedence than ${existing.location}`,
        })
        return
      }

      if (existing) {
        const label = existing.builtin ? "builtin" : existing.location
        log.warn("duplicate skill name", {
          name,
          existing: existing.location,
          duplicate: candidate.location,
        })
        recordDiagnostic({
          path: candidate.location,
          name,
          message: `Duplicate skill name overrides ${label}`,
        })
      }

      skills[name] = entry
      priorities[name] = priority
    }

    const candidates = [] as SkillCandidate[]
    const home = Global.Path.home
    const dir = Instance.directory

    const existing = (dirs: string[]) => dirs.filter((d) => existsSync(d)).map((d) => path.resolve(d))

    // --- Global roots: only paths under ~, labeled "global" ---

    if (!Flag.SYNERGY_DISABLE_CLAUDE_CODE_SKILLS) {
      candidates.push(
        ...(await scanRoots(existing([path.join(home, ".claude")]), "claude", "global", CLAUDE_ENTRY_GLOBS)),
      )
    }

    candidates.push(...(await scanRoots(SkillPaths.synergyGlobalRoots(), "synergy", "global", SYNERGY_ENTRY_GLOBS)))
    candidates.push(
      ...(await scanRoots(
        existing([path.join(home, ".agents", "skills"), path.join(home, ".openclaw", "skills")]),
        "openclaw",
        "global",
        DEEP_ENTRY_GLOBS,
      )),
    )
    candidates.push(
      ...(await scanRoots(existing([path.join(home, ".codex", "skills")]), "codex", "global", DEEP_ENTRY_GLOBS)),
    )

    // --- Project roots: walk up from instanceDirectory, labeled with correct scope ---

    const projectRoots = await Array.fromAsync(
      Filesystem.up({
        targets: [".synergy", ".claude", ".codex", ".agents", "skills"],
        start: dir,
      }),
    )

    for (const root of projectRoots) {
      const normalized = path.resolve(root)
      if (normalized.endsWith(`${path.sep}.synergy`)) {
        candidates.push(...(await scanRoots([normalized], "synergy", "project", SYNERGY_ENTRY_GLOBS)))
      } else if (normalized.endsWith(`${path.sep}.claude`) && !Flag.SYNERGY_DISABLE_CLAUDE_CODE_SKILLS) {
        candidates.push(...(await scanRoots([normalized], "claude", "project", CLAUDE_ENTRY_GLOBS)))
      } else if (normalized.endsWith(`${path.sep}.codex`)) {
        candidates.push(...(await scanRoots([path.join(normalized, "skills")], "codex", "project", DEEP_ENTRY_GLOBS)))
      } else if (normalized.endsWith(`${path.sep}.agents`)) {
        candidates.push(
          ...(await scanRoots([path.join(normalized, "skills")], "openclaw", "project", DEEP_ENTRY_GLOBS)),
        )
      } else if (path.basename(normalized) === "skills") {
        candidates.push(...(await scanRoots([normalized], "openclaw", "workspace", DEEP_ENTRY_GLOBS)))
      }
    }

    const seenLocations = new Set<string>()
    const ordered = candidates
      .sort((left, right) => right.priority - left.priority || left.location.localeCompare(right.location))
      .filter((candidate) => {
        const normalized = path.resolve(candidate.location)
        if (seenLocations.has(normalized)) return false
        seenLocations.add(normalized)
        return true
      })

    for (const candidate of ordered) {
      await addCandidate(candidate)
    }

    return { skills, diagnostics }
  })

  export async function reload() {
    log.info("reloading skill state")
    await state.resetAll()
    log.info("skill state reloaded")
  }

  export async function diagnostics() {
    return state().then((x) => x.diagnostics)
  }

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }
}
