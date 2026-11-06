import { useLingui } from "@lingui/solid"
import { Show } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const savingLabel = { id: "settings.save.saving", message: "Saving..." }
const savedLabel = { id: "settings.save.saved", message: "Changes saved" }
const failedLabel = { id: "settings.save.failed", message: "Changes not saved" }
const unsavedLabel = { id: "settings.save.unsaved", message: "Unsaved changes" }

type SaveStatus = import("../settings-save-status").SettingsSaveStatus

export function SaveIndicator(props: { status: SaveStatus; class?: string }) {
  const { _ } = useLingui()
  return (
    <Show when={props.status !== "idle"}>
      <div
        class="settings-save-indicator"
        classList={{ [props.class ?? ""]: !!props.class }}
        data-save-status={props.status}
        role="status"
        aria-live="polite"
      >
        <Show when={props.status === "loading"}>
          <Spinner class="size-3" />
          <span>{_({ id: "settings.save.loading", message: "Loading preferences…" })}</span>
        </Show>
        <Show when={props.status === "saving"}>
          <Spinner class="size-3" />
          <span>{_(savingLabel)}</span>
        </Show>
        <Show when={props.status === "saved"}>
          <Icon name={getSemanticIcon("state.success")} size="small" />
          <span>{_(savedLabel)}</span>
        </Show>
        <Show when={props.status === "invalid" || props.status === "partial" || props.status === "refresh"}>
          <Icon name={getSemanticIcon("state.warning")} size="small" />
          <span>
            {props.status === "invalid"
              ? _({ id: "settings.save.invalid", message: "Review your settings" })
              : props.status === "partial"
                ? _({ id: "settings.save.partial", message: "Some changes could not be saved" })
                : _({ id: "settings.save.refresh", message: "Changes saved. View needs updating." })}
          </span>
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
