import { For, Match, Show, Switch } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionTransitionStep, SessionTransitionStepState } from "./session-transition-progress"

export function SessionTransitionStepIcon(props: { state: SessionTransitionStepState }) {
  return (
    <span class="session-transition-step-icon" data-state={props.state}>
      <Switch>
        <Match when={props.state === "active"}>
          <Spinner class="session-transition-step-spinner" />
        </Match>
        <Match when={props.state === "complete"}>
          <Icon name={getSemanticIcon("state.success")} size="small" />
        </Match>
        <Match when={true}>
          <span class="session-transition-step-dot" />
        </Match>
      </Switch>
    </span>
  )
}

export function SessionTransitionStepList(props: { steps: SessionTransitionStep[] }) {
  return (
    <div class="session-transition-step-list">
      <For each={props.steps}>
        {(step) => (
          <div class="session-transition-step-row" data-state={step.state}>
            <SessionTransitionStepIcon state={step.state} />
            <div class="session-transition-step-copy">
              <span class="session-transition-step-title">{step.label}</span>
              <Show keyed when={step.detail}>
                {(detail) => <span class="session-transition-step-detail">{detail}</span>}
              </Show>
            </div>
            <span class="session-transition-step-status">
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
