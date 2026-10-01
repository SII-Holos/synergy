import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { DocxReader } from "../../../src/components/attachment-workbench/docx-reader"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/components/attachment-workbench/styles.css"
import { docxSample } from "./samples"

render(() => {
  const [bytes, setBytes] = createSignal(docxSample())
  return (
    <I18nProvider
      i18n={setupI18n({
        locale: "en",
        messages: {
          en: {
            "app.attachment.office.notice": "Preview layout may differ from the original file.",
            "app.attachment.office.corrupt": "This file is damaged or incomplete. Download the original to check it.",
            "app.attachment.office.encrypted":
              "Encrypted Office files cannot be previewed. Download the original to open it.",
            "app.attachment.office.find": "Find in document",
            "app.attachment.office.matches": "{count} matching pages",
            "app.attachment.office.nextMatch": "Next match",
            "app.attachment.pdf.previousPage": "Previous page",
            "app.attachment.pdf.nextPage": "Next page",
            "app.attachment.pdf.pagePosition": "{page} / {count}",
            "app.attachment.pdf.fitWidth": "Fit width",
            "app.attachment.pdf.zoomIn": "Zoom in",
            "app.attachment.pdf.zoomOut": "Zoom out",
          },
        },
      })}
    >
      <style>{"html,body,#root {margin:0;width:100%;height:100%}"}</style>
      <button data-fixture type="button" onClick={() => setBytes(docxSample("单页替换文档", false))}>
        Single page sample
      </button>
      <button data-fixture type="button" onClick={() => setBytes(docxSample())}>
        Valid sample
      </button>
      <button data-fixture type="button" onClick={() => setBytes(new Uint8Array([1, 2]))}>
        Corrupt sample
      </button>
      <button
        data-fixture
        type="button"
        onClick={() => setBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))}
      >
        Encrypted sample
      </button>
      <DocxReader bytes={bytes()} filename="sample.docx" />
    </I18nProvider>
  )
}, document.getElementById("root")!)
