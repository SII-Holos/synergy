import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { showToast } from "@ericsanchezok/synergy-ui/toast"

export type CopySessionIDLabels = {
  successTitle: string
  failureLabel: string
  failureDescription: string
}

/**
 * Copy the raw session ID to the clipboard.
 *
 * Failure feedback is owned by the global clipboard failure hook configured
 * in entry.tsx (it renders the failure toast); a success toast is only shown
 * here because the menu closes before inline feedback could be seen.
 */
export async function copySessionID(sessionID: string, labels: CopySessionIDLabels): Promise<void> {
  const result = await copyTextToClipboard(sessionID, {
    label: labels.failureLabel,
    failureDescription: labels.failureDescription,
  })
  if (result.ok) {
    showToast({ type: "success", title: labels.successTitle })
  }
}
