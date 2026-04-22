import { Show } from "solid-js"
import type { HolosProfile } from "@ericsanchezok/synergy-sdk"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { DropdownMenu } from "@ericsanchezok/synergy-ui/dropdown-menu"
import { showToast } from "@ericsanchezok/synergy-ui/toast"

function truncateId(id: string): string {
  if (id.length <= 16) return id
  return id.slice(0, 8) + "..." + id.slice(-4)
}

function statusLabel(status: string, needsLogin: boolean): string {
  if (needsLogin) return "Sign-in required"
  if (status === "connected") return "Connected"
  if (status === "failed") return "Connection failed"
  if (status === "disconnected") return "Disconnected"
  if (status === "connecting") return "Connecting"
  return "Unavailable"
}

function statusChipTone(status: string, needsLogin: boolean): string {
  if (needsLogin) {
    return "bg-amber-500/14 text-icon-warning-base ring-amber-400/20"
  }
  if (status === "connected") {
    return "bg-emerald-500/14 text-icon-success-base ring-emerald-400/20"
  }
  if (status === "failed" || status === "disconnected") {
    return "bg-rose-500/14 text-icon-critical-base ring-rose-400/20"
  }
  if (status === "connecting") {
    return "bg-amber-500/14 text-icon-warning-base ring-amber-400/20"
  }
  return "bg-surface-raised-stronger-non-alpha text-text-weak ring-white/8"
}

