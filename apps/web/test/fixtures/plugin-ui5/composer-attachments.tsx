import { I18nProvider } from "@lingui/solid"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import "@ericsanchezok/synergy-ui/styles"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import "../../../src/index.css"
import { PromptAttachments } from "../../../src/components/prompt-input/attachments"
import type { PendingPromptAttachment } from "../../../src/components/prompt-input/pending-attachments"
import type { UploadedAttachmentPart } from "../../../src/context/prompt"
import { i18n } from "./composer-attachments-locale"

function Fixture() {
  const imageMode = location.search === "?image"
  const imageUrl =
    "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"/>')
  const imageFile = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"/>'], "portrait.svg", {
    type: "image/svg+xml",
  })
  const [uploads, setUploads] = createSignal<UploadedAttachmentPart[]>([])
  const [pending, setPending] = createSignal<PendingPromptAttachment[]>(
    imageMode
      ? [{ id: "image", filename: "portrait.svg", mime: "image/svg+xml", status: "uploading", size: imageFile.size }]
      : ["first", "second", "third", "fourth"].map((id) => ({
          id,
          filename: `${id}.txt`,
          mime: "text/plain",
          size: 42,
          status: id === "third" ? "failed" : "uploading",
          ...(id === "third" ? { error: "Connection interrupted" } : {}),
        })),
  )
  Object.assign(window, {
    fixture: {
      complete: () => {
        setUploads([
          { type: "attachment", id: "image", mime: "image/svg+xml", filename: "portrait.svg", url: imageUrl },
        ])
        setPending([])
      },
      fail: () =>
        setPending([
          {
            id: "image",
            filename: "portrait.svg",
            mime: "image/svg+xml",
            size: imageFile.size,
            status: "failed",
            error: "Connection interrupted",
          },
        ]),
    },
  })
  const [retried, setRetried] = createSignal("")
  return (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <style>{`body { margin: 0 } form { width: 100% }`}</style>
        <form>
          <PromptAttachments
            uploads={uploads}
            notes={() => []}
            sessions={() => []}
            pending={pending}
            order={() => (imageMode ? ["image"] : ["first", "second", "third", "fourth"])}
            pendingFile={() => (imageMode ? imageFile : undefined)}
            retryAttachment={async (id) => {
              setRetried(id)
            }}
            serverUrl={location.origin}
            removeAttachment={(id) => setPending((value) => value.filter((item) => item.id !== id))}
          />
          <button type="button" class="prompt-input-add-button">
            Add attachment
          </button>
        </form>
        <output id="retried">{retried()}</output>
      </DialogProvider>
    </I18nProvider>
  )
}
render(() => <Fixture />, document.getElementById("root")!)
