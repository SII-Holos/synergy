import type { PluginComponentProps, PluginShellContext } from "@ericsanchezok/synergy-plugin"
import { Button, HostView } from "@ericsanchezok/synergy-plugin/components"
import "./shell.css"

export default function Studio({ context }: PluginComponentProps<PluginShellContext>) {
  return (
    <div class="studio" data-ui-part="workbench">
      <header class="studio-toolbar" data-ui-part="toolbar">
        <strong>Studio</strong>
        <Button onClick={() => context.navigation.open({ page: "session" })}>New session</Button>
        <Button onClick={() => context.navigation.open({ page: "plugins" })}>Plugins</Button>
      </header>
      <main class="studio-main" data-ui-part="content">
        <HostView shell={context.shell} view="route" />
      </main>
      <footer class="studio-footer">{context.extensions.render({ slot: "app.footer" })}</footer>
    </div>
  )
}
