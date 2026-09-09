import { batch } from "solid-js"
import type { PluginContribution } from "./api"

export interface PreparedPluginUI {
  install(): void
  uninstall(): void
  dispose(): void
}

function identity(plugin: PluginContribution) {
  return JSON.stringify([plugin.scopeId, plugin.generation, plugin.capabilities.toSorted(), plugin.contributions])
}

export function createPluginGenerations(input: {
  prepare(plugin: PluginContribution, signal: AbortSignal): Promise<PreparedPluginUI>
  changed(plugins: PluginContribution[]): void
  error(plugin: PluginContribution, error: unknown): void
}) {
  const active = new Map<string, { plugin: PluginContribution; identity: string; ui: PreparedPluginUI }>()
  let pending: AbortController | undefined
  let disposed = false
  const notify = () => input.changed([...active.values()].map((record) => record.plugin))
  function cleanup(record: { plugin: PluginContribution; ui: PreparedPluginUI }, uninstall = true) {
    if (uninstall) {
      try {
        record.ui.uninstall()
      } catch (error) {
        input.error(record.plugin, error)
      }
    }
    try {
      record.ui.dispose()
    } catch (error) {
      input.error(record.plugin, error)
    }
  }
  function clear() {
    pending?.abort()
    batch(() => {
      for (const record of active.values()) {
        cleanup(record)
      }
      active.clear()
      notify()
    })
  }
  return {
    async reconcile(plugins: PluginContribution[]) {
      if (disposed) throw new Error("Plugin UI generations are disposed")
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      const requested = new Set(plugins.map((plugin) => plugin.pluginId))
      batch(() => {
        for (const [id, record] of active) {
          if (requested.has(id)) continue
          cleanup(record)
          active.delete(id)
        }
        notify()
      })
      const replacements = await Promise.all(
        plugins.map(async (plugin) => {
          const key = identity(plugin)
          if (active.get(plugin.pluginId)?.identity === key) return
          try {
            const ui = await input.prepare(plugin, controller.signal)
            if (controller.signal.aborted) {
              cleanup({ plugin, ui }, false)
              return
            }
            return { plugin, identity: key, ui }
          } catch (error) {
            if (!controller.signal.aborted) input.error(plugin, error)
          }
        }),
      )
      if (controller.signal.aborted) {
        for (const record of replacements) if (record) cleanup(record, false)
        return
      }
      batch(() => {
        for (const next of replacements) {
          if (!next) continue
          const previous = active.get(next.plugin.pluginId)
          try {
            previous?.ui.uninstall()
            next.ui.install()
          } catch (error) {
            cleanup(next)
            try {
              previous?.ui.install()
            } catch (restoreError) {
              if (previous) {
                active.delete(previous.plugin.pluginId)
                cleanup(previous)
              }
              input.error(next.plugin, restoreError)
            }
            input.error(next.plugin, error)
            continue
          }
          active.set(next.plugin.pluginId, next)
          if (previous) cleanup(previous, false)
        }
        notify()
      })
    },
    clear,
    dispose() {
      if (disposed) return
      disposed = true
      clear()
    },
  }
}
