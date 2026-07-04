import { Show } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

type SaveStatus = "idle" | "saving" | "saved" | "error" | "dirty"

export function SaveIndicator(props: { status: SaveStatus; class?: string }) {
  return (
    <Show when={props.status !== "idle"}>
      <div
        class="settings-save-indicator"
        classList={{ [props.class ?? ""]: !!props.class }}
        data-save-status={props.status}
      >
        <Show when={props.status === "saving"}>
          <Spinner class="size-3" />
          <span>Saving...</span>
        </Show>
        <Show when={props.status === "saved"}>
          <Icon name={getSemanticIcon("state.success")} size="small" />
          <span>Saved</span>
        </Show>
        <Show when={props.status === "error"}>
          <Icon name={getSemanticIcon("state.error")} size="small" />
          <span>Save failed</span>
        </Show>
        <Show when={props.status === "dirty"}>
          <Icon name={getSemanticIcon("state.warning")} size="small" />
          <span>Unsaved</span>
        </Show>
      </div>
    </Show>
  )
}
