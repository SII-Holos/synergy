import { $ } from "bun"
import { REPO_ROOT, PRESETS_DIST_DIR } from "../shared/packages"
import { PINNED_MODELS_CATALOG_PATH } from "../shared/build/models-catalog"

export async function buildSynergyBinaries(version: string, runtimeChannel: string): Promise<string[]> {
  console.log("\n=== build synergy binaries ===\n")
  await $`bun run ./packages/presets/script/build.ts`.cwd(REPO_ROOT).env({
    ...process.env,
    MODELS_DEV_API_JSON: PINNED_MODELS_CATALOG_PATH,
    SYNERGY_VERSION: version,
    SYNERGY_CHANNEL: runtimeChannel,
    SYNERGY_RELEASE_MODULE_TARGETS: "all",
  })

  const directories = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: PRESETS_DIST_DIR, onlyFiles: false }))
  return directories
    .map(String)
    .filter((entry) => /^synergy-(linux|darwin|windows)-(x64|arm64)(?:-(baseline|musl))*$/.test(entry))
}
