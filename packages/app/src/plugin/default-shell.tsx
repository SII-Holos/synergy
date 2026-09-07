import type { PluginComponentProps, PluginShellService } from "@ericsanchezok/synergy-plugin"

export function DefaultShell(props: PluginComponentProps<{ shell: PluginShellService }>) {
  return (
    <>
      <div class="flex-1 min-h-0 min-w-0 flex overflow-hidden" data-ui-part="workbench">
        {props.context.shell.render("navigation")}
        <main
          class="relative flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col contain-[layout_style_paint]"
          data-ui-part="content"
        >
          {props.context.shell.render("route")}
        </main>
      </div>
      {props.context.shell.render("footer")}
    </>
  )
}
