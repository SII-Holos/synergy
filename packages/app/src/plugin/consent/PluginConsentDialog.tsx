import { For, Show, createMemo, createSignal } from "solid-js"
import { pluginPermission } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { ApprovalReview } from "@ericsanchezok/synergy-sdk/client"
import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import "./PluginConsentDialog.css"

const DISPLAY_GROUPS: Array<{
  key: string
  label: MessageDescriptor
  categories: string[]
  icon: SemanticIconTokenName
}> = [
  {
    key: "tools",
    label: pluginPermission.groupTools,
    categories: ["tools", "files"],
    icon: "plugins.permission.tools",
  },
  {
    key: "data",
    label: pluginPermission.groupData,
    categories: ["data", "session", "identity"],
    icon: "plugins.permission.data",
  },
  {
    key: "network",
    label: pluginPermission.groupNetwork,
    categories: ["network", "communication"],
    icon: "plugins.permission.network",
  },
  { key: "ui", label: pluginPermission.groupUi, categories: ["ui", "browser"], icon: "plugins.permission.ui" },
  {
    key: "runtime",
    label: pluginPermission.groupRuntime,
    categories: ["runtime", "hooks", "platform"],
    icon: "plugins.permission.runtime",
  },
]

type ReviewAccessItem = ApprovalReview["access"][number]

export type PluginConsentIntent = "install" | "update" | "reapprove"

export interface PluginConsentDialogProps {
  intent: PluginConsentIntent
  review: ApprovalReview
  staleMessage?: string | null
  onApprove: (review: ApprovalReview) => void | ApprovalReview | Promise<void | ApprovalReview>
  onCancel: () => void
}

const INTENT_COPY: Record<
  PluginConsentIntent,
  { title: MessageDescriptor; description: MessageDescriptor; primary: MessageDescriptor; busy: MessageDescriptor }
> = {
  install: {
    title: { id: "app.plugin.consent.install.title", message: "Confirm plugin install" },
    description: { id: "app.plugin.consent.install.description", message: "Review what this plugin can do." },
    primary: { id: "app.plugin.consent.install.approve", message: "Confirm & install" },
    busy: { id: "app.plugin.consent.approving", message: "Confirming..." },
  },
  update: {
    title: { id: "app.plugin.consent.update.title", message: "Confirm plugin update" },
    description: { id: "app.plugin.consent.update.description", message: "Review the expanded access in this update." },
    primary: { id: "app.plugin.consent.update.approve", message: "Confirm & update" },
    busy: { id: "app.plugin.consent.approving", message: "Confirming..." },
  },
  reapprove: {
    title: { id: "app.plugin.consent.reapprove.title", message: "Confirm plugin access" },
    description: { id: "app.plugin.consent.reapprove.description", message: "Review what this plugin can do." },
    primary: { id: "app.plugin.consent.reapprove.approve", message: "Confirm & reload" },
    busy: { id: "app.plugin.consent.approving", message: "Confirming..." },
  },
}

function iconForItem(item: ReviewAccessItem): SemanticIconTokenName {
  if (item.category === "tools") return "plugins.permission.tools"
  if (item.category === "files") return "plugins.permission.filesystem"
  if (item.category === "network" || item.category === "communication") return "plugins.permission.network"
  if (["data", "session", "identity"].includes(item.category)) return "plugins.permission.data"
  if (item.category === "ui" || item.category === "browser") return "plugins.permission.ui"
  if (item.category === "hooks") return "plugins.permission.hooks"
  if (item.category === "runtime" || item.category === "platform") return "plugins.permission.runtime"
  return "state.empty"
}

function groupByDisplayCategory(items: readonly ReviewAccessItem[]) {
  const grouped = new Map<string, ReviewAccessItem[]>()
  for (const item of items) {
    const group = DISPLAY_GROUPS.find((candidate) => candidate.categories.includes(item.category))
    const key = group?.key ?? item.category
    grouped.set(key, [...(grouped.get(key) ?? []), item])
  }
  return DISPLAY_GROUPS.map((group) => ({ ...group, items: grouped.get(group.key) ?? [] })).filter(
    (group) => group.items.length > 0,
  )
}

