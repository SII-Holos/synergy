import { createMemo, createSignal, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServer } from "@/context/server"
import { useHolos } from "@/context/holos"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { DialogSelectServer } from "@/components/dialog"
import { SessionLspIndicator, SessionMcpIndicator, SessionCortexIndicator } from "@/components/session"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { DialogSettings } from "@/components/dialog/dialog-settings"
import { DropdownMenu } from "@ericsanchezok/synergy-ui/dropdown-menu"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"

function ConfigSetStatus() {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(false)
  const [activating, setActivating] = createSignal<string>()

  const activeSet = createMemo(() => globalSync.configSets.find((set) => set.active))

  async function handleActivate(name: string) {
    if (name === activeSet()?.name || activating()) return
    setActivating(name)
    try {
      await globalSDK.client.config.set.activate({ name })
      await globalSync.refreshAllConfigs()
      showToast({ title: "Config Set activated", description: `Using ${name}` })
      setOpen(false)
    } catch (error: any) {
      showToast({ title: "Failed to switch Config Set", description: error.message })
    } finally {
      setActivating(undefined)
    }
  }

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        data-component="button"
        data-size="small"
        data-variant="ghost"
        class="rounded-full px-2.5 h-7 transition-colors hover:bg-surface-raised-base-hover"
      >
        <div class="flex items-center gap-2 min-w-0">
          <Icon name="server" size="small" class="text-icon-base" />
          <span class="text-12-medium text-text-base truncate max-w-24">{activeSet()?.name ?? "default"}</span>
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-52" onClick={(event: MouseEvent) => event.stopPropagation()}>
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>Switch Config Set</DropdownMenu.GroupLabel>
            <For each={globalSync.configSets}>
              {(set) => (
                <DropdownMenu.Item onSelect={() => void handleActivate(set.name)} disabled={!!activating()}>
                  <Icon name={set.active ? "check" : "server"} size="small" class="mr-2" />
                  <DropdownMenu.ItemLabel>
                    <span class="flex items-center gap-2">
                      <span>{set.name}</span>
                      <Show when={activating() === set.name}>
                        <span class="text-text-weak">Switching...</span>
                      </Show>
                    </span>
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            onSelect={() => {
              setOpen(false)
              dialog.show(() => <DialogSettings initialTab="config-sets" />)
            }}
          >
            <Icon name="settings" size="small" class="mr-2" />
            <DropdownMenu.ItemLabel>Manage in Settings</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function HolosStatusIndicator() {
  const holos = useHolos()

  return (
    <Show when={holos.state.identity.loggedIn}>
      <Button
        size="small"
        variant="ghost"
        class="rounded-full px-2.5 h-7 transition-colors hover:bg-surface-raised-base-hover"
      >
        <div class="flex items-center gap-2">
          <div
            classList={{
              "size-1.5 rounded-full shadow-[0_0_0_2px_color-mix(in_srgb,currentColor_20%,transparent)]": true,
              "bg-icon-success-base text-icon-success-base animate-[statusPulse_3s_ease-in-out_infinite]":
                holos.state.connection.status === "connected",
              "bg-icon-critical-base text-icon-critical-base animate-[statusPulse_1.5s_ease-in-out_infinite]":
                holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected",
              "bg-border-strong text-border-strong":
                holos.state.connection.status === "connecting" ||
                holos.state.connection.status === "disabled" ||
                holos.state.connection.status === "unknown",
            }}
          />
          <span class="text-12-medium text-text-base">Holos</span>
        </div>
      </Button>
    </Show>
  )
}

export function StatusBar() {
  const params = useParams()
  const server = useServer()
  const dialog = useDialog()

  return (
    <div class="flex items-center justify-center gap-2 py-1">
      <Button
        size="small"
        variant="ghost"
        class="rounded-full px-2.5 h-7 transition-colors hover:bg-surface-raised-base-hover"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div class="flex items-center gap-2">
          <div
            classList={{
              "size-1.5 rounded-full shadow-[0_0_0_2px_color-mix(in_srgb,currentColor_20%,transparent)]": true,
              "bg-icon-success-base text-icon-success-base animate-[statusPulse_3s_ease-in-out_infinite]":
                server.healthy() === true,
              "bg-icon-critical-base text-icon-critical-base animate-[statusPulse_1.5s_ease-in-out_infinite]":
                server.healthy() === false,
              "bg-border-strong text-border-strong": server.healthy() === undefined,
            }}
          />
          <span class="text-12-medium text-text-base truncate max-w-24">{server.name}</span>
        </div>
      </Button>

      <ConfigSetStatus />
      <HolosStatusIndicator />

      <Show when={params.dir}>
        <div class="flex items-center gap-0.5">
          <SessionLspIndicator />
          <SessionMcpIndicator />
          <Show when={params.id}>
            <SessionCortexIndicator sessionID={params.id!} />
          </Show>
        </div>
      </Show>
    </div>
  )
}
