export type SettingsSaveStatus = "idle" | "saving" | "saved" | "error" | "dirty"

type SourceSaveStatus = Exclude<SettingsSaveStatus, "dirty"> | "loading"

export function settingsSaveFooterStatus(input: {
  saving: boolean
  dirty: boolean
  resultCurrent: boolean
  aggregate: SourceSaveStatus
  server: SourceSaveStatus
  personalize: SourceSaveStatus
}): SettingsSaveStatus {
  if (input.saving || input.server === "saving" || input.personalize === "saving" || input.personalize === "loading")
    return "saving"
  if (input.dirty && !input.resultCurrent) return "dirty"
  if (input.aggregate === "error" || input.server === "error" || input.personalize === "error") return "error"
  if (input.dirty) return "dirty"
  if (input.aggregate === "saved" || input.server === "saved") return "saved"
  return "idle"
}
