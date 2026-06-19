import { createSignal, Show } from "solid-js"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useAuth } from "@/context/auth"
import { useHolosLoginPopup } from "@/hooks/use-holos-login-popup"
import { AppPanel } from "@/components/app-panel"
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

  const [tab, setTab] = createSignal<"hub" | "contacts">("hub")
  const [reconnecting, setReconnecting] = createSignal(false)
  const [refreshingContacts, setRefreshingContacts] = createSignal(false)

  async function refetchAll() {
    if (refreshingContacts()) return
    setRefreshingContacts(true)
    await holos.refresh()
    // refreshPresence route removed; holos.refresh() already fetches latest state
    setRefreshingContacts(false)
  }

  async function handleDisconnect() {
    try {
      await globalSDK.client.holos.logout()
      showToast({ type: "info", title: "Disconnected from Holos" })
      void holos.refresh()
    } catch {
      showToast({ type: "error", title: "Failed to disconnect" })
    }
  }

  async function handleReconnect() {
    if (reconnecting()) return
    setReconnecting(true)
    try {
      await globalSDK.client.holos.reconnect()
      showToast({ type: "info", title: "Reconnecting..." })
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
      showToast({ type: "error", title: "Reconnect failed", description: msg || "Failed to reconnect" })
    } finally {
      setReconnecting(false)
    }
  }

  const { trigger: handleConnectHolos, connecting } = useHolosLoginPopup({
    serverUrl: globalSDK.url,
    onSuccess: ({ agentId }) => {
      if (auth.status === "guest" && agentId) {
        auth.loginWithToken(agentId, { id: agentId })
      }
      void holos.refresh()
      showToast({ type: "info", title: "Connected to Holos" })
    },
    onError: (msg) => showToast({ type: "error", title: msg }),
  })

  return (
    <AppPanel.Root>
      <style>{CARD_ENTER_STYLE}</style>
      <AppPanel.Content>
        <AppPanel.Header>
          <AppPanel.HeaderRow>
            <AppPanel.Title>Holos</AppPanel.Title>
            <AppPanel.Actions>
              <AppPanel.SegmentedNav
                items={[
                  { id: "hub", label: "Hub" },
                  { id: "contacts", label: "Contacts" },
                ]}
                active={tab()}
                onChange={(id) => setTab(id as "hub" | "contacts")}
              />
            </AppPanel.Actions>
          </AppPanel.HeaderRow>
        </AppPanel.Header>
        <AppPanel.Body>
          <Show when={holos.loaded} fallback={<AppPanel.Loading />}>
            <Show when={tab() === "hub"}>
              <HubView
                profile={holos.state.social.profile}
                agentId={holos.state.identity.agentId}
                connectionStatus={holos.state.connection.status}
                loggedIn={holos.state.identity.loggedIn}
                isGuest={auth.status === "guest"}
                connecting={connecting()}
                reconnecting={reconnecting()}
                onDisconnect={handleDisconnect}
                onReconnect={handleReconnect}
                onConnectHolos={handleConnectHolos}
              />
            </Show>
            <Show when={tab() === "contacts"}>
              <ContactsView onRefresh={refetchAll} refreshing={refreshingContacts()} />
            </Show>
          </Show>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
