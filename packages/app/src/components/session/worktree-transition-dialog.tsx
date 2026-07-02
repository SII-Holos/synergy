import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalSDK } from "@/context/global-sdk"
import {
  reduceWorkspaceTransitionProgress,
  type WorkspaceTransitionProgressState,
} from "@/components/session/worktree-session"
import "./worktree-transition-dialog.css"

export type SessionStartProgressStepState = "pending" | "active" | "complete"

export type SessionStartProgress = {
  title: string
  description: string
  steps: Array<{ id: string; label: string; state: SessionStartProgressStepState }>
}

function errorDescription(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (error instanceof Error && error.message) return error.message
  return "Request failed"
}

function DialogCloseButton(props: { disabled?: boolean }) {
  const dialog = useDialog()
  return (
    <button
      type="button"
      data-slot="dialog-close-button"
      data-component="icon-button"
      data-variant="ghost"
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) dialog.close()
      }}
    >
      <Icon name="x" size="small" />
    </button>
  )
}

function StepIcon(props: { state: SessionStartProgressStepState }) {
  return (
    <span class="wtd-step-icon" data-state={props.state}>
      <Switch>
        <Match when={props.state === "active"}>
          <Spinner class="wtd-step-spinner" />
        </Match>
        <Match when={props.state === "complete"}>
          <Icon name={getSemanticIcon("state.success")} size="small" />
        </Match>
        <Match when={true}>
          <span class="wtd-step-dot" />
        </Match>
      </Switch>
    </span>
  )
}

function StepList(props: { steps: SessionStartProgress["steps"] }) {
  return (
    <div class="wtd-step-list">
      <For each={props.steps}>
        {(step) => (
          <div class="wtd-step-row" data-state={step.state}>
            <StepIcon state={step.state} />
            <span>{step.label}</span>
          </div>
        )}
      </For>
    </div>
  )
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
      <StepList steps={progress().steps} />
    </Dialog>
  )
}

export function WorktreeTransitionDialog(props: {
  mode: "enter" | "leave"
  sessionID: string
  directory: string
  onPendingChange?: (pending: boolean) => void
}) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal("")
  const [state, setState] = createSignal<WorkspaceTransitionProgressState>(
    props.mode === "enter" ? { phase: "form", operation: "enter" } : { phase: "idle" },
  )
  const loading = createMemo(() => state().phase === "loading")
  const title = createMemo(() => {
    const current = state()
    if (current.phase === "success") return current.operation === "leave" ? "Left worktree" : "Moved to worktree"
    if (current.phase === "error")
      return current.operation === "leave" ? "Exit worktree failed" : "Enter worktree failed"
    return props.mode === "leave" ? "Leaving worktree" : "Move session to worktree"
  })
  const description = createMemo(() => {
    const current = state()
    if (current.phase === "success") return current.message
    if (current.phase === "error") return current.message
    if (props.mode === "leave") return "Returning this session to the main checkout."
    return "Create an isolated worktree for this session."
  })
  const steps = createMemo<SessionStartProgress["steps"]>(() => {
    const current = state()
    if (current.phase !== "loading") return []
    if (current.operation === "leave") return [{ id: "leave", label: "Leaving worktree", state: "active" }]
    return [
      { id: "create", label: "Creating worktree", state: "active" },
      { id: "prepare", label: "Preparing session", state: "pending" },
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
            message: "Session returned to the main checkout.",
          }),
        )
        showToast({ type: "info", title: "Exited worktree", description: "Session returned to the main checkout." })
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
      const description = result.data?.name ? `Session is now using ${result.data.name}.` : "Worktree created."
      setState((prev) => reduceWorkspaceTransitionProgress(prev, { type: "succeed", message: description }))
      showToast({ type: "info", title: "Moved to worktree", description })
    } catch (error) {
      setState((prev) => reduceWorkspaceTransitionProgress(prev, { type: "fail", message: errorDescription(error) }))
      showToast({
        type: "error",
        title: props.mode === "leave" ? "Exit worktree failed" : "Enter worktree failed",
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
    <Dialog
      title={title()}
      description={description()}
      class="workspace-transition-dialog"
      dismissible={!loading()}
      action={<DialogCloseButton disabled={loading()} />}
    >
      <Switch>
        <Match when={state().phase === "form"}>
          <form
            class="wtd-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <TextField autofocus label="Worktree name" placeholder="Auto-generated" value={name()} onChange={setName} />
            <div class="wtd-actions">
              <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="small">
                Create worktree
              </Button>
            </div>
          </form>
        </Match>
        <Match when={state().phase === "loading"}>
          <StepList steps={steps()} />
        </Match>
        <Match when={state().phase === "success"}>
          <div class="wtd-result">
            <span class="wtd-result-icon" data-state="success">
              <Icon name={getSemanticIcon("state.success")} size="normal" />
            </span>
            <div class="wtd-result-copy">
              <div class="wtd-result-title">{props.mode === "leave" ? "Left worktree" : "Moved to worktree"}</div>
              <div class="wtd-result-description">{description()}</div>
            </div>
          </div>
          <div class="wtd-actions">
            <Button type="button" variant="primary" size="small" onClick={() => dialog.close()}>
              Done
            </Button>
          </div>
        </Match>
        <Match when={state().phase === "error"}>
          <div class="wtd-error">{description()}</div>
          <div class="wtd-actions">
            <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="small" onClick={() => void submit()}>
              Try again
            </Button>
          </div>
        </Match>
      </Switch>
    </Dialog>
  )
}
