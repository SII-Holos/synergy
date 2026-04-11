import { $ } from "bun"
import { REPO_ROOT } from "../shared/packages"

export async function bunInstall() {
  console.log("\n=== bun install ===\n")
  await $`bun install`.cwd(REPO_ROOT)
}
