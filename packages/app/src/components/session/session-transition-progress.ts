import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

export type SessionTransitionKind = "new-session" | "new-worktree-session" | "enter-worktree" | "leave-worktree"

export type SessionTransitionPhase = "loading" | "success" | "error"
export type SessionTransitionStepState = "pending" | "active" | "complete"

export type SessionTransitionStep = {
  id: string
  label: string
  detail?: string
  state: SessionTransitionStepState
}

export type SessionTransitionProgress = {
  kind: SessionTransitionKind
  phase: SessionTransitionPhase
  title: string
  description: string
  steps: SessionTransitionStep[]
}

export type SessionTransitionActions = {
  retry?: () => void
  dismiss?: () => void
}

export type SessionStartupStage = "workspace" | "message" | "complete"

export type SessionStartupWorkspaceStep = {
  label: string
  activeDetail: string
  completeDetail: string
}

type SessionStartupStepsInput =
  | { stage: "workspace"; workspace: SessionStartupWorkspaceStep }
  | { stage: "message" | "complete"; workspace?: SessionStartupWorkspaceStep }

const presentationByKind = {
  "new-session": { icon: "session.new", kicker: "New session" },
  "new-worktree-session": { icon: "workspace.worktree", kicker: "Worktree session" },
  "enter-worktree": { icon: "workspace.enterWorktree", kicker: "Session worktree" },
  "leave-worktree": { icon: "workspace.leaveWorktree", kicker: "Main checkout" },
} satisfies Record<SessionTransitionKind, { icon: SemanticIconTokenName; kicker: string }>

export function sessionTransitionPresentation(progress: SessionTransitionProgress) {
  const presentation = presentationByKind[progress.kind]
  const icon =
    progress.phase === "success"
      ? getSemanticIcon("state.success")
      : progress.phase === "error"
        ? getSemanticIcon("state.error")
        : getSemanticIcon(presentation.icon)
  return { icon, kicker: presentation.kicker }
}

export function createSessionStartupSteps(input: SessionStartupStepsInput): SessionTransitionStep[] {
  const messageState = input.stage === "workspace" ? "pending" : input.stage === "message" ? "active" : "complete"
  const steps: SessionTransitionStep[] = [
    {
      id: "session",
      label: "Prepare session",
      detail: "Conversation state is ready.",
      state: "complete",
    },
  ]

  if (input.workspace) {
    const workspaceComplete = input.stage !== "workspace"
    steps.push({
      id: "workspace",
      label: input.workspace.label,
      detail: workspaceComplete ? input.workspace.completeDetail : input.workspace.activeDetail,
      state: workspaceComplete ? "complete" : "active",
    })
  }

  steps.push({
    id: "message",
    label: "Send message",
    detail: messageState === "complete" ? "First message dispatched." : "Dispatching your first message.",
    state: messageState,
  })
  return steps
}

export function createNewSessionTransitionProgress(): SessionTransitionProgress {
  return {
    kind: "new-session",
    phase: "loading",
    title: "Starting session",
    description: "Sending your first message.",
    steps: createSessionStartupSteps({ stage: "message" }),
  }
}

export function createNewSessionTransitionSuccessProgress(): SessionTransitionProgress {
  return {
    kind: "new-session",
    phase: "success",
    title: "Session started",
    description: "Your first message was sent.",
    steps: createSessionStartupSteps({ stage: "complete" }),
  }
}
