import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { isPathContained } from "@/util/path-contain"

export namespace SkillSourceProfile {
  export type SourceID = "synergy" | "agents" | "claude" | "codex" | "openclaw"
  export type ScopeID = "project" | "workspace" | "global"
  export type ValidationMode = "strict" | "lenient"

  export type NormalizationShim = {
    id: string
    owner: "skill"
    deleteWhen: string
    validation: "lenient"
    acceptedEntryNames: readonly string[]
  }

  type RootAnchor = "ancestor" | "home" | "config" | "configOverride"

  type RootDefinition = {
    scope: ScopeID
    anchor: RootAnchor
    path: string
  }

  export type Profile = {
    id: SourceID
    displayName: string
    validation: ValidationMode
    sourceRank: number
    acceptedEntryNames: readonly string[]
    roots: readonly RootDefinition[]
    normalizationShim?: NormalizationShim
    writable?: Partial<
      Record<
        "project" | "global",
        { anchor: "instance" | "config"; path: string; compatibilityPaths?: readonly string[] }
      >
    >
    enabled?: () => boolean
  }

  export type ResolvedRoot = {
    source: SourceID
    scope: ScopeID
    sourceRank: number
    scopeRank: number
    rootRank: number
    path: string
    acceptedEntryNames: readonly string[]
    validation: ValidationMode
    normalizationShim?: NormalizationShim
  }

  const SCOPE_RANKS: Record<ScopeID, number> = {
    project: 40,
    workspace: 35,
    global: 20,
  }

  export const profiles: readonly Profile[] = [
    {
      id: "synergy",
      displayName: "Synergy",
      validation: "strict",
      sourceRank: 100,
      acceptedEntryNames: ["SKILL.md"],
      roots: [
        { scope: "project", anchor: "ancestor", path: ".synergy/skill" },
        { scope: "project", anchor: "ancestor", path: ".synergy/skills" },
        { scope: "global", anchor: "config", path: "skill" },
        { scope: "global", anchor: "config", path: "skills" },
        { scope: "global", anchor: "home", path: ".synergy/skill" },
        { scope: "global", anchor: "home", path: ".synergy/skills" },
        { scope: "global", anchor: "configOverride", path: "skill" },
        { scope: "global", anchor: "configOverride", path: "skills" },
      ],
      writable: {
        project: { anchor: "instance", path: ".synergy/skill", compatibilityPaths: [".synergy/skills"] },
        global: { anchor: "config", path: "skill", compatibilityPaths: ["skills"] },
      },
    },
    {
      id: "agents",
      displayName: "Agent Skills",
      validation: "strict",
      sourceRank: 80,
      acceptedEntryNames: ["SKILL.md"],
      roots: [
        { scope: "project", anchor: "ancestor", path: ".agents/skills" },
        { scope: "global", anchor: "home", path: ".agents/skills" },
      ],
      normalizationShim: {
        id: "agents-pre-standardization-load",
        owner: "skill",
        deleteWhen: "All supported releases have migrated .agents/skills entries to strict Agent Skills manifests",
        validation: "lenient",
        acceptedEntryNames: ["SKILL.md", "Skill.md"],
      },
    },
    {
      id: "openclaw",
      displayName: "OpenClaw",
      validation: "lenient",
      sourceRank: 80,
      acceptedEntryNames: ["SKILL.md", "Skill.md"],
      roots: [
        { scope: "workspace", anchor: "ancestor", path: "skills" },
        { scope: "global", anchor: "home", path: ".openclaw/skills" },
      ],
    },
    {
      id: "claude",
      displayName: "Claude",
      validation: "lenient",
      sourceRank: 70,
      acceptedEntryNames: ["SKILL.md", "Skill.md"],
      roots: [
        { scope: "project", anchor: "ancestor", path: ".claude/skills" },
        { scope: "global", anchor: "home", path: ".claude/skills" },
      ],
      enabled: () => !Flag.SYNERGY_DISABLE_CLAUDE_CODE_SKILLS,
    },
    {
      id: "codex",
      displayName: "Codex",
      validation: "lenient",
      sourceRank: 60,
      acceptedEntryNames: ["SKILL.md", "Skill.md"],
      roots: [
        { scope: "project", anchor: "ancestor", path: ".codex/skills" },
        { scope: "global", anchor: "home", path: ".codex/skills" },
      ],
    },
  ] as const satisfies readonly Profile[]

