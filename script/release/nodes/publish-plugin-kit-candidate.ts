import { publishGenericWorkspacePackage, type DependencyVersionMap } from "../shared/publish-generic"
import { PLUGIN_KIT_DIR } from "../shared/packages"

export async function publishPluginKitCandidate(
  version: string,
  channel: string,
  dependencyVersions?: DependencyVersionMap,
) {
  console.log("\n=== publish plugin-kit candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: PLUGIN_KIT_DIR,
    name: "@ericsanchezok/synergy-plugin-kit",
    version,
    channel,
    dependencyVersions,
  })
}
