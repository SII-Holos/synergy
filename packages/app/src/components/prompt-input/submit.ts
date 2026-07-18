import { type Accessor, Setter } from "solid-js"
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
import { useSessionTransition } from "@/context/session-transition"
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
import { requestErrorMessage as errorMessage } from "@/utils/error"
import {
  formatNoteContent,
  formatSessionPreview,
  formatSessionReference,
  inlineLength,
  SESSION_PREVIEW_MAX_MESSAGES,
} from "./content"
import { setCursorPosition } from "./editor-dom"
import { createUploadedAttachmentInputPart } from "./attachment-submit"
import { createPromptDraftSnapshot, createSubmitFailureRestoreSnapshot } from "@/utils/prompt"
import { sendSessionCommand } from "./session-command"
import type { BlueprintSlot, PromptInputMode, PromptInputProps, PromptInputStore } from "./types"
import { buildLightLoopTaskDescription } from "./light-loop-task"
import { getPendingLightLoopSlashBlock, resolveSlashCommandIntent, type SlashUiCommand } from "./slash-command-intent"
import { resolvePromptSubmitIntent } from "./submit-intent"
import { acquireNewSessionSubmitLock } from "./new-session-submit-lock"
import {
  createNewSessionWorkspaceErrorProgress,
  createNewSessionWorkspaceProgress,
  createNewSessionWorkspaceSuccessProgress,
  isWorktreeWorkspaceSelection,
  worktreeSetupFailureMessage,
} from "@/components/session/worktree-session"
import {
  createNewSessionTransitionErrorProgress,
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
  type SessionTransitionActions,
  type SessionTransitionProgress,
} from "@/components/session/session-transition-progress"
import { createNewSessionRecoveryActions, type NewSessionRecovery } from "@/components/session/new-session-recovery"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { PI } from "./prompt-input-i18n"

type PromptSubmitInput = {
  props: Pick<
    PromptInputProps,
    | "newSessionWorkspaceSelection"
    | "newSessionCanonicalDirectory"
    | "onNewSessionWorkspaceSelectionReset"
    | "onNewSessionTransitionChange"
    | "sessionTransitionPending"
  >
  uploadedAttachments: Accessor<UploadedAttachmentPart[]>
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  selectedControlProfile: Accessor<ControlProfileId>
  pendingPlan: Accessor<boolean>
  clearPendingPlan: () => void
  pendingLattice: Accessor<{ mode: "auto" | "collaborative"; maxModelCalls: number } | null>
  clearPendingLattice: () => void
  pendingLightLoop: Accessor<boolean>
  clearPendingLightLoop: () => void
  localArmedLoop: Accessor<BlueprintSlot | null>
  setLocalArmedLoop: Setter<BlueprintSlot | null>
  setBlueprintLoading: Setter<boolean>
  newSessionSubmitPending: Accessor<boolean>
  setNewSessionSubmitPending: Setter<boolean>
  store: PromptInputStore
  setStore: SetStoreFunction<PromptInputStore>
  addToHistory: (prompt: Prompt, mode: PromptInputMode) => void
  frontendCommands: Accessor<SlashUiCommand[]>
  working: Accessor<boolean>
  abort: () => void
  editor: () => HTMLDivElement
  queueScroll: () => void
}

