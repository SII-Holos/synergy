import { For, Show, createMemo, createSignal } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { ApprovalReview } from "@ericsanchezok/synergy-sdk/client"
import { PermissionRiskBadge } from "./PermissionRiskBadge"
import "./PluginConsentDialog.css"

const DISPLAY_GROUPS: { key: string; label: string; categories: string[]; icon: SemanticIconTokenName }[] = [
  { key: "tools", label: "Tools", categories: ["tools", "files"], icon: "plugins.permission.tools" },
  { key: "data", label: "Data", categories: ["data", "session", "identity"], icon: "plugins.permission.data" },
  { key: "network", label: "Network", categories: ["network", "communication"], icon: "plugins.permission.network" },
  { key: "ui", label: "UI", categories: ["ui", "browser"], icon: "plugins.permission.ui" },
  {
    key: "runtime",
    label: "Runtime",
    categories: ["runtime", "hooks", "platform"],
    icon: "plugins.permission.runtime",
  },
]

type ReviewPermissionItem = ApprovalReview["diff"]["added"][number]
type ReviewSeverity = ApprovalReview["risk"]

export type PluginConsentIntent = "install" | "update" | "reapprove"

export interface PluginConsentDialogProps {
  intent: PluginConsentIntent
  review: ApprovalReview
  staleMessage?: string | null
  onApprove: (review: ApprovalReview) => void | ApprovalReview | Promise<void | ApprovalReview>
  onCancel: () => void
}

const INTENT_COPY: Record<PluginConsentIntent, { title: string; description: string; primary: string; busy: string }> =
  {
    install: {
      title: "Approve Plugin Install",
      description: "Review the permissions before installing this plugin.",
      primary: "Approve & install",
      busy: "Approving...",
    },
    update: {
      title: "Approve Plugin Update",
      description: "Review the permission changes before updating this plugin.",
      primary: "Approve & update",
      busy: "Approving...",
    },
    reapprove: {
      title: "Review Plugin Permissions",
      description: "Review the current plugin manifest before reloading it.",
      primary: "Approve & reload",
      busy: "Approving...",
    },
  }

function groupByDisplayCategory(items: readonly ReviewPermissionItem[]) {
  const map: Record<string, ReviewPermissionItem[]> = {}
  for (const item of items) {
    const displayKey = DISPLAY_GROUPS.find((group) => group.categories.includes(item.category))
    const groupKey = displayKey?.key ?? item.category
    if (!map[groupKey]) map[groupKey] = []
    map[groupKey]!.push(item)
  }
  return DISPLAY_GROUPS.map((group) => ({ ...group, items: map[group.key] ?? [] })).filter(
    (group) => group.items.length > 0,
  )
}

function iconForItem(item: ReviewPermissionItem): SemanticIconTokenName {
  if (item.category === "tools") return "plugins.permission.tools"
  if (item.category === "files") return "plugins.permission.filesystem"
  if (item.category === "network" || item.category === "communication") return "plugins.permission.network"
  if (item.category === "data" || item.category === "session" || item.category === "identity") {
    return "plugins.permission.data"
  }
  if (item.category === "ui" || item.category === "browser") return "plugins.permission.ui"
  if (item.category === "runtime" || item.category === "platform") return "plugins.permission.runtime"
  if (item.category === "hooks") return "plugins.permission.hooks"
  return "state.empty"
}

function permissionKey(item: ReviewPermissionItem): string {
  return item.key
}

function severity(value: string | undefined): ReviewSeverity {
  if (value === "medium" || value === "high") return value
  return "low"
}

function pluginLabel(review: ApprovalReview): string {
  return review.name || review.pluginId
}

function versionCopy(review: ApprovalReview): string {
  const from = review.diff.fromVersion
  const to = review.diff.toVersion ?? review.version
  if (from && from !== to) return `v${from} → v${to}`
  return `v${to}`
}

