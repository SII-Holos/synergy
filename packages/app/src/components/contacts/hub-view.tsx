import { Show, For, createMemo } from "solid-js"
import type { HolosState, HolosProfile } from "@ericsanchezok/synergy-sdk"
import { AgentCard } from "./agent-card"
import { StatsSection } from "@/components/stats/stats-section"

function capabilityTone(status: "available" | "locked" | "degraded" | "unknown") {
  if (status === "locked") return "text-icon-critical-base bg-rose-500/12 ring-rose-400/18"
  if (status === "degraded") return "text-icon-warning-base bg-amber-500/12 ring-amber-400/18"
  return "text-text-weak bg-surface-raised-stronger-non-alpha ring-white/8"
}

function quotaTone(percent: number | null) {
  if (percent == null) return "bg-text-interactive-base"
  if (percent > 30) return "bg-icon-success-base"
  if (percent > 10) return "bg-icon-warning-base"
  return "bg-icon-critical-base"
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
      <section class="rounded-[1.35rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(255,255,255,0.03)]">
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
          <div class="mt-3 rounded-[1.15rem] bg-surface-inset-base/42 p-3 ring-1 ring-inset ring-white/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <div class="rounded-[1rem] bg-surface-raised-base/92 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(255,255,255,0.03)]">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Capabilities</div>
                    <div class="mt-1 text-13-semibold tracking-tight text-text-strong">
                      {allReady() ? "All systems available" : `${issueItems().length} needs attention`}
                    </div>
                  </div>
                  <div class="shrink-0 rounded-full bg-surface-raised-stronger-non-alpha px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-white/8">
                    {props.capabilityItems.length} total
                  </div>
                </div>

                <Show
                  when={!allReady()}
                  fallback={
                    <div class="mt-3 text-11-regular text-text-weak">
                      Everything needed for Holos is currently available.
                    </div>
                  }
                >
                  <div class="mt-3 flex flex-wrap gap-1.5">
                    <For each={issueItems()}>
                      {(item) => (
                        <span
                          class={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ${capabilityTone(item.status)}`}
                        >
                          {item.title}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <Show when={showQuota()}>
                <div class="rounded-[1rem] bg-surface-raised-base/92 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(255,255,255,0.03)]">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Quota</div>
                      <div class="mt-1 text-13-semibold tracking-tight text-text-strong">Daily usage remaining</div>
                    </div>
                    <div class="text-right">
                      <div class="text-15-semibold tabular-nums tracking-tight text-text-strong">
                        {quota().remaining}/{quota().limit}
                      </div>
                      <Show when={quotaPercent() != null}>
                        <div class="mt-1 text-[10px] font-medium text-text-weak">{quotaPercent()}% left</div>
                      </Show>
                    </div>
                  </div>

                  <Show when={quotaPercent() != null}>
                    <div class="mt-3 h-2 rounded-full bg-surface-inset-base/65 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                      <div
                        class={`h-full rounded-full transition-all duration-500 ${quotaTone(quotaPercent())}`}
                        style={{ width: `${quotaPercent()}%` }}
                      />
                    </div>
                  </Show>
                </div>
              </Show>
            </div>

            <Show when={!allReady()}>
              {(() => {
                const primary = issueItems()[0]?.action
                if (!primary) return null
                const isLogin = primary.kind === "login_holos"
                return (
                  <button
                    type="button"
                    class="mt-3 flex h-9 w-full items-center justify-center rounded-xl bg-text-interactive-base text-12-medium text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
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
          </div>
        </Show>
      </section>

      <div class="mt-6">
        <StatsSection />
      </div>
    </>
  )
}
