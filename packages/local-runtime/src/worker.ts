import { version } from "../package.json" with { type: "json" }
export const metadata = { id: "local-runtime", version, apiVersion: 1 }
import { registerConfig } from "./config-schema"
import { registerLocalProviderSdks } from "./provider/sdk-registry"

export function registerWorker() {
  registerConfig()
  registerLocalProviderSdks()
}
