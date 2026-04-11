import type { Component } from "solid-js"
import { PageIntro } from "../components"
import { useDictionary } from "../locale"
import { ImportStep } from "../steps/import"

export const ImportPhase: Component = () => {
  const { t } = useDictionary()

  return (
    <div class="su-import-layout">
      <PageIntro title={t("importTitle")} copy={t("importDescription")} class="su-import-intro" />
      <ImportStep />
    </div>
  )
}
