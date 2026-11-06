import { createEffect, type Accessor } from "solid-js"
import { useLocale, type LocalePreference } from "./locale"
import { createLocaleConfigReconciliation } from "./locale-config-reconciliation"

export function LocaleConfigReconciler(props: { preference: Accessor<LocalePreference | undefined> }) {
  const locale = useLocale()
  const reconciliation = createLocaleConfigReconciliation(locale.controller)

  createEffect(() => {
    const preference = props.preference()
    void reconciliation.sync(preference)
  })

  return null
}