export function usePromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const prompt = usePrompt()
  const sessionTransition = useSessionTransition()
  const params = useParams()
  const { i18n } = useLocale()

  return async (event: Event) => {
    event.preventDefault()
    const isNewSession = !params.id

    if (input.props.sessionTransitionPending) {
      showToast({
        type: "warning",
        title: i18n._(PI.submitTransitionPendingTitle),
        description: i18n._(PI.submitTransitionPendingDesc),
      })
      return
    }
    const newSessionSubmitLease = acquireNewSessionSubmitLock({
      isNewSession,
      pending: input.newSessionSubmitPending,
      setPending: input.setNewSessionSubmitPending,
    })
    if (!newSessionSubmitLease) {
      showToast({
        type: "warning",
        title: i18n._(PI.submitInProgress),
        description: i18n._(PI.submitInProgressDesc),
      })
      return
    }
    const releaseNewSessionSubmit = newSessionSubmitLease.release

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part && part.type === "text" ? part.content : "")).join("")
    const attachments = input.uploadedAttachments().slice()
    const notes = input.noteAttachments().slice()
    const sessions = input.sessionAttachments().slice()
    const mode = input.store.mode
    const currentContext = {
      items: prompt.context.items(),
    }
    const draftSnapshot = createPromptDraftSnapshot({
      prompt: currentPrompt,
      context: currentContext,
    })
    const failureRestoreSnapshot = createSubmitFailureRestoreSnapshot({
      prompt: currentPrompt,
      context: currentContext,
    })
    const restoreInput = (options?: { focus?: boolean }) => {
      prompt.set(failureRestoreSnapshot.prompt, inlineLength(failureRestoreSnapshot.prompt))
      prompt.context.set(failureRestoreSnapshot.context)
      input.setStore("mode", mode)
      input.setStore("popover", null)

      if (options?.focus === false) return
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor?.isConnected) return
        editor.focus()
        setCursorPosition(editor, inlineLength(failureRestoreSnapshot.prompt))
        input.queueScroll()
      })
    }
    const slashIntent = resolveSlashCommandIntent({
      text,
      backendCommands: sync.data.command,
      uiCommands: input.frontendCommands(),
    })

    const blueprintSlot = input.localArmedLoop()
    const submitIntent = resolvePromptSubmitIntent({
      text,
      working: input.working(),
      hasBlueprintSlot: !!blueprintSlot,
    })
    if (submitIntent === "abort") {
      releaseNewSessionSubmit()
      input.abort()
      return
    }
    if (submitIntent === "blocked") {
      if (input.pendingLightLoop()) {
        showToast({
          type: "warning",
          title: i18n._(PI.submitLightLoopTitle),
          description: i18n._(PI.submitLightLoopDesc),
        })
        releaseNewSessionSubmit()
        return
      }
      const hasContextOnlyInput =
        attachments.length > 0 ||
        notes.length > 0 ||
        sessions.length > 0 ||
        currentContext.items.length > 0 ||
        currentPrompt.some((part) => part.type === "file")
      if (hasContextOnlyInput) {
        showToast({
          type: "warning",
          title: i18n._(PI.submitAddMessage),
          description: i18n._(PI.submitAddMessageDesc),
        })
      }
      releaseNewSessionSubmit()
      return
    }
    if (input.pendingLightLoop() && !blueprintSlot && mode !== "normal") {
      showToast({
        type: "warning",
        title: i18n._(PI.submitNormalMessage),
        description: i18n._(PI.submitNormalMessageDesc),
      })
      releaseNewSessionSubmit()
      return
    }
    const pendingLightLoopSlashBlock =
      input.pendingLightLoop() && !blueprintSlot ? getPendingLightLoopSlashBlock(slashIntent) : undefined
    if (pendingLightLoopSlashBlock) {
      showToast({
        type: "warning",
        title: translateDescriptor(pendingLightLoopSlashBlock.title, i18n),
        description: translateDescriptor(pendingLightLoopSlashBlock.description, i18n),
      })
      releaseNewSessionSubmit()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        type: "warning",
        title: i18n._(PI.submitSelectAgent),
        description: i18n._(PI.submitSelectAgentDesc),
      })
      releaseNewSessionSubmit()
      return
    }

    const selectedVariant = local.model.variant.current()
    const selectedModel = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    input.addToHistory(currentPrompt, mode)
    input.setStore("historyIndex", -1)
    input.setStore("savedPrompt", null)

    const projectDirectory = sdk.directory
    const currentScopeKey = sdk.scopeKey
    // Capture (and disarm) workflow state armed on the new-session composer
    // before navigation can reset it; applied once the session exists.
    const armedPlan = isNewSession && input.pendingPlan()
    if (armedPlan) input.clearPendingPlan()
    const armedLattice = isNewSession ? input.pendingLattice() : null
    if (armedLattice) input.clearPendingLattice()
    const armedLightLoop = input.pendingLightLoop()
    const fileAttachmentsForTask = currentPrompt.filter((part): part is FileAttachmentPart => part.type === "file")
    const armedLightLoopTaskDescription = armedLightLoop
      ? buildLightLoopTaskDescription({
          text,
          uploads: attachments,
          notes,
          sessions,
          fileAttachments: fileAttachmentsForTask,
          contextItems: currentContext.items,
        })
      : undefined
    if (armedLightLoop && !armedLightLoopTaskDescription && !blueprintSlot) {
      showToast({
        type: "warning",
        title: i18n._(PI.submitLightLoopTitle),
        description: i18n._(PI.submitLightLoopDesc),
      })
      releaseNewSessionSubmit()
      return
    }
    if (armedLightLoop && blueprintSlot) input.clearPendingLightLoop()
    const workspaceSelection = input.props.newSessionWorkspaceSelection ?? { mode: "current" as const }
    const worktreeWorkspaceSelection = isWorktreeWorkspaceSelection(workspaceSelection) ? workspaceSelection : undefined
    const newSessionRecovery: NewSessionRecovery | undefined = isNewSession
      ? {
          draft: draftSnapshot,
          mode,
          workspaceSelection,
          controlProfile: input.selectedControlProfile(),
          plan: armedPlan,
          lattice: armedLattice,
          lightLoop: armedLightLoop,
          blueprintSlot,
          agent: currentAgent.name,
          model: selectedModel,
          variant: selectedVariant,
          autoSubmit: false,
        }
      : undefined
    const publishNewSessionTransition = (
      sessionID: string,
      progress: SessionTransitionProgress | null,
      actions?: SessionTransitionActions,
    ) => {
      input.props.onNewSessionTransitionChange?.({ sessionID, progress, actions })
    }
    const updateNewSessionWorktreeProgress = (sessionID: string, stage: "workspace" | "message") => {
      if (!worktreeWorkspaceSelection) return
      publishNewSessionTransition(
        sessionID,
        createNewSessionWorkspaceProgress({ selection: worktreeWorkspaceSelection, stage }),
      )
    }
    let sessionScopeKey = currentScopeKey
    let sessionCreateScopeKey = currentScopeKey

    const resolveSessionClient = (scopeKey: string) => {
      sessionScopeKey = scopeKey
      if (scopeKey !== currentScopeKey) {
        globalSync.ensureScopeState(scopeKey)
        return createSynergyClient({
          baseUrl: sdk.url,
          fetch: platform.fetch,
          directory: scopeKey,
          throwOnError: true,
        })
      }
      return sdk.client
    }
    let client = resolveSessionClient(
      isNewSession && !sdk.isHome
        ? (input.props.newSessionCanonicalDirectory ?? projectDirectory ?? currentScopeKey)
        : currentScopeKey,
    )
    if (isNewSession && !sdk.isHome) {
      sessionCreateScopeKey = input.props.newSessionCanonicalDirectory ?? projectDirectory ?? currentScopeKey
    }

    let createdSessionForSubmit = false
    const persistCreatedSessionFailure = (sessionID: string, title: string, message: string) => {
      if (!createdSessionForSubmit || !newSessionRecovery) return false
      const actions = createNewSessionRecoveryActions({
        recovery: newSessionRecovery,
        setRecovery: (recovery) => sessionTransition.setRecovery(currentScopeKey, recovery),
        deleteSession: async () => {
          await client.session.delete({ sessionID }).catch(() => undefined)
        },
        clearTransition: () => publishNewSessionTransition(sessionID, null),
        navigateToComposer: () => navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true }),
      })
      const progress = worktreeWorkspaceSelection
        ? createNewSessionWorkspaceErrorProgress({ title, message })
        : createNewSessionTransitionErrorProgress({ title, message })
      publishNewSessionTransition(sessionID, progress, actions)
      return true
    }
    const failCreatedSessionSetup = (sessionID: string, title: string, message: string) => {
      persistCreatedSessionFailure(sessionID, title, message)
      releaseNewSessionSubmit()
    }
    const sessionStartFailureMessage = (message: string) =>
      createdSessionForSubmit ? `${i18n._(PI.submitSessionNotStarted)} ${message}` : message

    let session: (typeof sync.session.get extends (...args: any[]) => infer R ? R : never) | null | undefined =
      params.id ? sync.session.get(params.id) : undefined
    if (!session && isNewSession) {
      session = await client.session
        .create({
          controlProfile: input.selectedControlProfile(),
          workspace: { mode: "current" },
        })
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          releaseNewSessionSubmit()
          showToast({
            type: "error",
            title: i18n._(PI.submitFailedStart),
            description: errorMessage(err),
          })
          return null
        })
      if (session === null) return
      if (session) {
        createdSessionForSubmit = true
        client = resolveSessionClient(sessionCreateScopeKey)
        local.handoffNewSessionIntent(session.id)
        if (selectedVariant) {
          local.model.variant.setForSession(session.id, selectedVariant, selectedModel, sessionScopeKey)
        }
        input.props.onNewSessionWorkspaceSelectionReset?.()
        publishNewSessionTransition(
          session.id,
          worktreeWorkspaceSelection
            ? createNewSessionWorkspaceProgress({ selection: worktreeWorkspaceSelection, stage: "workspace" })
            : createNewSessionTransitionProgress(),
        )
        navigate(`/${base64Encode(sessionScopeKey)}/session/${session.id}`)

        if (worktreeWorkspaceSelection) {
          try {
            if (worktreeWorkspaceSelection.mode === "create") {
              const result = await client.worktree.create({
                directory: sessionCreateScopeKey,
                worktreeCreateInput: {
                  sessionID: session.id,
                  bind: true,
                },
              })
              const setupFailure = worktreeSetupFailureMessage(result.data)
              if (setupFailure) throw new Error(setupFailure)
            } else {
              await client.worktree.enter({
                directory: sessionCreateScopeKey,
                sessionID: session.id,
                worktreeEnterInput: { target: worktreeWorkspaceSelection.target },
              })
            }
            updateNewSessionWorktreeProgress(session.id, "message")
          } catch (err) {
            const message = errorMessage(err)
            showToast({
              type: "error",
              title: i18n._(PI.submitFailedWorktree),
              description: sessionStartFailureMessage(message),
            })
            failCreatedSessionSetup(session.id, i18n._(PI.submitFailedWorktree), message)
            return
          }
        }
      }
    }
    if (!session && params.id) {
      await sync.session.sync(params.id)
      session = sync.session.get(params.id)
    }
    if (!session) {
      releaseNewSessionSubmit()
      return
    }
    if (isNewSession && session.controlProfile !== input.selectedControlProfile()) {
      session = await client.session
        .update({ sessionID: session.id, controlProfile: input.selectedControlProfile() })
        .then((x) => x.data ?? session)
        .catch(() => session)
    }
    if (!session) {
      releaseNewSessionSubmit()
      return
    }
    const failSessionSetup = (sessionID: string, title: string, message: string) => {
      failCreatedSessionSetup(sessionID, title, message)
    }
    if (blueprintSlot && (session.workflow?.kind === "plan" || session.workflow?.kind === "lightloop")) {
      const sessionID = session.id
      const fallbackSession = session
      const workflowName = session.workflow.kind === "plan" ? "Plan" : "Light Loop"
      session = await client.workflow.session
        .set({ id: sessionID, workflowSetInput: { kind: "none" } })
        .then((x) => x.data ?? fallbackSession)
        .catch(async (err) => {
          const message = errorMessage(err)
          showToast({
            type: "error",
            title: i18n._({ ...PI.submitFailedExitWorkflow, values: { workflow: workflowName } }),
            description: sessionStartFailureMessage(message),
          })
          failSessionSetup(
            sessionID,
            i18n._({ ...PI.submitFailedExitWorkflow, values: { workflow: workflowName } }),
            message,
          )
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
          const message = errorMessage(err)
          showToast({
            type: "error",
            title: i18n._(PI.submitFailedTogglePlan),
            description: sessionStartFailureMessage(message),
          })
          failSessionSetup(sessionID, i18n._(PI.submitFailedTogglePlan), message)
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
          const message = errorMessage(err)
          showToast({
            type: "error",
            title: i18n._(PI.submitFailedEnableLattice),
            description: sessionStartFailureMessage(message),
          })
          failSessionSetup(sessionID, i18n._(PI.submitFailedEnableLattice), message)
          return undefined
        })
      if (!session) return
    }
    let enabledLightLoopForSubmit: { sessionID: string } | undefined
    if (!blueprintSlot && armedLightLoop && !armedLattice && session.workflow?.kind !== "lightloop") {
      const sessionID = session.id
      const fallbackSession = session
      session = await client.workflow.session
        .set({
          id: sessionID,
          workflowSetInput: { kind: "lightloop", taskDescription: armedLightLoopTaskDescription! },
        })
        .then((x) => {
          enabledLightLoopForSubmit = { sessionID }
          return x.data ?? fallbackSession
        })
        .catch(async (err) => {
          const message = errorMessage(err)
          showToast({
            type: "error",
            title: i18n._(PI.submitFailedLightLoop),
            description: sessionStartFailureMessage(message),
          })
          failSessionSetup(sessionID, i18n._(PI.submitFailedLightLoop), message)
          return undefined
        })
      if (!session) return
    }
    const activeSession = session!

    const model = selectedModel
    const agent = currentAgent.name
    const variant = selectedVariant
    const clearInput = () => {
      prompt.resetDraft()
      input.setStore("mode", "normal")
      input.setStore("popover", null)
      input.setLocalArmedLoop(null)
    }

    const failActiveSessionSubmit = (title: string, message: string) => {
      const persisted = persistCreatedSessionFailure(activeSession.id, title, message)
      releaseNewSessionSubmit()
      if (!persisted) restoreInput()
    }

    const rollbackLightLoopForSubmit = async () => {
      if (!enabledLightLoopForSubmit) return
      await client.workflow.session
        .set({
          id: enabledLightLoopForSubmit.sessionID,
          workflowSetInput: { kind: "none" },
        })
        .catch(() => undefined)
    }

    const finishNewSessionTransition = () => {
      if (!createdSessionForSubmit) return
      const progress = worktreeWorkspaceSelection
        ? createNewSessionWorkspaceSuccessProgress({ selection: worktreeWorkspaceSelection })
        : createNewSessionTransitionSuccessProgress()
      publishNewSessionTransition(activeSession.id, progress, {
        dismiss: () => publishNewSessionTransition(activeSession.id, null),
      })
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
        finishNewSessionTransition()
        releaseNewSessionSubmit()
      } catch (err) {
        const message = errorMessage(err)
        if (createdLoopID) {
          await sdk.client.blueprint.loop.cancel({ id: createdLoopID }).catch(() => undefined)
        }
        showToast({
          type: "error",
          title: i18n._(PI.submitFailedBlueprint),
          description: sessionStartFailureMessage(message),
        })
        failActiveSessionSubmit(i18n._(PI.submitFailedBlueprint), message)
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
          finishNewSessionTransition()
          releaseNewSessionSubmit()
        })
        .catch(async (err) => {
          const message = errorMessage(err)
          showToast({
            type: "error",
            title: i18n._(PI.submitFailedShell),
            description: sessionStartFailureMessage(message),
          })
          failActiveSessionSubmit(i18n._(PI.submitFailedShell), message)
        })
      return
    }

    if (slashIntent.kind === "backend-prompt" || slashIntent.kind === "backend-action") {
      clearInput()
      sendSessionCommand({
        client,
        sessionID: activeSession.id,
        command: slashIntent.command,
        arguments: slashIntent.arguments,
        agent,
        model,
        variant,
        attachments,
        notes,
        sessions,
      })
        .then(() => {
          finishNewSessionTransition()
          releaseNewSessionSubmit()
          if (armedLightLoop) input.clearPendingLightLoop()
        })
        .catch(async (err) => {
          const message = errorMessage(err)
          await rollbackLightLoopForSubmit()
          showToast({
            type: "error",
            title: i18n._(PI.submitFailedCommand),
            description: sessionStartFailureMessage(message),
          })
          failActiveSessionSubmit(i18n._(PI.submitFailedCommand), message)
        })
      return
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
        finishNewSessionTransition()
        releaseNewSessionSubmit()
        if (armedLightLoop) input.clearPendingLightLoop()
        if (result.data?.status === "queued" && optimisticAdded) {
          removeOptimisticMessage()
          optimisticAdded = false
        }
        if (!wsConnected) {
          showToast({
            type: "warning",
            title: i18n._(PI.submitQueued),
            description: i18n._(PI.submitSentDesc),
          })
        }
      })
      .catch(async (err) => {
        const message = errorMessage(err)
        await rollbackLightLoopForSubmit()
        showToast({
          type: "error",
          title: i18n._(PI.submitFailedSend),
          description: sessionStartFailureMessage(message),
        })
        if (optimisticAdded) removeOptimisticMessage()
        failActiveSessionSubmit(i18n._(PI.submitFailedSend), message)
      })
  }
}
