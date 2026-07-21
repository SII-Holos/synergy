import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Log } from "../util/log"
import { BUILTIN_SKILLS } from "./builtin"
import { ConfigMarkdown } from "../config/markdown"
import { Plugin } from "../plugin"
import { SkillManifest } from "./manifest"
import { SkillSourceProfile } from "./source-profile"

export namespace Skill {
  const log = Log.create({ service: "skill" })

  export const Source = z.enum(["synergy", "agents", "claude", "codex", "openclaw"])
  export type Source = z.infer<typeof Source>

  export const Scope = z.enum(["project", "workspace", "global"])
  export type Scope = z.infer<typeof Scope>

  export const Diagnostic = SkillManifest.Diagnostic
  export type Diagnostic = SkillManifest.Diagnostic

  export const Origin = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("builtin") }),
    z.object({
      kind: z.literal("plugin"),
      pluginID: z.string(),
      contributionID: z.string(),
    }),
    z.object({
      kind: z.literal("filesystem"),
      source: Source,
      scope: Scope,
    }),
  ])
  export type Origin = z.infer<typeof Origin>

  export const Backing = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("file"),
      baseDir: z.string(),
      entryFile: z.string(),
    }),
    z.object({
      kind: z.literal("memory"),
      content: z.string(),
      references: z.record(z.string(), z.string()).optional(),
    }),
  ])
  export type Backing = z.infer<typeof Backing>

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    declaredLicense: z.string().optional(),
    declaredCompatibility: z.string().optional(),
    invocation: z.object({ user: z.boolean(), model: z.boolean() }),
    origin: Origin,
    backing: Backing,
    diagnostics: Diagnostic.array(),
  })
  export type Info = z.infer<typeof Info>

  export const Manifest = SkillManifest.Schema

  export const State = z.object({
    skills: z.record(z.string(), Info),
    diagnostics: Diagnostic.array(),
  })
  export type State = z.infer<typeof State>

  type FilesystemCandidate = {
    kind: "filesystem"
    entryFile: string
    baseDir: string
    source: Source
    scope: Scope
    validation: SkillSourceProfile.ValidationMode
    normalizationShim?: SkillSourceProfile.NormalizationShim
    rank: readonly [number, number, number, string]
  }

  type ProgrammaticCandidate = {
    kind: "programmatic"
    info: Info
    rank: readonly [number, number, number, string]
  }

  type Candidate = FilesystemCandidate | ProgrammaticCandidate

  const ENTRY_GLOB = new Bun.Glob("**/{SKILL.md,Skill.md}")
  const PROGRAMMATIC_SCOPE_RANK = 10
  const PLUGIN_SOURCE_RANK = 90
  const BUILTIN_SCOPE_RANK = 0

  function compareRanks(left: Candidate, right: Candidate) {
    for (let index = 0; index < left.rank.length; index++) {
      const leftPart = left.rank[index]!
      const rightPart = right.rank[index]!
      if (typeof leftPart === "number" && typeof rightPart === "number") {
        if (leftPart !== rightPart) return rightPart - leftPart
      } else {
        const compared = String(leftPart).localeCompare(String(rightPart))
        if (compared !== 0) return compared
      }
    }
    return 0
  }

  function candidatePath(candidate: Candidate) {
    if (candidate.kind === "filesystem") return candidate.entryFile
    if (candidate.info.origin.kind === "plugin") {
      return `plugin:${candidate.info.origin.pluginID}:${candidate.info.origin.contributionID}`
    }
    return `builtin:${candidate.info.name}`
  }

  function candidateSource(candidate: Candidate): Diagnostic["source"] {
    if (candidate.kind === "filesystem") return candidate.source
    if (candidate.info.origin.kind === "plugin") return "plugin"
    return "builtin"
  }

  function collisionDiagnostic(input: { winner: Candidate; shadowed: Candidate; name: string }): Diagnostic {
    const winner = candidatePath(input.winner)
    const shadowed = candidatePath(input.shadowed)
    return {
      code: "skill.candidate_shadowed",
      severity: "warning",
      name: input.name,
      source: candidateSource(input.shadowed),
      path: shadowed,
      reason: {
        kind: "precedence",
        winner,
        shadowed,
        winnerRank: [...input.winner.rank],
        shadowedRank: [...input.shadowed.rank],
      },
      message: `Skill candidate ${shadowed} is shadowed by ${winner}`,
    }
  }

  async function scanFilesystemCandidates() {
    const candidates = new Map<string, FilesystemCandidate>()

    for (const root of SkillSourceProfile.existingRoots(ScopeContext.current.directory)) {
      try {
        for await (const match of ENTRY_GLOB.scan({
          cwd: root.path,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        })) {
          if (!root.acceptedEntryNames.includes(path.basename(match))) continue
          const entryFile = await fs.realpath(match)
          const candidate: FilesystemCandidate = {
            kind: "filesystem",
            entryFile,
            baseDir: path.dirname(entryFile),
            source: root.source,
            scope: root.scope,
            validation: root.validation,
            normalizationShim: root.normalizationShim,
            rank: [root.scopeRank, root.sourceRank, root.rootRank, entryFile],
          }
          const existing = candidates.get(entryFile)
          if (!existing || compareRanks(candidate, existing) < 0) candidates.set(entryFile, candidate)
        }
      } catch (error) {
        log.error("failed skill directory scan", { root: root.path, source: root.source, error })
      }
    }

    return [...candidates.values()]
  }

  function programmaticInfo(input: {
    name: string
    description: string
    backing: Info["backing"]
    origin: Info["origin"]
  }) {
    const source = input.origin.kind === "builtin" ? "builtin" : "plugin"
    const normalized = SkillManifest.normalizeProgrammatic({
      manifest: { name: input.name, description: input.description },
      source,
    })
    if (!normalized.value) return { diagnostics: normalized.diagnostics }
    return {
      info: {
        ...normalized.value,
        origin: input.origin,
        backing: input.backing,
      } satisfies Info,
      diagnostics: normalized.diagnostics,
    }
  }

  async function pluginReferences(input: {
    directory: string
    existing?: Record<string, string>
    name: string
  }): Promise<{ references?: Record<string, string>; diagnostics: Diagnostic[] }> {
    const references = { ...input.existing }
    const diagnostics: Diagnostic[] = []
    const referenceDir = path.join(input.directory, "references")
    const realBase = await fs.realpath(input.directory).catch(() => undefined)
    const realReferenceDir = await fs.realpath(referenceDir).catch(() => undefined)
    if (!realBase || !realReferenceDir || path.relative(realBase, realReferenceDir).startsWith("..")) {
      return { references: Object.keys(references).length > 0 ? references : undefined, diagnostics }
    }

    for await (const relative of new Bun.Glob("**/*").scan({
      cwd: realReferenceDir,
      absolute: false,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const file = await fs.realpath(path.join(realReferenceDir, relative)).catch(() => undefined)
      if (!file || path.relative(realBase, file).startsWith("..")) continue
      const key = `references/${relative.replace(/\\/g, "/")}`
      if (key in references) continue
      try {
        references[key] = await Bun.file(file).text()
      } catch (error) {
        diagnostics.push({
          code: "skill.reference_read_failed",
          severity: "warning",
          name: input.name,
          source: "plugin",
          path: file,
          reason: { kind: "read" },
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { references: Object.keys(references).length > 0 ? references : undefined, diagnostics }
  }

  async function programmaticCandidates() {
    const candidates: ProgrammaticCandidate[] = []
    const diagnostics: Diagnostic[] = []

    for (const builtin of BUILTIN_SKILLS) {
      const normalized = programmaticInfo({
        name: builtin.name,
        description: builtin.description,
        backing: {
          kind: "memory",
          content: builtin.content,
          references: builtin.references,
        },
        origin: { kind: "builtin" },
      })
      diagnostics.push(...normalized.diagnostics)
      if (!normalized.info) continue
      candidates.push({
        kind: "programmatic",
        info: normalized.info,
        rank: [BUILTIN_SCOPE_RANK, 0, 0, `builtin:${builtin.name}`],
      })
    }

    try {
      for (const pluginSkill of await Plugin.skillEntries()) {
        const contributionID = pluginSkill.contributionId ?? pluginSkill.name
        const resourceDiagnostics: Diagnostic[] = []
        let backing: Info["backing"] = {
          kind: "memory",
          content: pluginSkill.content ?? "",
          references: pluginSkill.references,
        }
        if (pluginSkill.dir) {
          const resolvedDirectory = path.resolve(pluginSkill.pluginDir, pluginSkill.dir)
          const directory = await fs.realpath(resolvedDirectory).catch(() => resolvedDirectory)
          let entryFile: string | undefined
          for (const entryName of ["SKILL.md", "Skill.md", "content.txt", "content.md"]) {
            const candidate = path.join(directory, entryName)
            if (!(await Bun.file(candidate).exists())) continue
            entryFile = await fs.realpath(candidate).catch(() => candidate)
            break
          }

          if (!pluginSkill.content && !pluginSkill.references && entryFile) {
            backing = { kind: "file", baseDir: directory, entryFile }
          } else {
            let content = pluginSkill.content ?? ""
            if (!pluginSkill.content && entryFile) {
              const raw = await Bun.file(entryFile).text()
              content = entryFile.endsWith(".md")
                ? await ConfigMarkdown.parse(entryFile)
                    .then((document) => document.content)
                    .catch(() => raw)
                : raw
            }
            const loaded = await pluginReferences({
              directory,
              existing: pluginSkill.references,
              name: pluginSkill.name,
            })
            resourceDiagnostics.push(...loaded.diagnostics)
            backing = { kind: "memory", content, references: loaded.references }
          }
        }
        const normalized = programmaticInfo({
          name: pluginSkill.name,
          description: pluginSkill.description,
          backing,
          origin: {
            kind: "plugin",
            pluginID: pluginSkill.pluginId,
            contributionID,
          },
        })
        diagnostics.push(...normalized.diagnostics, ...resourceDiagnostics)
        if (!normalized.info) continue
        normalized.info.diagnostics.push(...resourceDiagnostics)
        candidates.push({
          kind: "programmatic",
          info: normalized.info,
          rank: [PROGRAMMATIC_SCOPE_RANK, PLUGIN_SOURCE_RANK, 0, `${pluginSkill.pluginId}:${contributionID}`],
        })
      }
    } catch (error) {
      diagnostics.push({
        code: "skill.plugin_entries_failed",
        severity: "error",
        name: "plugin",
        source: "plugin",
        reason: { kind: "enumeration" },
        message: error instanceof Error ? error.message : String(error),
      })
    }

    return { candidates, diagnostics }
  }

  async function normalizeFilesystemCandidate(candidate: FilesystemCandidate) {
    const normalized = await SkillManifest.normalizeFile({
      entryFile: candidate.entryFile,
      source: candidate.source,
      mode: candidate.validation,
    })
    if (normalized.value || !candidate.normalizationShim) return normalized

    const fallback = await SkillManifest.normalizeFile({
      entryFile: candidate.entryFile,
      source: candidate.source,
      mode: candidate.normalizationShim.validation,
    })
    if (!fallback.value) return normalized

    const shimDiagnostic: Diagnostic = {
      code: "skill.normalization_shim_applied",
      severity: "warning",
      name: fallback.value.name,
      source: candidate.source,
      path: candidate.entryFile,
      reason: {
        kind: "normalization_shim",
        id: candidate.normalizationShim.id,
        deleteWhen: candidate.normalizationShim.deleteWhen,
      },
      message: `Loaded legacy ${candidate.source} Skill through compatibility shim '${candidate.normalizationShim.id}'`,
    }
    const diagnostics = [...fallback.diagnostics, shimDiagnostic]
    return {
      value: { ...fallback.value, diagnostics },
      diagnostics,
    }
  }

  async function materialize(candidate: Candidate): Promise<{ info?: Info; diagnostics: Diagnostic[] }> {
    if (candidate.kind === "programmatic") return { info: candidate.info, diagnostics: [] }
    const normalized = await normalizeFilesystemCandidate(candidate)
    if (!normalized.value) return { diagnostics: normalized.diagnostics }
    return {
      info: {
        name: normalized.value.name,
        description: normalized.value.description,
        declaredLicense: normalized.value.declaredLicense,
        declaredCompatibility: normalized.value.declaredCompatibility,
        invocation: normalized.value.invocation,
        origin: { kind: "filesystem", source: candidate.source, scope: candidate.scope },
        backing: {
          kind: "file",
          baseDir: candidate.baseDir,
          entryFile: candidate.entryFile,
        },
        diagnostics: normalized.value.diagnostics,
      },
      diagnostics: normalized.diagnostics,
    }
  }

  export const state = ScopedState.create(async () => {
    const skills: Record<string, Info> = {}
    const diagnostics: Diagnostic[] = []
    const grouped = new Map<string, Array<{ candidate: Candidate; info: Info }>>()
    const [filesystem, programmatic] = await Promise.all([scanFilesystemCandidates(), programmaticCandidates()])
    diagnostics.push(...programmatic.diagnostics)

    for (const candidate of [...filesystem, ...programmatic.candidates]) {
      const materialized = await materialize(candidate)
      diagnostics.push(...materialized.diagnostics)
      if (!materialized.info) continue
      const entries = grouped.get(materialized.info.name) ?? []
      entries.push({ candidate, info: materialized.info })
      grouped.set(materialized.info.name, entries)
    }

    for (const [name, entries] of grouped) {
      entries.sort((left, right) => compareRanks(left.candidate, right.candidate))
      const winner = entries[0]!
      const collisionDiagnostics = entries
        .slice(1)
        .map((entry) => collisionDiagnostic({ winner: winner.candidate, shadowed: entry.candidate, name }))
      winner.info.diagnostics.push(...collisionDiagnostics)
      diagnostics.push(...collisionDiagnostics)
      skills[name] = winner.info
    }

    return { skills, diagnostics }
  })

  export async function reload() {
    log.info("reloading skill state")
    await state.resetAll()
    log.info("skill state reloaded")
  }

  export async function diagnostics() {
    return state().then((value) => value.diagnostics)
  }

  export async function get(name: string) {
    return state().then((value) => value.skills[name])
  }

  export async function all() {
    return state().then((value) => Object.values(value.skills))
  }

  export async function content(skill: Info) {
    if (skill.backing.kind === "memory") return skill.backing.content
    const backing = skill.backing
    if (skill.origin.kind === "plugin") {
      const raw = await Bun.file(backing.entryFile)
        .text()
        .catch(() => undefined)
      if (raw === undefined) return ""
      if (!backing.entryFile.endsWith(".md")) return raw
      return ConfigMarkdown.parse(backing.entryFile)
        .then((document) => document.content)
        .catch(() => raw)
    }
    if (skill.origin.kind !== "filesystem") return ""
    return ConfigMarkdown.parse(backing.entryFile)
      .then((document) => document.content)
      .catch(() => "")
  }

  export function runtimeCompatibility(skill: Info) {
    const compatibilityDiagnostics = skill.diagnostics.filter(
      (diagnostic) => diagnostic.code !== "skill.candidate_shadowed",
    )
    if (compatibilityDiagnostics.some((diagnostic) => diagnostic.severity === "error")) return "partial" as const
    if (compatibilityDiagnostics.some((diagnostic) => diagnostic.severity === "warning")) return "partial" as const
    return skill.origin.kind === "filesystem" && skill.origin.source !== "synergy" && skill.origin.source !== "agents"
      ? ("compatible" as const)
      : ("native" as const)
  }
}
