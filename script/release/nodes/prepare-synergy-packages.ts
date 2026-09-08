import fs from "node:fs/promises"
import { join } from "path"
import { CLI_DIR, PRODUCT_RUNTIME_DIST_DIR, RUNTIME_RELEASE_TARGETS } from "../shared/packages"
import { currentGitRemoteUrl } from "../shared/git"
import { createSynergyWrapperPackageJson } from "../shared/package-manifest"
import { prepareRuntimeAssets } from "../shared/runtime-assets"

export async function prepareSynergyPackages(version: string, platformNames: string[]) {
  console.log("\n=== prepare synergy packages ===\n")

  const repositoryUrl = await currentGitRemoteUrl()

  const scopedBinaries: Record<string, string> = {}
  for (const name of platformNames) {
    const scopedName = `@ericsanchezok/${name}`
    scopedBinaries[scopedName] = version
    const distDir = join(PRODUCT_RUNTIME_DIST_DIR, name)
    await prepareRuntimeAssets(name)

    await Bun.write(
      join(distDir, "package.json"),
      JSON.stringify(
        {
          name: scopedName,
          version,
          os: [name.includes("windows") ? "win32" : name.includes("darwin") ? "darwin" : "linux"],
          cpu: [name.includes("arm64") ? "arm64" : "x64"],
          repository: {
            type: "git",
            url: repositoryUrl,
          },
        },
        null,
        2,
      ),
    )
  }

  await stageSynergyWrapper({
    cliDir: CLI_DIR,
    runtimeDistDir: PRODUCT_RUNTIME_DIST_DIR,
    version,
    optionalDependencies: scopedBinaries,
    repositoryUrl,
  })

  return platformNames.map((name) => `@ericsanchezok/${name}`)
}

export async function stageSynergyWrapper(options: {
  cliDir: string
  runtimeDistDir: string
  version: string
  optionalDependencies: Record<string, string>
  repositoryUrl: string
}) {
  const binName = RUNTIME_RELEASE_TARGETS.full.executable
  const directory = join(options.runtimeDistDir, binName)
  await fs.mkdir(directory, { recursive: true })
  await fs.rm(join(directory, "bin"), { recursive: true, force: true })
  await fs.cp(join(options.cliDir, "bin"), join(directory, "bin"), { recursive: true })
  await fs.copyFile(join(options.cliDir, "script/postinstall.mjs"), join(directory, "postinstall.mjs"))
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify(
      createSynergyWrapperPackageJson({
        version: options.version,
        binName,
        optionalDependencies: options.optionalDependencies,
        repositoryUrl: options.repositoryUrl,
      }),
      null,
      2,
    ),
  )
  return directory
}
