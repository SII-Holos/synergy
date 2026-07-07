import { createSignal, type Accessor, Setter } from "solid-js"
import { produce, type SetStoreFunction } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { createSynergyClient, type Message, type Part } from "@ericsanchezok/synergy-sdk/client"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import type {
  FileAttachmentPart,
  NoteAttachmentPart,
  Prompt,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import type { FileSelection } from "@/context/file"
import type { ControlProfileId } from "@/context/input"
import { Identifier } from "@/utils/id"
import {
  formatNoteContent,
  formatSessionPreview,
  formatSessionReference,
  inlineLength,
  inlineText,
  SESSION_PREVIEW_MAX_MESSAGES,
} from "./content"
import { setCursorPosition } from "./editor-dom"
import { createUploadedAttachmentInputPart } from "./attachment-submit"
import { createPromptDraftSnapshot, createSubmitFailureRestoreSnapshot } from "@/utils/prompt"
import { sendSessionCommand } from "./session-command"
import type { BlueprintSlot, PromptInputMode, PromptInputProps, PromptInputStore } from "./types"
import {
  SessionStartProgressDialog,
  type SessionStartProgress,
  type SessionStartProgressStepState,
} from "@/components/session/worktree-transition-dialog"
import type { NewSessionWorkspaceSelection } from "@/components/session/worktree-session"

type PromptSubmitInput = {
  props: Pick<
    PromptInputProps,
    "newSessionWorkspaceSelection" | "newSessionCanonicalDirectory" | "onNewSessionWorkspaceSelectionReset"
  >
  uploadedAttachments: Accessor<UploadedAttachmentPart[]>
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  activeFile: Accessor<string | undefined>
  selectedControlProfile: Accessor<ControlProfileId>
  pendingPlan: Accessor<boolean>
  clearPendingPlan: () => void
  pendingLattice: Accessor<{ mode: "auto" | "collaborative"; maxModelCalls: number } | null>
  clearPendingLattice: () => void
  pendingLightLoop: Accessor<{ taskDescription: string } | null>
  clearPendingLightLoop: () => void
  localArmedLoop: Accessor<BlueprintSlot | null>
  setLocalArmedLoop: Setter<BlueprintSlot | null>
  setBlueprintLoading: Setter<boolean>
  store: PromptInputStore
  setStore: SetStoreFunction<PromptInputStore>
  addToHistory: (prompt: Prompt, mode: PromptInputMode) => void
  working: Accessor<boolean>
  abort: () => void
  editor: () => HTMLDivElement
  queueScroll: () => void
}

function errorMessage(err: unknown) {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return "Request failed"
}

export function usePromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const prompt = usePrompt()
  const params = useParams()
  const [startProgress, setStartProgress] = createSignal<SessionStartProgress>({
    title: "Starting session",
    description: "Preparing this session before sending your prompt.",
    steps: [],
  })
  let startProgressOpen = false

  const startProgressSteps = (
    selection: NewSessionWorkspaceSelection,
    active: "workspace" | "session" | "prompt",
  ): SessionStartProgress["steps"] => {
    const steps: Array<{ id: "workspace" | "session" | "prompt"; label: string; detail?: string }> = []
    if (selection.mode === "create") {
      steps.push({ id: "workspace", label: "Create checkout", detail: "Preparing a new git worktree." })
    }
    if (selection.mode === "existing") {
      steps.push({ id: "workspace", label: "Bind worktree", detail: "Using the selected checkout." })
    }
    steps.push({ id: "session", label: "Prepare session", detail: "Creating the conversation state." })
    steps.push({ id: "prompt", label: "Send prompt", detail: "Dispatching your first message." })
    const activeIndex = Math.max(
      0,
      steps.findIndex((step) => step.id === active),
    )
    return steps.map((step, index) => {
      const state: SessionStartProgressStepState =
        index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending"
      return { ...step, state }
    })
  }

  const updateStartProgress = (selection: NewSessionWorkspaceSelection, active: "workspace" | "session" | "prompt") => {
    setStartProgress({
      title: selection.mode === "current" ? "Starting session" : "Starting worktree session",
      description:
        selection.mode === "current"
          ? "Preparing the session before sending your prompt."
          : "Creating the checkout and preparing the session before sending your prompt.",
      steps: startProgressSteps(selection, active),
    })
  }

  const openStartProgress = (selection: NewSessionWorkspaceSelection) => {
    updateStartProgress(selection, selection.mode === "current" ? "session" : "workspace")
    if (startProgressOpen) return
    startProgressOpen = true
    dialog.push(() => SessionStartProgressDialog({ progress: startProgress }))
  }

  const closeStartProgress = () => {
    if (!startProgressOpen) return
    startProgressOpen = false
    dialog.close()
  }

  return async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part && part.type === "text" ? part.content : "")).join("")
    const attachments = input.uploadedAttachments().slice()
    const notes = input.noteAttachments().slice()
    const sessions = input.sessionAttachments().slice()
    const mode = input.store.mode
    const currentContext = {
      activeTab: prompt.context.activeTab(),
      items: prompt.context.items(),
    }
    const draftSnapshot = createPromptDraftSnapshot({
      prompt: currentPrompt,
      context: currentContext,
      activeFile: input.activeFile(),
    })
    const failureRestoreSnapshot = createSubmitFailureRestoreSnapshot({
      prompt: currentPrompt,
      context: currentContext,
    })

    const blueprintSlot = input.localArmedLoop()
    if (
      !blueprintSlot &&
      text.trim().length === 0 &&
      attachments.length === 0 &&
      notes.length === 0 &&
      sessions.length === 0
    ) {
      if (input.working()) input.abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        type: "warning",
        title: "Select an agent and model",
        description: "Choose an agent and model before sending a prompt.",
      })
      return
    }

    const selectedVariant = local.model.variant.current()
    input.addToHistory(currentPrompt, mode)
    input.setStore("historyIndex", -1)
    input.setStore("savedPrompt", null)

    const projectDirectory = sdk.directory
    const currentScopeKey = sdk.scopeKey
    const isNewSession = !params.id
    // Capture (and disarm) workflow state armed on the new-session composer
    // before navigation can reset it; applied once the session exists.
    const armedPlan = isNewSession && input.pendingPlan()
    if (armedPlan) input.clearPendingPlan()
    const armedLattice = isNewSession ? input.pendingLattice() : null
    if (armedLattice) input.clearPendingLattice()
    const armedLightLoop = isNewSession ? input.pendingLightLoop() : null
    if (armedLightLoop) input.clearPendingLightLoop()
    const workspaceSelection = input.props.newSessionWorkspaceSelection ?? { mode: "current" as const }

    let sessionScopeKey = currentScopeKey
    let sessionCreateScopeKey = currentScopeKey
    let client = sdk.client

    if (isNewSession) {
      openStartProgress(workspaceSelection)
      if (!sdk.isHome) {
        sessionCreateScopeKey = input.props.newSessionCanonicalDirectory ?? projectDirectory ?? currentScopeKey
        if (sessionCreateScopeKey !== currentScopeKey) {
          client = createSynergyClient({
            baseUrl: sdk.url,
            fetch: platform.fetch,
            directory: sessionCreateScopeKey,
            throwOnError: true,
          })
          globalSync.ensureScopeState(sessionCreateScopeKey)
        }
      }
    }

    const useSessionScopeClient = (scopeKey: string) => {
      sessionScopeKey = scopeKey
      if (scopeKey !== currentScopeKey) {
        client = createSynergyClient({
          baseUrl: sdk.url,
          fetch: platform.fetch,
          directory: scopeKey,
          throwOnError: true,
        })
        globalSync.ensureScopeState(scopeKey)
      } else {
        client = sdk.client
      }
    }

    let createdSessionForSubmit = false

    let session = params.id ? sync.session.get(params.id) : undefined
    if (!session && isNewSession) {
      session = await client.session
        .create({
          controlProfile: input.selectedControlProfile(),
          workspace: workspaceSelection,
        })
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            type: "error",
            title: workspaceSelection.mode === "current" ? "Failed to start session" : "Failed to create worktree",
            description: errorMessage(err),
          })
          closeStartProgress()
          return undefined
        })
      if (session) {
        createdSessionForSubmit = true
        useSessionScopeClient(sessionCreateScopeKey)
        input.props.onNewSessionWorkspaceSelectionReset?.()
        updateStartProgress(workspaceSelection, "session")
        navigate(`/${base64Encode(sessionScopeKey)}/session/${session.id}`)
      }
    }
    if (!session && params.id) {
      await sync.session.sync(params.id)
      session = sync.session.get(params.id)
    }
    if (!session) {
      closeStartProgress()
      return
    }
    if (isNewSession && session.controlProfile !== input.selectedControlProfile()) {
      session = await client.session
        .update({ sessionID: session.id, controlProfile: input.selectedControlProfile() })
        .then((x) => x.data ?? session)
        .catch(() => session)
    }
    if (!session) return
    if (blueprintSlot && session.workflow?.kind === "plan") {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.workflow.session
        .set({ id: sessionID, workflowSetInput: { kind: "none" } })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          showToast({
            type: "error",
            title: "Failed to exit Plan",
            description: errorMessage(err),
          })
          if (createdSessionForSubmit) {
            await client.session.delete({ sessionID }).catch(() => undefined)
            navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
          }
          closeStartProgress()
          return undefined
        })
      if (!session) return
    }
    if (!blueprintSlot && armedPlan && !armedLattice && !armedLightLoop && session.workflow?.kind !== "plan") {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.workflow.session
        .set({ id: sessionID, workflowSetInput: { kind: "plan" } })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          showToast({
            type: "error",
            title: "Failed to toggle Plan",
            description: errorMessage(err),
          })
          if (createdSessionForSubmit) {
            await client.session.delete({ sessionID }).catch(() => undefined)
            navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
          }
          closeStartProgress()
          return undefined
        })
      if (!session) return
    }
    if (armedLattice && session.workflow?.kind !== "lattice") {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.workflow.session
        .set({
          id: sessionID,
          workflowSetInput: {
            kind: "lattice",
            mode: armedLattice.mode,
            maxModelCalls: armedLattice.maxModelCalls,
          },
        })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          showToast({
            type: "error",
            title: "Failed to enable Lattice",
            description: errorMessage(err),
          })
          if (createdSessionForSubmit) {
            await client.session.delete({ sessionID }).catch(() => undefined)
            navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
          }
          closeStartProgress()
          return undefined
        })
      if (!session) return
    }
    if (armedLightLoop && !armedLattice && session.workflow?.kind !== "lightloop") {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.workflow.session
        .set({
          id: sessionID,
          workflowSetInput: { kind: "lightloop", taskDescription: armedLightLoop.taskDescription },
        })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          showToast({
            type: "error",
            title: "Failed to enable Light Loop",
            description: errorMessage(err),
          })
          if (createdSessionForSubmit) {
            await client.session.delete({ sessionID }).catch(() => undefined)
            navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
          }
          closeStartProgress()
          return undefined
        })
      if (!session) return
    }
    const activeSession = session!

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const variant = selectedVariant
    const clearInput = () => {
      prompt.resetDraft()
      input.setStore("mode", "normal")
      input.setStore("popover", null)
      input.setLocalArmedLoop(null)
    }

    const restoreInput = () => {
      prompt.set(failureRestoreSnapshot.prompt, inlineLength(failureRestoreSnapshot.prompt))
      prompt.context.set(failureRestoreSnapshot.context)
      input.setStore("mode", mode)
      input.setStore("popover", null)
      requestAnimationFrame(() => {
        input.editor().focus()
        setCursorPosition(input.editor(), inlineLength(failureRestoreSnapshot.prompt))
        input.queueScroll()
      })
    }

    const rollbackCreatedSession = async () => {
      if (!createdSessionForSubmit) return
      await client.session.delete({ sessionID: activeSession.id }).catch(() => undefined)
      navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
    }

    if (isNewSession) updateStartProgress(workspaceSelection, "prompt")

    if (blueprintSlot && mode === "normal") {
      input.setBlueprintLoading(true)
      let createdLoopID: string | undefined
      try {
        const userText = text.trim()
        let loopID: string
        if (blueprintSlot.type === "pending") {
          const result = await sdk.client.blueprint.loop.create({
            blueprintLoopCreateInput: {
              noteID: blueprintSlot.noteID,
              title: blueprintSlot.title,
              sessionID: activeSession.id,
              runMode: blueprintSlot.runMode,
              executionAgent: agent,
              model,
            },
          })
          const loop = result.data
          if (!loop?.id) throw new Error("Loop creation returned no data")
          loopID = loop.id
          createdLoopID = loop.id
        } else {
          loopID = blueprintSlot.loopID
        }

        clearInput()
        await sdk.client.blueprint.loop.start({ id: loopID, userPrompt: userText || undefined })
        closeStartProgress()
      } catch (err) {
        if (createdLoopID) {
          await sdk.client.blueprint.loop.cancel({ id: createdLoopID }).catch(() => undefined)
        }
        closeStartProgress()
        showToast({
          type: "error",
          title: "Failed to start Blueprint",
          description: errorMessage(err),
        })
        rollbackCreatedSession()
        restoreInput()
      } finally {
        input.setBlueprintLoading(false)
      }
      return
    }

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: activeSession.id,
          agent,
          model,
          command: text,
        })
        .then(() => {
          closeStartProgress()
        })
        .catch((err) => {
          closeStartProgress()
          showToast({
            type: "error",
            title: "Failed to send shell command",
            description: errorMessage(err),
          })
          rollbackCreatedSession()
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        sendSessionCommand({
          client,
          sessionID: activeSession.id,
          command: commandName,
          arguments: args.join(" "),
          agent,
          model,
          variant,
          attachments,
          notes,
          sessions,
        })
          .then(() => {
            closeStartProgress()
          })
          .catch((err) => {
            closeStartProgress()
            showToast({
              type: "error",
              title: "Failed to send command",
              description: errorMessage(err),
            })
            rollbackCreatedSession()
            restoreInput()
          })
        return
      }
    }

    const toAbsolutePath = (path: string) =>
      path.startsWith("/")
        ? path
        : ((sync.data.path.directory || projectDirectory || globalSync.data.paths.home) + "/" + path).replace("//", "/")

    const getSessionPreviewData = async (attachment: SessionAttachmentPart) => {
      const [childStore] = globalSync.ensureScopeState(attachment.directory)
      const cachedMessages = childStore.message[attachment.sessionId]
      if (cachedMessages !== undefined) {
        return {
          messages: cachedMessages,
          getParts: (messageID: string) => childStore.part[messageID] ?? [],
        }
      }

      const response = await client.session.messages({
        directory: attachment.directory,
        sessionID: attachment.sessionId,
        limit: SESSION_PREVIEW_MAX_MESSAGES,
      })
      const items = (response.data ?? []).filter((item) => !!item?.info?.id)
      const messages = items
        .map((item) => item.info)
        .filter((message) => !!message?.id)
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
      const partsByMessage = new Map(items.map((item) => [item.info.id, item.parts]))
      return {
        messages,
        getParts: (messageID: string) => partsByMessage.get(messageID) ?? [],
      }
    }

    const createSessionAttachmentPart = async (attachment: SessionAttachmentPart) => {
      let content = formatSessionReference(attachment)
      try {
        const preview = await getSessionPreviewData(attachment)
        content = formatSessionPreview({
          attachment,
          sessionMessages: preview.messages,
          getParts: preview.getParts,
        })
      } catch {}

      return {
        id: Identifier.ascending("part"),
        type: "attachment" as const,
        mime: "text/plain",
        url: `data:text/plain;base64,${base64Encode(content)}`,
        filename: `${attachment.title || "session"}.session.txt`,
        model: { mode: "content" as const, text: content },
        metadata: {
          kind: "session",
          sessionId: attachment.sessionId,
          directory: attachment.directory,
          title: attachment.title || "Untitled",
          updatedAt: attachment.updatedAt,
        },
      }
    }

    const sessionAttachmentParts = await Promise.all(sessions.map(createSessionAttachmentPart))

    const fileAttachments = currentPrompt.filter((part) => part.type === "file") as FileAttachmentPart[]

    const fileAttachmentParts = fileAttachments.map((attachment) => {
      const absolute = toAbsolutePath(attachment.path)
      const query = attachment.selection
        ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
        : ""
      return {
        id: Identifier.ascending("part"),
        type: "attachment" as const,
        mime: "text/plain",
        url: `file://${absolute}${query}`,
        filename: getFilename(attachment.path),
        model: { mode: "content" as const },
        source: {
          type: "file" as const,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
          path: absolute,
        },
      }
    })

    const usedUrls = new Set(fileAttachmentParts.map((part) => part.url))

    const contextFileParts: Array<{
      id: string
      type: "attachment"
      mime: string
      url: string
      filename?: string
      model: { mode: "content" }
    }> = []

    const addContextFile = (path: string, selection?: FileSelection) => {
      const absolute = toAbsolutePath(path)
      const query = selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""
      const url = `file://${absolute}${query}`
      if (usedUrls.has(url)) return
      usedUrls.add(url)
      contextFileParts.push({
        id: Identifier.ascending("part"),
        type: "attachment",
        mime: "text/plain",
        url,
        filename: getFilename(path),
        model: { mode: "content" },
      })
    }

    const activePath = input.activeFile()
    if (activePath && prompt.context.activeTab()) {
      addContextFile(activePath)
    }

    for (const item of prompt.context.items()) {
      if (item.type !== "file") continue
      addContextFile(item.path, item.selection)
    }

    const uploadedAttachmentParts = attachments.map(createUploadedAttachmentInputPart)

    const noteAttachmentParts = notes.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "attachment" as const,
      mime: "text/plain",
      url: `data:text/plain;base64,${base64Encode(formatNoteContent(attachment))}`,
      filename: `${attachment.title || "Untitled"}.md`,
      model: { mode: "content" as const, text: formatNoteContent(attachment) },
      metadata: {
        kind: "note",
        noteId: attachment.noteId,
        title: attachment.title || "Untitled",
      },
    }))

    const queueing = input.working()
    const messageID = queueing ? undefined : Identifier.ascending("message")
    const textPart = {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text,
    }
    const requestParts = [
      textPart,
      ...fileAttachmentParts,
      ...contextFileParts,
      ...uploadedAttachmentParts,
      ...noteAttachmentParts,
      ...sessionAttachmentParts,
    ]

    const optimisticParts = messageID
      ? (requestParts.map((part) => ({
          ...part,
          sessionID: activeSession.id,
          messageID,
        })) as unknown as Part[])
      : []

    const userMessageMetadata = {
      promptDraft: draftSnapshot,
    }

    const optimisticMessage: Message | undefined = messageID
      ? {
          id: messageID,
          sessionID: activeSession.id,
          role: "user",
          time: { created: Date.now() },
          agent,
          model,
          variant,
          metadata: userMessageMetadata,
        }
      : undefined

    const setSyncStore =
      sessionScopeKey === currentScopeKey ? sync.set : globalSync.ensureScopeState(sessionScopeKey)[1]

    const addOptimisticMessage = () => {
      if (!messageID || !optimisticMessage) return
      setSyncStore(
        produce((draft) => {
          const messages = draft.message[activeSession.id]
          if (!messages) {
            draft.message[activeSession.id] = [optimisticMessage]
          } else {
            const result = Binary.search(messages, messageID, (m) => m.id)
            messages.splice(result.index, 0, optimisticMessage)
          }
          draft.part[messageID] = optimisticParts
            .filter((p) => !!p?.id)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
        }),
      )
    }

    const removeOptimisticMessage = () => {
      if (!messageID) return
      setSyncStore(
        produce((draft) => {
          const messages = draft.message[activeSession.id]
          if (messages) {
            const result = Binary.search(messages, messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[messageID]
        }),
      )
    }

    clearInput()
    let optimisticAdded = false
    if (!queueing) {
      addOptimisticMessage()
      optimisticAdded = true
    }

    const wsConnected = sdk.connected()

    client.session
      .input({
        sessionID: activeSession.id,
        agent,
        model,
        ...(messageID ? { messageID } : {}),
        parts: requestParts,
        variant,
        metadata: { promptDraft: draftSnapshot },
      })
      .then((result) => {
        closeStartProgress()
        if (result.data?.status === "queued" && optimisticAdded) {
          removeOptimisticMessage()
          optimisticAdded = false
        }
        if (!wsConnected) {
          showToast({
            type: "warning",
            title: "Message sent",
            description: "Response will appear after reconnection",
          })
        }
      })
      .catch((err) => {
        closeStartProgress()
        showToast({
          type: "error",
          title: "Failed to send prompt",
          description: errorMessage(err),
        })
        if (optimisticAdded) removeOptimisticMessage()
        rollbackCreatedSession()
        restoreInput()
      })
  }
}
