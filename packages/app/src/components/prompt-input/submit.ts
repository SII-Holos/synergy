import type { Accessor, Setter } from "solid-js"
import { produce, type SetStoreFunction } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { createSynergyClient, type Message, type Part } from "@ericsanchezok/synergy-sdk/client"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import type {
  FileAttachmentPart,
  ImageAttachmentPart,
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
import type { BlueprintSlot, PromptInputMode, PromptInputProps, PromptInputStore } from "./types"

type PromptSubmitInput = {
  props: Pick<PromptInputProps, "newSessionWorktree" | "onNewSessionWorktreeReset">
  imageAttachments: Accessor<ImageAttachmentPart[]>
  uploadedAttachments: Accessor<UploadedAttachmentPart[]>
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  activeFile: Accessor<string | undefined>
  selectedControlProfile: Accessor<ControlProfileId>
  planMode: Accessor<boolean>
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
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const prompt = usePrompt()
  const params = useParams()

  return async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part && part.type === "text" ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const attachments = input.uploadedAttachments().slice()
    const notes = input.noteAttachments().slice()
    const sessions = input.sessionAttachments().slice()
    const mode = input.store.mode

    const blueprintSlot = input.localArmedLoop()
    if (
      !blueprintSlot &&
      text.trim().length === 0 &&
      images.length === 0 &&
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

    input.addToHistory(currentPrompt, mode)
    input.setStore("historyIndex", -1)
    input.setStore("savedPrompt", null)

    const projectDirectory = sdk.directory
    const currentScopeKey = sdk.scopeKey
    const isNewSession = !params.id
    const worktreeSelection = input.props.newSessionWorktree ?? "main"

    let sessionScopeKey = currentScopeKey
    let client = sdk.client

    if (isNewSession && !sdk.isHome && projectDirectory) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              type: "error",
              title: "Failed to create worktree",
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.path) {
          showToast({
            type: "error",
            title: "Failed to create worktree",
            description: "Request failed",
          })
          return
        }
        sessionScopeKey = createdWorktree.path
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionScopeKey = worktreeSelection
      }

      if (sessionScopeKey !== currentScopeKey) {
        client = createSynergyClient({
          baseUrl: sdk.url,
          fetch: platform.fetch,
          directory: sessionScopeKey,
          throwOnError: true,
        })
        globalSync.ensureScopeState(sessionScopeKey)
      }

      input.props.onNewSessionWorktreeReset?.()
    }
    let createdSessionForSubmit = false

    let session = params.id ? sync.session.get(params.id) : undefined
    if (!session && isNewSession) {
      session = await client.session
        .create({ controlProfile: input.selectedControlProfile() })
        .then((x) => x.data ?? undefined)
      if (session) {
        createdSessionForSubmit = true
        navigate(`/${base64Encode(sessionScopeKey)}/session/${session.id}`)
      }
    }
    if (!session && params.id) {
      await sync.session.sync(params.id)
      session = sync.session.get(params.id)
    }
    if (!session) return
    if (isNewSession && session.controlProfile !== input.selectedControlProfile()) {
      session = await client.session
        .update({ sessionID: session.id, controlProfile: input.selectedControlProfile() })
        .then((x) => x.data ?? session)
        .catch(() => session)
    }
    if (!session) return
    if (blueprintSlot && session.blueprint?.planMode) {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.blueprint.session
        .planMode({ id: sessionID, planMode: false })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          showToast({
            type: "error",
            title: "Failed to exit Plan Mode",
            description: errorMessage(err),
          })
          if (createdSessionForSubmit) {
            await client.session.delete({ sessionID }).catch(() => undefined)
            navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
          }
          return undefined
        })
      if (!session) return
    }
    if (!blueprintSlot && input.planMode() && !session.blueprint?.planMode) {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.blueprint.session
        .planMode({ id: sessionID, planMode: true })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          showToast({
            type: "error",
            title: "Failed to toggle Plan Mode",
            description: errorMessage(err),
          })
          if (createdSessionForSubmit) {
            await client.session.delete({ sessionID }).catch(() => undefined)
            navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
          }
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
    const variant = local.model.variant.current()

    const clearInput = () => {
      prompt.reset()
      input.setStore("mode", "normal")
      input.setStore("popover", null)
      input.setLocalArmedLoop(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, inlineLength(currentPrompt))
      input.setStore("mode", mode)
      input.setStore("popover", null)
      requestAnimationFrame(() => {
        input.editor().focus()
        setCursorPosition(input.editor(), inlineLength(currentPrompt))
        input.queueScroll()
      })
    }

    const rollbackCreatedSession = async () => {
      if (!createdSessionForSubmit) return
      await client.session.delete({ sessionID: activeSession.id }).catch(() => undefined)
      navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true })
    }

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
      } catch (err) {
        if (createdLoopID) {
          await sdk.client.blueprint.loop.cancel({ id: createdLoopID }).catch(() => undefined)
        }
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
        .catch((err) => {
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
        client.session
          .command({
            sessionID: activeSession.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: [
              ...images.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: attachment.mime,
                url: attachment.dataUrl,
                filename: attachment.filename,
              })),
              ...attachments.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: attachment.mime,
                url: attachment.url,
                filename: attachment.filename,
              })),
              ...notes.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: "text/plain",
                url: `data:text/plain;base64,${base64Encode(formatNoteContent(attachment))}`,
                filename: `${attachment.title || "Untitled"}.md`,
                metadata: {
                  kind: "note",
                  noteId: attachment.noteId,
                  title: attachment.title || "Untitled",
                },
              })),
              ...sessions.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: "text/plain",
                url: `data:text/plain;base64,${base64Encode(formatSessionReference(attachment))}`,
                filename: `${attachment.title || "session"}.session.txt`,
                metadata: {
                  kind: "session",
                  sessionId: attachment.sessionId,
                  directory: attachment.directory,
                  title: attachment.title || "Untitled",
                  updatedAt: attachment.updatedAt,
                },
              })),
            ],
          })
          .catch((err) => {
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
        type: "file" as const,
        mime: "text/plain",
        url: `data:text/plain;base64,${base64Encode(content)}`,
        filename: `${attachment.title || "session"}.session.txt`,
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
        type: "file" as const,
        mime: "text/plain",
        url: `file://${absolute}${query}`,
        filename: getFilename(attachment.path),
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
      type: "file"
      mime: string
      url: string
      filename?: string
    }> = []

    const addContextFile = (path: string, selection?: FileSelection) => {
      const absolute = toAbsolutePath(path)
      const query = selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""
      const url = `file://${absolute}${query}`
      if (usedUrls.has(url)) return
      usedUrls.add(url)
      contextFileParts.push({
        id: Identifier.ascending("part"),
        type: "file",
        mime: "text/plain",
        url,
        filename: getFilename(path),
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

    const imageAttachmentParts = images.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    }))

    const uploadedAttachmentParts = attachments.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename,
    }))

    const noteAttachmentParts = notes.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: "text/plain",
      url: `data:text/plain;base64,${base64Encode(formatNoteContent(attachment))}`,
      filename: `${attachment.title || "Untitled"}.md`,
      metadata: {
        kind: "note",
        noteId: attachment.noteId,
        title: attachment.title || "Untitled",
      },
    }))

    const messageID = Identifier.ascending("message")
    const textPart = {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text,
    }
    const requestParts = [
      textPart,
      ...fileAttachmentParts,
      ...contextFileParts,
      ...imageAttachmentParts,
      ...uploadedAttachmentParts,
      ...noteAttachmentParts,
      ...sessionAttachmentParts,
    ]

    const optimisticParts = requestParts.map((part) => ({
      ...part,
      sessionID: activeSession.id,
      messageID,
    })) as unknown as Part[]

    const optimisticMessage: Message = {
      id: messageID,
      sessionID: activeSession.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }

    const setSyncStore =
      sessionScopeKey === currentScopeKey ? sync.set : globalSync.ensureScopeState(sessionScopeKey)[1]

    const addOptimisticMessage = () => {
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
    addOptimisticMessage()

    const wsConnected = sdk.connected()

    client.session
      .promptAsync({
        sessionID: activeSession.id,
        agent,
        model,
        messageID,
        parts: requestParts,
        variant,
      })
      .then(() => {
        if (!wsConnected) {
          showToast({
            type: "warning",
            title: "Message sent",
            description: "Response will appear after reconnection",
          })
        }
      })
      .catch((err) => {
        showToast({
          type: "error",
          title: "Failed to send prompt",
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        rollbackCreatedSession()
        restoreInput()
      })
  }
}
