import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { usePluginHost } from "../host"

export function PluginUIDiagnostics(props: { pluginId: string }) {
  const host = usePluginHost()
  const { _ } = useLingui()
  const status = () => host.status().get(props.pluginId)
  const label = () => {
    switch (status()?.state) {
      case "registered":
        return _({ id: "app.plugin.ui.registered", message: "Registered" })
      case "loading":
        return _({ id: "app.plugin.ui.loading", message: "Loading interface" })
      case "available":
        return _({ id: "app.plugin.ui.available", message: "Interface ready" })
      case "failed":
        return _({ id: "app.plugin.ui.failed", message: "Interface error" })
      case "incompatible":
        return _({ id: "app.plugin.ui.incompatible", message: "Incompatible interface" })
    }
  }
  return (
    <Show when={status()}>
      <section class="plugin-detail-section">
        <h3>{_({ id: "app.plugin.ui.diagnostics", message: "Plugin interface" })}</h3>
        <p role="status">{label()}</p>
        <Show when={status()?.reason}>{(reason) => <p>{reason()}</p>}</Show>
        <For each={host.extensions(props.pluginId).filter((item) => !item.mounted)}>
          {(item) => (
            <p>
              {item.id}:{" "}
              {_({ id: "app.plugin.ui.outletMissing", message: "Not rendered in the current workbench view" })} (
              {item.outlet})
            </p>
          )}
        </For>
      </section>
    </Show>
  )
}
