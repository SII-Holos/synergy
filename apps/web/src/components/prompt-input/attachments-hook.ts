import type { Accessor, Setter } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import type { ContentPart, NoteAttachmentPart, SessionAttachmentPart } from "@/context/prompt"
import { PromptAttachmentError, uploadPromptAttachment } from "@/utils/prompt-attachment"
import { useLocale } from "@/context/locale"
import { formatAttachmentBatchToast, formatOversizedAttachmentToast, partitionPromptAttachmentFiles } from "./files"
import { createPromptPartID, inlineLength } from "./content"
import { getCursorPosition } from "./editor-dom"
import { PI } from "./prompt-input-i18n"
import type { BlueprintSlot, DroppedBlueprintData, DroppedSessionData, PromptInputStore } from "./types"
import { decideDroppedSession } from "./session-drop"

type PromptAttachmentsInput = {
  editor: () => HTMLDivElement | undefined
  isFocused: Accessor<boolean>
  addPart: (part: ContentPart) => void
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  localArmedLoop: Accessor<BlueprintSlot | null>
  setLocalArmedLoop: Setter<BlueprintSlot | null>
  activeLoopID: Accessor<string | undefined>
  working: Accessor<boolean>
  workflowKind: Accessor<"plan" | "lightloop" | "lattice" | "boss" | "extension" | undefined>
  clearPendingWorkflows: () => void
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
  const { i18n } = useLocale()

  const cursor = () => {
    const editor = input.editor()
    return prompt.cursor() ?? (editor ? getCursorPosition(editor) : inlineLength(prompt.current()))
  }

  const appendAttachment = async (file: File, draft: ReturnType<typeof prompt.capture>["draft"]) => {
    try {
      const cursorPosition = draft.cursor() ?? cursor()
      const uploaded = await uploadPromptAttachment(sdk.client, file)
      draft.set(
        [
          ...draft.current(),
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
            : i18n._(PI.attachFailedGeneric)

      showToast({
        type: "error",
        title: error instanceof PromptAttachmentError ? error.title : i18n._(PI.attachFailedTitle),
        description,
      })
    }
  }

  const addAttachments = async (files: Iterable<File>) => {
    const all = Array.from(files)
    const existing = composerAttachmentScope()
    const batchToast = formatAttachmentBatchToast(all, existing, i18n)
    if (batchToast) {
      showToast(batchToast)
      return
    }
    const { accepted, rejected } = partitionPromptAttachmentFiles(all)
    const toast = formatOversizedAttachmentToast(rejected, accepted.length, i18n)
    if (toast) showToast(toast)
    const draft = prompt.capture()
    try {
      for (const file of accepted) {
        await appendAttachment(file, draft.draft)
      }
    } finally {
      draft.release()
    }
  }

  const composerAttachmentScope = () => {
    const parts = prompt.current()
    const attachments = parts.filter(
      (part): part is Extract<ContentPart, { type: "attachment" }> => part.type === "attachment",
    )
    return {
      count: attachments.length,
      bytes: attachments.reduce((total, part) => total + (typeof part.size === "number" ? part.size : 0), 0),
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
      const binding = prompt.capture()
      try {
        const dropped = JSON.parse(blueprintData) as DroppedBlueprintData
        if (!dropped.noteID) return
        const workflowKind = input.workflowKind()
        if (input.working()) {
          showToast({
            type: "warning",
            title: i18n._(PI.sessionRunning),
            description:
              workflowKind === "lightloop"
                ? i18n._(PI.attachWaitLightLoop)
                : workflowKind === "plan"
                  ? i18n._(PI.attachWaitPlan)
                  : i18n._(PI.attachWaitRun),
          })
          return
        }
        if (input.localArmedLoop() || input.activeLoopID()) {
          showToast({
            type: "warning",
            title: i18n._(PI.attachSlotOccupied),
            description: i18n._(PI.attachWaitCurrentBp),
          })
          return
        }
        if (workflowKind === "lattice" || workflowKind === "boss") {
          showToast({
            type: "warning",
            title: workflowKind === "lattice" ? i18n._(PI.attachLatticeActive) : i18n._(PI.attachBossActive),
            description: workflowKind === "lattice" ? i18n._(PI.attachCancelLattice) : i18n._(PI.attachCancelBoss),
          })
          return
        }
        if (workflowKind === "plan" || workflowKind === "lightloop") {
          if (params.id) {
            try {
              await sdk.client.workflow.session.set({
                id: params.id,
                workflowSetInput: { kind: "none" },
              })
            } catch (err) {
              showToast({
                type: "error",
                title: workflowKind === "plan" ? i18n._(PI.attachExitPlanFailed) : i18n._(PI.attachExitLightLoopFailed),
                description: err instanceof Error ? err.message : i18n._(PI.attachRequestFailed),
              })
              return
            }
          }
          if (!binding.isCurrent()) return
          input.clearPendingWorkflows()
        }
        input.setLocalArmedLoop({
          type: "pending",
          noteID: dropped.noteID,
          title: dropped.title || "Blueprint",
          runMode: "current",
        })
      } catch {
      } finally {
        binding.release()
      }
      return
    }

    const sessionData = event.dataTransfer?.getData("application/x-synergy-session")
    if (sessionData) {
      try {
        const dropped = JSON.parse(sessionData) as DroppedSessionData
        const decision = decideDroppedSession(dropped, params.id, input.sessionAttachments())
        if (!decision.accepted) return
        const cursorPosition = cursor()
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
        const cursorPosition = cursor()
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
    addAttachments,
    removeAttachment,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
