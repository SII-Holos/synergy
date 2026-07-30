import { $ } from "bun"
import { REPO_ROOT, SYNERGY_DIST_DIR } from "../shared/packages"
import { PINNED_MODELS_CATALOG_PATH } from "../../../packages/synergy/script/models-catalog"

export async function buildSynergyBinaries(version: string, runtimeChannel: string) {
  console.log("\n=== build synergy binaries ===\n")
  await $`bun run ./packages/synergy/script/build.ts`.cwd(REPO_ROOT).env({
    ...process.env,
    MODELS_DEV_API_JSON: PINNED_MODELS_CATALOG_PATH,
    SYNERGY_VERSION: version,
    SYNERGY_CHANNEL: runtimeChannel,
  })

  const directories = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: SYNERGY_DIST_DIR, onlyFiles: false }))
  return directories.filter((entry) => !entry.includes(".") && entry !== "synergy")
}
