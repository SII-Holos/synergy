import { $ } from "bun"
import { UTIL_DIR } from "../shared/packages"

export async function buildUtil() {
  console.log("\n=== build util ===\n")
  await $`bun run build`.cwd(UTIL_DIR)
}
