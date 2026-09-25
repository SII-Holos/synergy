import { registerSandboxHelper } from "./sandbox/helper-source"
import { packagedSandboxHelper } from "./helper-assets"

export function registerLocalSandboxHelper() {
  const asset = packagedSandboxHelper()
  if (asset) registerSandboxHelper(asset)
}
