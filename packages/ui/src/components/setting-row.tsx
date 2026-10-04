export { useSettingRow } from "./setting-row-context"
import { SettingRowContext } from "./setting-row-context"
import "./setting-row.css"
import { createUniqueId, Show, type JSX } from "solid-js"

export function SettingRow(props: {
  title: string
  description?: string
  trailing: JSX.Element
  leading?: JSX.Element
  stateLabel?: string
  controlLayout?: "compact" | "field" | "group"
  statePlacement?: "control" | "description"
}) {
  const id = createUniqueId()
  return (
    <div class="ds-setting-row" data-control-layout={props.controlLayout}>
      <div class="flex items-center gap-3 flex-1 min-w-0">
        <Show when={props.leading}>
          <div class="flex-shrink-0">{props.leading}</div>
        </Show>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span id={`${id}-title`} class="settings-row-title">
            {props.title}
          </span>
          <Show when={props.description || (props.stateLabel && props.statePlacement === "description")}>
            <div id={`${id}-description`} class="settings-row-details">
              <Show when={props.description}>
                <span class="settings-row-description">{props.description}</span>
              </Show>
              <Show when={props.stateLabel && props.statePlacement === "description"}>
                <span class="settings-row-state">{props.stateLabel}</span>
              </Show>
            </div>
          </Show>
        </div>
      </div>
      <div class="settings-row-control flex items-center gap-2">
        <Show when={props.stateLabel && props.statePlacement !== "description"}>
          <span class="settings-row-state">{props.stateLabel}</span>
        </Show>
        <SettingRowContext.Provider
          value={{
            title: props.title,
            titleId: `${id}-title`,
            descriptionId:
              props.description || (props.stateLabel && props.statePlacement === "description")
                ? `${id}-description`
                : "",
          }}
        >
          {props.trailing}
        </SettingRowContext.Provider>
      </div>
    </div>
  )
}
