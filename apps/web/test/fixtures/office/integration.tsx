import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { PlatformProvider } from "../../../src/context/platform"
import { DraftAttachmentPreview } from "../../../src/components/attachment-workbench/draft-preview"
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
const mime = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
function PreviewDialogFixture() {
  const dialog = useDialog()
  const url = `data:${mime[format]};base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`
  return (
    <button
      type="button"
      onClick={() =>
        dialog.show(() => (
          <DraftAttachmentPreview
            file={{ url, mime: mime[format], filename: `sample.${format}`, size: bytes.length }}
            serverUrl={location.origin}
            isValid={() => true}
            onInvalid={() => dialog.close()}
          />
        ))
      }
    >
      Open preview
    </button>
  )
}
render(
  () => (
    <I18nProvider i18n={setupI18n({ locale: "en" })}>
      <style>{"html,body,#root{height:100%;width:100%;margin:0}"}</style>
      {new URLSearchParams(location.search).has("dialog") ? (
        <PlatformProvider
          value={{ platform: "web", openLink: () => {}, restart: async () => {}, notify: async () => {} }}
        >
          <DialogProvider>
            <PreviewDialogFixture />
          </DialogProvider>
        </PlatformProvider>
      ) : (
        <OfficePreview format={format} bytes={bytes} />
      )}
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
