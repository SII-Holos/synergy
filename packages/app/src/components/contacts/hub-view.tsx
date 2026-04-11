import { Show, For, createMemo } from "solid-js"
import type { HolosState, HolosProfile } from "@ericsanchezok/synergy-sdk"
import { AgentCard } from "./agent-card"

function capabilityTone(status: "available" | "locked" | "degraded" | "unknown") {
  if (status === "locked") return "text-icon-critical-base bg-rose-500/10"
  if (status === "degraded") return "text-icon-warning-base bg-amber-500/10"
  return "text-text-weak bg-surface-inset-base"
}

export function HubView(props: {
  profile: HolosProfile | null
  agentId: string | null
  connectionStatus: string
  loggedIn: boolean
  isGuest: boolean
  connecting: boolean
  reconnecting: boolean
  capabilityItems: HolosState["capability"]["items"]
  entitlements: HolosState["entitlement"]
  onEditProfile: () => void
  onDisconnect: () => void
  onReconnect: () => void
  onRerunSetup: () => void
  onConnectHolos: () => void
}) {
  const issueItems = createMemo(() => props.capabilityItems.filter((item) => item.status !== "available"))
  const allReady = createMemo(() => issueItems().length === 0)
  const quota = createMemo(() => props.entitlements.quotas.dailyFreeUsage)
  const showQuota = createMemo(() => quota().remaining != null && quota().limit != null)
  const quotaPercent = createMemo(() => {
    const q = quota()
    if (q.remaining == null || q.limit == null || q.limit === 0) return null
    return Math.round((q.remaining / q.limit) * 100)
  })

  return (
    <>
      <AgentCard
        profile={props.profile}
        agentId={props.agentId}
        connectionStatus={props.connectionStatus}
        loggedIn={props.loggedIn}
        isGuest={props.isGuest}
        connecting={props.connecting}
        reconnecting={props.reconnecting}
        onEditProfile={props.onEditProfile}
        onDisconnect={props.onDisconnect}
        onReconnect={props.onReconnect}
        onRerunSetup={props.onRerunSetup}
        onConnectHolos={props.onConnectHolos}
      />

      <Show when={!props.isGuest && props.profile}>
        <div class="flex items-center gap-2 mt-4 px-1">
          <span class="text-12-medium text-text-weak shrink-0">Capabilities</span>
          <div class="flex-1" />
          <Show
            when={allReady()}
            fallback={
              <div class="flex flex-wrap justify-end gap-1">
                <For each={issueItems()}>
                  {(item) => (
                    <span
                      class={`inline-flex items-center px-2 py-0.5 rounded-full text-10-medium ${capabilityTone(item.status)}`}
                    >
                      {item.title}
                    </span>
                  )}
                </For>
              </div>
            }
          >
            <span class="text-12-regular text-text-weakest">All available</span>
          </Show>
        </div>

        <Show when={showQuota()}>
          <div class="flex items-center gap-2 mt-2.5 px-1">
            <span class="text-12-medium text-text-weak">Daily usage</span>
            <div class="flex-1" />
            <span class="text-12-regular text-text-weakest tabular-nums">
              {quota().remaining}/{quota().limit}
            </span>
          </div>
          <Show when={quotaPercent() != null}>
            <div class="mt-1.5 mx-1 h-1 rounded-full bg-surface-inset-base overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                classList={{
                  "bg-icon-success-base": quotaPercent()! > 30,
                  "bg-icon-warning-base": quotaPercent()! > 10 && quotaPercent()! <= 30,
                  "bg-icon-critical-base": quotaPercent()! <= 10,
                }}
                style={{ width: `${quotaPercent()}%` }}
              />
            </div>
          </Show>
        </Show>

        <Show when={!allReady()}>
          {(() => {
            const primary = issueItems()[0]?.action
            if (!primary) return null
            const isLogin = primary.kind === "login_holos"
            return (
              <button
                type="button"
                class="w-full h-8 mt-3 flex items-center justify-center rounded-lg text-12-medium transition-all active:scale-[0.98] bg-text-interactive-base text-white hover:opacity-90 disabled:opacity-60"
                disabled={props.connecting || (isLogin ? false : props.reconnecting)}
                onClick={isLogin ? props.onConnectHolos : props.onReconnect}
              >
                {props.connecting
                  ? "Connecting…"
                  : props.reconnecting
                    ? "Reconnecting…"
                    : isLogin
                      ? "Sign in to Holos"
                      : "Reconnect to Holos"}
              </button>
            )
          })()}
        </Show>
      </Show>
    </>
  )
}
