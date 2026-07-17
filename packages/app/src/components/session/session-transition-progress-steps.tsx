import { For, Match, Show, Switch } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionTransitionStep, SessionTransitionStepState } from "./session-transition-progress"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { S } from "./session-i18n"

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
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)

  return (
    <div class="session-transition-step-list">
      <For each={props.steps}>
        {(step) => (
          <div class="session-transition-step-row" data-state={step.state}>
            <SessionTransitionStepIcon state={step.state} />
            <div class="session-transition-step-copy">
              <span class="session-transition-step-title">{translateDescriptor(step.label, i18n)}</span>
              <Show keyed when={step.detail}>
                {(detail) => <span class="session-transition-step-detail">{translateDescriptor(detail, i18n)}</span>}
              </Show>
            </div>
            <span class="session-transition-step-status">
              <Switch>
                <Match when={step.state === "active"}>{_(S.worktreeStepActive)}</Match>
                <Match when={step.state === "complete"}>{_(S.worktreeStepComplete)}</Match>
                <Match when={true}>{_(S.worktreeStepPending)}</Match>
              </Switch>
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
