import type { Accessor } from "solid-js"
import { For } from "solid-js"
import type { NoteAttachmentPart, SessionAttachmentPart, UploadedAttachmentPart } from "@/context/prompt"
import { AttachmentCard } from "@ericsanchezok/synergy-ui/attachment-card"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { uploadedPromptAttachmentToFile } from "./attachment-files"

export function PromptAttachments(props: {
  uploads: Accessor<UploadedAttachmentPart[]>
  notes: Accessor<NoteAttachmentPart[]>
  sessions: Accessor<SessionAttachmentPart[]>
  serverUrl: string
  removeAttachment: (id: string) => void
}) {
  const remove = (event: MouseEvent, id: string) => {
    event.stopPropagation()
    props.removeAttachment(id)
  }

  return (
    <div class="flex flex-wrap gap-2 px-3 pt-3">
      <For each={props.uploads()}>
        {(attachment) => (
          <div class="relative group w-56 max-w-full">
            <AttachmentCard file={uploadedPromptAttachmentToFile(attachment)} serverUrl={props.serverUrl} />
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.notes()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <Icon name="notebook-pen" size="small" class="shrink-0 text-text-interactive-base" />
              <span class="text-12-medium text-text-base max-w-[160px] truncate">{attachment.title || "Untitled"}</span>
            </div>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.sessions()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <Icon name="message-square" size="small" class="shrink-0 text-text-interactive-base" />
              <span class="text-12-medium text-text-base max-w-[180px] truncate">{attachment.title || "Untitled"}</span>
            </div>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
