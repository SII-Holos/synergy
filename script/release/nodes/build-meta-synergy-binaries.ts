import { $ } from "bun"
import { META_SYNERGY_DIST_DIR, REPO_ROOT } from "../shared/packages"

export async function buildMetaSynergyBinaries(version: string) {
  console.log("\n=== build meta-synergy binaries ===\n")
  await $`bun run ./packages/meta-synergy/script/build.ts`
    .cwd(REPO_ROOT)
    .env({ ...process.env, META_SYNERGY_VERSION: version })

  const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: META_SYNERGY_DIST_DIR, onlyFiles: false }))
  return entries.filter((entry) => !entry.includes("."))
}
