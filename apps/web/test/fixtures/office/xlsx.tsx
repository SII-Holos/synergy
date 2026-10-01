import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { XlsxReader } from "../../../src/components/attachment-workbench/xlsx-reader"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/components/attachment-workbench/styles.css"
import { xlsxSample } from "./xlsx-sample"
render(
  () => (
    <I18nProvider
      i18n={setupI18n({
        locale: "en",
        messages: {
          en: {
            "app.attachment.office.notice": "Preview layout may differ from the original file.",
            "app.attachment.office.find": "Find in document",
            "app.attachment.xlsx.copyCells": "Copy selected cells",
            "app.attachment.xlsx.cellValue": "Cell value or formula",
            "app.attachment.xlsx.worksheets": "Worksheets",
            "app.attachment.xlsx.matches": "{count} matching cells",
            "app.attachment.office.nextMatch": "Next match",
          },
        },
      })}
    >
      <style>{"html,body,#root{height:100%;width:100%;margin:0}"}</style>
      <XlsxReader bytes={xlsxSample()} />
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
