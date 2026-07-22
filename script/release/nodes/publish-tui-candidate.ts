import type { DependencyVersionMap } from "../shared/package-manifest"
import { publishGenericWorkspacePackage } from "../shared/publish-generic"
import { TUI_DIR } from "../shared/packages"

export async function publishTuiCandidate(version: string, channel: string, dependencyVersions?: DependencyVersionMap) {
  console.log("\n=== publish tui candidate ===\n")
  await publishGenericWorkspacePackage({
    dir: TUI_DIR,
    name: "@ericsanchezok/synergy-tui",
    version,
    channel,
    dependencyVersions,
  })
}
