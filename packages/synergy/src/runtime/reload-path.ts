import path from "path"
import { ConfigDomain } from "../config/domain"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { SkillSourceProfile } from "../instruction/source-profile"
import { isPathContained } from "../util/path-contain"
import { RuntimeSchema } from "./schema"

export namespace RuntimeReloadPath {
  export type Target = RuntimeSchema.ReloadTarget
  export type Scope = RuntimeSchema.ReloadScope

  export type PathPlatform = "win32" | "posix"

  function platformKind(): PathPlatform {
    return process.platform === "win32" ? "win32" : "posix"
  }

  function pathApi(platform: PathPlatform = platformKind()) {
    return platform === "win32" ? path.win32 : path.posix
  }

  export function normalizePath(filePath: string, platform: PathPlatform = platformKind()) {
    return pathApi(platform).resolve(platform === "win32" ? filePath.replaceAll("/", "\\") : filePath)
  }

  export function comparisonPath(filePath: string, platform: PathPlatform = platformKind()) {
    const normalized = normalizePath(filePath, platform)
    return platform === "win32" ? normalized.toLowerCase() : normalized
  }

  function absolutePath(filePath: string, platform: PathPlatform = platformKind()) {
    return normalizePath(filePath, platform)
  }

  function isContained(parent: string, child: string, platform: PathPlatform = platformKind()) {
    if (platform === platformKind())
      return isPathContained(comparisonPath(parent, platform), comparisonPath(child, platform))
    const api = pathApi(platform)
    const relative = api.relative(comparisonPath(parent, platform), comparisonPath(child, platform))
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  }

  function domainForFile(filePath: string) {
    const domain = ConfigDomain.domainForFile(filePath)
    if (domain || process.platform !== "win32") return domain
    const basename = pathApi().basename(filePath).toLowerCase()
    return ConfigDomain.definitions.find((candidate) => candidate.filename.toLowerCase() === basename)
  }

  function globalConfigRoots() {
    return {
      agent: [
        absolutePath(path.join(Global.Path.config, "agent")),
        absolutePath(path.join(Global.Path.config, "agents")),
      ],
      command: [
        absolutePath(path.join(Global.Path.config, "command")),
        absolutePath(path.join(Global.Path.config, "commands")),
      ],
      skill: SkillSourceProfile.existingRootPaths(ScopeContext.current.directory).filter(
        (root) => !isContained(ScopeContext.current.directory, root),
      ),
      tool: [absolutePath(path.join(Global.Path.config, "tool"))],
    }
  }

  function projectConfigRoots() {
    return {
      agent: [
        absolutePath(path.join(ScopeContext.current.directory, ".synergy", "agent")),
        absolutePath(path.join(ScopeContext.current.directory, ".synergy", "agents")),
      ],
      command: [
        absolutePath(path.join(ScopeContext.current.directory, ".synergy", "command")),
        absolutePath(path.join(ScopeContext.current.directory, ".synergy", "commands")),
      ],
      skill: SkillSourceProfile.existingRootPaths(ScopeContext.current.directory).filter((root) =>
        isContained(ScopeContext.current.directory, root),
      ),
      tool: [absolutePath(path.join(ScopeContext.current.directory, ".synergy", "tool"))],
    }
  }

  function isUnderRoots(normalized: string, roots: string[]) {
    return roots.some((root) => isContained(root, normalized))
  }

  function hasExtension(filePath: string, extension: string) {
    const actual = pathApi().extname(filePath)
    return process.platform === "win32" ? actual.toLowerCase() === extension : actual === extension
  }

  function globalLegacyConfigFiles() {
    return [path.join(Global.Path.config, "synergy.jsonc"), path.join(Global.Path.config, "synergy.json")].map((file) =>
      comparisonPath(file),
    )
  }

  function projectLegacyConfigFiles() {
    return [
      path.join(ScopeContext.current.directory, "synergy.jsonc"),
      path.join(ScopeContext.current.directory, "synergy.json"),
      path.join(ScopeContext.current.directory, ".synergy", "synergy.jsonc"),
      path.join(ScopeContext.current.directory, ".synergy", "synergy.json"),
    ].map((file) => comparisonPath(file))
  }

  function matchesSkillEntryFile(normalized: string) {
    const basename = pathApi().basename(normalized)
    return SkillSourceProfile.allRoots(ScopeContext.current.directory).some((root) => {
      const accepted = root.acceptedEntryNames.some((name) =>
        process.platform === "win32" ? name.toLowerCase() === basename.toLowerCase() : name === basename,
      )
      return accepted && comparisonPath(root.path) !== comparisonPath(normalized) && isContained(root.path, normalized)
    })
  }

  export function detectScopeForFile(filePath: string): Scope | undefined {
    const normalized = absolutePath(filePath)
    const comparison = comparisonPath(normalized)

    if (globalLegacyConfigFiles().includes(comparison)) return "global"
    if (projectLegacyConfigFiles().includes(comparison)) return "project"

    const globalDomainDir = absolutePath(ConfigDomain.directory())
    if (isContained(globalDomainDir, normalized) && domainForFile(normalized)) return "global"

    const projectDomainDir = absolutePath(path.join(ScopeContext.current.directory, ".synergy", "synergy.d"))
    if (isContained(projectDomainDir, normalized) && domainForFile(normalized)) return "project"

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
    const normalized = absolutePath(filePath)
    const comparison = comparisonPath(normalized)
    const targets: Target[] = []

    if (globalLegacyConfigFiles().includes(comparison) || projectLegacyConfigFiles().includes(comparison)) {
      targets.push("config")
    }

    const globalDomainDir = absolutePath(ConfigDomain.directory())
    const projectDomainDir = absolutePath(path.join(ScopeContext.current.directory, ".synergy", "synergy.d"))
    if (
      (isContained(globalDomainDir, normalized) || isContained(projectDomainDir, normalized)) &&
      domainForFile(normalized)
    ) {
      const domain = domainForFile(normalized)!
      targets.push(...(domain.reloadTargets as Target[]))
    }

    const globalRoots = globalConfigRoots()
    const projectRoots = projectConfigRoots()
    if (matchesSkillEntryFile(normalized)) {
      targets.push("skill")
    }

    const agentRoots = [...globalRoots.agent, ...projectRoots.agent]
    if (hasExtension(normalized, ".md") && isUnderRoots(normalized, agentRoots)) {
      targets.push("config", "agent")
    }

    const commandRoots = [...globalRoots.command, ...projectRoots.command]
    if (hasExtension(normalized, ".md") && isUnderRoots(normalized, commandRoots)) {
      targets.push("config", "command")
    }

    const toolRoots = [...globalRoots.tool, ...projectRoots.tool]
    if ((hasExtension(normalized, ".ts") || hasExtension(normalized, ".js")) && isUnderRoots(normalized, toolRoots)) {
      targets.push("tool_registry")
    }

    return [...new Set(targets)]
  }
}
