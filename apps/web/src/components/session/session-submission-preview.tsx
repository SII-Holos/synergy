import { Show } from "solid-js"
import type { SessionTransitionEntry } from "@/context/session-transition"
import { SessionTransitionCard } from "./session-transition-card"

export function SessionSubmissionPreview(props: { entry: SessionTransitionEntry }) {
  return (
    <div class="session-content-column session-submission-preview">
      <Show when={props.entry.draft?.text}>
        <div class="session-submission-prompt">{props.entry.draft?.text}</div>
      </Show>
      <SessionTransitionCard
        progress={props.entry.progress}
        onRetry={props.entry.actions?.retry}
        onDismiss={props.entry.actions?.dismiss}
      />
    </div>
  )
}
