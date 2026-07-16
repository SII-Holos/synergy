import type { LocaleController, LocalePreference } from "@/context/locale"

type LocalePreferenceController = Pick<LocaleController, "setPreference">

export async function applyLocalePreference(input: {
  preference: LocalePreference
  controller: LocalePreferenceController
  onChange: (preference: LocalePreference) => void
}): Promise<boolean> {
  const activated = await input.controller.setPreference(input.preference)
  if (!activated) return false
  input.onChange(input.preference)
  return true
}
