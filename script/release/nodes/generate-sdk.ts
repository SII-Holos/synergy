import { $ } from "bun"
import { REPO_ROOT } from "../shared/packages"

export async function generateSdk() {
  console.log("\n=== generate sdk ===\n")
  await $`bun run ./packages/sdk/js/script/build.ts`.cwd(REPO_ROOT)
}
