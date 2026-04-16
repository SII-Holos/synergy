import { $ } from "bun"
import { META_PROTOCOL_DIR } from "../shared/packages"

export async function buildMetaProtocol() {
  console.log("\n=== build meta-protocol ===\n")
  await $`bun run build`.cwd(META_PROTOCOL_DIR)
}
