import { $ } from "bun"
import fs from "fs"
import path from "path"
import { META_SYNERGY_DIST_DIR } from "../shared/packages"

export async function validateMetaSynergyArtifacts(platformNames: string[]) {
  console.log("\n=== validate meta-synergy artifacts ===\n")

  for (const name of platformNames) {
    const baseDir = path.join(META_SYNERGY_DIST_DIR, name)
    const binaryRelative = name.includes("windows") ? "bin/meta-synergy.exe" : "bin/meta-synergy"
    if (!fs.existsSync(path.join(baseDir, binaryRelative))) {
      throw new Error(`missing ${binaryRelative} in ${baseDir}`)
    }
  }

  const currentPlatform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const smokeTarget = platformNames.find(
    (name) => name.includes(currentPlatform) && !name.includes("baseline") && !name.includes("musl"),
  )
  if (!smokeTarget) return

  const smokeBinary = smokeTarget.includes("windows") ? "./bin/meta-synergy.exe" : "./bin/meta-synergy"
  const cwd = path.join(META_SYNERGY_DIST_DIR, smokeTarget)
  const tmpHome = path.join(META_SYNERGY_DIST_DIR, ".smoke-test-home")
  await $`rm -rf ${tmpHome}`.nothrow()
  await $`mkdir -p ${tmpHome}`

  try {
    const env = { ...process.env, META_SYNERGY_HOME: tmpHome }
    await $`${smokeBinary} mode managed`.cwd(cwd).env(env)
    await $`${smokeBinary} start`.cwd(cwd).env(env)
    await Bun.sleep(2000)
    await $`${smokeBinary} --json status`.cwd(cwd).env(env)
    await $`${smokeBinary} stop`.cwd(cwd).env(env)
    console.log(`smoke test passed for ${smokeTarget}`)
  } finally {
    await $`rm -rf ${tmpHome}`.nothrow()
  }
}
