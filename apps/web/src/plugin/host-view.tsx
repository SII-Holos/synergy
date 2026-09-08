import { UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"
import type { JSX } from "solid-js"

export function HostView(props: { render(): JSX.Element }) {
  return (
    <UIStyleProvider pluginId="synergy">
      <div data-plugin-ui="synergy">{props.render()}</div>
    </UIStyleProvider>
  )
}
