import type { Accessor } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ReencodeJobState } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SettingsSubsection } from "../components/SettingsPrimitives"
import { reencodeJobPercent } from "./library-reencode-model"

function updatedText(count: number) {
  return { id: "settings.library.reencode.updated", message: "Updated: {count}", values: { count } }
}
function skippedText(count: number) {
  return { id: "settings.library.reencode.skipped", message: "Skipped: {count}", values: { count } }
}
function failedText(count: number) {
  return { id: "settings.library.reencode.failed", message: "Failed: {count}", values: { count } }
}
const cancelLabel = { id: "settings.library.reencode.cancel", message: "Cancel" }
const cancellingLabel = { id: "settings.library.reencode.cancelling", message: "Cancelling\u2026" }

function progressTitle(type: string) {
  return { id: "settings.library.reencode.progress", message: "Re-encoding {type} records…", values: { type } }
}
function progressAria(type: string) {
  return { id: "settings.library.reencode.progress.aria", message: "Re-encoding {type} records", values: { type } }
}

export function LibraryReencodeProgress(props: {
  job: Accessor<ReencodeJobState>
  cancelling: boolean
  onCancel: () => void
}) {
  const { _ } = useLingui()
  const percent = () => reencodeJobPercent(props.job())

  return (
    <SettingsSubsection title={_(progressTitle(props.job().type))}>
      <div
        class="usage-window-meter"
        style="margin-bottom: 8px;"
        role="progressbar"
        aria-label={_(progressAria(props.job().type))}
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
          <span class="usage-overview-label">{_(updatedText(props.job().okCount))}</span>
          <span class="usage-overview-label">{_(skippedText(props.job().skippedCount))}</span>
          <span class="usage-overview-label">{_(failedText(props.job().failedCount))}</span>
        </div>
        <Button type="button" variant="ghost" size="small" disabled={props.cancelling} onClick={props.onCancel}>
          {props.cancelling ? _(cancellingLabel) : _(cancelLabel)}
        </Button>
      </div>
    </SettingsSubsection>
  )
}
