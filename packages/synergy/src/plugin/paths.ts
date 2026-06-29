import path from "path"
import { Global } from "../global"

export namespace PluginPaths {
  export function authFile(pluginId: string) {
    return path.join(Global.Path.data, "plugin", pluginId, "auth.json")
  }

  export function cacheDir(pluginId: string) {
    return path.join(Global.Path.cache, "plugin", pluginId)
  }

  export function signingKeysDir() {
    return path.join(Global.Path.root, "keys")
  }

  export function signingKeyFile() {
    return path.join(signingKeysDir(), "signing-key.json")
  }

  export function trustedSigningKeysDir() {
    return path.join(signingKeysDir(), "trusted")
  }
}
