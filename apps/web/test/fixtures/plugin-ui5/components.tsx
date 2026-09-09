import { createResource, onCleanup, Show, type Component } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import type { PluginUIOverlays } from "@ericsanchezok/synergy-plugin"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { createPluginExportLoader } from "../../../src/plugin/loaders"
import { createPluginSurfaceLifetime } from "../../../src/plugin/surface-lifetime"
import { createPluginSurfaceAccess } from "../../../src/plugin/surface-access"
import { createPluginSurfaceOverlays } from "../../../src/plugin/surface-overlays"
import { PluginComponentMount } from "../../../src/plugin/component-mount"

function Fixture() {
  const lifetime = createPluginSurfaceLifetime((error) => {
    throw error
  })
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: ["ui.hostActions"],
    current: () => true,
  })
  const overlays = createPluginSurfaceOverlays({
    pluginId: "public-components",
    lifetime: lifetime.context,
    access,
    reportError: (error) => {
      throw new Error(error.message)
    },
  })
  const loader = createPluginExportLoader()
  const params = new URLSearchParams(location.search)
  const [component] = createResource(
    async () =>
      (
        await loader.load<Component<{ context: { pluginId: string; overlays: PluginUIOverlays } }>>(
          "public-components",
          params.get("bundle")!,
          "plugin_component_0",
          "5.0",
          params.get("hash")!,
        )
      ).default,
  )
  onCleanup(() => {
    lifetime.dispose()
    loader.dispose()
  })
  return (
    <Show when={component()}>
      {(component) => (
        <PluginComponentMount
          component={component()}
          context={{ pluginId: "public-components", overlays }}
          reportError={(error) => {
            throw new Error(error.message)
          }}
        />
      )}
    </Show>
  )
}
const i18n = setupI18n({ locale: "en", messages: { en: {} } })
let dispose: (() => void) | undefined
const button = document.createElement("button")
button.id = "dispose"
button.textContent = "Release surface"
button.addEventListener("click", () => dispose?.())
document.body.append(button)
dispose = render(
  () => (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <Fixture />
      </DialogProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
