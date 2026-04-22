import { Show, For, createMemo } from "solid-js"
import type { HolosState, HolosProfile } from "@ericsanchezok/synergy-sdk"
import { AgentCard } from "./agent-card"
import { StatsSection } from "@/components/stats/stats-section"

function capabilityStateMeta(status: "available" | "locked" | "degraded" | "unknown") {
  if (status === "available") {
    return {
      badgeClass: "bg-emerald-500/14 text-icon-success-base ring-emerald-400/20",
      iconClass: "bg-emerald-500/16 text-icon-success-base ring-emerald-400/20",
      icon: "✓",
      label: "Ready",
    }
  }
  if (status === "locked") {
    return {
      badgeClass: "bg-rose-500/12 text-icon-critical-base ring-rose-400/18",
      iconClass: "bg-rose-500/14 text-icon-critical-base ring-rose-400/20",
      icon: "—",
      label: "Unavailable",
    }
  }
  if (status === "degraded") {
    return {
      badgeClass: "bg-amber-500/12 text-icon-warning-base ring-amber-400/18",
      iconClass: "bg-amber-500/14 text-icon-warning-base ring-amber-400/20",
      icon: "!",
      label: "Limited",
    }
  }
  return {
    badgeClass: "bg-surface-raised-stronger-non-alpha text-text-weak ring-border-base/50",
    iconClass: "bg-surface-raised-stronger-non-alpha text-text-weaker ring-border-base/50",
    icon: "?",
    label: "Unknown",
  }
}

function capabilityStatusCopy(item: HolosState["capability"]["items"][number]) {
  if (item.status === "available") return "Ready in this shell."
  if (item.reason === "not_logged_in") return "Sign in to Holos to enable it."
  if (item.reason === "not_connected") return "Reconnect the shell to enable it."
  if (item.reason === "temporarily_unavailable") return "Temporarily unavailable in this shell."
  return "Currently unavailable in this shell."
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
      <section class="rounded-[1.35rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
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
          <div class="mt-3 rounded-[1.15rem] bg-surface-inset-base/42 p-3 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <div class="rounded-[1rem] bg-surface-raised-base/92 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Capabilities</div>
                    <div class="mt-1 text-13-semibold tracking-tight text-text-strong">
                      {allReady()
                        ? "Holos shell ready"
                        : `${issueItems().length} feature${issueItems().length === 1 ? "" : "s"} need attention`}
                    </div>
                  </div>
                  <div class="shrink-0 rounded-full bg-surface-raised-stronger-non-alpha px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/50">
                    {props.capabilityItems.length} features
                  </div>
                </div>

                <div class="mt-3 space-y-2">
                  <For each={props.capabilityItems}>
                    {(item) => {
                      const meta = capabilityStateMeta(item.status)
                      return (
                        <div class="flex items-start gap-3 rounded-[0.95rem] bg-surface-inset-base/48 px-3 py-2.5 ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
                          <div
                            class={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1 ring-inset ${meta.iconClass}`}
                          >
                            {meta.icon}
                          </div>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-start justify-between gap-3">
                              <div class="text-12-medium text-text-strong">{item.title}</div>
                              <div
                                class={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.14em] ring-1 ring-inset ${meta.badgeClass}`}
                              >
                                {meta.label}
                              </div>
                            </div>
                            <div class="mt-1 text-11-regular leading-relaxed text-text-weak">{item.description}</div>
                            <div class="mt-1 text-[10px] font-medium text-text-weaker">
                              {capabilityStatusCopy(item)}
                            </div>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>

              <Show when={showQuota()}>
                <div class="rounded-[1rem] bg-surface-raised-base/92 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
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
                    <div class="mt-3 h-2 rounded-full bg-surface-inset-base/65 p-0.5 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
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
