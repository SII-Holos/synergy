import { For, Show, createMemo } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { PluginPermissions } from "../api"

interface PluginPermissionsDisplayProps {
  permissions: PluginPermissions
  isUpdate?: boolean
  previousPermissions?: PluginPermissions
}

interface PermissionItem {
  icon: SemanticIconTokenName
  label: string
  warning?: boolean
  changed?: "new" | "removed"
}

interface PermissionGroup {
  title: string
  items: PermissionItem[]
}

function hasPermission(perms: PluginPermissions | undefined, path: string[]): boolean {
  let current: unknown = perms
  for (const key of path) {
    if (current == null || typeof current !== "object") return false
    current = (current as Record<string, unknown>)[key]
  }
  return !!current
}

function hasArrayItems(perms: PluginPermissions | undefined, path: string[]): boolean {
  let current: unknown = perms
  for (const key of path) {
    if (current == null || typeof current !== "object") return false
    current = (current as Record<string, unknown>)[key]
  }
  return Array.isArray(current) && current.length > 0
}

function arrayDiff(
  current: string[] | undefined,
  previous: string[] | undefined,
): { added: string[]; removed: string[] } {
  const cur = new Set(current ?? [])
  const prev = new Set(previous ?? [])
  const added = [...cur].filter((d) => !prev.has(d))
  const removed = [...prev].filter((d) => !cur.has(d))
  return { added, removed }
}

