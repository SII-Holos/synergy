import { $ } from "bun"
import { REPO_ROOT } from "../shared/packages"

export async function generateSchema() {
  console.log("\n=== generate schema ===\n")
  await $`bun run ./packages/synergy/script/generate-schema.ts`.cwd(REPO_ROOT)
  await $`bunx prettier --write packages/synergy/schema/config.schema.json`.cwd(REPO_ROOT)
}
