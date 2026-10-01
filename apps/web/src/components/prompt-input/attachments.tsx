import type { Accessor } from "solid-js"
import { createMemo, For, Show } from "solid-js"
import type { NoteAttachmentPart, SessionAttachmentPart, UploadedAttachmentPart } from "@/context/prompt"
import {
  AttachmentCard,
  resolveImagePreviewImage,
  type AttachmentFile,
} from "@ericsanchezok/synergy-ui/attachment-card"
import type { ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { buildPromptUploadEntries } from "./attachment-preview"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import type { PendingPromptAttachment } from "./pending-attachments"
import { PendingAttachmentCard } from "./pending-attachment-card"
import { PI } from "./prompt-input-i18n"

type Entry = { id: string } & (
  | { kind: "pending"; value: PendingPromptAttachment }
  | { kind: "upload"; value: ReturnType<typeof buildPromptUploadEntries>[number] }
  | { kind: "note"; value: NoteAttachmentPart }
  | { kind: "session"; value: SessionAttachmentPart }
)

export function PromptAttachments(props: {
  uploads: Accessor<UploadedAttachmentPart[]>
  notes: Accessor<NoteAttachmentPart[]>
  sessions: Accessor<SessionAttachmentPart[]>
  pending: Accessor<PendingPromptAttachment[]>
  order: Accessor<string[]>
  pendingFile: (id: string) => File | undefined
  retryAttachment: (id: string) => Promise<void>
  serverUrl: string
  removeAttachment: (id: string) => void
  onOpen?: (file: AttachmentFile, id: string) => void
}) {
  const { i18n } = useLocale()
  let root!: HTMLDivElement
  const ordering = new Map<string, number>()
  let sequence = 0
  const uploadEntries = createMemo(() =>
    buildPromptUploadEntries(props.serverUrl, props.uploads(), resolveImagePreviewImage),
  )
  const previewImages = createMemo(() =>
    uploadEntries()
      .map((entry) => entry.imagePreview)
      .filter((image): image is ImagePreviewImage => !!image),
  )
  const entries = createMemo(() => {
    const uploaded = new Set(props.uploads().map((part) => part.id))
    const result: Entry[] = [
      ...uploadEntries().map((value) => ({ id: value.attachment.id, kind: "upload" as const, value })),
      ...props.notes().map((value) => ({ id: value.id, kind: "note" as const, value })),
      ...props.sessions().map((value) => ({ id: value.id, kind: "session" as const, value })),
      ...props
        .pending()
        .filter((entry) => !uploaded.has(entry.id))
        .map((value) => ({ id: value.id, kind: "pending" as const, value })),
    ]
    const byId = new Map(result.map((entry) => [entry.id, entry]))
    for (const id of [...props.order(), ...props.pending().map((entry) => entry.id)])
      if (byId.has(id) && !ordering.has(id)) ordering.set(id, sequence++)
    for (const entry of result) if (!ordering.has(entry.id)) ordering.set(entry.id, sequence++)
    return result.sort((a, b) => ordering.get(a.id)! - ordering.get(b.id)!)
  })
  const counts = () => ({
    uploading: props.pending().filter((entry) => entry.status === "uploading").length,
    failed: props.pending().filter((entry) => entry.status === "failed").length,
  })
  const remove = (id: string) => {
    const index = entries().findIndex((entry) => entry.id === id)
    const neighbor = entries()[index + 1]?.id ?? entries()[index - 1]?.id
    const fallback = root.closest("form")?.querySelector<HTMLButtonElement>(".prompt-input-add-button")
    props.removeAttachment(id)
    queueMicrotask(() => {
      const entry = Array.from(root.querySelectorAll<HTMLElement>("[data-attachment-id]")).find(
        (element) => element.dataset.attachmentId === neighbor,
      )
      ;(entry?.querySelector<HTMLElement>("button, a") ?? fallback)?.focus()
    })
  }
  return (
    <div class="prompt-attachments" ref={root}>
      <Show when={counts().uploading || counts().failed}>
        <div class="prompt-attachment-status" role="status">
          {i18n._({
            id: "prompt.attachments.pendingSummary",
            message: "{uploading} uploading · {failed} failed",
            values: counts(),
          })}
          <Show when={counts().failed}>
            <button
              type="button"
              onClick={() => {
                queueMicrotask(() => root.querySelector<HTMLButtonElement>('[data-slot="attachment-retry"]')?.focus())
              }}
            >
              {i18n._({ id: "prompt.attachments.resolveFailed", message: "Review failed attachments" })}
            </button>
          </Show>
        </div>
      </Show>
      <div
        data-slot="attachment-row-layout"
        role="group"
        aria-label={i18n._({ id: "prompt.attachments.list", message: "Attachments" })}
        tabIndex={0}
      >
        <For each={entries()}>
          {(entry) => (
            <div data-slot="attachment-row-entry" data-attachment-id={entry.id}>
              <Show
                when={entry.kind !== "pending"}
                fallback={
                  entry.kind === "pending" && (
                    <PendingAttachmentCard
                      entry={entry.value}
                      file={props.pendingFile(entry.id)}
                      uploadingLabel={i18n._(PI.attachUploadingStatus)}
                      uploadedLabel={i18n._(PI.attachUploadedStatus)}
                      failedLabel={i18n._({ id: "prompt.attachments.failed", message: "Upload failed" })}
                      retryLabel={i18n._({ id: "prompt.attachments.retry", message: "Retry upload" })}
                      removeLabel={i18n._({ ...PI.attachRemoveButton, values: { filename: entry.value.filename } })}
                      onRemove={remove}
                      onRetry={(id) => void props.retryAttachment(id)}
                    />
                  )
                }
              >
                <div class="prompt-attachment-entry relative group">
                  <Show
                    when={entry.kind === "upload"}
                    fallback={
                      <div class="prompt-attachment-reference">
                        <Icon
                          name={getSemanticIcon(entry.kind === "note" ? "notes.main" : "session.default")}
                          size="small"
                        />
                        <span title={entry.kind === "note" || entry.kind === "session" ? entry.value.title : undefined}>
                          {entry.kind === "note" || entry.kind === "session"
                            ? entry.value.title || i18n._({ id: "prompt.attachments.untitled", message: "Untitled" })
                            : ""}
                        </span>
                      </div>
                    }
                  >
                    {entry.kind === "upload" && (
                      <AttachmentCard
                        file={entry.value.file}
                        serverUrl={props.serverUrl}
                        compact="draft"
                        onOpen={props.onOpen ? (file) => props.onOpen?.(file, entry.id) : undefined}
                        imagePreview={
                          entry.value.imagePreviewIndex !== undefined
                            ? { images: previewImages(), index: entry.value.imagePreviewIndex }
                            : undefined
                        }
                      />
                    )}
                  </Show>
                  <button
                    type="button"
                    class="prompt-attachment-remove"
                    aria-label={i18n._({
                      ...PI.attachRemoveButton,
                      values: {
                        filename:
                          entry.kind === "upload"
                            ? entry.value.attachment.filename
                            : entry.kind === "note" || entry.kind === "session"
                              ? entry.value.title
                              : "",
                      },
                    })}
                    onClick={(event) => {
                      event.stopPropagation()
                      remove(entry.id)
                    }}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" />
                  </button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
