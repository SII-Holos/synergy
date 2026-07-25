import { $ } from "bun"
import { join } from "path"
import { SYNERGY_DIR, SYNERGY_DIST_DIR } from "../shared/packages"
import { currentGitRemoteUrl } from "../shared/git"
import { createSynergyWrapperPackageJson } from "../shared/package-manifest"
import { prepareRuntimeAssets } from "../shared/runtime-assets"

export async function prepareSynergyPackages(version: string, platformNames: string[]) {
  console.log("\n=== prepare synergy packages ===\n")

  const pkg = (await Bun.file(join(SYNERGY_DIR, "package.json")).json()) as { name: string }
  const repositoryUrl = await currentGitRemoteUrl()

  await $`mkdir -p ${join(SYNERGY_DIST_DIR, pkg.name)}`
  await $`cp -r ${join(SYNERGY_DIR, "bin")} ${join(SYNERGY_DIST_DIR, pkg.name, "bin")}`
  await $`cp ${join(SYNERGY_DIR, "script/postinstall.mjs")} ${join(SYNERGY_DIST_DIR, pkg.name, "postinstall.mjs")}`

  const scopedBinaries: Record<string, string> = {}
  for (const name of platformNames) {
    const scopedName = `@ericsanchezok/${name}`
    scopedBinaries[scopedName] = version
    const distDir = join(SYNERGY_DIST_DIR, name)
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

  await Bun.write(
    join(SYNERGY_DIST_DIR, pkg.name, "package.json"),
    JSON.stringify(
      createSynergyWrapperPackageJson({
        version,
        binName: pkg.name,
        optionalDependencies: scopedBinaries,
        repositoryUrl,
      }),
      null,
      2,
    ),
  )

  return platformNames.map((name) => `@ericsanchezok/${name}`)
}
