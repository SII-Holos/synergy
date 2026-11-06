import type { LocaleController, LocalePreference } from "@/context/locale"
import { isLocalePreference } from "@/context/locale/types"

export async function prepareLocaleSettingsSave(
  patch: Record<string, unknown>,
  controller: LocaleController,
): Promise<void> {
  const preference = patch.locale
  if (!isLocalePreference(preference)) return

  const result = await controller.setPreference(preference)
  if (result.status === "failed") throw result.error
  if (result.status === "superseded") throw new Error("Locale activation was superseded")
}

export async function rejectLocaleSettingsSave(
  patch: Record<string, unknown>,
  controller: LocaleController,
  authoritative: LocalePreference | undefined,
): Promise<boolean> {
  const preference = patch.locale
  if (!isLocalePreference(preference)) return false
  return controller.rejectPendingPreference(preference, authoritative)
}