export function PluginPermissionsDisplay(props: PluginPermissionsDisplayProps) {
  const items = createMemo<PermissionGroup[]>(() => {
    const p = props.permissions
    const prev = props.previousPermissions
    const isUpdate = !!props.isUpdate

    const groups: PermissionGroup[] = []
    const uiItems: PermissionItem[] = []

    function addItem(item: PermissionItem) {
      uiItems.push(item)
    }

    // UI permissions
    if (p?.ui === true) {
      addItem({
        icon: "plugins.permission.ui",
        label: "Plugin UI surfaces",
      })
    }
    if (uiItems.length > 0) {
      groups.push({ title: "UI", items: uiItems })
    }

    // Network permissions
    const networkItems: PermissionItem[] = []
    const connectDomains = p?.network?.connectDomains
    if (hasArrayItems(p, ["network", "connectDomains"])) {
      const prevDomains = prev?.network?.connectDomains
      if (isUpdate && prevDomains) {
        const diff = arrayDiff(connectDomains, prevDomains)
        for (const d of diff.added) {
          networkItems.push({
            icon: "plugins.permission.network",
            label: `Network access to: ${d}`,
            changed: "new",
          })
        }
        for (const d of diff.removed) {
          networkItems.push({
            icon: "plugins.permission.network",
            label: `No longer connects to: ${d}`,
            changed: "removed",
          })
        }
        // Show unchanged domains only if no diff item was generated
        if (diff.added.length === 0 && diff.removed.length === 0) {
          networkItems.push({
            icon: "plugins.permission.network",
            label: `Network access to: ${connectDomains!.join(", ")}`,
          })
        }
      } else {
        networkItems.push({
          icon: "plugins.permission.network",
          label: `Network access to: ${connectDomains!.join(", ")}`,
        })
      }
    }
    if (hasArrayItems(p, ["network", "resourceDomains"])) {
      // Resource domains are less important, show only if no connect domains
      if (!hasArrayItems(p, ["network", "connectDomains"])) {
        networkItems.push({
          icon: "plugins.permission.network",
          label: `Resource access to: ${p!.network!.resourceDomains!.join(", ")}`,
        })
      }
    }
    if (networkItems.length > 0) {
      groups.push({ title: "Network", items: networkItems })
    }

    // Data permissions
    const dataItems: PermissionItem[] = []
    if (p?.data?.session === "metadata") {
      dataItems.push({ icon: "plugins.permission.data", label: "Read session metadata" })
    }
    if (p?.data?.session === "read") {
      dataItems.push({ icon: "plugins.permission.data", label: "Read session data" })
    }
    if (p?.data?.workspace === "metadata") {
      dataItems.push({ icon: "plugins.permission.filesystem", label: "Read workspace metadata" })
    }
    if (p?.data?.workspace === "read") {
      dataItems.push({ icon: "plugins.permission.filesystem", label: "Read workspace files" })
    }
    if (p?.data?.config === "global") {
      dataItems.push({ icon: "plugins.permission.config", label: "Access global config" })
    }
    if (dataItems.length > 0) {
      groups.push({ title: "Data", items: dataItems })
    }

    // Tool permissions
    const toolItems: PermissionItem[] = []
    if (hasPermission(p, ["tools", "shell"])) {
      toolItems.push({
        icon: "plugins.permission.shell",
        label: "Invoke shell commands",
        warning: true,
      })
    }
    if (hasPermission(p, ["tools", "filesystem"])) {
      toolItems.push({
        icon: "plugins.permission.filesystem",
        label: "Access filesystem",
        warning: true,
      })
    }
    if (toolItems.length > 0) {
      groups.push({ title: "Tools", items: toolItems })
    }

    return groups
  })

  const hasRiskyPermissions = () =>
    hasPermission(props.permissions, ["tools", "shell"]) || hasPermission(props.permissions, ["tools", "filesystem"])

  const headerText = () => {
    if (props.isUpdate) {
      return `This plugin update wants to:`
    }
    return "This plugin wants to:"
  }

  return (
    <div class="plugin-permissions-display flex flex-col gap-4">
      {/* Summary header */}
      <p class="text-14-medium text-text-strong">{headerText()}</p>

      {/* Permission groups */}
      <div class="flex flex-col gap-3">
        <For each={items()}>
          {(group) => (
            <div class="permission-group">
              <p class="text-12-medium text-text-weak uppercase tracking-wider mb-1.5">{group.title}</p>
              <ul class="flex flex-col gap-1.5">
                <For each={group.items}>
                  {(item) => (
                    <li class="flex items-center gap-2 text-13-regular text-text-base">
                      <Icon name={getSemanticIcon(item.icon)} size="small" class="shrink-0 text-text-weak" />
                      <span>{item.label}</span>
                      <Show when={item.warning}>
                        <span class="inline-flex items-center gap-1 rounded-full bg-surface-warning-weak px-2 py-0.5 text-11-medium text-text-on-warning-base">
                          <Icon name={getSemanticIcon("state.warning")} size="small" />
                          Elevated access
                        </span>
                      </Show>
                      <Show when={item.changed === "new"}>
                        <span class="rounded-full bg-surface-success-weak px-2 py-0.5 text-11-medium text-text-on-success-base">
                          New
                        </span>
                      </Show>
                      <Show when={item.changed === "removed"}>
                        <span class="rounded-full bg-surface-weak px-2 py-0.5 text-11-medium text-text-weak line-through">
                          Removed
                        </span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </div>

      {/* Empty state */}
      <Show when={items().length === 0}>
        <p class="text-13-regular text-text-weak">No specific permissions declared.</p>
      </Show>

      {/* UI execution indicator */}
      <div class="flex items-center gap-3 rounded-lg border border-border-base bg-surface-base p-3">
        <Icon name={getSemanticIcon("plugins.permission.hostUi")} size="small" class="text-text-on-success-base" />
        <div>
          <p class="text-13-medium text-text-base">Host-rendered UI</p>
          <p class="text-12-regular text-text-weak">Can render declared surfaces in Synergy after approval.</p>
        </div>
      </div>

      {/* Risky permissions warning */}
      <Show when={hasRiskyPermissions()}>
        <div class="flex items-start gap-2 rounded-lg border border-border-warning-base bg-surface-warning-weak p-3">
          <Icon
            name={getSemanticIcon("state.warning")}
            size="small"
            class="mt-0.5 text-text-on-warning-base shrink-0"
          />
          <div>
            <p class="text-13-medium text-text-on-warning-base">Elevated permissions requested</p>
            <p class="text-12-regular text-text-weak mt-0.5">
              This plugin requests access beyond the UI surface. Review carefully before installing.
            </p>
          </div>
        </div>
      </Show>
    </div>
  )
}
