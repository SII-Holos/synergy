import path from "node:path"
import {
  CORE_RUNTIME_DIST_DIR,
  PRESETS_DIST_DIR,
  RELEASE_CATALOG,
  REPO_ROOT,
  type RuntimeArtifactProfile,
} from "./packages"
import { assertRuntimeManifest } from "./runtime-contract"

export async function prepareRuntimeAssets(name: string, profile: RuntimeArtifactProfile = "full") {
  const runtimeDir = path.join(profile === "core" ? CORE_RUNTIME_DIST_DIR : PRESETS_DIST_DIR, name)
  await assertRuntimeManifest(runtimeDir, name, profile)
}

export async function runtimeDependencies(profile: RuntimeArtifactProfile = "full") {
  const entries =
    profile === "core"
      ? [RELEASE_CATALOG.cli, RELEASE_CATALOG.harness, RELEASE_CATALOG.localRuntime]
      : Object.values(RELEASE_CATALOG)
  const dependencies: Record<string, string> = {}
  for (const entry of entries) {
    const pkg = (await Bun.file(path.join(REPO_ROOT, entry.directory, "package.json")).json()) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    Object.assign(dependencies, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies)
  }
  return dependencies
}
