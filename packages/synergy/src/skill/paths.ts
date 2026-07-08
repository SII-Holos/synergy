import path from "path"
import { existsSync } from "fs"
import { Global } from "@/global"
import { Flag } from "@/flag/flag"

export namespace SkillPaths {
  function uniq(paths: string[]) {
    return Array.from(new Set(paths.filter((dir): dir is string => !!dir).map((dir) => path.resolve(dir))))
  }

  function uniqExisting(paths: string[]) {
    return uniq(paths.filter((dir) => existsSync(dir)))
  }

  export function claudeRoots(instanceDirectory: string) {
    return uniqExisting([path.join(instanceDirectory, ".claude"), path.join(Global.Path.home, ".claude")])
  }

  export function openClawRoots(instanceDirectory: string) {
    return uniqExisting([
      path.join(instanceDirectory, "skills"),
      path.join(instanceDirectory, ".agents", "skills"),
      path.join(Global.Path.home, ".agents", "skills"),
      path.join(Global.Path.home, ".openclaw", "skills"),
    ])
  }

  export function codexRoots(instanceDirectory: string) {
    return uniqExisting([
      path.join(instanceDirectory, ".codex", "skills"),
      path.join(Global.Path.home, ".codex", "skills"),
    ])
  }

  export function nativeRuntimeRootsSync(instanceDirectory: string) {
    const roots = [
      Global.Path.config,
      path.join(instanceDirectory, ".synergy"),
      path.join(Global.Path.home, ".synergy"),
    ]

    if (Flag.SYNERGY_CONFIG_DIR) roots.push(Flag.SYNERGY_CONFIG_DIR)

    return Array.from(new Set(roots.filter((dir): dir is string => !!dir))).map((dir) => path.resolve(dir))
  }

  export function runtimeSkillRootsSync(instanceDirectory: string) {
    const synergy = nativeRuntimeRootsSync(instanceDirectory)
    const claude = claudeRoots(instanceDirectory)

    return uniqExisting([
      ...synergy.flatMap((root) => [path.join(root, "skill"), path.join(root, "skills")]),
      ...claude.map((root) => path.join(root, "skills")),
      ...openClawRoots(instanceDirectory),
      ...codexRoots(instanceDirectory),
    ])
  }

  export function runtimeSkillRootCandidatesSync(instanceDirectory: string) {
    const synergy = nativeRuntimeRootsSync(instanceDirectory)

    return uniq([
      ...synergy.flatMap((root) => [path.join(root, "skill"), path.join(root, "skills")]),
      path.join(instanceDirectory, ".claude", "skills"),
      path.join(Global.Path.home, ".claude", "skills"),
      path.join(instanceDirectory, "skills"),
      path.join(instanceDirectory, ".agents", "skills"),
      path.join(Global.Path.home, ".agents", "skills"),
      path.join(Global.Path.home, ".openclaw", "skills"),
      path.join(instanceDirectory, ".codex", "skills"),
      path.join(Global.Path.home, ".codex", "skills"),
    ])
  }

  export function synergyGlobalRoots() {
    const roots = [Global.Path.config, path.join(Global.Path.home, ".synergy")]
    if (Flag.SYNERGY_CONFIG_DIR) roots.push(Flag.SYNERGY_CONFIG_DIR)
    return uniqExisting(roots)
  }
}
