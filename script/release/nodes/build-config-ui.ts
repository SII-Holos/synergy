import { $ } from "bun"
import { CONFIG_UI_DIR } from "../shared/packages"

export async function buildConfigUI() {
  console.log("\n=== build config ui ===\n")
  await $`bun run build`.cwd(CONFIG_UI_DIR)
}
