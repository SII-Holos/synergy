import type { Accessor } from "solid-js"
import { createMemo, For } from "solid-js"
import type { NoteAttachmentPart, SessionAttachmentPart, UploadedAttachmentPart } from "@/context/prompt"
import { AttachmentCard, resolveImagePreviewImage } from "@ericsanchezok/synergy-ui/attachment-card"
import type { ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { buildPromptUploadEntries } from "./attachment-preview"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import type { PendingPromptAttachment } from "./pending-attachments"
import { PendingAttachmentCard } from "./pending-attachment-card"
import { PI } from "./prompt-input-i18n"

export function PromptAttachments(props: {
  uploads: Accessor<UploadedAttachmentPart[]>
  notes: Accessor<NoteAttachmentPart[]>
  sessions: Accessor<SessionAttachmentPart[]>
  pending: Accessor<PendingPromptAttachment[]>
  serverUrl: string
  removeAttachment: (id: string) => void
}) {
  const { i18n } = useLocale()
  const remove = (event: MouseEvent, id: string) => {
    event.stopPropagation()
    props.removeAttachment(id)
  }

  const flashingIds = createMemo(
    () =>
      new Set(
        props
          .pending()
          .filter((entry) => entry.status === "uploaded")
          .map((entry) => entry.id),
      ),
  )
  const uploadEntries = createMemo(() =>
    buildPromptUploadEntries(
      props.serverUrl,
      props.uploads().filter((attachment) => !flashingIds().has(attachment.id)),
      resolveImagePreviewImage,
    ),
  )
  const previewImages = createMemo(() =>
    uploadEntries()
      .map((entry) => entry.imagePreview)
      .filter((image): image is ImagePreviewImage => Boolean(image)),
  )

  return (
    <div class="flex flex-wrap gap-2 px-3 pt-3">
      <For each={props.pending()}>
        {(entry) => (
          <PendingAttachmentCard
            entry={entry}
            uploadingLabel={i18n._(PI.attachUploadingStatus)}
            uploadedLabel={i18n._(PI.attachUploadedStatus)}
            removeLabel={i18n._({ ...PI.attachRemoveButton, values: { filename: entry.filename } })}
            onRemove={props.removeAttachment}
          />
        )}
      </For>
      <For each={uploadEntries()}>
        {(entry) => (
          <div class="relative group w-56 max-w-full">
            <AttachmentCard
              file={entry.file}
              serverUrl={props.serverUrl}
              imagePreview={
                entry.imagePreviewIndex !== undefined
                  ? { images: previewImages(), index: entry.imagePreviewIndex }
                  : undefined
              }
            />
            <button
              type="button"
              onClick={(event) => remove(event, entry.attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name={getSemanticIcon("action.close")} class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.notes()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <Icon name={getSemanticIcon("notes.main")} size="small" class="shrink-0 text-text-interactive-base" />
              <span class="text-12-medium text-text-base max-w-[160px] truncate">{attachment.title || "Untitled"}</span>
            </div>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name={getSemanticIcon("action.close")} class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.sessions()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <Icon
                name={getSemanticIcon("session.default")}
                size="small"
                class="shrink-0 text-text-interactive-base"
              />
              <span class="text-12-medium text-text-base max-w-[180px] truncate">{attachment.title || "Untitled"}</span>
            </div>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name={getSemanticIcon("action.close")} class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
