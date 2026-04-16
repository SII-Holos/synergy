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
      class="rounded-xl bg-surface-raised-base flex flex-col transition-all overflow-hidden"
      style={{ animation: "contactFadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
    >
      <Show
        when={!props.isGuest && props.profile}
        fallback={
          <div class="p-4 flex flex-col items-center gap-3 text-center">
            <div class="size-12 rounded-full bg-surface-inset-base flex items-center justify-center">
              <Icon name="globe" size="normal" class="text-icon-weak" />
            </div>
            <div>
              <div class="text-13-medium text-text-base">Standalone mode</div>
              <p class="text-11-regular text-text-weak mt-1 leading-relaxed max-w-[220px] mx-auto">
                Connect to Holos for contacts, remote collaboration, and platform capabilities.
              </p>
            </div>
            <button
              type="button"
              class="h-8 w-full max-w-[200px] flex items-center justify-center rounded-lg bg-text-interactive-base text-white text-12-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60"
              onClick={props.onConnectHolos}
              disabled={props.connecting}
            >
              {props.connecting ? "Connecting…" : "Connect to Holos"}
            </button>
          </div>
        }
      >
        {(profile) => (
          <div class="p-3 flex items-start gap-3">
            <div class="relative shrink-0">
              <Avatar fallback={profile().name} size="large" class="size-11 rounded-full overflow-hidden" />
              <div
                class={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface-raised-base ${statusDot()}`}
              />
            </div>

            <div class="flex-1 min-w-0 pt-0.5">
              <div class="flex items-center gap-2">
                <span class="text-14-semibold text-text-strong truncate">{profile().name}</span>
                <div class="ml-auto shrink-0 flex items-center gap-1">
                  <Show when={needsLogin()}>
                    <button
                      type="button"
                      class="text-10-medium text-text-interactive-base hover:underline transition-all disabled:opacity-60"
                      onClick={props.onConnectHolos}
                      disabled={props.connecting}
                    >
                      {props.connecting ? "…" : "Sign in"}
                    </button>
                  </Show>
                  <Show when={canReconnect()}>
                    <button
                      type="button"
                      class="text-10-medium text-text-interactive-base hover:underline transition-all disabled:opacity-60"
                      onClick={props.onReconnect}
                      disabled={props.reconnecting}
                    >
                      {props.reconnecting ? "Reconnecting…" : "Reconnect"}
                    </button>
                  </Show>
                  <DropdownMenu>
                    <DropdownMenu.Trigger class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-all">
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

              <Show when={props.agentId}>
                <div class="text-10-regular text-text-weakest font-mono mt-0.5 truncate">
                  {truncateId(props.agentId ?? "")}
                </div>
              </Show>

              <Show when={profile().bio}>
                <div class="text-11-regular text-text-weak line-clamp-2 leading-relaxed mt-1">{profile().bio}</div>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
