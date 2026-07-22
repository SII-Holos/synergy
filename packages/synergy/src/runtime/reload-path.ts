import path from "path"
import { ConfigDomain } from "../config/domain"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { SkillSourceProfile } from "../skill/source-profile"
import { isPathContained } from "../util/path-contain"
import { RuntimeSchema } from "./schema"

export namespace RuntimeReloadPath {
  export type Target = RuntimeSchema.ReloadTarget
  export type Scope = RuntimeSchema.ReloadScope

  function globalConfigRoots() {
    return {
      agent: [
        path.resolve(path.join(Global.Path.config, "agent")),
        path.resolve(path.join(Global.Path.config, "agents")),
      ],
      command: [
        path.resolve(path.join(Global.Path.config, "command")),
        path.resolve(path.join(Global.Path.config, "commands")),
      ],
      skill: SkillSourceProfile.existingRootPaths(ScopeContext.current.directory).filter(
        (root) => !isPathContained(path.resolve(ScopeContext.current.directory), root),
      ),
      tool: [path.resolve(path.join(Global.Path.config, "tool"))],
    }
  }

  function projectConfigRoots() {
    return {
      agent: [
        path.resolve(path.join(ScopeContext.current.directory, ".synergy", "agent")),
        path.resolve(path.join(ScopeContext.current.directory, ".synergy", "agents")),
      ],
      command: [
        path.resolve(path.join(ScopeContext.current.directory, ".synergy", "command")),
        path.resolve(path.join(ScopeContext.current.directory, ".synergy", "commands")),
      ],
      skill: SkillSourceProfile.existingRootPaths(ScopeContext.current.directory).filter((root) =>
        isPathContained(path.resolve(ScopeContext.current.directory), root),
      ),
      tool: [path.resolve(path.join(ScopeContext.current.directory, ".synergy", "tool"))],
    }
  }

  function isUnderRoots(normalized: string, roots: string[]) {
    return roots.some((root) => isPathContained(root, normalized))
  }

  function globalLegacyConfigFiles() {
    return [path.join(Global.Path.config, "synergy.jsonc"), path.join(Global.Path.config, "synergy.json")].map((file) =>
      path.resolve(file),
    )
  }

  function projectLegacyConfigFiles() {
    return [
      path.join(ScopeContext.current.directory, "synergy.jsonc"),
      path.join(ScopeContext.current.directory, "synergy.json"),
      path.join(ScopeContext.current.directory, ".synergy", "synergy.jsonc"),
      path.join(ScopeContext.current.directory, ".synergy", "synergy.json"),
    ].map((file) => path.resolve(file))
  }

  export function detectScopeForFile(filePath: string): Scope | undefined {
    const normalized = path.resolve(filePath)

    if (globalLegacyConfigFiles().includes(normalized)) return "global"
    if (projectLegacyConfigFiles().includes(normalized)) return "project"

    const globalDomainDir = path.resolve(ConfigDomain.directory())
    if (isPathContained(globalDomainDir, normalized) && ConfigDomain.domainForFile(normalized)) return "global"

    const projectDomainDir = path.resolve(path.join(ScopeContext.current.directory, ".synergy", "synergy.d"))
    if (isPathContained(projectDomainDir, normalized) && ConfigDomain.domainForFile(normalized)) return "project"

    const globalRoots = globalConfigRoots()
    const allGlobalRoots = [...globalRoots.agent, ...globalRoots.command, ...globalRoots.skill, ...globalRoots.tool]
    if (isUnderRoots(normalized, allGlobalRoots)) return "global"

    const projectRoots = projectConfigRoots()
    const allProjectRoots = [
      ...projectRoots.agent,
      ...projectRoots.command,
      ...projectRoots.skill,
      ...projectRoots.tool,
    ]
    if (isUnderRoots(normalized, allProjectRoots)) return "project"

    return undefined
  }

  export function detectTargetsForFile(filePath: string): Target[] {
    const normalized = path.resolve(filePath)
    const targets: Target[] = []

    if (globalLegacyConfigFiles().includes(normalized) || projectLegacyConfigFiles().includes(normalized)) {
      targets.push("config")
    }

    const globalDomainDir = path.resolve(ConfigDomain.directory())
    const projectDomainDir = path.resolve(path.join(ScopeContext.current.directory, ".synergy", "synergy.d"))
    if (
      (isPathContained(globalDomainDir, normalized) || isPathContained(projectDomainDir, normalized)) &&
      ConfigDomain.domainForFile(normalized)
    ) {
      const domain = ConfigDomain.domainForFile(normalized)!
      targets.push(...(domain.reloadTargets as Target[]))
    }

    const globalRoots = globalConfigRoots()
    const projectRoots = projectConfigRoots()
    if (SkillSourceProfile.matchesEntryFile(normalized, ScopeContext.current.directory)) {
      targets.push("skill")
    }

    const agentRoots = [...globalRoots.agent, ...projectRoots.agent]
    if (normalized.endsWith(".md") && isUnderRoots(normalized, agentRoots)) {
      targets.push("config", "agent")
    }

    const commandRoots = [...globalRoots.command, ...projectRoots.command]
    if (normalized.endsWith(".md") && isUnderRoots(normalized, commandRoots)) {
      targets.push("config", "command")
    }

    const toolRoots = [...globalRoots.tool, ...projectRoots.tool]
    if ([".ts", ".js"].includes(path.extname(normalized)) && isUnderRoots(normalized, toolRoots)) {
      targets.push("tool_registry")
    }

    return [...new Set(targets)]
  }
}
