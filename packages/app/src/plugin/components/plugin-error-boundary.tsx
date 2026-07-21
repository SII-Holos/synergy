import { ErrorBoundary, type ParentProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { usePluginHost } from "../host"

interface PluginErrorBoundaryProps extends ParentProps {
  pluginId: string
  componentName?: string
}

export function PluginErrorBoundary(props: PluginErrorBoundaryProps) {
  const { _ } = useLingui()
  let pluginHost: ReturnType<typeof usePluginHost> | undefined
  try {
    pluginHost = usePluginHost()
  } catch {
    // PluginHostProvider not mounted — no error logging available
  }

  return (
    <ErrorBoundary
      fallback={(err: any) => {
        const message = err?.message || String(err)
        // Log the error to the plugin host for status tracking
        if (pluginHost) {
          const existing = pluginHost.errors()
          const exists = existing.some((e) => e.pluginId === props.pluginId && e.message === message)
          if (!exists) {
            console.error(`[PluginErrorBoundary] ${props.pluginId}:`, err)
          }
        }
        return (
          <div class="plugin-error-card">
            <div class="plugin-error-header">
              <Icon name={getSemanticIcon("state.error")} />
              <span>
                {_({
                  id: "app.plugin.error.title",
                  message: "Plugin Error: {pluginId}",
                  values: { pluginId: props.pluginId },
                })}
              </span>
              {props.componentName && <span class="plugin-error-component">{props.componentName}</span>}
            </div>
            <div class="plugin-error-message">{message}</div>
            <div class="plugin-error-hint">
              {_({
                id: "app.plugin.error.hint",
                message: "The plugin may need to be updated. Check the plugin settings.",
              })}
            </div>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
