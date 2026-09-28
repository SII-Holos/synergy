import { pathToFileURL, fileURLToPath } from "node:url"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"

export namespace LSPPaths {
  function options() {
    return { windows: (EnvironmentResources.current()?.runtime?.platform ?? process.platform) === "win32" }
  }
  export function url(path: string) {
    return pathToFileURL(path, options()).href
  }
  export function path(url: string) {
    return fileURLToPath(url, options())
  }
}
