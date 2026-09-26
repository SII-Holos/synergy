import type { DependencyVersionMap } from "../shared/package-manifest"
import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { UTIL_DIR } from "../shared/packages"

export async function publishUtilCandidate(
  version: string,
  channel: string,
  dependencyVersions?: DependencyVersionMap,
) {
  console.log("\n=== publish util candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: UTIL_DIR,
    name: "@ericsanchezok/synergy-util",
    version,
    channel,
    dependencyVersions,
  })
}
