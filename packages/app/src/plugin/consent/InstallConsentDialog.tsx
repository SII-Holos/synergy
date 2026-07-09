import { For, Show, createMemo } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { PermissionRiskBadge } from "./PermissionRiskBadge"
import type { PermissionItem, PluginPermissionDiff } from "./schema"
import "./InstallConsentDialog.css"

// ── Display grouping ────────────────────────────────────────────────────────

const DISPLAY_GROUPS: { key: string; label: string; categories: string[]; icon: string }[] = [
  { key: "tools", label: "Tools", categories: ["tools", "files"], icon: "terminal" },
  { key: "data", label: "Data", categories: ["data"], icon: "folder" },
  { key: "network", label: "Network", categories: ["network"], icon: "globe" },
  { key: "ui", label: "UI", categories: ["ui"], icon: "panel-left" },
  { key: "runtime", label: "Runtime", categories: ["runtime", "hooks"], icon: "cpu" },
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

function iconForItem(item: PermissionItem): string {
  if (item.category === "tools") return "terminal"
  if (item.category === "files") return "folder"
  if (item.category === "network") return "globe"
  if (item.category === "data") return "file-text"
  if (item.category === "ui") return "panel-left"
  if (item.category === "runtime") return "cpu"
  if (item.category === "hooks") return "zap"
  return "circle"
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

  const grouped = createMemo(() => groupByDisplayCategory(props.diff.added))
  const overallRisk = createMemo(() => props.diff.riskAfter ?? "low")

  const pluginLabel = () => props.manifest.displayName ?? props.manifest.name

  return (
    <Dialog
      title={`Install Plugin`}
      description={`${pluginLabel()} ${props.manifest.version} requests the following permissions.`}
      class="consent-dialog"
    >
      {/* ── Risk summary header ── */}
      <div class="consent-risk-summary">
        <Icon name="shield-check" size="small" />
        <span>This plugin requires your approval to install</span>
        <PermissionRiskBadge risk={overallRisk()} />
      </div>

      {/* ── Permissions by category ── */}
      <div class="consent-groups">
        <For each={grouped()}>
          {(group) => (
            <div class="consent-group">
              <div class="consent-group-header">
                <Icon name={group.icon} size="small" class="consent-group-icon" />
                <span class="consent-group-label">{group.label}</span>
                <span class="consent-group-count">{group.items.length}</span>
              </div>
              <ul class="consent-group-items">
                <For each={group.items}>
                  {(item) => (
                    <li class="consent-item">
                      <div class="consent-item-row">
                        <Icon name={iconForItem(item)} size="small" class="consent-item-icon" />
                        <div class="consent-item-body">
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
        <p class="text-13-regular text-text-weak">No specific permissions declared.</p>
      </Show>

      {/* ── Changed items (severity upgrades) ── */}
      <Show when={props.diff.changed.length > 0}>
        <div class="consent-changed">
          <p class="consent-changed-title">
            <Icon name="diff" size="small" class="consent-changed-icon" />
            Severity changes
          </p>
          <For each={props.diff.changed}>
            {(change) => (
              <div class="consent-changed-item">
                <code>{change.key}</code>
                <span>
                  <PermissionRiskBadge risk={(change.before ?? "low") as "low" | "medium" | "high"} />
                  <Icon name="arrow-right" size="small" class="consent-arrow" />
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
          Deny
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
          Approve &amp; Install
        </Button>
      </div>
    </Dialog>
  )
}
