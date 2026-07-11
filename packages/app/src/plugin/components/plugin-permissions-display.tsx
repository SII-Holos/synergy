import { For, Show, createMemo } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

interface PluginPermissionsDisplayProps {
  capabilities: string[]
  previousCapabilities?: string[]
}

export function PluginPermissionsDisplay(props: PluginPermissionsDisplayProps) {
  const previous = createMemo(() => new Set(props.previousCapabilities ?? []))
  const removed = createMemo(() =>
    (props.previousCapabilities ?? []).filter((capability) => !props.capabilities.includes(capability)),
  )

  return (
    <div class="plugin-permissions-display flex flex-col gap-3">
      <p class="text-14-medium text-text-strong">This plugin requests these Synergy host capabilities:</p>
      <Show
        when={props.capabilities.length}
        fallback={<p class="text-13-regular text-text-weak">No host capabilities requested.</p>}
      >
        <ul class="flex flex-col gap-1.5">
          <For each={props.capabilities}>
            {(capability) => (
              <li class="flex items-center gap-2 text-13-regular">
                <Icon name={getSemanticIcon("plugins.permission.runtime")} size="small" />
                <span>{capability}</span>
                <Show when={props.previousCapabilities && !previous().has(capability)}>
                  <span class="text-text-success">New</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={removed().length}>
        <div class="flex flex-col gap-1.5">
          <p class="text-12-medium text-text-weak uppercase tracking-wider">No longer requested</p>
          <ul class="flex flex-col gap-1.5">
            <For each={removed()}>
              {(capability) => <li class="text-13-regular text-text-weak line-through">{capability}</li>}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  )
}
