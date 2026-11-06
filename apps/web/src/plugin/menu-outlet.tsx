import { For, Show } from "solid-js"
import type { PluginMenuLocation } from "@ericsanchezok/synergy-plugin"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { pluginMenus } from "./registries/menu-registry"

export function PluginMenuOutlet(props: { location: PluginMenuLocation }) {
  return (
    <For each={pluginMenus.list(props.location)}>
      {(entry) => (
        <Show when={entry.option()}>
          {(option) => (
            <Button
              variant="ghost"
              size="small"
              disabled={option().disabled}
              title={option().description}
              onClick={() => {
                void entry.execute().catch((error) =>
                  showToast({
                    title: option().title,
                    description: error instanceof Error ? error.message : String(error),
                    type: "error",
                  }),
                )
              }}
            >
              {option().title}
            </Button>
          )}
        </Show>
      )}
    </For>
  )
}
