import { createSignal, createMemo, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useAuth } from "@/context/auth"
import { usePanel } from "@/context/panel"
import { Panel } from "@/components/panel"
import { RequestsSection } from "./request-card"
import { FriendsSection } from "./contact-card"
import type { Contact } from "@ericsanchezok/synergy-sdk"

function AddFriendForm(props: { onClose: () => void; onSent: () => void; existingPeerIds: Set<string> }) {
  const globalSDK = useGlobalSDK()
  const [agentId, setAgentId] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [preview, setPreview] = createSignal<{ name: string; bio?: string } | null>(null)
  const [error, setError] = createSignal("")
  const [lookupLoading, setLookupLoading] = createSignal(false)

  function resetForm() {
    setAgentId("")
    setPreview(null)
    setError("")
  }

  function handleClose() {
    resetForm()
    props.onClose()
  }

  async function handleLookup() {
    const id = agentId().trim()
    if (!id) return
    setLookupLoading(true)
    setError("")
    setPreview(null)
    try {
      const res = await globalSDK.client.holos.agents.get({ agentId: id })
      const agent = res.data?.data
      if (agent) {
        const profile = agent.profile as Record<string, string> | undefined
        setPreview({
          name: profile?.name || agent.owner_name,
          bio: profile?.bio,
        })
      }
    } catch {
      setError("Agent not found — you can still send a request")
    } finally {
      setLookupLoading(false)
    }
  }

  async function handleSend() {
    const id = agentId().trim()
    if (!id) return
    if (props.existingPeerIds.has(id)) {
      setError("You already have a pending request to this agent")
      return
    }
    setLoading(true)
    setError("")
    try {
      const peerName = preview()?.name
      const peerBio = preview()?.bio
      const result = await globalSDK.client.holos.friendRequest.send({
        peerId: id,
        ...(peerName ? { peerName } : {}),
        ...(peerBio ? { peerBio } : {}),
      })
      showToast({
        title: result.data?.queued ? "Request queued" : "Friend request sent",
        description: result.data?.queued
          ? "The agent appears to be offline. Request will be delivered when they come online."
          : undefined,
      })
      resetForm()
      props.onSent()
      props.onClose()
    } catch (e: any) {
      setError(e.message || "Failed to send request")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      class="rounded-xl bg-surface-base ring-1 ring-border-base/30 shadow-sm p-4 flex flex-col gap-3"
      style={{ animation: "contactFadeUp 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
    >
      <div class="flex items-center justify-between">
        <span class="text-14-semibold text-text-strong">Add Friend</span>
        <button
          type="button"
          class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
          onClick={handleClose}
        >
          <Icon name="x" size="small" />
        </button>
      </div>

      <div class="flex items-center gap-2">
        <input
          type="text"
          class="flex-1 px-3 py-1.5 rounded-lg bg-surface-inset-base text-13-regular text-text-base font-mono outline-none ring-1 ring-border-base/40 focus:ring-text-interactive-base/50 transition-shadow placeholder:text-text-weakest"
          placeholder="Enter agent ID"
          value={agentId()}
          onInput={(e) => {
            setAgentId(e.currentTarget.value)
            setPreview(null)
            setError("")
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleLookup()
          }}
        />
        <button
          type="button"
          class="px-3 py-1.5 rounded-lg text-12-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors disabled:opacity-40"
          disabled={!agentId().trim() || lookupLoading()}
          onClick={handleLookup}
        >
          {lookupLoading() ? "..." : "Search"}
        </button>
      </div>

      <Show when={preview()}>
        {(p) => (
          <div class="px-3 py-2 rounded-lg bg-surface-raised-base">
            <div class="text-13-medium text-text-base">{p().name}</div>
            <Show when={p().bio}>
              <div class="text-12-regular text-text-weak mt-0.5">{p().bio}</div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <div class="text-12-regular text-text-diff-delete-base">{error()}</div>
      </Show>

      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          class="px-3 py-1.5 rounded-lg text-12-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
          onClick={handleClose}
        >
          Cancel
        </button>
        <button
          type="button"
          class="px-3 py-1.5 rounded-lg bg-surface-interactive-base text-text-on-interactive-base text-12-medium hover:bg-surface-interactive-base-hover transition-colors disabled:opacity-40"
          disabled={!agentId().trim() || loading()}
          onClick={handleSend}
        >
          {loading() ? "Sending..." : "Send Request"}
        </button>
      </div>
    </div>
  )
}

export function ContactsView() {
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const auth = useAuth()
  const navigate = useNavigate()
  const panel = usePanel()

  const [search, setSearch] = createSignal("")
  const [showAddFriend, setShowAddFriend] = createSignal(false)
  const [requestLoadingIds, setRequestLoadingIds] = createSignal<Set<string>>(new Set())

  const contacts = createMemo(() => holos.state.social.contacts)
  const requests = createMemo(() => holos.state.social.friendRequests)
  const presence = createMemo(() => holos.state.social.presence)

  const pendingIncoming = createMemo(() =>
    (requests() ?? []).filter((r) => r.direction === "incoming" && r.status === "pending"),
  )
  const outgoingRequests = createMemo(() => (requests() ?? []).filter((r) => r.direction === "outgoing"))
  const totalRequestCount = createMemo(() => pendingIncoming().length + outgoingRequests().length)

  const filteredContacts = createMemo(() => {
    const list = contacts() ?? []
    const q = search().toLowerCase().trim()
    if (!q) return list
    return list.filter((c) => c.name.toLowerCase().includes(q) || c.bio?.toLowerCase().includes(q))
  })

  const handleRespond = async (id: string, status: "accepted" | "rejected") => {
    setRequestLoadingIds((prev) => new Set([...prev, id]))
    try {
      await globalSDK.client.holos.friendRequest.respond({ id, status })
      showToast({ title: status === "accepted" ? "Friend request accepted" : "Friend request rejected" })
      await holos.refresh()
    } catch (e: any) {
      showToast({ title: "Failed", description: e.message })
    } finally {
      setRequestLoadingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleCancelRequest = async (id: string) => {
    setRequestLoadingIds((prev) => new Set([...prev, id]))
    try {
      await globalSDK.client.holos.friendRequest.remove({ id })
      showToast({ title: "Request cancelled" })
      await holos.refresh()
    } catch (e: any) {
      showToast({ title: "Failed", description: e.message })
    } finally {
      setRequestLoadingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleRemoveContact = async (id: string) => {
    try {
      await globalSDK.client.holos.contact.remove({ id })
      showToast({ title: "Contact removed" })
      await holos.refresh()
    } catch (e: any) {
      showToast({ title: "Failed", description: e.message })
    }
  }

  const handleUpdateConfig = async (id: string, config: Partial<NonNullable<Contact["config"]>>) => {
    try {
      await globalSDK.client.holos.contact.updateConfig({ id, ...config })
      await holos.refresh()
    } catch (e: any) {
      showToast({ title: "Failed to update config", description: e.message })
    }
  }

  async function handleNavigateToContact(contact: Contact) {
    try {
      const res = await globalSDK.client.holos.contact.session({ id: contact.id })
      const { sessionID, directory } = res.data!
      navigate(`/${base64Encode(directory)}/session/${sessionID}`)
      panel.close()
    } catch (e: any) {
      showToast({ title: "Failed to open conversation", description: e?.message || String(e) })
    }
  }

  return (
    <Show
      when={!auth.isAuthenticated || auth.status !== "guest"}
      fallback={
        <Panel.Empty icon="users" title="Sign in to see contacts" description="Connect to Holos to manage contacts" />
      }
    >
      <Show when={showAddFriend()}>
        <div class="mb-4">
          <AddFriendForm
            onClose={() => setShowAddFriend(false)}
            onSent={() => void holos.refresh()}
            existingPeerIds={
              new Set(
                outgoingRequests()
                  .filter((r) => r.status === "pending" || r.status === "pending_delivery")
                  .map((r) => r.peerId),
              )
            }
          />
        </div>
      </Show>

      <Show when={totalRequestCount() > 0}>
        <RequestsSection
          requests={pendingIncoming()}
          outgoing={outgoingRequests()}
          onRespond={handleRespond}
          onCancel={handleCancelRequest}
          loadingIds={requestLoadingIds()}
        />
      </Show>

      <FriendsSection
        contacts={filteredContacts()}
        loading={!holos.loaded}
        search={search()}
        onSearch={setSearch}
        onRemove={handleRemoveContact}
        onNavigate={handleNavigateToContact}
        onUpdateConfig={handleUpdateConfig}
        presence={() => presence() ?? {}}
        onAddFriend={() => setShowAddFriend((v) => !v)}
        requestCount={totalRequestCount()}
      />
    </Show>
  )
}
