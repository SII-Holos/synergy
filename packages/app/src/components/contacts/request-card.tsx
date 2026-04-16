import { createSignal, For, Show } from "solid-js"
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
    <div class="mt-5">
      <button
        type="button"
        class="flex items-center gap-2 w-full px-0.5 mb-2.5 group"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span
          class="shrink-0 text-icon-weak transition-transform duration-150"
          classList={{ "rotate-90": !collapsed() }}
        >
          <Icon name="chevron-right" size="small" />
        </span>
        <span class="text-12-medium text-text-weak">Requests</span>
        <span
          class="flex items-center justify-center size-4.5 rounded-full bg-surface-interactive-base text-text-on-interactive-base text-10-medium leading-none"
          style={{ animation: "badgePopIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
        >
          {totalCount()}
        </span>
      </button>

      <Show when={!collapsed()}>
        <div class="flex flex-col gap-1.5">
          <For each={props.requests}>
            {(request, i) => {
              const busy = () => isLoading(request.id)
              return (
                <div
                  class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-raised-base transition-all"
                  classList={{ "opacity-45 pointer-events-none": busy() }}
                  style={{
                    animation: "contactFadeUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) backwards",
                    "animation-delay": `${i() * 40}ms`,
                  }}
                >
                  <Avatar
                    fallback={displayName(request)}
                    size="small"
                    class="size-7 rounded-full overflow-hidden shrink-0"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="text-12-medium text-text-base truncate">{displayName(request)}</div>
                  </div>
                  <div class="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      class="flex items-center justify-center size-6 rounded-md bg-surface-interactive-base text-text-on-interactive-base hover:bg-surface-interactive-base-hover transition-colors disabled:opacity-40"
                      onClick={() => props.onRespond(request.id, "accepted")}
                      disabled={busy()}
                      title="Accept"
                    >
                      <Icon name="check" size="small" class="scale-75" />
                    </button>
                    <button
                      type="button"
                      class="flex items-center justify-center size-6 rounded-md text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors disabled:opacity-40"
                      onClick={() => props.onRespond(request.id, "rejected")}
                      disabled={busy()}
                      title="Decline"
                    >
                      <Icon name="x" size="small" class="scale-75" />
                    </button>
                  </div>
                </div>
              )
            }}
          </For>

          <Show when={props.outgoing.length > 0}>
            <Show when={props.requests.length > 0}>
              <div class="h-px bg-border-base/10 mx-2 my-1" />
            </Show>
            <For each={props.outgoing}>
              {(request, i) => {
                const isMuted = () => request.status === "accepted" || request.status === "rejected"
                const busy = () => isLoading(request.id)
                return (
                  <div
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-raised-base transition-all"
                    classList={{ "opacity-50": isMuted() && !busy(), "opacity-45 pointer-events-none": busy() }}
                    style={{
                      animation: "contactFadeUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) backwards",
                      "animation-delay": `${(i() + props.requests.length) * 40}ms`,
                    }}
                  >
                    <Avatar
                      fallback={displayName(request)}
                      size="small"
                      class="size-7 rounded-full overflow-hidden shrink-0"
                    />
                    <div class="flex-1 min-w-0">
                      <div class="text-12-medium text-text-base truncate">{displayName(request)}</div>
                    </div>
                    <span class="text-10-regular text-text-weakest shrink-0">
                      {outgoingStatusLabel(request.status)}
                    </span>
                    <button
                      type="button"
                      class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors shrink-0 disabled:opacity-40"
                      onClick={() => props.onCancel(request.id)}
                      disabled={busy()}
                      title="Cancel request"
                    >
                      <Icon name="x" size="small" class="scale-75" />
                    </button>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}
