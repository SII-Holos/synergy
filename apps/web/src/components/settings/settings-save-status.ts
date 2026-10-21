export type SettingsSaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "error"
  | "dirty"
  | "loading"
  | "invalid"
  | "partial"
  | "refresh"

type SourceSaveStatus = Exclude<SettingsSaveStatus, "dirty"> | "loading"

export function settingsSaveFooterStatus(input: {
  saving: boolean
  loading?: boolean
  refreshPending?: boolean
  dirty: boolean
  resultCurrent: boolean
  aggregate: SourceSaveStatus
  server: SourceSaveStatus
  personalize: SourceSaveStatus
}): SettingsSaveStatus {
  if (input.saving || input.server === "saving" || input.personalize === "saving") return "saving"
  if (input.loading || input.personalize === "loading") return "loading"
  if (input.refreshPending) return input.aggregate === "partial" && input.resultCurrent ? "partial" : "refresh"
  if (input.resultCurrent && ["invalid", "partial", "refresh"].includes(input.aggregate)) return input.aggregate
  if (input.dirty && !input.resultCurrent) return "dirty"
  if (input.resultCurrent && (input.aggregate === "error" || input.server === "error" || input.personalize === "error"))
    return "error"
  if (input.dirty) return "dirty"
  if (input.resultCurrent && (input.aggregate === "saved" || input.server === "saved")) return "saved"
  return "idle"
}
