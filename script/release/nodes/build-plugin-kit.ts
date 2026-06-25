import { $ } from "bun"
import { PLUGIN_KIT_DIR } from "../shared/packages"

export async function buildPluginKit() {
  console.log("\n=== build plugin kit ===\n")
  await $`bun run build`.cwd(PLUGIN_KIT_DIR)
}
