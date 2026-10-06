import { resolveSessionReference } from "@/utils/session-reference"
import { type Accessor, Setter, batch, onCleanup, startTransition } from "solid-js"
import { produce, reconcile, type SetStoreFunction } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { createSynergyClient, type Message, type Part } from "@ericsanchezok/synergy-sdk/client"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLocal } from "@/context/local"
import { thinkingSelection } from "@/context/prompt/model-selection"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { projectFlowCopy } from "../dialog/project-flow-copy"
import { resolveTaskEnvironment } from "../session/task-location"
import { draftTransitionKey, useSessionTransition } from "@/context/session-transition"
import type {
  FileAttachmentPart,
  NoteAttachmentPart,
  Prompt,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import type { ControlProfileId } from "@/context/input"
import { Identifier } from "@/utils/id"
import { requestErrorMessage as errorMessage } from "@/utils/error"
import {
  formatNoteContent,
  formatSessionPreview,
  formatSessionReference,
  inlineLength,
  inlineText,
  SESSION_PREVIEW_MAX_MESSAGES,
} from "./content"
import { setCursorPosition } from "./editor-dom"
import { createSubmissionPartIDs, createSubmissionParts, optimisticPartSummaries } from "./submission-parts"
import { createPromptDraftSnapshot, createSubmitFailureRestoreSnapshot } from "@/utils/prompt"
import { sendSessionCommand } from "./session-command"
import type { BlueprintSlot, PromptInputMode, PromptInputProps, PromptInputStore } from "./types"
import { buildLightLoopInstructions } from "./light-loop-instructions"
import { getPendingLightLoopSlashBlock, resolveSlashCommandIntent, type SlashUiCommand } from "./slash-command-intent"
import {
  resolvePromptSubmitIntent,
  shouldAllowPromptSubmit,
  shouldBlockSubmitForUploadingAttachments,
  shouldRunComposerBeforeSubmit,
} from "./submit-intent"
import { acquireNewSessionSubmitLock } from "./new-session-submit-lock"
import {
  createNewSessionWorkspaceAcceptedProgress,
  createNewSessionWorkspaceErrorProgress,
  createNewSessionWorkspaceProgress,
  createNewSessionWorkspaceSuccessProgress,
  isWorktreeWorkspaceSelection,
} from "@/components/session/worktree-session"
import {
  createNewSessionTransitionAcceptedProgress,
  createNewSessionTransitionErrorProgress,
  createSessionActivityProgress,
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
  type SessionTransitionActions,
  type SessionTransitionProgress,
} from "@/components/session/session-transition-progress"
import type { SessionTransitionHandoff } from "@/components/session/session-transition-handoff"
import { isInboxItemMaterialized, upsertSessionInboxItem } from "@/components/session/session-inbox-utils"
import { createNewSessionRecoveryActions, type NewSessionRecovery } from "@/components/session/new-session-recovery"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { PI } from "./prompt-input-i18n"
import { reconcileMessage, removeMessageFromWindow, type MessageWindowState } from "@/context/session-message-window"
import { clearConversationContent } from "@/context/conversation-content-state"
import { nextMessageWindowTotal, nextMessageWindowTotalAfterRemoval } from "@/context/session-message-total"
import { promptSubmitFailure } from "./submit-failure"
import type { WorkspaceRecoveryRequest } from "../dialog/workspace-dialog-model"
import { recoverSessionInputReceipt } from "./input-receipt"
import { runComposerPreflight } from "./composer-preflight"
import { createOptimisticUserMessage } from "./optimistic-user-message"
import { handoffOptimisticMessage, isOptimisticMessagePending } from "@/context/session-optimistic-message"

type PromptSubmitInput = {
  props: Pick<
    PromptInputProps,
    | "newSessionEnvironmentID"
    | "newSessionEnvironmentProfile"
    | "newSessionWorkspaceSelection"
    | "newSessionCanonicalDirectory"
    | "onNewSessionWorkspaceSelectionReset"
    | "onNewSessionTransitionChange"
    | "sessionTransitionPending"
  >
  uploadedAttachments: Accessor<UploadedAttachmentPart[]>
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  attachmentsUploading: Accessor<boolean>
  attachmentsFailed?: Accessor<boolean>
  selectedControlProfile: Accessor<ControlProfileId>
  pendingPlan: Accessor<boolean>
  clearPendingPlan: () => void
  pendingLattice: Accessor<{ mode: "auto" | "collaborative"; maxModelCalls: number } | null>
  clearPendingLattice: () => void
  pendingLightLoop: Accessor<boolean>
  clearPendingLightLoop: () => void
  pendingBoss: Accessor<boolean>
  clearPendingBoss: () => void
  onBossEnabled: () => void
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
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  onWorkspaceUnavailable: (request: WorkspaceRecoveryRequest) => void
  onWorktreeUnavailable: () => void
  beforeSubmit: () => Promise<void>
  onAccepted?: (unchanged: boolean) => void
}

export function usePromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const promptContext = usePrompt()
  const sessionTransition = useSessionTransition()
  const params = useParams()
  const { i18n } = useLocale()
  let disposed = false
  onCleanup(() => (disposed = true))

  return async (event: Event) => {
    event.preventDefault()
    const binding = promptContext.capture()
    const prompt = binding.draft
    const initialSessionId = params.id
    let releaseSubmit: (() => void) | undefined
    let preparation: ReturnType<typeof sessionTransition.prepareDraft> | undefined
    try {
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
      releaseSubmit = newSessionSubmitLease.release

      const capture = () => {
        const currentPrompt = prompt.current()
        const text = currentPrompt
          .map((part) => ("content" in part && part.type === "text" ? part.content : ""))
          .join("")
        const currentContext = { items: prompt.context.items() }
        return {
          currentPrompt,
          text,
          attachments: input.uploadedAttachments().slice(),
          notes: input.noteAttachments().slice(),
          sessions: input.sessionAttachments().slice(),
          mode: input.store.mode,
          currentContext,
          draftSnapshot: createPromptDraftSnapshot({ prompt: currentPrompt, context: currentContext }),
          failureRestoreSnapshot: createSubmitFailureRestoreSnapshot({
            prompt: currentPrompt,
            context: currentContext,
          }),
        }
      }
      let {
        currentPrompt,
        text,
        attachments,
        notes,
        sessions,
        mode,
        currentContext,
        draftSnapshot,
        failureRestoreSnapshot,
      } = capture()
      let restoreRevision = prompt.revision()
      const restoreInput = (options?: { focus?: boolean }) => {
        if (!prompt.restoreIfUnchanged(restoreRevision, failureRestoreSnapshot)) return
        restoreRevision = prompt.revision()
        if (!binding.isCurrent()) return
        input.setStore("mode", mode)
        input.setStore("popover", null)

        if (options?.focus === false) return
        requestAnimationFrame(() => {
          const editor = input.editor()
          if (!binding.isCurrent() || !editor?.isConnected) return
          editor.focus()
          setCursorPosition(editor, inlineLength(failureRestoreSnapshot.prompt))
          input.queueScroll()
        })
      }
      let slashIntent = resolveSlashCommandIntent({
        text,
        backendCommands: sync.data.command,
        uiCommands: input.frontendCommands(),
      })

      const blueprintSlot = input.localArmedLoop()
      let submitIntent = resolvePromptSubmitIntent({
        text,
        working: input.working(),
        hasBlueprintSlot: !!blueprintSlot,
      })
      if (submitIntent === "abort") {
        input.abort()
        return
      }
      if (
        [...prompt.current(), ...prompt.context.items()].some(
          (part) => part.type === "file" && part.originScopeID && part.originScopeID !== sdk.scopeID,
        )
      ) {
        showToast({ type: "warning", title: i18n._(projectFlowCopy.unavailableReference) })
        return
      }
      if (shouldBlockSubmitForUploadingAttachments({ uploading: input.attachmentsUploading(), intent: submitIntent })) {
        if (input.attachmentsFailed?.()) {
          showToast({
            type: "warning",
            title: i18n._({ id: "prompt.attachments.resolveFailed", message: "Review failed attachments" }),
            description: i18n._({
              id: "prompt.attachments.blocked",
              message: "Retry or remove failed attachments above the editor before sending.",
            }),
          })
          return
        }
        showToast({
          type: "warning",
          title: i18n._(PI.submitWaitUploadsTitle),
          description: i18n._(PI.submitWaitUploadsDesc),
        })
        return
      }
      if (submitIntent === "blocked") {
        if (input.pendingLightLoop()) {
          showToast({
            type: "warning",
            title: i18n._(PI.submitLightLoopTitle),
            description: i18n._(PI.submitLightLoopDesc),
          })
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
        return
      }
      if (input.pendingLightLoop() && !blueprintSlot && mode !== "normal") {
        showToast({
          type: "warning",
          title: i18n._(PI.submitNormalMessage),
          description: i18n._(PI.submitNormalMessageDesc),
        })
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
        return
      }

      const submissionSessionID = isNewSession ? Identifier.descending("session") : initialSessionId
      const submissionMessageID = isNewSession ? Identifier.ascending("message") : undefined
      const submittedAt = Date.now()
      const submissionServer = sdk.url
      const partID = createSubmissionPartIDs()
      const captureSubmission = () => {
        const model = local.model.current()
        const agent = local.agent.current()
        if (!submissionMessageID || !submissionSessionID || !model || !agent) return undefined
        const message = createOptimisticUserMessage({
          id: submissionMessageID,
          sessionID: submissionSessionID,
          created: submittedAt,
          agent: agent.name,
          model: { modelID: model.id, providerID: model.provider.id },
          variant: local.model.variant.displayed(),
          metadata: { promptDraft: draftSnapshot },
        })
        const parts = createSubmissionParts({
          id: partID,
          prompt: currentPrompt,
          context: currentContext.items,
          attachments,
          notes,
          sessions,
          workspace: input.props.newSessionCanonicalDirectory ?? sdk.directory,
        }).map((part) => ({ ...part, sessionID: submissionSessionID, messageID: submissionMessageID })) as Part[]
        return {
          text,
          messageID: submissionMessageID,
          prompt: currentPrompt,
          submittedAt,
          serverUrl: submissionServer,
          message,
          parts,
        }
      }
      if (isNewSession && submitIntent === "message" && mode === "normal" && !blueprintSlot) {
        preparation = sessionTransition.prepareDraft(draftTransitionKey(sdk.url, sdk.scopeKey))
        const captured = captureSubmission()
        if (captured)
          batch(() => {
            sessionTransition.messageArrival.add(
              [sdk.url, sdk.scopeKey, captured.message.sessionID],
              captured.messageID,
            )
            preparation?.submit(captured)
          })
      }

      const runsBeforeSubmit = shouldRunComposerBeforeSubmit({
        intent: submitIntent,
        mode,
        slashKind: slashIntent.kind,
        hasBlueprintSlot: !!blueprintSlot,
        pendingLightLoop: input.pendingLightLoop(),
      })
      if (runsBeforeSubmit) {
        const completed = await runComposerPreflight({
          beforeSubmit: async () => {
            try {
              await input.beforeSubmit()
            } finally {
              restoreRevision = prompt.revision()
            }
          },
          restore: restoreInput,
          onNonAbortError: (error) =>
            showToast({
              type: "error",
              title: i18n._(PI.submitInterceptFailed),
              description: errorMessage(error),
            }),
        })
        if (!completed || !binding.isCurrent()) {
          return
        }
        ;({
          currentPrompt,
          text,
          attachments,
          notes,
          sessions,
          mode,
          currentContext,
          draftSnapshot,
          failureRestoreSnapshot,
        } = capture())
        slashIntent = resolveSlashCommandIntent({
          text,
          backendCommands: sync.data.command,
          uiCommands: input.frontendCommands(),
        })
        submitIntent = resolvePromptSubmitIntent({
          text,
          working: input.working(),
          hasBlueprintSlot: !!blueprintSlot,
        })
        if (submitIntent !== "message") {
          return
        }
      }
      if (
        !shouldAllowPromptSubmit({
          intent: submitIntent,
          variantReady: local.model.variant.ready(),
          requiresVariant: mode === "normal" && !blueprintSlot,
        })
      ) {
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
        return
      }

      sessions = sessions.map((part) => resolveSessionReference(part, globalSync.data.scope))
      const selectedVariant = local.model.variant.displayed()
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
      const armedBoss = input.pendingBoss()
      if (armedBoss) input.clearPendingBoss()
      const fileAttachmentsForInstructions = currentPrompt.filter(
        (part): part is FileAttachmentPart => part.type === "file",
      )
      const armedLightLoopInstructions = armedLightLoop
        ? buildLightLoopInstructions({
            text,
            uploads: attachments,
            notes,
            sessions,
            fileAttachments: fileAttachmentsForInstructions,
            contextItems: currentContext.items,
          })
        : undefined
      if (armedLightLoop && !armedLightLoopInstructions && !blueprintSlot) {
        showToast({
          type: "warning",
          title: i18n._(PI.submitLightLoopTitle),
          description: i18n._(PI.submitLightLoopDesc),
        })
        return
      }
      if (armedLightLoop && blueprintSlot) input.clearPendingLightLoop()
      const { environmentID, environmentProfile } = resolveTaskEnvironment({
        id: input.props.newSessionEnvironmentID,
        profile: input.props.newSessionEnvironmentProfile,
      })
      const workspaceSelection = input.props.newSessionWorkspaceSelection ?? { mode: "current" as const }
      const worktreeWorkspaceSelection = isWorktreeWorkspaceSelection(workspaceSelection)
        ? workspaceSelection
        : undefined
      const newSessionRecovery: NewSessionRecovery | undefined = isNewSession
        ? {
            draft: draftSnapshot,
            mode,
            workspaceSelection,
            controlProfile: input.selectedControlProfile(),
            environmentID,
            environmentProfile,
            plan: armedPlan,
            lattice: armedLattice,
            lightLoop: armedLightLoop,
            boss: armedBoss,
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
        handoff?: SessionTransitionHandoff,
      ) => {
        input.props.onNewSessionTransitionChange?.({ sessionID, progress, actions, handoff })
      }
      const updateNewSessionWorktreeProgress = (sessionID: string, stage: "workspace" | "message") => {
        if (!worktreeWorkspaceSelection) return
        publishNewSessionTransition(
          sessionID,
          createNewSessionWorkspaceProgress({ selection: worktreeWorkspaceSelection, stage }),
        )
      }
      const sessionScopeKey = currentScopeKey
      const client = sdk.client
      const connection = sdk.url
      const currentLocation = () =>
        server.url === connection && !!params.dir && base64Decode(params.dir) === sessionScopeKey

      let inputCleared = false
      const clearInput = () => {
        if (inputCleared) return false
        const clearedRevision = binding.clearIfUnchanged(restoreRevision)
        if (clearedRevision === undefined) return false
        inputCleared = true
        restoreRevision = clearedRevision
        input.setStore("mode", "normal")
        input.setStore("popover", null)
        input.setLocalArmedLoop(null)
        input.onAccepted?.(prompt.revision() === clearedRevision)
        return true
      }
      if (submissionMessageID)
        batch(() => {
          if (!clearInput()) return
          const captured = captureSubmission()
          if (captured) preparation?.submit(captured)
          preparation?.progress(
            worktreeWorkspaceSelection
              ? createNewSessionWorkspaceProgress({ selection: worktreeWorkspaceSelection, stage: "workspace" })
              : createSessionActivityProgress("new-session", "preparing_session"),
          )
        })

      let createdSessionForSubmit = false
      const newSessionFailureActions = (sessionID: string, recovery: NewSessionRecovery) =>
        createNewSessionRecoveryActions({
          recovery,
          setRecovery: (recovery) => sessionTransition.setRecovery(currentScopeKey, recovery),
          deleteSession: async () => {
            if (currentLocation() && params.id === sessionID) {
              const current = promptContext.capture()
              try {
                current.transferToSession(undefined)
              } finally {
                current.release()
              }
            }
            await client.session.delete({ sessionID }).catch(() => undefined)
          },
          clearTransition: () => publishNewSessionTransition(sessionID, null),
          navigateToComposer: () => navigate(`/${base64Encode(currentScopeKey)}/session`, { replace: true }),
        })
      const persistCreatedSessionFailure = (sessionID: string, title: string, message: string) => {
        if (!createdSessionForSubmit || !newSessionRecovery) return false
        const actions = newSessionFailureActions(sessionID, newSessionRecovery)
        const progress = worktreeWorkspaceSelection
          ? createNewSessionWorkspaceErrorProgress({ title, message })
          : createNewSessionTransitionErrorProgress({ title, message })
        publishNewSessionTransition(sessionID, progress, actions)
        return true
      }
      const failCreatedSessionSetup = (sessionID: string, title: string, message: string) => {
        persistCreatedSessionFailure(sessionID, title, message)
      }
      const sessionStartFailureMessage = (message: string) =>
        createdSessionForSubmit ? `${i18n._(PI.submitSessionNotStarted)} ${message}` : message

      let session: (typeof sync.session.get extends (...args: any[]) => infer R ? R : never) | null | undefined =
        initialSessionId ? sync.session.get(initialSessionId) : undefined
      if (!session && isNewSession) {
        session = await client.session
          .create({
            id: submissionSessionID,
            environmentID,
            environmentProfile,
            controlProfile: input.selectedControlProfile(),
            workspace: workspaceSelection,
          })
          .then((x) => x.data ?? undefined)
          .catch((err) => {
            const failure = promptSubmitFailure(err)
            const isCurrent = () => currentLocation() && !disposed && binding.isCurrent()
            if (failure.kind === "workspace-unavailable" && isCurrent())
              input.onWorkspaceUnavailable({
                kind: "draft",
                workspaceID: failure.workspaceID,
                reason: failure.reason,
                isCurrent,
              })
            const recover = (autoSubmit: boolean) => {
              if (!newSessionRecovery) return
              batch(() => {
                preparation?.clear()
                sessionTransition.setRecovery(currentScopeKey, { ...newSessionRecovery, autoSubmit })
              })
            }
            preparation?.progress(
              createNewSessionTransitionErrorProgress({
                title: i18n._(PI.submitFailedStart),
                message: errorMessage(err),
              }),
              { retry: () => recover(true), dismiss: () => recover(false) },
            )
            return null
          })
        if (session === null) return
        if (session) {
          createdSessionForSubmit = true
          const createdSessionID = session.id
          const initialProgress = worktreeWorkspaceSelection
            ? createSessionActivityProgress("new-worktree-session", "preparing_session")
            : createSessionActivityProgress("new-session", "preparing_session")
          await startTransition(() => {
            local.handoffNewSessionIntent(createdSessionID)
            preparation?.handoff(createdSessionID, initialProgress)
            publishNewSessionTransition(createdSessionID, initialProgress)
            if (binding.isCurrent() && binding.transferToSession(createdSessionID))
              navigate(`/${base64Encode(sessionScopeKey)}/session/${createdSessionID}`)
          })
          try {
            const saved = await client.session.setModelSelection(
              {
                sessionID: session.id,
                sessionModelSelectionInput: {
                  model: selectedModel,
                  thinking: thinkingSelection(selectedVariant),
                  expectedRevision: 0,
                },
              },
              { throwOnError: true },
            )
            if (saved.data) session = saved.data
          } catch (error) {
            failCreatedSessionSetup(session.id, i18n._(PI.submitFailedStart), errorMessage(error))
            return
          }
          input.props.onNewSessionWorkspaceSelectionReset?.()
          publishNewSessionTransition(
            session.id,
            worktreeWorkspaceSelection
              ? createNewSessionWorkspaceProgress({ selection: worktreeWorkspaceSelection, stage: "message" })
              : createNewSessionTransitionProgress(),
          )
        }
      }
      if (!session && initialSessionId) {
        await sync.session.sync(initialSessionId)
        session = sync.session.get(initialSessionId)
      }
      if (!session) {
        return
      }
      if (isNewSession && session.controlProfile !== input.selectedControlProfile()) {
        session = await client.session
          .update({ sessionID: session.id, controlProfile: input.selectedControlProfile() })
          .then((x) => x.data ?? session)
          .catch(() => session)
      }
      if (!session) {
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
            workflowSetInput: { kind: "lightloop", instructions: armedLightLoopInstructions! },
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
      if (armedBoss && !blueprintSlot && session.workflow?.kind !== "boss") {
        const sessionID = session.id
        const fallbackSession = session
        session = await client.workflow.session
          .set({ id: sessionID, workflowSetInput: { kind: "boss" } })
          .then((x) => {
            input.onBossEnabled()
            return x.data ?? fallbackSession
          })
          .catch(async (err) => {
            const message = errorMessage(err)
            showToast({
              type: "error",
              title: i18n._(PI.submitFailedEnableBoss),
              description: sessionStartFailureMessage(message),
            })
            failSessionSetup(sessionID, i18n._(PI.submitFailedEnableBoss), message)
            return undefined
          })
        if (!session) return
      }
      const activeSession = session!

      const model = selectedModel
      const agent = currentAgent.name
      const variant = selectedVariant

      const acknowledgeInput = () => {
        clearInput()
        input.onAccepted?.(
          prompt.revision() === restoreRevision && (binding.isCurrent() || params.id === activeSession.id),
        )
        if (armedLightLoop) input.clearPendingLightLoop()
      }

      const failActiveSessionSubmit = (title: string, message: string, options?: { focus?: boolean }) => {
        const persisted = persistCreatedSessionFailure(activeSession.id, title, message)
        if (!persisted) restoreInput(options)
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
        input.onAccepted?.(
          prompt.revision() === restoreRevision && (binding.isCurrent() || params.id === activeSession.id),
        )
        if (!createdSessionForSubmit) return
        const progress = worktreeWorkspaceSelection
          ? createNewSessionWorkspaceSuccessProgress({ selection: worktreeWorkspaceSelection })
          : createNewSessionTransitionSuccessProgress()
        publishNewSessionTransition(activeSession.id, progress, {
          dismiss: () => publishNewSessionTransition(activeSession.id, null),
        })
      }

      const handoffNewSessionMessage = (
        input: { messageID: string; itemID?: string; acceptedAt: number },
        confirmed = true,
      ) => {
        if (!createdSessionForSubmit && confirmed) return
        const accepted = worktreeWorkspaceSelection
          ? createNewSessionWorkspaceAcceptedProgress({ selection: worktreeWorkspaceSelection })
          : createNewSessionTransitionAcceptedProgress()
        if (!confirmed) accepted.activity = { phase: "checking_receipt", startedAt: Date.now() }
        const success = worktreeWorkspaceSelection
          ? createNewSessionWorkspaceSuccessProgress({ selection: worktreeWorkspaceSelection })
          : createNewSessionTransitionSuccessProgress()
        publishNewSessionTransition(activeSession.id, accepted, undefined, {
          ...input,
          accepted,
          workspaceSelection,
          success,
          ...(!confirmed ? { unconfirmed: { missing: recoverUnacceptedInput, accepted: acknowledgeInput } } : {}),
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
        await client.session
          .shell({
            sessionID: activeSession.id,
            agent,
            model,
            command: text,
          })
          .then(() => {
            finishNewSessionTransition()
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
        await sendSessionCommand({
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

      const getSessionPreviewData = async (attachment: SessionAttachmentPart) => {
        if (!attachment.scopeID) throw new Error("Session reference has not been migrated")
        const [childStore] = globalSync.ensureScopeState(attachment.scopeID)
        const cachedMessages = childStore.message[attachment.sessionId]
        if (cachedMessages !== undefined) {
          return {
            messages: cachedMessages,
            getParts: (messageID: string) => childStore.part[messageID] ?? [],
          }
        }

        const response = await client.session.messages({
          scopeID: attachment.scopeID,
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

      const sessionContent = new Map(
        await Promise.all(
          sessions.map(async (attachment) => {
            let content = formatSessionReference(attachment)
            try {
              const preview = await getSessionPreviewData(attachment)
              content = formatSessionPreview({
                attachment,
                sessionMessages: preview.messages,
                getParts: preview.getParts,
              })
            } catch {}
            return [attachment.id, content] as const
          }),
        ),
      )
      const requestParts = createSubmissionParts({
        id: partID,
        prompt: currentPrompt,
        context: currentContext.items,
        attachments,
        notes,
        sessions,
        workspace: activeSession.workspace?.path,
        sessionContent,
      })
      const queueing = input.working() || !!activeSession.paused
      const messageID =
        submissionMessageID ??
        prompt.admissionIdentity(
          JSON.stringify({
            sessionID: activeSession.id,
            agent,
            model,
            variant,
            parts: requestParts.map((part) => ({ ...part, id: undefined })),
          }),
          () => Identifier.ascending("message"),
        )

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
        ? createOptimisticUserMessage({
            id: messageID,
            sessionID: activeSession.id,
            created: submittedAt,
            agent,
            model,
            variant,
            metadata: userMessageMetadata,
          })
        : undefined

      const [syncStore, setSyncStore] =
        sessionScopeKey === currentScopeKey ? [sync.data, sync.set] : globalSync.ensureScopeState(sessionScopeKey)

      const addOptimisticMessage = () => {
        if (!messageID || !optimisticMessage) return
        const metadata = syncStore.messageWindow[activeSession.id]
        const current: MessageWindowState<Message> = {
          messages: syncStore.message[activeSession.id] ?? [],
          mode: metadata?.mode ?? "latest",
          pendingLatest: metadata?.pendingLatest ?? false,
          pendingLatestIds: metadata?.pendingLatestIds ?? [],
          tailMissingLatest: metadata?.tailMissingLatest ?? false,
        }
        const existing = current.messages.some((message) => message.id === messageID)
        const result = reconcileMessage(current, optimisticMessage)
        const visible = result.window.messages.some((message) => message.id === messageID)
        if (visible && !existing && !preparation)
          sessionTransition.messageArrival.add([submissionServer, sessionScopeKey, activeSession.id], messageID)
        globalSync.invalidateResource(sessionScopeKey, activeSession.id, "message")
        setSyncStore(
          produce((draft) => {
            for (const droppedID of result.droppedIds) clearConversationContent(draft, droppedID)
            draft.message[activeSession.id] = result.window.messages
            draft.messageWindow[activeSession.id] = {
              nextCursor: metadata?.nextCursor ?? null,
              hasMore: metadata?.hasMore ?? false,
              total: nextMessageWindowTotal({
                total: metadata?.total ?? current.messages.length,
                existing,
                visible,
              }),
              mode: result.window.mode,
              pendingLatest: result.window.pendingLatest,
              pendingLatestIds: result.window.pendingLatestIds,
              tailMissingLatest: result.window.tailMissingLatest,
            }
            if (visible) {
              draft.partSummary[messageID] = optimisticPartSummaries(optimisticParts)
              for (const part of optimisticParts) draft.partVersion[part.id] = `optimistic:${part.id}`
              draft.partPage[messageID] = { hasMore: false, hasEarlier: false, nextCursor: null, previousCursor: null }
              draft.part[messageID] = optimisticParts
                .filter((part) => !!part?.id)
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
            }
          }),
        )
      }

      const handoffAcceptedOptimisticMessage = (canonicalID: string) => {
        if (!messageID) return
        if (canonicalID === messageID) return
        sessionTransition.messageIdentity.handoff(
          [submissionServer, sessionScopeKey, activeSession.id],
          messageID,
          canonicalID,
        )
        sessionTransition.messageArrival.handoff(
          [submissionServer, sessionScopeKey, activeSession.id],
          messageID,
          canonicalID,
        )
        const messages = syncStore.message[activeSession.id]
        if (!messages) return
        const metadata = syncStore.messageWindow[activeSession.id]
        const result = handoffOptimisticMessage({
          current: {
            messages,
            mode: metadata?.mode ?? "latest",
            pendingLatest: metadata?.pendingLatest ?? false,
            pendingLatestIds: metadata?.pendingLatestIds ?? [],
            tailMissingLatest: metadata?.tailMissingLatest ?? false,
          },
          optimisticParts: syncStore.part[messageID],
          canonicalParts: syncStore.part[canonicalID],
          optimisticID: messageID,
          canonicalID,
          total: metadata?.total ?? messages.length,
        })
        globalSync.invalidateResource(sessionScopeKey, activeSession.id, "message")
        batch(() => {
          sessionTransition.handoffMessage(activeSession.id, canonicalID)
          setSyncStore(
            produce((draft) => {
              draft.message[activeSession.id] = result.window.messages
              clearConversationContent(draft, messageID)
              if (result.canonicalParts) draft.part[canonicalID] = result.canonicalParts
              if (metadata) {
                draft.messageWindow[activeSession.id] = {
                  ...metadata,
                  total: result.total,
                  pendingLatest: result.window.pendingLatest,
                  pendingLatestIds: result.window.pendingLatestIds,
                }
              }
            }),
          )
        })
      }

      const removeOptimisticMessage = () => {
        if (messageID)
          sessionTransition.messageArrival.remove([submissionServer, sessionScopeKey, activeSession.id], messageID)
        if (!messageID) return
        const messages = syncStore.message[activeSession.id]
        if (!messages) return
        const currentMessage = messages.find((message) => message.id === messageID)
        if (currentMessage && !isOptimisticMessagePending(currentMessage)) return
        const metadata = syncStore.messageWindow[activeSession.id]
        const current: MessageWindowState<Message> = {
          messages,
          mode: metadata?.mode ?? "latest",
          pendingLatest: metadata?.pendingLatest ?? false,
          pendingLatestIds: metadata?.pendingLatestIds ?? [],
          tailMissingLatest: metadata?.tailMissingLatest ?? false,
        }
        const pending = current.pendingLatestIds.includes(messageID)
        const result = removeMessageFromWindow(current, messageID)
        const removed = result.messages.length !== messages.length
        globalSync.invalidateResource(sessionScopeKey, activeSession.id, "message")
        setSyncStore(
          produce((draft) => {
            draft.message[activeSession.id] = result.messages
            clearConversationContent(draft, messageID)
            if (metadata) {
              draft.messageWindow[activeSession.id] = {
                ...metadata,
                total: removed
                  ? nextMessageWindowTotalAfterRemoval({ total: metadata.total, pending })
                  : metadata.total,
                pendingLatest: result.pendingLatest,
                pendingLatestIds: result.pendingLatestIds,
              }
            }
          }),
        )
      }

      let optimisticAdded = false
      if (!queueing) {
        addOptimisticMessage()
        optimisticAdded = true
      }
      clearInput()

      let inputInFlight = false
      const recoverUnacceptedInput = () => {
        removeOptimisticMessage()
        restoreInput({ focus: false })
        publishNewSessionTransition(
          activeSession.id,
          createNewSessionTransitionErrorProgress({
            title: i18n._(PI.submitFailedSend),
            message: i18n._(PI.submitSessionNotStarted),
          }),
          {
            retry: () => {
              if (inputInFlight) return
              publishNewSessionTransition(activeSession.id, createNewSessionTransitionProgress())
              inputCleared = false
              clearInput()
              addOptimisticMessage()
              optimisticAdded = true
              void sendInput()
            },
            dismiss: () => {
              publishNewSessionTransition(activeSession.id, null)
              void rollbackLightLoopForSubmit()
              if (!newSessionRecovery) return
              sessionTransition.setRecovery(currentScopeKey, { ...newSessionRecovery, autoSubmit: false })
              navigate(`/${base64Encode(currentScopeKey)}/session`)
            },
          },
        )
      }
      const sendInput = async () => {
        if (inputInFlight) return
        inputInFlight = true
        const wsConnected = sdk.connected()
        const inboxRequest = globalSync.captureResourceRequest(sessionScopeKey, activeSession.id, "inbox")
        return client.session
          .input(
            {
              sessionID: activeSession.id,
              agent,
              ...(messageID ? { messageID } : {}),
              parts: requestParts,
              metadata: {
                promptDraft: draftSnapshot,
                ...(createdSessionForSubmit ? { sessionTransition: { workspaceSelection } } : {}),
              },
            },
            { throwOnError: true },
          )
          .then((result) => {
            const accepted = result.data
            if (!accepted) throw new Error("Session input returned no acceptance result")
            acknowledgeInput()
            if (accepted.status === "queued") {
              const item = accepted.item
              // Guard the mutation upsert: the backend may have already consumed
              // this item (and materialized its message) before the acceptance
              // response lands, e.g. when the session went idle between enqueue
              // and response. Re-inserting would resurrect a ghost inbox row.
              // History-mode windows track unseen canonical arrivals in
              // pendingLatestIds rather than the messages array, so both count.
              if (
                !isInboxItemMaterialized(
                  syncStore.message[activeSession.id],
                  item,
                  isOptimisticMessagePending,
                  syncStore.messageWindow[activeSession.id]?.pendingLatestIds,
                )
              ) {
                globalSync.applyResourceMutationResponse(
                  sessionScopeKey,
                  activeSession.id,
                  "inbox",
                  inboxRequest,
                  result.response?.headers,
                  () => {
                    setSyncStore(
                      "inbox",
                      activeSession.id,
                      reconcile(upsertSessionInboxItem(syncStore.inbox[activeSession.id], item), { key: "id" }),
                    )
                  },
                )
              }
            }
            if (accepted.status === "queued" && optimisticAdded) {
              handoffAcceptedOptimisticMessage(accepted.item.messageID)
              optimisticAdded = false
            }
            handoffNewSessionMessage(
              accepted.status === "queued"
                ? {
                    messageID: accepted.item.messageID,
                    itemID: accepted.item.id,
                    acceptedAt: accepted.item.time.created,
                  }
                : { messageID: accepted.messageID, acceptedAt: Date.now() },
            )
            if (!wsConnected) {
              showToast({
                type: "warning",
                title: i18n._(PI.submitQueued),
                description: i18n._(PI.submitSentDesc),
              })
            }
          })
          .catch(async (err) => {
            const failure = promptSubmitFailure(err)
            const directoryUnavailable =
              failure.kind === "worktree-unavailable" || failure.kind === "workspace-unavailable"
            if (messageID) {
              const receipt = await recoverSessionInputReceipt(client, { sessionID: activeSession.id, messageID })
              if (receipt.kind !== "missing") {
                const progress = receipt.kind === "accepted" ? receipt.progress : undefined
                if (progress) acknowledgeInput()
                handoffNewSessionMessage({ messageID, itemID: progress?.itemID, acceptedAt: Date.now() }, !!progress)
                return
              }
              if (!directoryUnavailable) {
                recoverUnacceptedInput()
                return
              }
            }
            await rollbackLightLoopForSubmit()
            if (optimisticAdded) removeOptimisticMessage()
            const worktreeUnavailable = failure.kind === "worktree-unavailable"
            failActiveSessionSubmit(i18n._(PI.submitFailedSend), failure.message, {
              focus: !directoryUnavailable,
            })
            if (failure.kind === "workspace-unavailable") {
              const isCurrent = () =>
                currentLocation() && (params.id === activeSession.id || (!disposed && binding.isCurrent()))
              if (isCurrent())
                input.onWorkspaceUnavailable({
                  kind: "session",
                  sessionID: activeSession.id,
                  workspaceID: failure.workspaceID,
                  reason: failure.reason,
                  isCurrent,
                  onRecovered:
                    createdSessionForSubmit && newSessionRecovery
                      ? async (selection) => {
                          if (!isCurrent() || params.id !== activeSession.id) return
                          await newSessionFailureActions(activeSession.id, {
                            ...newSessionRecovery,
                            workspaceSelection: selection,
                            autoSubmit: false,
                          }).dismiss()
                        }
                      : undefined,
                })
              return
            }
            if (worktreeUnavailable) {
              input.onWorktreeUnavailable()
              return
            }
            showToast({
              type: "error",
              title: i18n._(PI.submitFailedSend),
              description: sessionStartFailureMessage(failure.message),
            })
          })
          .finally(() => {
            inputInFlight = false
          })
      }
      await sendInput()
    } finally {
      if (sessionTransition.get(draftTransitionKey(sdk.url, sdk.scopeKey))?.progress.phase !== "error")
        preparation?.clear()
      releaseSubmit?.()
      binding.release()
    }
  }
}
