import { createSignal, createMemo, Show } from "solid-js"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useAuth } from "@/context/auth"
import { AppPanel } from "@/components/app-panel"
import { FriendsSection } from "./contact-card"
import type { Contact } from "@ericsanchezok/synergy-sdk"

export function ContactsView(props: { onRefresh: () => void | Promise<void>; refreshing: boolean }) {
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const auth = useAuth()
  const [search, setSearch] = createSignal("")

  const contacts = createMemo(() => holos.state.social.contacts)
  const presence = createMemo(() => holos.state.social.presence)
  const onlineCount = createMemo(() => Object.values(presence() ?? {}).filter((value) => value === "online").length)

  const filteredContacts = createMemo(() => {
    const list = contacts() ?? []
    const q = search().toLowerCase().trim()
    if (!q) return list
    return list.filter((c) => c.name.toLowerCase().includes(q))
  })

  const handleRemoveContact = async (id: string) => {
    try {
      await globalSDK.client.holos.contact.remove({ id })
      showToast({ type: "info", title: "Contact removed" })
      await holos.refresh()
    } catch (e: any) {
      showToast({ type: "error", title: "Failed", description: e.message })
    }
  }

  async function handleNavigateToContact(_contact: Contact) {
    showToast({ type: "info", title: "Holos messaging", description: "Contact sessions are no longer supported." })
  }

  return (
    <Show
      when={!auth.isAuthenticated || auth.status !== "guest"}
      fallback={
        <AppPanel.Empty
          icon="users"
          title="Sign in to see contacts"
          description="Connect to Holos to manage contacts"
        />
      }
    >
      <AppPanel.Section
        label="Overview"
        actions={
          <AppPanel.Action
            icon="refresh-ccw"
            label={props.refreshing ? "Refreshing..." : "Refresh"}
            disabled={props.refreshing}
            onClick={() => void props.onRefresh()}
          />
        }
      >
        <AppPanel.CardList cols={2}>
          <AppPanel.Card title={String((contacts() ?? []).length)} subtitle="Contacts" />
          <AppPanel.Card title={String(onlineCount())} subtitle="Online" />
        </AppPanel.CardList>
      </AppPanel.Section>

      <FriendsSection
        contacts={filteredContacts()}
        loading={!holos.loaded}
        search={search()}
        onSearch={setSearch}
        onRemove={handleRemoveContact}
        onNavigate={handleNavigateToContact}
        presence={() => presence() ?? {}}
      />
    </Show>
  )
}
