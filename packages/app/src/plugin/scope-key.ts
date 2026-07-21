import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { HOME_SCOPE_KEY } from "@/utils/scope"

export function resolvePluginScopeKey(dir: string | undefined, search: string) {
  if (dir) return base64Decode(dir)
  const encoded = new URLSearchParams(search).get("_scope")
  return encoded ? base64Decode(encoded) : HOME_SCOPE_KEY
}
