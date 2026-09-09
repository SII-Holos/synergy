import { useLingui } from "@lingui/solid"
import { Show } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const savingLabel = { id: "settings.save.saving", message: "Saving..." }
const savedLabel = { id: "settings.save.saved", message: "Saved" }
const failedLabel = { id: "settings.save.failed", message: "Save failed" }
const unsavedLabel = { id: "settings.save.unsaved", message: "Unsaved" }

type SaveStatus = "idle" | "saving" | "saved" | "error" | "dirty"

export function SaveIndicator(props: { status: SaveStatus; class?: string }) {
  const { _ } = useLingui()
  return (
    <Show when={props.status !== "idle"}>
      <div
        class="settings-save-indicator"
        classList={{ [props.class ?? ""]: !!props.class }}
        data-save-status={props.status}
      >
        <Show when={props.status === "saving"}>
          <Spinner class="size-3" />
          <span>{_(savingLabel)}</span>
        </Show>
        <Show when={props.status === "saved"}>
          <Icon name={getSemanticIcon("state.success")} size="small" />
          <span>{_(savedLabel)}</span>
        </Show>
        <Show when={props.status === "error"}>
          <Icon name={getSemanticIcon("state.error")} size="small" />
          <span>{_(failedLabel)}</span>
        </Show>
        <Show when={props.status === "dirty"}>
          <Icon name={getSemanticIcon("state.warning")} size="small" />
          <span>{_(unsavedLabel)}</span>
        </Show>
      </div>
    </Show>
  )
}
