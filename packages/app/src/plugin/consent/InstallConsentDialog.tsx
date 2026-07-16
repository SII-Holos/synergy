import { For, Show, createMemo } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { PermissionRiskBadge } from "./PermissionRiskBadge"
import type { PermissionItem, PluginPermissionDiff } from "./schema"
import "./InstallConsentDialog.css"

// ── Display grouping ────────────────────────────────────────────────────────

const DISPLAY_GROUPS: {
  key: string
  labelId: string
  labelMessage: string
  categories: string[]
  icon: SemanticIconTokenName
}[] = [
  {
    key: "tools",
    labelId: "app.plugin.permissionGroup.tools",
    labelMessage: "Tools",
    categories: ["tools", "files"],
    icon: "plugins.permission.tools",
  },
  {
    key: "data",
    labelId: "app.plugin.permissionGroup.data",
    labelMessage: "Data",
    categories: ["data"],
    icon: "plugins.permission.data",
  },
  {
    key: "network",
    labelId: "app.plugin.permissionGroup.network",
    labelMessage: "Network",
    categories: ["network"],
    icon: "plugins.permission.network",
  },
  {
    key: "ui",
    labelId: "app.plugin.permissionGroup.ui",
    labelMessage: "UI",
    categories: ["ui"],
    icon: "plugins.permission.ui",
  },
  {
    key: "runtime",
    labelId: "app.plugin.permissionGroup.runtime",
    labelMessage: "Runtime",
    categories: ["runtime", "hooks"],
    icon: "plugins.permission.runtime",
  },
]

// ── Helpers ─────────────────────────────────────────────────────────────────

function groupByDisplayCategory(items: PermissionItem[]) {
  const map: Record<string, PermissionItem[]> = {}
  for (const item of items) {
    const displayKey = DISPLAY_GROUPS.find((g) => g.categories.includes(item.category))
    const groupKey = displayKey?.key ?? item.category
    if (!map[groupKey]) map[groupKey] = []
    map[groupKey]!.push(item)
  }
  return DISPLAY_GROUPS.map((g) => ({ ...g, items: map[g.key] ?? [] })).filter((g) => g.items.length > 0)
}

function iconForItem(item: PermissionItem): SemanticIconTokenName {
  if (item.category === "tools") return "plugins.permission.tools"
  if (item.category === "files") return "plugins.permission.filesystem"
  if (item.category === "network") return "plugins.permission.network"
  if (item.category === "data") return "plugins.permission.data"
  if (item.category === "ui") return "plugins.permission.ui"
  if (item.category === "runtime") return "plugins.permission.runtime"
  if (item.category === "hooks") return "plugins.permission.hooks"
  return "state.empty"
}

// ── Component ───────────────────────────────────────────────────────────────

export interface InstallConsentDialogProps {
  manifest: { name: string; version: string; displayName?: string }
  diff: PluginPermissionDiff
  onApprove: () => void
  onDeny: () => void
}

export function InstallConsentDialog(props: InstallConsentDialogProps) {
  const dialog = useDialog()
  const { _ } = useLingui()

  const grouped = createMemo(() => groupByDisplayCategory(props.diff.added))
  const overallRisk = createMemo(() => props.diff.riskAfter ?? "low")

  const pluginLabel = () => props.manifest.displayName ?? props.manifest.name

  return (
    <Dialog
      title={_({ id: "app.plugin.consent.title", message: "Install Plugin" })}
      description={_({
        id: "app.plugin.consent.description",
        message: `${pluginLabel()} ${props.manifest.version} requests the following permissions.`,
      })}
      class="consent-dialog"
    >
      {/* ── Risk summary header ── */}
      <div class="consent-risk-summary">
        <Icon name={getSemanticIcon("permission.required")} size="small" />
        <span>
          {_({ id: "app.plugin.consent.riskSummary", message: "This plugin requires your approval to install" })}
        </span>
        <PermissionRiskBadge risk={overallRisk()} />
      </div>

      {/* ── Permissions by category ── */}
      <div class="consent-groups">
        <For each={grouped()}>
          {(group) => (
            <div class="consent-group">
              <div class="consent-group-header">
                <Icon name={getSemanticIcon(group.icon)} size="small" class="consent-group-icon" />
                <span class="consent-group-label">{_({ id: group.labelId, message: group.labelMessage })}</span>
                <span class="consent-group-count">{group.items.length}</span>
              </div>
              <ul class="consent-group-items">
                <For each={group.items}>
                  {(item) => (
                    <li class="consent-item">
                      <div class="consent-item-row">
                        <Icon name={getSemanticIcon(iconForItem(item))} size="small" class="consent-item-icon" />
                        <div class="consent-item-body">
                          {/* item.title and item.description are plugin-author content — pass through */}
                          <span class="consent-item-title">{item.title}</span>
                          <span class="consent-item-desc">{item.description}</span>
                        </div>
                        <PermissionRiskBadge risk={item.severity} />
                      </div>
                      <Show when={item.technical}>
                        <div class="consent-item-technical">{item.technical}</div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </div>

      {/* ── Empty state ── */}
      <Show when={grouped().length === 0}>
        <p class="text-13-regular text-text-weak">
          {_({ id: "app.plugin.consent.emptyPermissions", message: "No specific permissions declared." })}
        </p>
      </Show>

      {/* ── Changed items (severity upgrades) ── */}
      <Show when={props.diff.changed.length > 0}>
        <div class="consent-changed">
          <p class="consent-changed-title">
            <Icon name={getSemanticIcon("plugins.permission.diff")} size="small" class="consent-changed-icon" />
            {_({ id: "app.plugin.consent.severityChanges", message: "Severity changes" })}
          </p>
          <For each={props.diff.changed}>
            {(change) => (
              <div class="consent-changed-item">
                {/* change.key is a plugin-author capability key — pass through */}
                <code>{change.key}</code>
                <span>
                  <PermissionRiskBadge risk={(change.before ?? "low") as "low" | "medium" | "high"} />
                  <Icon name={getSemanticIcon("navigation.forward")} size="small" class="consent-arrow" />
                  <PermissionRiskBadge risk={(change.after ?? "low") as "low" | "medium" | "high"} />
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* ── Actions ── */}
      <div class="consent-actions">
        <Button
          type="button"
          variant="ghost"
          size="small"
          onClick={() => {
            dialog.close()
            props.onDeny()
          }}
        >
          {_({ id: "app.plugin.consent.deny", message: "Deny" })}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="small"
          onClick={async () => {
            await props.onApprove()
            dialog.close()
          }}
        >
          {_({ id: "app.plugin.consent.approveInstall", message: "Approve & Install" })}
        </Button>
      </div>
    </Dialog>
  )
}
