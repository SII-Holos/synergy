import { For, Match, Show, Switch } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { WorkspaceProgressStep } from "./worktree-session"

export type WorktreeProgressStepState = WorkspaceProgressStep["state"]

export function StepIcon(props: { state: WorktreeProgressStepState }) {
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

export function StepList(props: { steps: WorkspaceProgressStep[] }) {
  return (
    <div class="wtd-step-list">
      <For each={props.steps}>
        {(step) => (
          <div class="wtd-step-row" data-state={step.state}>
            <StepIcon state={step.state} />
            <div class="wtd-step-copy">
              <span class="wtd-step-title">{step.label}</span>
              <Show keyed when={step.detail}>
                {(detail) => <span class="wtd-step-detail">{detail}</span>}
              </Show>
            </div>
            <span class="wtd-step-status">
              <Switch>
                <Match when={step.state === "active"}>In progress</Match>
                <Match when={step.state === "complete"}>Done</Match>
                <Match when={true}>Pending</Match>
              </Switch>
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
