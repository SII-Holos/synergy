import type { DependencyVersionMap } from "../shared/package-manifest"
import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { SDK_DIR } from "../shared/packages"

export async function publishSdkCandidate(version: string, channel: string, dependencyVersions?: DependencyVersionMap) {
  console.log("\n=== publish sdk candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: SDK_DIR,
    name: "@ericsanchezok/synergy-sdk",
    version,
    channel,
    dependencyVersions,
  })
}
