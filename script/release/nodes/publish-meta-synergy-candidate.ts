import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { META_SYNERGY_DIR } from "../shared/packages"

export async function publishMetaSynergyCandidate(version: string, channel: string) {
  console.log("\n=== publish meta-synergy candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: META_SYNERGY_DIR,
    name: "@ericsanchezok/meta-synergy",
    version,
    channel,
  })
}
