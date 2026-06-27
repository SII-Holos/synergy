import { $ } from "bun"
import { DESKTOP_DIR } from "../shared/packages"

export async function buildDesktop() {
  console.log("\n=== build desktop ===\n")
  await $`bun run desktop:build`.cwd(DESKTOP_DIR)
}
