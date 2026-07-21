import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { SYNERGY_LINK_PROTOCOL_DIR } from "../shared/packages"

export async function publishSynergyLinkProtocolCandidate(version: string, channel: string) {
  console.log("\n=== publish synergy-link-protocol candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: SYNERGY_LINK_PROTOCOL_DIR,
    name: "@ericsanchezok/synergy-link-protocol",
    version,
    channel,
  })
}
