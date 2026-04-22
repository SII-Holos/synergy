import { createSignal, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import type { FriendRequest } from "@ericsanchezok/synergy-sdk"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

function outgoingStatusLabel(status: FriendRequest["status"]): string {
  switch (status) {
    case "pending":
      return "Pending"
    case "pending_delivery":
      return "Queued"
    case "accepted":
      return "Accepted"
    case "rejected":
      return "Declined"
    default:
      return "Sent"
  }
}

function displayName(request: FriendRequest): string {
  return request.peerName || request.peerId.slice(0, 8) + "…"
}

function formatRequestDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp))
}

function StatusPill(props: { label: string; tone?: "default" | "success" | "warning" | "danger" }) {
  return (
    <span
      class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-10-medium"
      classList={{
        "bg-surface-inset-base/70 text-text-weak": !props.tone || props.tone === "default",
        "bg-emerald-500/10 text-icon-success-base": props.tone === "success",
        "bg-amber-500/10 text-icon-warning-base": props.tone === "warning",
        "bg-rose-500/10 text-icon-critical-base": props.tone === "danger",
      }}
    >
      {props.label}
    </span>
  )
}

function RequestCardShell(props: {
  request: FriendRequest
  delay: number
  muted?: boolean
  busy?: boolean
  directionLabel: string
  statusTone?: "default" | "success" | "warning" | "danger"
  actionSlot: JSX.Element
}) {
  return (
    <div
      class="flex items-start gap-3 rounded-[22px] border border-border-base bg-background-base/86 p-3.5 shadow-[0_16px_38px_-32px_color-mix(in_srgb,var(--surface-brand-base)_32%,transparent)] backdrop-blur-xl transition-all"
      classList={{
        "opacity-55": props.muted && !props.busy,
        "opacity-45 pointer-events-none": props.busy,
      }}
      style={{
        animation: "contactFadeUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) backwards",
        "animation-delay": `${props.delay}ms`,
      }}
    >
      <Avatar
        fallback={displayName(props.request)}
        size="small"
        class="size-10 rounded-2xl overflow-hidden shrink-0 ring-1 ring-border-base/60 shadow-sm"
      />

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <div class="truncate text-13-medium text-text-strong">{displayName(props.request)}</div>
          <StatusPill label={props.directionLabel} />
          <Show when={props.request.direction === "outgoing" && props.request.status}>
            <StatusPill label={outgoingStatusLabel(props.request.status)} tone={props.statusTone} />
          </Show>
        </div>

        <Show when={props.request.peerBio?.trim()}>
          <div class="mt-2 rounded-2xl bg-surface-inset-base/55 px-3 py-2 text-11-regular leading-5 text-text-weak line-clamp-2">
            {props.request.peerBio}
          </div>
        </Show>

        <div class="mt-3 flex items-center justify-between gap-3">
          <span class="inline-flex items-center gap-1.5 text-10-medium text-text-subtle">
            <Icon name="message-square" size="small" />
            {formatRequestDate(props.request.createdAt)}
          </span>
          <div class="shrink-0">{props.actionSlot}</div>
        </div>
      </div>
    </div>
  )
}

export function RequestsSection(props: {
  requests: FriendRequest[]
  outgoing: FriendRequest[]
  onRespond: (id: string, status: "accepted" | "rejected") => void
  onCancel: (id: string) => void
  loadingIds?: Set<string>
}) {
  const [collapsed, setCollapsed] = createSignal(false)
  const totalCount = () => props.requests.length + props.outgoing.length
  const isLoading = (id: string) => props.loadingIds?.has(id) ?? false

  return (
    <section class="mt-5 rounded-[26px] border border-border-base bg-background-base/88 p-4 shadow-[0_20px_50px_-36px_color-mix(in_srgb,var(--surface-brand-base)_40%,transparent)] backdrop-blur-xl">
      <button type="button" class="flex w-full items-center gap-3 text-left" onClick={() => setCollapsed((v) => !v)}>
        <div class="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-surface-brand-base/15 text-text-strong shadow-sm ring-1 ring-border-base/60">
          <Icon name="user-plus" size="small" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-13-medium text-text-strong">Requests</span>
            <span
              class="flex items-center justify-center rounded-full bg-surface-interactive-base px-2.5 py-1 text-10-medium leading-none text-text-on-interactive-base"
              style={{ animation: "badgePopIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
            >
              {totalCount()}
            </span>
          </div>
          <p class="mt-1 text-11-regular text-text-weak">Review incoming invites and keep outgoing requests tidy.</p>
        </div>
        <span class="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border-base bg-surface-raised-stronger-non-alpha text-icon-weak transition-transform duration-150">
          <Icon name={collapsed() ? "chevron-right" : "chevron-down"} size="small" />
        </span>
      </button>

      <Show when={!collapsed()}>
        <div class="mt-4 flex flex-col gap-4">
          <Show when={props.requests.length > 0}>
            <div class="flex flex-col gap-2.5">
              <div class="flex items-center gap-2 px-1">
                <span class="text-11-medium uppercase tracking-[0.14em] text-text-subtle">Incoming</span>
                <span class="h-px flex-1 bg-border-base/40" />
              </div>
              <For each={props.requests}>
                {(request, i) => {
                  const busy = () => isLoading(request.id)
                  return (
                    <RequestCardShell
                      request={request}
                      delay={i() * 40}
                      busy={busy()}
                      directionLabel="Incoming"
                      actionSlot={
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-full bg-surface-interactive-base px-3 py-1.5 text-11-medium text-text-on-interactive-base transition-colors hover:bg-surface-interactive-base-hover disabled:opacity-40"
                            onClick={() => props.onRespond(request.id, "accepted")}
                            disabled={busy()}
                          >
                            <Icon name="check" size="small" />
                            Accept
                          </button>
                          <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-11-medium text-text-weak transition-colors hover:bg-surface-inset-base hover:text-text-base disabled:opacity-40"
                            onClick={() => props.onRespond(request.id, "rejected")}
                            disabled={busy()}
                          >
                            <Icon name="x" size="small" />
                            Decline
                          </button>
                        </div>
                      }
                    />
                  )
                }}
              </For>
            </div>
          </Show>

          <Show when={props.outgoing.length > 0}>
            <div class="flex flex-col gap-2.5">
              <div class="flex items-center gap-2 px-1">
                <span class="text-11-medium uppercase tracking-[0.14em] text-text-subtle">Outgoing</span>
                <span class="h-px flex-1 bg-border-base/40" />
              </div>
              <For each={props.outgoing}>
                {(request, i) => {
                  const busy = () => isLoading(request.id)
                  const muted = () => request.status === "accepted" || request.status === "rejected"
                  const tone = () => {
                    if (request.status === "accepted") return "success" as const
                    if (request.status === "rejected") return "danger" as const
                    if (request.status === "pending_delivery") return "warning" as const
                    return "default" as const
                  }

                  return (
                    <RequestCardShell
                      request={request}
                      delay={(i() + props.requests.length) * 40}
                      busy={busy()}
                      muted={muted()}
                      directionLabel="Outgoing"
                      statusTone={tone()}
                      actionSlot={
                        <button
                          type="button"
                          class="inline-flex items-center gap-1.5 rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-11-medium text-text-weak transition-colors hover:bg-surface-inset-base hover:text-text-base disabled:opacity-40"
                          onClick={() => props.onCancel(request.id)}
                          disabled={busy()}
                          title="Cancel request"
                        >
                          <Icon name="x" size="small" />
                          Cancel
                        </button>
                      }
                    />
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  )
}
