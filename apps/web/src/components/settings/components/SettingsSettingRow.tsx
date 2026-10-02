import { SettingRow as SharedSettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import type { ComponentProps } from "solid-js"

export function SettingRow(props: ComponentProps<typeof SharedSettingRow>) {
  return (
    <SharedSettingRow
      {...props}
      controlLayout={props.controlLayout ?? "field"}
      statePlacement={props.statePlacement ?? "description"}
    />
  )
}
