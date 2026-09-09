import type { PluginComponentProps, PluginSessionLayoutService } from "@ericsanchezok/synergy-plugin"

export function DefaultSession(props: PluginComponentProps<{ layout: PluginSessionLayoutService }>) {
  const layout = props.context.layout
  return (
    <div
      class="synergy-workbench-canvas relative bg-background-stronger size-full overflow-hidden flex flex-col"
      data-ui-part="session"
    >
      <div class="flex-1 min-h-0 flex flex-col md:flex-row relative">
        <div
          class="session-workbench-pane synergy-workbench-canvas @container relative min-w-0 flex flex-1 flex-col bg-background-stronger pt-3 pb-0 md:py-3"
          style={{
            "min-width": layout.minimumWidth() === undefined ? undefined : `${layout.minimumWidth()}px`,
            "--prompt-height": layout.promptHeight() ? `${layout.promptHeight()}px` : undefined,
          }}
        >
          {layout.render("conversation")}
          {layout.render("composer")}
        </div>
        {layout.render("workbench.side")}
      </div>
      {layout.render("workbench.bottom")}
    </div>
  )
}
