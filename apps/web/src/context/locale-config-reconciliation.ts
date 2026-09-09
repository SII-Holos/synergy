import type { LocaleController, LocalePreference } from "./locale/types"

type LocaleConfigController = Pick<LocaleController, "reconcileGlobalPreference">

export function createLocaleConfigReconciliation(controller: LocaleConfigController) {
  let observed = false
  let preference: LocalePreference | undefined

  return {
    async sync(next: LocalePreference | undefined): Promise<void> {
      if (observed && preference === next) return
      observed = true
      preference = next
      await controller.reconcileGlobalPreference(next)
    },
  }
}
