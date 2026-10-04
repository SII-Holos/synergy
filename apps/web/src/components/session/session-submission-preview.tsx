import { For, Show } from "solid-js"
import type { SessionTransitionEntry } from "@/context/session-transition"
import { SessionSubmissionStatus } from "./session-submission-status"

export function SessionSubmissionPreview(props: { entry: SessionTransitionEntry }) {
  return (
    <div class="session-content-column session-submission-preview">
      <Show when={props.entry.draft?.text || props.entry.draft?.prompt?.some((part) => part.type !== "text")}>
        <div class="session-submission-prompt">
          {props.entry.draft?.text}
          <For each={props.entry.draft?.prompt?.filter((part) => part.type !== "text")}>
            {(part) => (
              <div>
                {"filename" in part ? part.filename : "title" in part ? part.title : "path" in part ? part.path : ""}
              </div>
            )}
          </For>
        </div>
      </Show>
      <SessionSubmissionStatus entry={props.entry} />
    </div>
  )
}
