import { useSettingRow } from "./setting-row-context"
import { Switch as Kobalte } from "@kobalte/core/switch"
import { createUniqueId, Show, splitProps } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"

export interface SwitchProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  hideLabel?: boolean
  description?: string
}

export function Switch(props: SwitchProps) {
  const row = useSettingRow()
  const inputId = createUniqueId()
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "hideLabel",
    "description",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
  ])
  return (
    <Kobalte {...others} class={local.class} data-component="switch">
      <Kobalte.Input
        id={inputId}
        aria-label={local["aria-label"]}
        aria-labelledby={
          local["aria-label"] ? undefined : (local["aria-labelledby"] ?? (!local.children ? row?.titleId : undefined))
        }
        aria-describedby={local["aria-describedby"] ?? (row?.descriptionId || undefined)}
        data-slot="switch-input"
      />
      <Show when={local.children}>
        <Show
          when={local["aria-label"]}
          fallback={
            <Kobalte.Label data-slot="switch-label" classList={{ "sr-only": local.hideLabel }}>
              {local.children}
            </Kobalte.Label>
          }
        >
          <label for={inputId} data-slot="switch-label" classList={{ "sr-only": local.hideLabel }}>
            {local.children}
          </label>
        </Show>
      </Show>
      <Show when={local.description}>
        <Kobalte.Description data-slot="switch-description">{local.description}</Kobalte.Description>
      </Show>
      <Kobalte.ErrorMessage data-slot="switch-error" />
      <Kobalte.Control data-slot="switch-control">
        <Kobalte.Thumb data-slot="switch-thumb" />
      </Kobalte.Control>
    </Kobalte>
  )
}
