import { Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalSDK } from "@/context/global-sdk"
import {
  reduceWorkspaceTransitionProgress,
  type WorkspaceTransitionProgressState,
} from "@/components/session/worktree-session"
import type { SessionStartProgress, SessionStartProgressStepState } from "./worktree-progress-components"
import { StepList } from "./worktree-progress-components"

export type { SessionStartProgress, SessionStartProgressStepState }
export { StepList, StepIcon } from "./worktree-progress-components"
import "./worktree-transition-dialog.css"

type WorktreeDialogOperation = "enter" | "leave"

function errorDescription(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (error instanceof Error && error.message) return error.message
  return "Request failed"
}

function operationIcon(operation: WorktreeDialogOperation) {
  return getSemanticIcon(operation === "leave" ? "workspace.leaveWorktree" : "workspace.enterWorktree")
}

function operationSuccessTitle(operation: WorktreeDialogOperation) {
  return operation === "leave" ? "Left worktree" : "Moved to worktree"
}

function operationDefaultDescription(operation: WorktreeDialogOperation) {
  if (operation === "leave") return "Return this session to the main checkout without deleting the worktree."
  return "Create an isolated checkout, then bind this session to it."
}

function operationBannerDetail(operation: WorktreeDialogOperation, phase: WorkspaceTransitionProgressState["phase"]) {
  if (phase === "error") return "The session workspace was not changed."
  if (phase === "loading") {
    return operation === "leave" ? "Updating the session workspace." : "Creating the checkout and binding the session."
  }
  return operation === "leave" ? "No worktree files will be removed." : "Name it now or use the generated branch name."
}

function operationResultTitle(operation: WorktreeDialogOperation) {
  return operation === "leave" ? "Main checkout active" : "Worktree active"
}

function operationResultDescription(operation: WorktreeDialogOperation) {
  return operation === "leave"
    ? "The worktree remains available for later use."
    : "Future commands use the isolated checkout."
}

export function SessionStartProgressDialog(props: { progress: () => SessionStartProgress }) {
  const progress = () => props.progress()
  return (
    <Dialog
      title={progress().title}
      description={progress().description}
      class="workspace-transition-dialog"
      dismissible={false}
      action={<span class="wtd-dialog-action-placeholder" aria-hidden="true" />}
    >
      <div class="wtd-progress-shell">
        <StepList steps={progress().steps} />
      </div>
    </Dialog>
  )
}

