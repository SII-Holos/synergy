import type { LocaleController, LocalePreference, LocaleSwitchResult } from "@/context/locale"
import { isLocalePreference } from "@/context/locale/types"

type LocalePreferenceController = Pick<LocaleController, "setPreference">

export async function applyLocalePreference(input: {
  preference: LocalePreference
  controller: LocalePreferenceController
  onChange: (preference: LocalePreference) => void
}): Promise<LocaleSwitchResult> {
  const result = await input.controller.setPreference(input.preference)
  if (result.status !== "applied") return result
  input.onChange(input.preference)
  return result
}

export async function rollbackFailedLocalePatch(input: {
  patch: Record<string, unknown>
  authoritativePreference: LocalePreference | undefined
  controller: Pick<LocaleController, "rejectPendingPreference">
}): Promise<boolean> {
  const failedPreference = input.patch.locale
  if (!isLocalePreference(failedPreference)) return false
  return input.controller.rejectPendingPreference(failedPreference, input.authoritativePreference)
}
