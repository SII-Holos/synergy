import { $ } from "bun"
import { APP_DIR } from "../shared/packages"

export async function buildApp() {
  console.log("\n=== build app ===\n")
  await $`bun run build`.cwd(APP_DIR)
}
