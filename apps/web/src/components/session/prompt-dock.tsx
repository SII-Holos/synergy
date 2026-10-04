import { SessionDecisionOutlet } from "./decision-surface"
import { For, Show, onCleanup } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { DefaultComposer } from "@/plugin/default-composer"
import type { PluginComponentProps, PluginComposerLayoutService } from "@ericsanchezok/synergy-plugin"

export function PromptDock(props: PluginComponentProps<PluginComposerLayoutService>) {
  const layout = props.context
  onCleanup(() => layout.mount(undefined))
  return (
    <div
      ref={layout.mount}
      class="session-prompt-dock relative md:absolute md:inset-x-0 md:bottom-0 flex flex-col items-center z-50 pointer-events-none safe-bottom"
    >
      <div class="session-prompt-dock-content session-content-column pointer-events-auto relative">
        {layout.render("priority")}
        <Show
          when={layout.ready()}
          fallback={
            <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
              {layout.pendingText()}
            </div>
          }
        >
          <Show when={!layout.readOnly()} fallback={layout.render("delegation")}>
            <SessionDecisionOutlet />
            <For each={layout.links()}>
              {(link) => (
                <div class="flex items-center justify-center pb-2">
                  <Tooltip value={link.title} placement="top">
                    <button
                      type="button"
                      class="workbench-control-surface workbench-control-surface-hover flex items-center justify-center gap-1.5 h-8 px-3 rounded-full border border-border-base text-12-medium text-text-weak hover:text-text-base transition-colors"
                      onClick={link.open}
                    >
                      <Icon name={getSemanticIcon(link.icon)} size="small" />
                      <span>{link.label}</span>
                    </button>
                  </Tooltip>
                </div>
              )}
            </For>
            <div class="relative">
              <Show when={layout.input()}>{(input) => <DefaultComposer context={{ input: input() }} />}</Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
