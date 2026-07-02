import type { Accessor, Setter } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import type { ContentPart, NoteAttachmentPart, SessionAttachmentPart } from "@/context/prompt"
import { PromptAttachmentError, uploadPromptAttachment } from "@/utils/prompt-attachment"
import {
  formatUnsupportedAttachmentToast,
  isPromptAttachmentFileAccepted,
  partitionPromptAttachmentFiles,
} from "./files"
import { createPromptPartID } from "./content"
import { getCursorPosition } from "./editor-dom"
import type { BlueprintSlot, DroppedBlueprintData, DroppedSessionData, PromptInputStore } from "./types"

type PromptAttachmentsInput = {
  editor: () => HTMLDivElement
  isFocused: Accessor<boolean>
  addPart: (part: ContentPart) => void
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  localArmedLoop: Accessor<BlueprintSlot | null>
  setLocalArmedLoop: Setter<BlueprintSlot | null>
  activeLoopID: Accessor<string | undefined>
  setStore: SetStoreFunction<PromptInputStore>
}

const DROPPABLE_TYPES = [
  "Files",
  "application/x-synergy-note",
  "application/x-synergy-session",
  "application/x-synergy-blueprint",
]

export function usePromptAttachments(input: PromptAttachmentsInput) {
  const sdk = useSDK()
  const prompt = usePrompt()
  const params = useParams()
  const dialog = useDialog()

  const addAttachment = async (file: File) => {
    if (!isPromptAttachmentFileAccepted(file)) {
      const toast = formatUnsupportedAttachmentToast([file], 0)
      if (toast) showToast(toast)
      return
    }

    try {
      const cursorPosition = prompt.cursor() ?? getCursorPosition(input.editor())
      const uploaded = await uploadPromptAttachment(sdk.client, file)
      prompt.set(
        [
          ...prompt.current(),
          {
            type: "attachment",
            id: createPromptPartID(),
            filename: file.name,
            mime: uploaded.mime,
            url: uploaded.url,
            size: uploaded.size,
            metadata: uploaded.metadata,
            presentation: uploaded.presentation,
          },
        ],
        cursorPosition,
      )
    } catch (error) {
      const description =
        error instanceof PromptAttachmentError
          ? error.message
          : error instanceof Error
            ? error.message
            : "This attachment couldn’t be prepared. Try another file."

      showToast({
        type: "error",
        title: error instanceof PromptAttachmentError ? error.title : "Couldn’t attach file",
        description,
      })
    }
  }

  const addAttachments = async (files: Iterable<File>) => {
    const { accepted, rejected } = partitionPromptAttachmentFiles(files)
    const toast = formatUnsupportedAttachmentToast(rejected, accepted.length)
    if (toast) showToast(toast)
    for (const file of accepted) {
      await addAttachment(file)
    }
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => !("id" in part) || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    if (!input.isFocused()) return
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const items = Array.from(clipboardData.items)
    const files = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file)

    if (files.length > 0) {
      await addAttachments(files)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""
    input.addPart({ type: "text", content: plainText, start: 0, end: 0 })
  }

  const handleDragOver = (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    const hasDroppable = event.dataTransfer?.types.some((type) => DROPPABLE_TYPES.includes(type))
    if (hasDroppable) {
      input.setStore("dragging", true)
    }
  }

  const handleDragLeave = (event: DragEvent) => {
    if (dialog.active) return

    const currentTarget = event.currentTarget
    const relatedTarget = event.relatedTarget
    if (
      currentTarget instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return
    }

    input.setStore("dragging", false)
  }

  const handleDrop = async (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    input.setStore("dragging", false)

    const blueprintData = event.dataTransfer?.getData("application/x-synergy-blueprint")
    if (blueprintData) {
      try {
        const dropped = JSON.parse(blueprintData) as DroppedBlueprintData
        if (!dropped.noteID) return
        if (input.localArmedLoop() || input.activeLoopID()) {
          showToast({
            type: "warning",
            title: "Blueprint slot occupied",
            description: "Wait for the current BlueprintLoop to finish before equipping another Blueprint.",
          })
          return
        }
        input.setLocalArmedLoop({
          type: "pending",
          noteID: dropped.noteID,
          title: dropped.title || "Blueprint",
          runMode: "current",
        })
      } catch {}
      return
    }

    const sessionData = event.dataTransfer?.getData("application/x-synergy-session")
    if (sessionData) {
      try {
        const dropped = JSON.parse(sessionData) as DroppedSessionData
        if (!dropped.id || !dropped.directory) return
        if (dropped.id === params.id && dropped.directory === sdk.directory) return
        const existing = input
          .sessionAttachments()
          .find((attachment) => attachment.sessionId === dropped.id && attachment.directory === dropped.directory)
        if (existing) return
        const cursorPosition = prompt.cursor() ?? getCursorPosition(input.editor())
        prompt.set(
          [
            ...prompt.current(),
            {
              type: "session",
              id: createPromptPartID(),
              sessionId: dropped.id,
              directory: dropped.directory,
              title: dropped.title || "Untitled",
              updatedAt: dropped.updatedAt,
            },
          ],
          cursorPosition,
        )
      } catch {}
      return
    }

    const noteData = event.dataTransfer?.getData("application/x-synergy-note")
    if (noteData) {
      try {
        const { id: noteId, title, content } = JSON.parse(noteData)
        const existing = input.noteAttachments().find((note) => note.noteId === noteId)
        if (existing) return
        const cursorPosition = prompt.cursor() ?? getCursorPosition(input.editor())
        prompt.set(
          [
            ...prompt.current(),
            {
              type: "note",
              id: createPromptPartID(),
              noteId,
              title: title || "Untitled",
              content: content || "",
            },
          ],
          cursorPosition,
        )
      } catch {}
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    await addAttachments(Array.from(dropped))
  }

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
