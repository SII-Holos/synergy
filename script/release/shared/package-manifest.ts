import path from "path"
import { FIXED_REGISTRY_PACKAGES, REPO_ROOT } from "./packages"

export type DependencyVersionMap = Record<string, string>

export type PackageJson = {
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

export async function readCatalog(): Promise<Record<string, string>> {
  const rootPkg = JSON.parse(await Bun.file(path.join(REPO_ROOT, "package.json")).text())
  return (rootPkg.workspaces?.catalog ?? {}) as Record<string, string>
}

export function createPublishablePackageJson(options: {
  packageJson: PackageJson
  version: string
  catalog: Record<string, string>
  dependencyVersions?: DependencyVersionMap
}): PackageJson {
  const packageJson = structuredClone(options.packageJson)
  if (packageJson.exports) {
    packageJson.exports = distExports(packageJson.exports)
  }
  if (typeof packageJson.types === "string") {
    packageJson.types = distPath(packageJson.types, ".d.ts")
  }

  packageJson.dependencies = resolveDeps(
    packageJson.dependencies,
    options.version,
    options.catalog,
    options.dependencyVersions,
  )
  packageJson.optionalDependencies = resolveDeps(
    packageJson.optionalDependencies,
    options.version,
    options.catalog,
    options.dependencyVersions,
  )
  packageJson.peerDependencies = resolveDeps(
    packageJson.peerDependencies,
    options.version,
    options.catalog,
    options.dependencyVersions,
  )
  delete packageJson.devDependencies
  return packageJson
}

export function createSynergyWrapperPackageJson(options: {
  version: string
  binName: string
  optionalDependencies: Record<string, string>
  repositoryUrl: string
}): PackageJson {
  return {
    name: "@ericsanchezok/synergy",
    bin: {
      [options.binName]: `./bin/${options.binName}`,
    },
    scripts: {
      postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
    },
    version: options.version,
    optionalDependencies: options.optionalDependencies,
    repository: {
      type: "git",
      url: options.repositoryUrl,
    },
  }
}

function distExports(exportsField: Record<string, unknown>) {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(exportsField)) {
    const source =
      typeof value === "string"
        ? value
        : typeof value === "object" && value !== null
          ? (value as { import?: string }).import
          : undefined
    if (!source || typeof source !== "string") {
      output[key] = value
      continue
    }
    const file = distPath(source)
    output[key] = {
      types: `${file}.d.ts`,
      import: `${file}.js`,
    }
  }
  return output
}

function distPath(source: string, extension = "") {
  const file = source.replace("./src/", "./dist/").replace(/\.(m?ts|js)$/, "")
  return `${file}${extension}`
}

function resolveDeps(
  deps: Record<string, string> | undefined,
  version: string,
  catalog: Record<string, string>,
  dependencyVersions: DependencyVersionMap = {},
): Record<string, string> | undefined {
  if (!deps) return deps
  const resolved: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (spec.startsWith("workspace:")) {
      if (dependencyVersions[name]) {
        resolved[name] = dependencyVersions[name]
      } else if ((FIXED_REGISTRY_PACKAGES as readonly string[]).includes(name)) {
        resolved[name] = version
      } else {
        throw new Error(
          `Cannot resolve workspace: dependency "${name}: ${spec}" — ` +
            `add it to FIXED_REGISTRY_PACKAGES in packages.ts or remove the workspace reference`,
        )
      }
    } else if (spec.startsWith("catalog:")) {
      const catalogName = spec === "catalog:" ? name : spec.slice("catalog:".length)
      const catalogVersion = catalog[catalogName]
      if (!catalogVersion) {
        throw new Error(`Cannot resolve ${spec} dependency "${name}" — no entry found in root workspaces.catalog`)
      }
      resolved[name] = catalogVersion
    } else {
      resolved[name] = spec
    }
  }
  return resolved
}
