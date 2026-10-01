import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { OfficePreview } from "../../../src/components/attachment-workbench/office-preview"
import type { OfficeFormat } from "../../../src/components/attachment-workbench/office-contract"
import { docxSample } from "./samples"
import { xlsxSample } from "./xlsx-sample"
import { pptxSample } from "./pptx-sample"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/components/attachment-workbench/styles.css"

const format = (new URLSearchParams(location.search).get("format") ?? "docx") as OfficeFormat
const samples = { docx: docxSample, xlsx: xlsxSample, pptx: pptxSample }
const bytes = await samples[format]()
render(
  () => (
    <I18nProvider i18n={setupI18n({ locale: "en" })}>
      <style>{"html,body,#root{height:100%;width:100%;margin:0}"}</style>
      <OfficePreview format={format} bytes={bytes} />
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
