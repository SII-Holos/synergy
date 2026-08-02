import { $ } from "bun"
import path from "path"
import { APP_DIST_DIR, SYNERGY_DIR, SYNERGY_DIST_DIR } from "../shared/packages"
import { assertRuntimeManifest } from "../shared/runtime-contract"

const playwrightRuntimeCheck = "__browser-playwright-runtime-check"
const embeddingRuntimeCheck = "__embedding-runtime-check"

export async function validateLocalArtifacts(platformPackageNames: string[]) {
  console.log("\n=== validate local artifacts ===\n")

  if (!(await Bun.file(path.join(APP_DIST_DIR, "index.html")).exists())) {
    throw new Error("packages/app/dist/index.html is missing")
  }
  if (!(await Bun.file(path.join(SYNERGY_DIR, "schema/config.schema.json")).exists())) {
    throw new Error("packages/synergy/schema/config.schema.json is missing")
  }

  for (const name of platformPackageNames) {
    await assertRuntimeManifest(path.join(SYNERGY_DIST_DIR, name), name)
  }

  const currentPlatform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const smokeTarget = platformPackageNames.find(
    (name) => name.includes(currentPlatform) && !name.includes("baseline") && !name.includes("musl"),
  )
  if (smokeTarget) {
    const smokeBinary = smokeTarget.includes("windows") ? "./bin/synergy.exe" : "./bin/synergy"
    await $`${smokeBinary} --version`.cwd(path.join(SYNERGY_DIST_DIR, smokeTarget))
    await $`${smokeBinary} ${playwrightRuntimeCheck}`.cwd(path.join(SYNERGY_DIST_DIR, smokeTarget))
    await $`${smokeBinary} ${embeddingRuntimeCheck}`.cwd(path.join(SYNERGY_DIST_DIR, smokeTarget))
  }
}
