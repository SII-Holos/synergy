import { $ } from "bun"
import path from "path"
import { NPM_REGISTRY, SYNERGY_DIST_DIR } from "../shared/packages"
import { npmAuthFlag, npmEnsureDistTag, npmVersionExists, retry } from "../shared/runtime"

export async function publishSynergyCandidate(version: string, channel: string) {
  console.log("\n=== publish synergy candidate ===\n")

  const mainPackagePath = path.join(SYNERGY_DIST_DIR, "synergy")
  const entries = await Array.fromAsync(new Bun.Glob("synergy-*").scan({ cwd: SYNERGY_DIST_DIR, onlyFiles: false }))
  const platformNames = entries.filter((entry) => entry !== "synergy")
  const authFlag = npmAuthFlag()

  for (let index = 0; index < platformNames.length; index += 3) {
    const batch = platformNames.slice(index, index + 3)
    await Promise.all(
      batch.map(async (name) => {
        const packageName = `@ericsanchezok/${name}`
        const cwd = path.join(SYNERGY_DIST_DIR, name)
        if (!(await npmVersionExists(packageName, version))) {
          if (process.platform !== "win32") {
            await $`chmod -R 755 .`.cwd(cwd)
          }
          await $`rm -f *.tgz`.cwd(cwd).nothrow()
          await $`bun pm pack`.cwd(cwd)
          await retry(
            () => $`npm publish *.tgz --registry ${NPM_REGISTRY} --tag ${channel} --access public ${authFlag}`.cwd(cwd),
            {
              attempts: 3,
              delay: 15_000,
            },
          )
        }
        await npmEnsureDistTag(packageName, version, channel)
      }),
    )
  }

  const mainPackageName = "@ericsanchezok/synergy"
  if (!(await npmVersionExists(mainPackageName, version))) {
    await $`rm -f *.tgz`.cwd(mainPackagePath).nothrow()
    await $`bun pm pack`.cwd(mainPackagePath)
    await retry(
      () =>
        $`npm publish *.tgz --registry ${NPM_REGISTRY} --tag ${channel} --access public ${authFlag}`.cwd(
          mainPackagePath,
        ),
      {
        attempts: 3,
        delay: 15_000,
      },
    )
  }
  await npmEnsureDistTag(mainPackageName, version, channel)

  return {
    platformPackages: platformNames.map((name) => `@ericsanchezok/${name}`),
    platformNames,
  }
}