function AccessItem(props: { item: ReviewAccessItem; muted?: boolean }) {
  const { _ } = useLingui()
  return (
    <li classList={{ "consent-item": true, "consent-item-muted": props.muted }}>
      <div class="consent-item-row">
        <Icon name={getSemanticIcon(iconForItem(props.item))} size="small" class="consent-item-icon" />
        <div class="consent-item-body">
          <span class="consent-item-title">{props.item.title}</span>
          <span class="consent-item-desc">{props.item.description}</span>
          <details class="consent-item-technical">
            <summary>{_({ id: "app.plugin.consent.technicalDetails", message: "Technical details" })}</summary>
            <code>{props.item.technical ?? props.item.key}</code>
          </details>
        </div>
      </div>
    </li>
  )
}

function AccessList(props: { title: string; items: readonly ReviewAccessItem[]; empty: string; muted?: boolean }) {
  return (
    <section class="consent-section">
      <div class="consent-section-heading">
        <h3>{props.title}</h3>
        <span>{props.items.length}</span>
      </div>
      <Show when={props.items.length > 0} fallback={<p class="consent-muted">{props.empty}</p>}>
        <ul class="consent-group-items">
          <For each={[...props.items].toSorted((left, right) => left.key.localeCompare(right.key))}>
            {(item) => <AccessItem item={item} muted={props.muted} />}
          </For>
        </ul>
      </Show>
    </section>
  )
}

export function PluginConsentDialog(props: PluginConsentDialogProps) {
  const dialog = useDialog()
  const { _ } = useLingui()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [currentReview, setCurrentReview] = createSignal(props.review)
  const [staleMessage, setStaleMessage] = createSignal(props.staleMessage ?? null)
  const copy = createMemo(() => INTENT_COPY[props.intent])
  const groupedAccess = createMemo(() => groupByDisplayCategory(currentReview().access))

  async function approve() {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      const nextReview = await props.onApprove(currentReview())
      if (nextReview) {
        setCurrentReview(nextReview)
        setStaleMessage(
          _({ id: "app.plugin.consent.reviewChanged", message: "Plugin changed while you were reviewing it" }),
        )
        return
      }
      dialog.close()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : _({ id: "app.plugin.consent.approvalFailed", message: "Confirmation failed" }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={translateDescriptor(copy().title, { _ })}
      description={_({
        id: "app.plugin.consent.dialog.description",
        message: "{plugin} v{version}. {description}",
        values: {
          plugin: currentReview().name || currentReview().pluginId,
          version: currentReview().version,
          description: translateDescriptor(copy().description, { _ }),
        },
      })}
      class="consent-dialog"
    >
      <div class="consent-confirmation-summary">
        <Icon name={getSemanticIcon("permission.required")} size="small" />
        <span>
          {currentReview().reason ??
            _({ id: "app.plugin.consent.confirmationRequired", message: "Please confirm this access change." })}
        </span>
      </div>

      <Show when={staleMessage()}>
        {(message) => (
          <div class="consent-warning" role="status">
            <Icon name={getSemanticIcon("state.warning")} size="small" />
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <div class="consent-groups">
        <For each={groupedAccess()}>
          {(group) => (
            <section class="consent-group">
              <div class="consent-group-header">
                <Icon name={getSemanticIcon(group.icon)} size="small" class="consent-group-icon" />
                <span class="consent-group-label">{translateDescriptor(group.label, { _ })}</span>
                <span class="consent-group-count">{group.items.length}</span>
              </div>
              <ul class="consent-group-items">
                <For each={group.items}>{(item) => <AccessItem item={item} />}</For>
              </ul>
            </section>
          )}
        </For>
      </div>

      <Show when={currentReview().access.length === 0}>
        <p class="consent-muted">
          {_({ id: "app.plugin.consent.noHostAccess", message: "This plugin does not request host access." })}
        </p>
      </Show>

      <AccessList
        title={_({ id: "app.plugin.consent.removed.title", message: "Access removed by this update" })}
        empty={_({ id: "app.plugin.consent.removed.empty", message: "No access is being removed." })}
        items={currentReview().removed}
        muted
      />

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
          {_({ id: "app.plugin.consent.notNow", message: "Not now" })}
        </Button>
        <Button type="button" variant="primary" size="small" disabled={busy()} onClick={() => void approve()}>
          {translateDescriptor(busy() ? copy().busy : copy().primary, { _ })}
        </Button>
      </div>
    </Dialog>
  )
}
