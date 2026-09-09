import { $ } from "bun"
import { REPO_ROOT } from "../shared/packages"

export async function buildPlugin() {
  console.log("\n=== build plugin ===\n")
  await $`bun turbo build --filter=@ericsanchezok/synergy-plugin`.cwd(REPO_ROOT)
}
