import { createSignal, createMemo, Show } from "solid-js"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useAuth } from "@/context/auth"
import { useHolosLoginPopup } from "@/hooks/use-holos-login-popup"
import { Panel } from "@/components/panel"
import { ViewTab } from "@/components/engram/shared"
import { EditProfileDialog } from "./edit-profile-dialog"
import { HubView } from "./hub-view"
import { ContactsView } from "./contacts-view"

const CARD_ENTER_STYLE = `
@keyframes contactFadeUp {
  from { opacity: 0; transform: translateY(8px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`

export function HolosPanel() {
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const auth = useAuth()
  const dialogCtx = useDialog()

  const [tab, setTab] = createSignal<"hub" | "contacts">("hub")
  const [reconnecting, setReconnecting] = createSignal(false)
  const [refreshingContacts, setRefreshingContacts] = createSignal(false)

  const pendingIncoming = createMemo(() =>
    (holos.state.social.friendRequests ?? []).filter((r) => r.direction === "incoming" && r.status === "pending"),
  )

  async function refetchAll() {
    if (refreshingContacts()) return
    setRefreshingContacts(true)
    await holos.refresh()
    try {
      await globalSDK.client.holos.refreshPresence()
    } finally {
      await holos.refresh()
      for (let attempt = 0; attempt < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await holos.refresh()
      }
      setRefreshingContacts(false)
    }
  }

  function handleEditProfile() {
    const p = holos.state.social.profile
    if (!p) return
    dialogCtx.show(() => (
      <EditProfileDialog
        profile={p}
        onSaved={() => void holos.refresh()}
        onRerunSetup={() => {
          void holos.refresh()
          auth.logout()
        }}
      />
    ))
  }

  async function handleDisconnect() {
    try {
      await globalSDK.client.holos.logout()
      showToast({ title: "Disconnected from Holos" })
      void holos.refresh()
    } catch {
      showToast({ title: "Failed to disconnect" })
    }
  }

  async function handleReconnect() {
    if (reconnecting()) return
    setReconnecting(true)
    try {
      await globalSDK.client.holos.reconnect()
      showToast({ title: "Reconnecting..." })
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "data" in error
            ? String((error as any).data?.message ?? "")
            : ""
      if (msg.toLowerCase().includes("no holos credentials")) {
        void handleConnectHolos()
        return
      }
      showToast({ title: "Reconnect failed", description: msg || "Failed to reconnect" })
    } finally {
      setReconnecting(false)
    }
  }

  function handleRerunSetup() {
    if (!confirm("Re-run the onboarding setup? Your current profile data will be preserved.")) return
    globalSDK.client.holos.profile
      .reset()
      .then(() => auth.logout())
      .catch(() => showToast({ title: "Failed to reset setup" }))
  }

  const { trigger: handleConnectHolos, connecting } = useHolosLoginPopup({
    serverUrl: globalSDK.url,
    onSuccess: ({ agentId }) => {
      if (auth.status === "guest" && agentId) {
        auth.loginWithToken(agentId, { id: agentId })
      }
      void holos.refresh()
      showToast({ title: "Connected to Holos" })
    },
    onError: (msg) => showToast({ title: msg }),
  })

  return (
    <Panel.Root>
      <style>{CARD_ENTER_STYLE}</style>
      <Panel.Header>
        <Panel.HeaderRow>
          <div class="flex items-center flex-1 min-w-0 gap-0.5 rounded-lg bg-surface-inset-base/50 p-0.5">
            <ViewTab active={tab() === "hub"} onClick={() => setTab("hub")}>
              Hub
            </ViewTab>
            <ViewTab active={tab() === "contacts"} onClick={() => setTab("contacts")}>
              <span class="flex items-center gap-1.5">
                Contacts
                <Show when={pendingIncoming().length > 0}>
                  <span class="flex items-center justify-center size-4 rounded-full bg-surface-interactive-solid text-text-on-interactive-base text-[9px] font-medium leading-none">
                    {pendingIncoming().length}
                  </span>
                </Show>
              </span>
            </ViewTab>
          </div>
        </Panel.HeaderRow>
      </Panel.Header>
      <Panel.Body>
        <Show when={holos.loaded} fallback={<Panel.Loading />}>
          <Show when={tab() === "hub"}>
            <HubView
              profile={holos.state.social.profile}
              agentId={holos.state.identity.agentId}
              connectionStatus={holos.state.connection.status}
              loggedIn={holos.state.identity.loggedIn}
              isGuest={auth.status === "guest"}
              connecting={connecting()}
              reconnecting={reconnecting()}
              capabilityItems={holos.state.capability.items}
              entitlements={holos.state.entitlement}
              onEditProfile={handleEditProfile}
              onDisconnect={handleDisconnect}
              onReconnect={handleReconnect}
              onRerunSetup={handleRerunSetup}
              onConnectHolos={handleConnectHolos}
            />
          </Show>
          <Show when={tab() === "contacts"}>
            <ContactsView onRefresh={refetchAll} refreshing={refreshingContacts()} />
          </Show>
        </Show>
      </Panel.Body>
    </Panel.Root>
  )
}
