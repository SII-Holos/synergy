import { $ } from "bun"
import { REPO_ROOT, SYNERGY_DIST_DIR } from "../shared/packages"

export async function buildSynergyBinaries(version: string, runtimeChannel: string) {
  console.log("\n=== build synergy binaries ===\n")
  await $`bun run ./packages/synergy/script/build.ts`
    .cwd(REPO_ROOT)
    .env({ ...process.env, SYNERGY_VERSION: version, SYNERGY_CHANNEL: runtimeChannel })

  const directories = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: SYNERGY_DIST_DIR, onlyFiles: false }))
  return directories.filter((entry) => !entry.includes(".") && entry !== "synergy")
}
