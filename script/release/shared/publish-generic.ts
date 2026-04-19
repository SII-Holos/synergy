import { $ } from "bun"
import path from "path"
import { npmAuthArgs, npmEnsureDistTag, npmVersionExists, retry, waitForNpmVersion } from "./runtime"
import { FIXED_REGISTRY_PACKAGES, NPM_REGISTRY, REPO_ROOT } from "./packages"

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
    const file = source.replace("./src/", "./dist/").replace(".ts", "").replace(".js", "")
    output[key] = {
      import: `${file}.js`,
      types: `${file}.d.ts`,
    }
  }
  return output
}

async function readCatalog(): Promise<Record<string, string>> {
  const rootPkg = JSON.parse(await Bun.file(path.join(REPO_ROOT, "package.json")).text())
  return (rootPkg.workspaces?.catalog ?? {}) as Record<string, string>
}

/**
 * Resolve Bun workspace/catalog protocol specifiers in a dependency map
 * so the published package.json contains valid semver ranges.
 *
 * - `workspace:*` for known registry packages → current release version
 * - `workspace:*` for unknown packages → throws (no silent fallback)
 * - `catalog:` → resolved from root workspaces.catalog by dependency name
 */
function resolveDeps(
  deps: Record<string, string> | undefined,
  version: string,
  catalog: Record<string, string>,
): Record<string, string> | undefined {
  if (!deps) return deps
  const resolved: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (spec.startsWith("workspace:")) {
      if ((FIXED_REGISTRY_PACKAGES as readonly string[]).includes(name)) {
        resolved[name] = version
      } else {
        throw new Error(
          `Cannot resolve workspace: dependency "${name}: ${spec}" — ` +
            `add it to FIXED_REGISTRY_PACKAGES in packages.ts or remove the workspace reference`,
        )
      }
    } else if (spec === "catalog:") {
      const catalogVersion = catalog[name]
      if (!catalogVersion) {
        throw new Error(`Cannot resolve catalog: dependency "${name}" — ` + `no entry found in root workspaces.catalog`)
      }
      resolved[name] = catalogVersion
    } else {
      resolved[name] = spec
    }
  }
  return resolved
}

export async function publishGenericWorkspacePackage(options: {
  dir: string
  name: string
  version: string
  channel: string
}) {
  const packageJsonPath = path.join(options.dir, "package.json")
  const originalText = await Bun.file(packageJsonPath).text()
  const catalog = await readCatalog()

  const packageJson = JSON.parse(originalText) as {
    exports?: Record<string, unknown>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  if (packageJson.exports) {
    packageJson.exports = distExports(packageJson.exports)
  }
  packageJson.dependencies = resolveDeps(packageJson.dependencies, options.version, catalog)
  packageJson.devDependencies = resolveDeps(packageJson.devDependencies, options.version, catalog)
  packageJson.peerDependencies = resolveDeps(packageJson.peerDependencies, options.version, catalog)
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2))

  try {
    if (await npmVersionExists(options.name, options.version)) {
      console.log(`${options.name}@${options.version} already exists, reconciling ${options.channel}`)
    } else {
      await $`rm -f *.tgz`.cwd(options.dir).nothrow()
      await $`bun pm pack`.cwd(options.dir)
      const tgz = (await $`ls *.tgz`.cwd(options.dir).text()).trim()
      const authArgs = npmAuthArgs()
      await retry(() =>
        $`npm publish ${tgz} --tag ${options.channel} --registry ${NPM_REGISTRY} --access public ${authArgs}`.cwd(
          options.dir,
        ),
      )
    }
  } finally {
    await Bun.write(packageJsonPath, originalText)
  }

  if (!(await waitForNpmVersion(options.name, options.version))) {
    throw new Error(`expected ${options.name}@${options.version} to appear in npm registry after publish`)
  }
  await npmEnsureDistTag(options.name, options.version, options.channel)
}
