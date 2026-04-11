import { FIXED_REGISTRY_PACKAGES } from "../shared/packages"
import { npmPromoteToLatest, npmTagMatches } from "../shared/runtime"

export async function promoteLatest(version: string, extraPackages: string[] = []) {
  console.log("\n=== promote latest ===\n")
  for (const packageName of [...FIXED_REGISTRY_PACKAGES, ...extraPackages]) {
    await npmPromoteToLatest(packageName, version)
  }
}

export async function verifyLatest(version: string, extraPackages: string[] = []) {
  console.log("\n=== verify latest ===\n")
  for (const packageName of [...FIXED_REGISTRY_PACKAGES, ...extraPackages]) {
    if (!(await npmTagMatches(packageName, "latest", version))) {
      throw new Error(`expected ${packageName}@${version} to be tagged latest`)
    }
  }
}
