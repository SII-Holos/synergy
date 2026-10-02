import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { OfficePreview } from "../../../src/components/attachment-workbench/office-preview"
import { docxSample } from "./samples"
render(
  () => (
    <I18nProvider
      i18n={setupI18n({
        locale: "en",
        messages: {
          en: {
            "app.attachment.preview.error": "Unable to preview this attachment.",
          },
        },
      })}
    >
      <button data-owner>Original attachment actions</button>
      <OfficePreview format="docx" bytes={docxSample()} />
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
