import { connectionStatusRows as channels } from "@ericsanchezok/synergy-channels/startup-status"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
export async function connectionStatusRows(report: (rows: RuntimeStatusRow[]) => void) {
  return channels(report)
}
