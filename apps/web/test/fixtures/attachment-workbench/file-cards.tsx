import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { MetaProvider } from "@solidjs/meta"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { AttachmentCard, AttachmentGallery, type AttachmentFile } from "@ericsanchezok/synergy-ui/attachment-card"
import { PendingAttachmentCard } from "../../../src/components/prompt-input/pending-attachment-card"
import type { PendingPromptAttachment } from "../../../src/components/prompt-input/pending-attachments"
import { PI } from "../../../src/components/prompt-input/prompt-input-i18n"
import { messages as en } from "../../../src/locales/en/messages.po"
import { messages as zh } from "../../../src/locales/zh-CN/messages.po"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/index.css"
import "./file-cards.css"

const params = new URLSearchParams(location.search)
const locale = params.get("locale") ?? "zh-CN"
const i18n = setupI18n({ locale, messages: { en, "zh-CN": zh } })
const files: AttachmentFile[] = [
  { filename: "message.html", mime: "text/html", size: 253, url: "data:text/html,preview" },
  { filename: "季度分析报告.pdf", mime: "application/pdf", size: 1258291, url: "data:application/pdf,preview" },
  {
    filename: "workspace-attachment-reference-and-responsive-layout-review.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 45260,
    url: "data:application/octet-stream,preview",
  },
  { filename: "measurements.csv", mime: "text/csv", size: 8704, url: "data:text/csv,value" },
]
const image = (filename: string): AttachmentFile => ({
  filename,
  mime: "image/svg+xml",
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#edf1f4"/><path d="M40 130V80h35v50m20 0V45h35v85m20 0V65h35v65" fill="#8395a3"/></svg>',
    ),
})
const opened: string[] = []
function Examples() {
  useTheme().setColorScheme(params.get("theme") === "dark" ? "dark" : "light")
  const [uploads, setUploads] = createStore<PendingPromptAttachment[]>([
    { id: "uploading", filename: "research-notes.docx", mime: files[2]!.mime, size: 45260, status: "uploading" },
    { id: "uploaded", filename: "measurements.csv", mime: "text/csv", size: 8704, status: "uploaded" },
    {
      id: "failed",
      filename: "quarterly-review.pdf",
      mime: "application/pdf",
      size: 1258291,
      status: "failed",
      error: "The upload was interrupted. Retry to send this file.",
    },
  ])
  return (
    <main class="synergy-workbench-canvas file-cards-review">
      <header>
        <h1>Attachments</h1>
        <p>Real components · production fonts · sample files</p>
      </header>
      <section data-example="process">
        <h2>Tool output</h2>
        <div data-slot="activity-evidence">
          <AttachmentGallery files={files} serverUrl={location.origin} layout="rows" compact="process" />
        </div>
      </section>
      <section data-example="message">
        <h2>Message attachments</h2>
        <div data-component="user-message" data-variant="turn-bubble">
          <div data-slot="user-message-attachments">
            <AttachmentGallery
              files={[files[1]!, files[2]!]}
              serverUrl={location.origin}
              layout="rows"
              compact="user"
              align="end"
            />
          </div>
        </div>
      </section>
      <section data-example="standard">
        <h2>Delivered files</h2>
        <AttachmentGallery files={[files[0]!, files[2]!]} serverUrl={location.origin} />
      </section>
      <section data-example="uploads">
        <h2>Upload states</h2>
        <div class="file-cards-review-row">
          <For each={uploads}>
            {(entry) => (
              <PendingAttachmentCard
                entry={entry}
                uploadingLabel={i18n._(PI.attachUploadingStatus)}
                uploadedLabel={i18n._(PI.attachUploadedStatus)}
                failedLabel={i18n._({ id: "prompt.attachments.failed", message: "Upload failed" })}
                retryLabel={i18n._({ id: "prompt.attachments.retry", message: "Retry upload" })}
                removeLabel={i18n._({ ...PI.attachRemoveButton, values: { filename: entry.filename } })}
                onRemove={(id) => setUploads((entries) => entries.filter((entry) => entry.id !== id))}
                onRetry={(id) => setUploads((entry) => entry.id === id, "status", "uploading")}
              />
            )}
          </For>
        </div>
      </section>
      <section data-example="images">
        <h2>Images retain their previews</h2>
        <AttachmentGallery
          files={[image("chart.svg"), image("overview.svg")]}
          serverUrl={location.origin}
          layout="rows"
          compact="user"
        />
      </section>
      <section data-example="narrow" class="file-cards-review-narrow">
        <h2>Narrow pane</h2>
        <div id="narrow-pane">
          <AttachmentCard file={files[2]!} serverUrl={location.origin} compact="draft" />
        </div>
      </section>
    </main>
  )
}
Object.assign(window, { fileCards: { opened } })
render(
  () => (
    <MetaProvider>
      <Font />
      <I18nProvider i18n={i18n}>
        <ThemeProvider>
          <ResourceOpenProvider
            value={{
              open: async (resource) => {
                if (resource.kind === "attachment") opened.push(resource.file.filename ?? "")
                return { status: "opened" }
              },
            }}
          >
            <Examples />
          </ResourceOpenProvider>
        </ThemeProvider>
      </I18nProvider>
    </MetaProvider>
  ),
  document.getElementById("root")!,
)
