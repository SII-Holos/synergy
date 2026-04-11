import { $ } from "bun"
import { PLUGIN_DIR } from "../shared/packages"

export async function buildPlugin() {
  console.log("\n=== build plugin ===\n")
  await $`bun run build`.cwd(PLUGIN_DIR)
}
