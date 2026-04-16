import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { META_PROTOCOL_DIR } from "../shared/packages"

export async function publishMetaProtocolCandidate(version: string, channel: string) {
  console.log("\n=== publish meta-protocol candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: META_PROTOCOL_DIR,
    name: "@ericsanchezok/meta-protocol",
    version,
    channel,
  })
}