  function ancestors(instanceDirectory: string) {
    const result: string[] = []
    const start = path.resolve(instanceDirectory)
    const home = path.resolve(Global.Path.home)
    let current = start
    while (true) {
      if (current === start || current !== home) result.push(current)
      if (current === home) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  function anchors(definition: RootDefinition, instanceDirectory: string) {
    if (definition.anchor === "ancestor") return ancestors(instanceDirectory)
    if (definition.anchor === "home") return [Global.Path.home]
    if (definition.anchor === "config") return [Global.Path.config]
    if (definition.anchor === "configOverride") return Flag.SYNERGY_CONFIG_DIR ? [Flag.SYNERGY_CONFIG_DIR] : []
    return []
  }

  export function allRoots(instanceDirectory: string): ResolvedRoot[] {
    const result: ResolvedRoot[] = []
    const seen = new Set<string>()

    for (const profile of profiles) {
      if (profile.enabled && !profile.enabled()) continue
      for (const [definitionIndex, definition] of profile.roots.entries()) {
        const bases = anchors(definition, instanceDirectory)
        for (const [anchorIndex, base] of bases.entries()) {
          const resolved = path.resolve(base, definition.path)
          if (definition.anchor === "ancestor" && anchorIndex > 0 && !existsSync(resolved)) continue
          const key = `${profile.id}:${definition.scope}:${resolved}`
          if (seen.has(key)) continue
          seen.add(key)
          result.push({
            source: profile.id,
            scope: definition.scope,
            sourceRank: profile.sourceRank,
            scopeRank: SCOPE_RANKS[definition.scope],
            rootRank: (profile.roots.length - definitionIndex) * 10_000 - anchorIndex,
            path: resolved,
            acceptedEntryNames: [
              ...new Set([...profile.acceptedEntryNames, ...(profile.normalizationShim?.acceptedEntryNames ?? [])]),
            ],
            validation: profile.validation,
            normalizationShim: profile.normalizationShim,
          })
        }
      }
    }

    return result
  }

  export function existingRoots(instanceDirectory: string) {
    return allRoots(instanceDirectory).filter((root) => existsSync(root.path))
  }

  export function allRootPaths(instanceDirectory: string) {
    return [...new Set(allRoots(instanceDirectory).map((root) => root.path))]
  }

  export function existingRootPaths(instanceDirectory: string) {
    return [...new Set(existingRoots(instanceDirectory).map((root) => root.path))]
  }

  export async function containsCanonicalPath(candidate: string, instanceDirectory: string) {
    const realCandidate = await fs.realpath(candidate).catch(() => undefined)
    if (!realCandidate) return false
    for (const root of existingRoots(instanceDirectory)) {
      const realRoot = await fs.realpath(root.path).catch(() => undefined)
      if (!realRoot || realRoot === realCandidate) continue
      if (isPathContained(realRoot, realCandidate)) return true
    }
    return false
  }

  export function matchesEntryFile(filePath: string, instanceDirectory: string) {
    const normalized = path.resolve(filePath)
    return allRoots(instanceDirectory).some((root) => {
      if (!root.acceptedEntryNames.includes(path.basename(normalized))) return false
      const relative = path.relative(root.path, normalized)
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    })
  }

  export function writableDestination(scope: "project" | "global", instanceDirectory: string) {
    const profile = profiles.find((item) => item.id === "synergy")
    const destination = profile?.writable?.[scope]
    if (!destination) return undefined
    const base = destination.anchor === "instance" ? instanceDirectory : Global.Path.config
    const canonical = path.resolve(base, destination.path)
    if (existsSync(canonical)) return canonical
    const existingCompatibilityPath = destination.compatibilityPaths
      ?.map((candidate) => path.resolve(base, candidate))
      .find((candidate) => existsSync(candidate))
    return existingCompatibilityPath ?? canonical
  }

  export function sourceLabel(source: SourceID) {
    return profiles.find((profile) => profile.id === source)?.displayName ?? source
  }

  export function scopeLabel(scope: ScopeID) {
    if (scope === "project") return "Project"
    if (scope === "workspace") return "Workspace"
    return "Global"
  }
}
