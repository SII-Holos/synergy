import { $ } from "bun"
import { REPO_ROOT } from "../shared/packages"

export async function buildPluginKit() {
  console.log("\n=== build plugin kit ===\n")
  await $`bun turbo build --filter=@ericsanchezok/synergy-plugin-kit`.cwd(REPO_ROOT)
}
