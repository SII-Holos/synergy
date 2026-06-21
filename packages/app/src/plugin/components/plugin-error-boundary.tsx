import { ErrorBoundary, type ParentProps } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

interface PluginErrorBoundaryProps extends ParentProps {
  pluginId: string
  componentName?: string
}

export function PluginErrorBoundary(props: PluginErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(err: any) => (
        <div class="plugin-error-card">
          <div class="plugin-error-header">
            <Icon name="alert-triangle" />
            <span>Plugin Error: {props.pluginId}</span>
            {props.componentName && <span class="plugin-error-component">{props.componentName}</span>}
          </div>
          <div class="plugin-error-message">{err?.message || String(err)}</div>
          <div class="plugin-error-hint">The plugin may need to be updated. Check the plugin settings.</div>
        </div>
      )}
    >
      {props.children}
    </ErrorBoundary>
  )
}
