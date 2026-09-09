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
      classList={{
        "relative md:absolute md:inset-x-0 md:bottom-0 flex flex-col justify-center items-center z-50 px-0 pointer-events-none safe-bottom pb-0 md:pb-3": true,
        "md:pt-12": !layout.isNewSession(),
      }}
      style={{
        transform: layout.isNewSession() ? "translateY(-35vh)" : "translateY(0)",
        transition: "transform 400ms ease-out",
      }}
    >
      <div class="session-prompt-dock-content w-full min-w-0 px-3 md:px-6 pointer-events-auto relative">
        {layout.render("priority")}
        <Show when={layout.isNewSession()}>{layout.render("greeting")}</Show>
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
                      class="workbench-control-surface workbench-control-surface-hover flex items-center justify-center gap-1.5 h-8 px-3 rounded-full border border-border-base text-12-medium text-text-weak hover:text-text-base active:scale-95 transition-all duration-150"
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
              {layout.render("inbox")}
            </div>
          </Show>
        </Show>
        <Show when={layout.isNewSession() && !layout.isGlobal()}>
          <div class="flex items-center justify-center gap-1.5 pt-3 text-12-regular text-text-subtle pointer-events-none">
            <Icon name={getSemanticIcon("workspace.main")} size="small" class="text-icon-base" />
            <span class="text-text-base">{layout.scopeName()}</span>
            <Show when={layout.branch()}>
              <span>·</span>
              <span>{layout.branch()}</span>
            </Show>
            <Show when={layout.lastModified()}>
              <span>·</span>
              <span>{layout.lastModified()}</span>
            </Show>
          </div>
        </Show>
        <Show when={!layout.isNewSession()}>
          <div class="pointer-events-auto">{layout.render("status")}</div>
        </Show>
      </div>
    </div>
  )
}
