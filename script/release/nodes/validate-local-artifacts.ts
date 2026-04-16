import { $ } from "bun"
import fs from "fs"
import path from "path"
import { APP_DIST_DIR, CONFIG_UI_DIST_DIR, SYNERGY_DIR, SYNERGY_DIST_DIR } from "../shared/packages"

export async function validateLocalArtifacts(platformPackageNames: string[]) {
  console.log("\n=== validate local artifacts ===\n")

  if (!(await Bun.file(path.join(APP_DIST_DIR, "index.html")).exists())) {
    throw new Error("packages/app/dist/index.html is missing")
  }
  if (!(await Bun.file(path.join(CONFIG_UI_DIST_DIR, "index.html")).exists())) {
    throw new Error("packages/config-ui/dist/index.html is missing")
  }
  if (!(await Bun.file(path.join(SYNERGY_DIR, "schema/config.schema.json")).exists())) {
    throw new Error("packages/synergy/schema/config.schema.json is missing")
  }

  const currentPlatform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const smokeTarget = platformPackageNames.find(
    (name) => name.includes(currentPlatform) && !name.includes("baseline") && !name.includes("musl"),
  )
  if (smokeTarget) {
    const smokeBinary = smokeTarget.includes("windows") ? "./bin/synergy.exe" : "./bin/synergy"
    await $`${smokeBinary} --version`.cwd(path.join(SYNERGY_DIST_DIR, smokeTarget))
  }

  for (const name of platformPackageNames) {
    const baseDir = path.join(SYNERGY_DIST_DIR, name)
    const binaryRelative = name.includes("windows") ? "bin/synergy.exe" : "bin/synergy"
    for (const relative of [binaryRelative, "app/index.html", "config-ui/index.html", "schema/config.schema.json"]) {
      if (!fs.existsSync(path.join(baseDir, relative))) {
        throw new Error(`missing ${relative} in ${baseDir}`)
      }
    }
  }
}
