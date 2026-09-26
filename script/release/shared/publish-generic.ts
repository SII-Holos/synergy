import { $ } from "bun"
import path from "path"
import fs from "node:fs/promises"
import os from "node:os"
import {
  createPublishablePackageJson,
  readCatalog,
  type DependencyVersionMap,
  type PackageJson,
} from "./package-manifest"
import { publishPackedArchive } from "./publish-modules"

export async function publishGenericWorkspacePackage(options: {
  dir: string
  name: string
  version: string
  channel: string
  dependencyVersions?: DependencyVersionMap
}) {
  const packageJsonPath = path.join(options.dir, "package.json")
  const originalText = await Bun.file(packageJsonPath).text()
  const catalog = await readCatalog()

  const sourcePackageJson = JSON.parse(originalText) as PackageJson
  const packageJson = createPublishablePackageJson({
    packageJson: sourcePackageJson,
    version: options.version,
    catalog,
    dependencyVersions: options.dependencyVersions,
  })
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2))

  try {
    await publishDirectory(options)
  } finally {
    await Bun.write(packageJsonPath, originalText)
  }
}

export async function publishDirectory(options: { dir: string; name: string; version: string; channel: string }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-publish-"))
  try {
    const manifest = await Bun.file(path.join(options.dir, "package.json")).json()
    if (manifest.name !== options.name || manifest.version !== options.version)
      throw new Error(`Publication identity differs from the prepared package: ${options.name}`)
    const archive = path.join(directory, "package.tgz")
    await $`bun pm pack --ignore-scripts --filename ${archive}`.cwd(options.dir).quiet()
    await publishPackedArchive({ name: options.name, version: options.version, archive }, options.channel)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
