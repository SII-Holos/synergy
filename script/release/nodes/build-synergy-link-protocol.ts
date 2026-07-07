import { $ } from "bun"
import { SYNERGY_LINK_PROTOCOL_DIR } from "../shared/packages"

export async function buildSynergyLinkProtocol() {
  console.log("\n=== build synergy-link-protocol ===\n")
  await $`bun run build`.cwd(SYNERGY_LINK_PROTOCOL_DIR)
}
