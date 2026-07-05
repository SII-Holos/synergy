import { $ } from "bun"
import { SYNERGY_LINK_DIST_DIR, REPO_ROOT } from "../shared/packages"

export async function buildSynergyLinkBinaries(version: string) {
  console.log("\n=== build synergy-link binaries ===\n")
  await $`bun run ./packages/synergy-link/script/build.ts`
    .cwd(REPO_ROOT)
    .env({ ...process.env, SYNERGY_LINK_VERSION: version })

  const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: SYNERGY_LINK_DIST_DIR, onlyFiles: false }))
  return entries.filter((entry) => !entry.includes("."))
}
