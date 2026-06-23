import type { Accessor, Setter } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import type { ContentPart, NoteAttachmentPart, SessionAttachmentPart } from "@/context/prompt"
import {
  isTextAttachmentFile,
  preparePromptAttachment,
  PromptAttachmentError,
  uploadPromptAttachment,
} from "@/utils/prompt-attachment"
import { ACCEPTED_FILE_TYPES } from "./files"
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
  setBlueprintLoading: Setter<boolean>
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
    if (!ACCEPTED_FILE_TYPES.includes(file.type) && !isTextAttachmentFile(file)) return

    try {
      const cursorPosition = prompt.cursor() ?? getCursorPosition(input.editor())
      if (isTextAttachmentFile(file)) {
        const uploaded = await uploadPromptAttachment(sdk.client, sdk.url, file)
        prompt.set(
          [
            ...prompt.current(),
            {
              type: "attachment",
              id: createPromptPartID(),
              filename: file.name,
              mime: uploaded.mime,
              url: uploaded.url,
            },
          ],
          cursorPosition,
        )
        return
      }

      const prepared = await preparePromptAttachment(file)
      if (prepared.mime.startsWith("image/")) {
        prompt.set(
          [
            ...prompt.current(),
            {
              type: "image",
              id: createPromptPartID(),
              filename: file.name,
              mime: prepared.mime,
              dataUrl: prepared.dataUrl,
            },
          ],
          cursorPosition,
        )
        return
      }

      prompt.set(
        [
          ...prompt.current(),
          {
            type: "attachment",
            id: createPromptPartID(),
            filename: file.name,
            mime: prepared.mime,
            url: prepared.dataUrl,
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
    const imageItems = items.filter((item) => ACCEPTED_FILE_TYPES.includes(item.type))

    if (imageItems.length > 0) {
      for (const item of imageItems) {
        const file = item.getAsFile()
        if (file) await addAttachment(file)
      }
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

    const blueprintData = event.dataTransfer?.getData("application/x-synergy-blueprint")
    if (blueprintData) {
      try {
        const dropped = JSON.parse(blueprintData) as DroppedBlueprintData
        if (!dropped.noteID) return
        if (input.localArmedLoop()) {
          showToast({
            type: "warning",
            title: "Slot occupied",
            description: "Remove the armed Blueprint before equipping another.",
          })
          return
        }
        input.setBlueprintLoading(true)
        try {
          const sessionID = params.id
          if (!sessionID) {
            showToast({
              type: "warning",
              title: "No session available",
              description: "Start a session before equipping a Blueprint.",
            })
            return
          }
          const result = await sdk.client.blueprint.loop.create({
            blueprintLoopCreateInput: {
              noteID: dropped.noteID,
              title: dropped.title || "Blueprint",
              sessionID,
              runMode: "current",
            },
          })
          const loop = result.data as BlueprintLoopInfo | undefined
          if (!loop) throw new Error("Loop creation returned no data")
          input.setLocalArmedLoop({
            loopID: loop.id,
            noteID: loop.noteID,
            title: loop.title,
            runMode: loop.runMode ?? "current",
          })
        } catch (err) {
          showToast({
            type: "error",
            title: "Failed to arm Blueprint",
            description: err instanceof Error ? err.message : "Unknown error",
          })
        } finally {
          input.setBlueprintLoading(false)
        }
      } catch {}
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    for (const file of Array.from(dropped)) {
      if (ACCEPTED_FILE_TYPES.includes(file.type) || isTextAttachmentFile(file)) {
        await addAttachment(file)
      }
    }
  }

  return {
    addAttachment,
    removeAttachment,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
