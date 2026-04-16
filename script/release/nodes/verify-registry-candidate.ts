import { FIXED_REGISTRY_PACKAGES } from "../shared/packages"
import { npmTagMatches, npmVersionExists } from "../shared/runtime"

export async function verifyRegistryCandidate(version: string, channel: string, extraPackages: string[] = []) {
  console.log("\n=== verify registry candidate ===\n")
  for (const packageName of [...FIXED_REGISTRY_PACKAGES, ...extraPackages]) {
    if (!(await npmVersionExists(packageName, version))) {
      throw new Error(`missing registry version: ${packageName}@${version}`)
    }
    if (!(await npmTagMatches(packageName, channel, version))) {
      throw new Error(`expected ${packageName}@${version} to be tagged ${channel}`)
    }
  }
}
