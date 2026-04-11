import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { PLUGIN_DIR } from "../shared/packages"

export async function publishPluginCandidate(version: string, channel: string) {
  console.log("\n=== publish plugin candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: PLUGIN_DIR,
    name: "@ericsanchezok/synergy-plugin",
    version,
    channel,
  })
}
