import { UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"
import { ErrorBoundary, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { PluginComponentProps, PluginSurfaceContext } from "@ericsanchezok/synergy-plugin"

export function PluginComponentMount<C extends Pick<PluginSurfaceContext, "pluginId">>(props: {
  component: Component<PluginComponentProps<C>>
  context: C
  reportError(error: { pluginId: string; message: string }): void
}) {
  return (
    <UIStyleProvider pluginId={props.context.pluginId}>
      <div data-plugin-ui={props.context.pluginId}>
        <ErrorBoundary
          fallback={(error: unknown) => {
            props.reportError({
              pluginId: props.context.pluginId,
              message: error instanceof Error ? error.message : String(error),
            })
            throw error
          }}
        >
          <Dynamic component={props.component} context={props.context} />
        </ErrorBoundary>
      </div>
    </UIStyleProvider>
  )
}
