import { $ } from "bun"
import { WEB_DIR } from "../shared/packages"

export async function buildApp() {
  console.log("\n=== build app ===\n")
  await $`bun run build`.cwd(WEB_DIR)
}
