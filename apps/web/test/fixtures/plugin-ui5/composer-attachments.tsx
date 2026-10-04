import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import "../../../src/index.css"
import { PromptAttachments } from "../../../src/components/prompt-input/attachments"
import type { PendingPromptAttachment } from "../../../src/components/prompt-input/pending-attachments"
import { i18n } from "./composer-attachments-locale"

function Fixture() {
  const [pending, setPending] = createSignal<PendingPromptAttachment[]>(
    ["first", "second", "third", "fourth"].map((id) => ({
      id,
      filename: `${id}.txt`,
      mime: "text/plain",
      size: 42,
      status: id === "third" ? "failed" : "uploading",
      ...(id === "third" ? { error: "Connection interrupted" } : {}),
    })),
  )
  const [retried, setRetried] = createSignal("")
  return (
    <I18nProvider i18n={i18n}>
      <style>{`body { margin: 0 } form { width: 100% }`}</style>
      <form>
        <PromptAttachments
          uploads={() => []}
          notes={() => []}
          sessions={() => []}
          pending={pending}
          order={() => ["first", "second", "third", "fourth"]}
          pendingFile={() => undefined}
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
    </I18nProvider>
  )
}
render(() => <Fixture />, document.getElementById("root")!)