export function AgentCard(props: {
  profile: HolosProfile | null
  agentId: string | null
  connectionStatus: string
  loggedIn: boolean
  isGuest: boolean
  connecting?: boolean
  reconnecting?: boolean
  onEditProfile: () => void
  onDisconnect: () => void
  onReconnect: () => void
  onRerunSetup: () => void
  onConnectHolos: () => void
}) {
  const statusDot = () => {
    const s = props.connectionStatus
    if (s === "connected") return "bg-icon-success-base"
    if (s === "failed" || s === "disconnected") return "bg-icon-critical-base"
    if (s === "connecting") return "bg-icon-warning-base animate-pulse"
    return "bg-border-strong"
  }

  const canDisconnect = () => props.connectionStatus === "connected" || props.connectionStatus === "connecting"
  const canReconnect = () =>
    props.loggedIn && (props.connectionStatus === "disconnected" || props.connectionStatus === "failed")
  const needsLogin = () => !props.loggedIn && !props.isGuest

  return (
    <div
      class="overflow-hidden rounded-[1.15rem] bg-surface-inset-base/45 p-3 ring-1 ring-inset ring-white/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-all"
      style={{ animation: "contactFadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
    >
      <Show
        when={!props.isGuest && props.profile}
        fallback={
          <div class="flex flex-col gap-4 rounded-[1rem] bg-surface-raised-base/95 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(255,255,255,0.03)]">
            <div class="flex items-start gap-3">
              <div class="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface-raised-stronger-non-alpha ring-1 ring-inset ring-white/8 shadow-[0_12px_30px_rgba(15,23,42,0.08)]">
                <Icon name="globe" size="normal" class="text-icon-weak" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Holos Hub</div>
                <div class="mt-1 text-15-semibold tracking-tight text-text-strong">Standalone mode</div>
                <p class="mt-1.5 max-w-[28ch] text-11-regular leading-relaxed text-text-weak">
                  Connect to Holos for contacts, remote collaboration, and platform capabilities.
                </p>
              </div>
            </div>
            <button
              type="button"
              class="flex h-9 w-full items-center justify-center rounded-xl bg-text-interactive-base text-12-medium text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
              onClick={props.onConnectHolos}
              disabled={props.connecting}
            >
              {props.connecting ? "Connecting…" : "Connect to Holos"}
            </button>
          </div>
        }
      >
        {(profile) => (
          <div class="rounded-[1rem] bg-surface-raised-base/95 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(255,255,255,0.03)]">
            <div class="flex items-start gap-3.5">
              <div class="relative shrink-0">
                <div class="rounded-[1.1rem] bg-surface-raised-stronger-non-alpha p-1 ring-1 ring-inset ring-white/8 shadow-[0_14px_36px_rgba(15,23,42,0.12)]">
                  <Avatar fallback={profile().name} size="large" class="size-12 rounded-[0.95rem] overflow-hidden" />
                </div>
                <div
                  class={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-surface-raised-base ${statusDot()}`}
                />
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Holos Agent</div>
                    <div class="mt-1 text-15-semibold tracking-tight text-text-strong truncate">{profile().name}</div>
                  </div>

                  <div class="flex shrink-0 items-start gap-2">
                    <div
                      class={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[10px] font-medium ring-1 ring-inset ${statusChipTone(
                        props.connectionStatus,
                        needsLogin(),
                      )}`}
                    >
                      <span class={`size-1.5 rounded-full ${statusDot()}`} />
                      <span>{statusLabel(props.connectionStatus, needsLogin())}</span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenu.Trigger class="flex size-7 items-center justify-center rounded-full border border-border-base/40 bg-surface-raised-stronger-non-alpha text-icon-weak transition-all hover:bg-surface-raised-base-hover hover:text-icon-base">
                        <Icon name="ellipsis" size="small" />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class="min-w-44">
                          <DropdownMenu.Item onSelect={props.onEditProfile}>
                            <Icon name="pen" size="small" class="mr-2" />
                            <DropdownMenu.ItemLabel>Edit profile</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <Show when={props.agentId}>
                            <DropdownMenu.Item
                              onSelect={() => {
                                navigator.clipboard.writeText(props.agentId ?? "")
                                showToast({ title: "Agent ID copied" })
                              }}
                            >
                              <Icon name="copy" size="small" class="mr-2" />
                              <DropdownMenu.ItemLabel>Copy ID</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </Show>
                          <DropdownMenu.Separator />
                          <Show when={canDisconnect()}>
                            <DropdownMenu.Item onSelect={props.onDisconnect}>
                              <Icon name="x" size="small" class="mr-2" />
                              <DropdownMenu.ItemLabel>Disconnect</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </Show>
                          <DropdownMenu.Item onSelect={props.onRerunSetup}>
                            <Icon name="refresh-ccw" size="small" class="mr-2" />
                            <DropdownMenu.ItemLabel>Re-run setup</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  </div>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <Show when={props.agentId}>
                    <div class="inline-flex max-w-full items-center rounded-full bg-surface-raised-stronger-non-alpha px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-white/8">
                      <span class="mr-1.5 text-text-weaker/70">ID</span>
                      <span class="truncate font-mono text-text-weak">{truncateId(props.agentId ?? "")}</span>
                    </div>
                  </Show>

                  <Show when={needsLogin()}>
                    <button
                      type="button"
                      class="inline-flex h-7 items-center rounded-full bg-amber-500/12 px-3 text-10-medium text-icon-warning-base ring-1 ring-inset ring-amber-400/20 transition-all hover:bg-amber-500/16 disabled:opacity-60"
                      onClick={props.onConnectHolos}
                      disabled={props.connecting}
                    >
                      {props.connecting ? "Connecting…" : "Sign in"}
                    </button>
                  </Show>

                  <Show when={canReconnect()}>
                    <button
                      type="button"
                      class="inline-flex h-7 items-center rounded-full bg-surface-raised-stronger-non-alpha px-3 text-10-medium text-text-base ring-1 ring-inset ring-white/8 transition-all hover:bg-surface-raised-base-hover disabled:opacity-60"
                      onClick={props.onReconnect}
                      disabled={props.reconnecting}
                    >
                      {props.reconnecting ? "Reconnecting…" : "Reconnect"}
                    </button>
                  </Show>
                </div>

                <Show when={profile().bio}>
                  <div class="mt-3 rounded-xl bg-surface-inset-base/50 px-3 py-2.5 text-11-regular leading-relaxed text-text-weak shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                    {profile().bio}
                  </div>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