export function WorktreeTransitionContent(props: {
  mode: "enter" | "leave"
  sessionID: string
  directory: string
  onPendingChange?: (pending: boolean) => void
  onClose: () => void
}) {
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal("")
  const [state, setState] = createSignal<WorkspaceTransitionProgressState>(
    props.mode === "enter" ? { phase: "form", operation: "enter" } : { phase: "idle" },
  )
  const loading = createMemo(() => state().phase === "loading")
  const currentOperation = createMemo<WorktreeDialogOperation>(() => {
    const current = state()
    if (current.phase === "idle") return props.mode
    return current.operation === "leave" ? "leave" : "enter"
  })
  const title = createMemo(() => {
    const current = state()
    const operation = currentOperation()
    if (current.phase === "success") return operationSuccessTitle(operation)
    if (current.phase === "error") return operation === "leave" ? "Leave worktree failed" : "Move to worktree failed"
    return operation === "leave" ? "Leave worktree" : "Move session to worktree"
  })
  const description = createMemo(() => {
    const current = state()
    if (current.phase === "success") return current.message
    if (current.phase === "error") return current.message
    return operationDefaultDescription(currentOperation())
  })
  const steps = createMemo<SessionStartProgress["steps"]>(() => {
    const current = state()
    if (current.phase !== "loading") return []
    if (current.operation === "leave")
      return [
        {
          id: "leave",
          label: "Return to main checkout",
          detail: "Updating this session workspace.",
          state: "active" as const,
        },
      ]
    return [
      { id: "create", label: "Create checkout", detail: "Preparing a new git worktree.", state: "active" as const },
      { id: "prepare", label: "Bind session", detail: "Updating the session workspace.", state: "pending" as const },
    ]
  })

  const setPending = (pending: boolean) => props.onPendingChange?.(pending)

  const submit = async () => {
    if (loading()) return
    const operation = props.mode === "leave" ? "leave" : "enter"
    setState((prev) =>
      reduceWorkspaceTransitionProgress(prev, {
        type: "load",
        operation,
        step: operation === "leave" ? "Leaving worktree" : "Creating worktree",
      }),
    )
    setPending(true)
    try {
      if (props.mode === "leave") {
        await globalSDK.client.worktree.leave({ directory: props.directory, sessionID: props.sessionID })
        setState((prev) =>
          reduceWorkspaceTransitionProgress(prev, {
            type: "succeed",
            message: "This session now runs from the main checkout.",
          }),
        )
        showToast({ type: "info", title: "Left worktree", description: "Session returned to the main checkout." })
        return
      }

      const trimmed = name().trim()
      const result = await globalSDK.client.worktree.create({
        directory: props.directory,
        worktreeCreateInput: {
          sessionID: props.sessionID,
          bind: true,
          name: trimmed.length > 0 ? trimmed : undefined,
        },
      })
      const desc = result.data?.name
        ? `This session now runs in ${result.data.name}.`
        : "This session now runs in the new worktree."
      setState((prev) => reduceWorkspaceTransitionProgress(prev, { type: "succeed", message: desc }))
      showToast({ type: "info", title: "Moved to worktree", description: desc })
    } catch (error) {
      setState((prev) => reduceWorkspaceTransitionProgress(prev, { type: "fail", message: errorDescription(error) }))
      showToast({
        type: "error",
        title: props.mode === "leave" ? "Leave worktree failed" : "Move to worktree failed",
        description: errorDescription(error),
      })
    } finally {
      setPending(false)
    }
  }

  onMount(() => {
    if (props.mode === "leave") void submit()
  })

  return (
    <div class="session-worktree-transition relative flex flex-col h-full">
      <div class="flex items-center justify-between px-6 py-4 border-b border-border-weak-base">
        <div>
          <div class="text-text-strong text-base font-semibold">{title()}</div>
          <div class="text-text-weak text-sm mt-0.5">{description()}</div>
        </div>
        <button
          type="button"
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          disabled={loading()}
          class="w-[30px] h-[30px] rounded-lg text-icon-weak border border-border-base bg-surface-inset-base hover:text-icon-base hover:bg-surface-inset-base-hover hover:border-border-weak-base disabled:opacity-50 flex items-center justify-center"
          onClick={() => {
            if (!loading()) props.onClose()
          }}
        >
          <Icon name="x" size="small" />
        </button>
      </div>
      <div class="flex-1 overflow-auto px-6 py-4">
        <Show when={state().phase !== "success"}>
          <div class="wtd-operation-banner" data-operation={currentOperation()}>
            <span class="wtd-operation-icon">
              <Icon name={operationIcon(currentOperation())} size="normal" />
            </span>
            <div class="wtd-operation-copy">
              <span class="wtd-operation-label">
                {currentOperation() === "leave" ? "Main checkout" : "Session worktree"}
              </span>
              <span class="wtd-operation-detail">{operationBannerDetail(currentOperation(), state().phase)}</span>
            </div>
          </div>
        </Show>
        <Switch>
          <Match when={state().phase === "form"}>
            <form
              class="wtd-form"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <TextField
                autofocus
                label="Worktree name"
                placeholder="Auto-generated"
                value={name()}
                onChange={setName}
              />
              <div class="wtd-actions">
                <Button type="button" variant="ghost" size="small" onClick={props.onClose}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="small">
                  Create worktree
                </Button>
              </div>
            </form>
          </Match>
          <Match when={state().phase === "loading"}>
            <div class="wtd-progress-shell">
              <StepList steps={steps()} />
            </div>
          </Match>
          <Match when={state().phase === "success"}>
            <div class="wtd-result">
              <span class="wtd-result-icon" data-state="success">
                <Icon name={getSemanticIcon("state.success")} size="normal" />
              </span>
              <div class="wtd-result-copy">
                <div class="wtd-result-title">{operationResultTitle(currentOperation())}</div>
                <div class="wtd-result-description">{operationResultDescription(currentOperation())}</div>
              </div>
            </div>
            <div class="wtd-actions">
              <Button type="button" variant="primary" size="small" onClick={props.onClose}>
                Done
              </Button>
            </div>
          </Match>
          <Match when={state().phase === "error"}>
            <div class="wtd-error">{description()}</div>
            <div class="wtd-actions">
              <Button type="button" variant="ghost" size="small" onClick={props.onClose}>
                Cancel
              </Button>
              <Button type="button" variant="primary" size="small" onClick={() => void submit()}>
                Try again
              </Button>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
