import type { Accessor } from "solid-js"
import type { ReencodeJobState } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SettingsSubsection } from "../components/SettingsPrimitives"
import { reencodeJobPercent } from "./library-reencode-model"

export function LibraryReencodeProgress(props: {
  job: Accessor<ReencodeJobState>
  cancelling: boolean
  onCancel: () => void
}) {
  const percent = () => reencodeJobPercent(props.job())

  return (
    <SettingsSubsection title={`Re-encoding ${props.job().type} records…`}>
      <div
        class="usage-window-meter"
        style="margin-bottom: 8px;"
        role="progressbar"
        aria-label={`Re-encoding ${props.job().type} records`}
        aria-valuemin="0"
        aria-valuemax={props.job().totalCount}
        aria-valuenow={props.job().completedCount}
      >
        <span style={{ width: `${percent()}%` }} />
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="gap:12px; display:flex;">
          <span class="usage-overview-label">
            {props.job().completedCount} / {props.job().totalCount}
          </span>
          <span class="usage-overview-label">Updated: {props.job().okCount}</span>
          <span class="usage-overview-label">Skipped: {props.job().skippedCount}</span>
          <span class="usage-overview-label">Failed: {props.job().failedCount}</span>
        </div>
        <Button type="button" variant="ghost" size="small" disabled={props.cancelling} onClick={props.onCancel}>
          {props.cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    </SettingsSubsection>
  )
}
