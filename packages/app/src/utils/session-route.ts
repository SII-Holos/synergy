import { base64Encode } from "@ericsanchezok/synergy-util/encode"

export function globalSessionRoute() {
  return `/${base64Encode("global")}/session`
}

export function directorySessionRoute(encodedDir: string | undefined) {
  return encodedDir ? `/${encodedDir}/session` : globalSessionRoute()
}