function PermissionList(props: {
  title: string
  empty: string
  items: readonly ReviewPermissionItem[]
  muted?: boolean
}) {
  return (
    <section class="consent-section">
      <div class="consent-section-heading">
        <h3>{props.title}</h3>
        <span>{props.items.length}</span>
      </div>
      <Show when={props.items.length > 0} fallback={<p class="consent-muted">{props.empty}</p>}>
        <ul class="consent-group-items">
          <For each={[...props.items].toSorted((a, b) => permissionKey(a).localeCompare(permissionKey(b)))}>
            {(item) => (
              <li classList={{ "consent-item": true, "consent-item-muted": props.muted }}>
                <div class="consent-item-row">
                  <Icon name={getSemanticIcon(iconForItem(item))} size="small" class="consent-item-icon" />
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
      </Show>
    </section>
  )
}

export function PluginConsentDialog(props: PluginConsentDialogProps) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [currentReview, setCurrentReview] = createSignal(props.review)
  const [staleMessage, setStaleMessage] = createSignal(props.staleMessage ?? null)
  const copy = createMemo(() => INTENT_COPY[props.intent])
  const groupedAdded = createMemo(() => groupByDisplayCategory(currentReview().diff.added))
  const hasManifestOnlyChange = createMemo(() => {
    const review = currentReview()
    return (
      !review.permissionsChanged &&
      review.diff.added.length === 0 &&
      review.diff.removed.length === 0 &&
      review.diff.changed.length === 0
    )
  })

  async function approve() {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      const nextReview = await props.onApprove(currentReview())
      if (nextReview) {
        setCurrentReview(nextReview)
        setStaleMessage("Plugin changed while you were reviewing it")
        return
      }
      dialog.close()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Approval failed"
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={copy().title}
      description={`${pluginLabel(currentReview())} ${versionCopy(currentReview())}. ${copy().description}`}
      class="consent-dialog"
    >
      <div class="consent-risk-summary">
        <Icon name={getSemanticIcon("permission.required")} size="small" />
        <span>{currentReview().reason ?? currentReview().diff.reason ?? "This plugin requires your approval."}</span>
        <PermissionRiskBadge risk={currentReview().diff.riskAfter ?? currentReview().risk} />
      </div>

      <Show when={staleMessage()}>
        {(message) => (
          <div class="consent-warning" role="status">
            <Icon name={getSemanticIcon("state.warning")} size="small" />
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <Show when={hasManifestOnlyChange()}>
        <div class="consent-manifest-note">
          <Icon name={getSemanticIcon("plugins.permission.diff")} size="small" />
          <span>Permissions are unchanged, but the plugin manifest changed. Review the metadata before approving.</span>
        </div>
      </Show>

      <Show when={groupedAdded().length > 0}>
        <div class="consent-groups">
          <For each={groupedAdded()}>
            {(group) => (
              <section class="consent-group">
                <div class="consent-group-header">
                  <Icon name={getSemanticIcon(group.icon)} size="small" class="consent-group-icon" />
                  <span class="consent-group-label">Added {group.label}</span>
                  <span class="consent-group-count">{group.items.length}</span>
                </div>
                <ul class="consent-group-items">
                  <For each={group.items}>
                    {(item) => (
                      <li class="consent-item">
                        <div class="consent-item-row">
                          <Icon name={getSemanticIcon(iconForItem(item))} size="small" class="consent-item-icon" />
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
              </section>
            )}
          </For>
        </div>
      </Show>

      <PermissionList
        title="Removed permissions"
        empty="No permissions are being removed."
        items={currentReview().diff.removed}
        muted
      />
      <PermissionList
        title="Current permissions"
        empty="No existing permissions are unchanged."
        items={currentReview().diff.unchanged}
        muted
      />

      <Show when={currentReview().diff.changed.length > 0}>
        <section class="consent-changed">
          <p class="consent-changed-title">
            <Icon name={getSemanticIcon("plugins.permission.diff")} size="small" class="consent-changed-icon" />
            Severity changes
          </p>
          <For each={currentReview().diff.changed}>
            {(change) => (
              <div class="consent-changed-item">
                <code>{change.key}</code>
                <span>
                  <PermissionRiskBadge risk={severity(change.before)} />
                  <Icon name={getSemanticIcon("navigation.forward")} size="small" class="consent-arrow" />
                  <PermissionRiskBadge risk={severity(change.after)} />
                </span>
              </div>
            )}
          </For>
        </section>
      </Show>

      <Show when={error()}>
        {(message) => (
          <div class="consent-error" role="alert">
            <Icon name={getSemanticIcon("state.warning")} size="small" />
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <div class="consent-actions">
        <Button
          type="button"
          variant="ghost"
          size="small"
          disabled={busy()}
          onClick={() => {
            dialog.close()
            props.onCancel()
          }}
        >
          Not now
        </Button>
        <Button type="button" variant="primary" size="small" disabled={busy()} onClick={() => void approve()}>
          {busy() ? copy().busy : copy().primary}
        </Button>
      </div>
    </Dialog>
  )
}
