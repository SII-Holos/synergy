import type { Accessor } from "solid-js"
import { For } from "solid-js"
import type {
  ImageAttachmentPart,
  NoteAttachmentPart,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

export function PromptAttachments(props: {
  images: Accessor<ImageAttachmentPart[]>
  uploads: Accessor<UploadedAttachmentPart[]>
  notes: Accessor<NoteAttachmentPart[]>
  sessions: Accessor<SessionAttachmentPart[]>
  removeAttachment: (id: string) => void
}) {
  return (
    <div class="flex flex-wrap gap-2 px-3 pt-3">
      <For each={props.images()}>
        {(attachment) => (
          <div class="relative group">
            <img
              src={attachment.dataUrl}
              alt={attachment.filename}
              class="size-16 rounded-md object-cover border border-border-base"
            />
            <button
              type="button"
              onClick={() => props.removeAttachment(attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
            <div class="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md">
              <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
            </div>
          </div>
        )}
      </For>
      <For each={props.uploads()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <FileIcon node={{ path: attachment.filename, type: "file" }} class="shrink-0 size-5" />
              <span class="text-12-medium text-text-base max-w-[160px] truncate">{attachment.filename}</span>
            </div>
            <button
              type="button"
              onClick={() => props.removeAttachment(attachment.id)}
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
              onClick={() => props.removeAttachment(attachment.id)}
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
              onClick={() => props.removeAttachment(attachment.id)}
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
