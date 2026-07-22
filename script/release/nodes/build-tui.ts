import { $ } from "bun"
import { TUI_DIR } from "../shared/packages"

export async function buildTui() {
  console.log("\n=== build tui ===\n")
  await $`bun run build`.cwd(TUI_DIR)
}
