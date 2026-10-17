import { connectionStatusRows as channels } from "@ericsanchezok/synergy-channels/startup-status"
import { connectionStatusRows as holos } from "@ericsanchezok/synergy-holos/startup-status"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
export async function connectionStatusRows(report: (rows: RuntimeStatusRow[]) => void) {
  return [...(await channels(report)), ...(await holos())]
}
