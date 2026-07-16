import type { MessageDescriptor } from "@lingui/core"
import type { ProviderAuthHealth } from "@ericsanchezok/synergy-sdk/client"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { ProductUpdateNotice } from "@/context/product-update"
import { providerNeedsAction, providerRecoveryTarget } from "@/components/provider/provider-auth-presentation"

export type AppAttentionNotice = {
  id: string
  source: "product-update" | "provider-auth"
  priority: number
  tone: "active" | "warning" | "ready" | "error"
  /** Display title — server-provided text for product-update, msg descriptor for provider-auth */
  title: MessageDescriptor
  /** Display detail — server-provided text for product-update, msg descriptor for provider-auth */
  detail: MessageDescriptor
  actionLabel?: MessageDescriptor
  progress?: number
  busy?: boolean
  iconToken: SemanticIconTokenName
  action: { type: "product-update" } | { type: "open-settings"; section: "providers" | "github"; providerID?: string }
}

export function selectAppAttention(input: {
  productUpdate: ProductUpdateNotice
  authHealth: Record<string, ProviderAuthHealth>
  providerNames: Record<string, string>
}): AppAttentionNotice | undefined {
  const candidates = [productUpdateAttention(input.productUpdate), providerAuthAttention(input)].filter(
    (notice): notice is AppAttentionNotice => !!notice,
  )
  return candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0]
}

function productUpdateAttention(notice: ProductUpdateNotice): AppAttentionNotice | undefined {
  if (!notice.visible) return undefined
  const priority = notice.tone === "active" ? 400 : notice.tone === "error" ? 200 : 100
  const titleStr = notice.title || "Product update available"
  const detailStr = notice.detail || "A new version is ready to install."
  return {
    id: "product-update",
    source: "product-update",
    priority,
    tone: notice.tone === "neutral" ? "ready" : notice.tone,
    title: { id: "attention.productUpdate.title", message: titleStr },
    detail: { id: "attention.productUpdate.detail", message: detailStr },
    actionLabel: notice.actionLabel ? { id: "attention.productUpdate.action", message: notice.actionLabel } : undefined,
    progress: notice.progress ?? undefined,
    busy: notice.busy || !notice.action,
    iconToken: notice.action === "install" ? "product.update.install" : "product.update",
    action: { type: "product-update" },
  }
}

function providerAuthAttention(input: {
  authHealth: Record<string, ProviderAuthHealth>
  providerNames: Record<string, string>
}): AppAttentionNotice | undefined {
  const affected = Object.values(input.authHealth)
    .filter((health) => providerNeedsAction(health))
    .sort((a, b) => a.providerID.localeCompare(b.providerID))
  if (affected.length === 0) return undefined

  const first = affected[0]
  const firstName = input.providerNames[first.providerID] ?? first.providerID
  const single = affected.length === 1
  const target = single ? providerRecoveryTarget(first.providerID) : { section: "providers" as const }
  return {
    id: `provider-auth:${affected.map((health) => health.providerID).join(",")}`,
    source: "provider-auth",
    priority: 300,
    tone: "warning",
    title: single
      ? { id: "attention.providerAuth.title.single", message: `${firstName} needs sign-in` }
      : { id: "attention.providerAuth.title.plural", message: `${affected.length} providers need attention` },
    detail: single
      ? { id: "attention.providerAuth.detail.single", message: "Reconnect to restore models and usage." }
      : { id: "attention.providerAuth.detail.plural", message: "Review rejected credentials in Settings." },
    actionLabel:
      single && first.recovery === "update_environment"
        ? { id: "attention.providerAuth.action.review", message: "Review" }
        : { id: "attention.providerAuth.action.reconnect", message: "Reconnect" },
    iconToken: "providers.reconnect",
    action: {
      type: "open-settings",
      section: target.section,
      ...(single && target.section === "providers" ? { providerID: first.providerID } : {}),
    },
  }
}
