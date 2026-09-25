import { readFileSync } from "node:fs"
import path from "node:path"

export interface Workspace {
  directory: string
  name: string
  exports?: Record<string, unknown>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

export function workspaces(root: string): Workspace[] {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  return manifest.workspaces.packages.map((directory: string) => ({
    ...JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")),
    directory,
  }))
}

export function workspaceGraph(packages: Workspace[], options: { optionalPeers?: boolean } = {}) {
  const names = new Set(packages.map((pkg) => pkg.name))
  return Object.fromEntries(
    packages.map((pkg) => [
      pkg.name,
      Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter(
        (name) =>
          names.has(name) &&
          (options.optionalPeers !== false ||
            !pkg.peerDependenciesMeta?.[name]?.optional ||
            Object.hasOwn(pkg.dependencies ?? {}, name) ||
            Object.hasOwn(pkg.optionalDependencies ?? {}, name)),
      ),
    ]),
  )
}
