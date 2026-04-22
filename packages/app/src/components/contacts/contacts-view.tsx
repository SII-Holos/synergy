import { createSignal, createMemo, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useAuth } from "@/context/auth"
import { usePanel } from "@/context/panel"
import { Panel } from "@/components/panel"
import { RequestsSection } from "./request-card"
import { FriendsSection } from "./contact-card"
import type { Contact } from "@ericsanchezok/synergy-sdk"

function SummaryMetric(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div class="rounded-2xl bg-surface-inset-base/55 px-3 py-3">
      <div class="text-10-medium uppercase tracking-[0.14em] text-text-subtle">{props.label}</div>
      <div class={`mt-1 text-18-semibold tabular-nums ${props.strong ? "text-text-strong" : "text-text-base"}`}>
        {props.value}
      </div>
    </div>
  )
}

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
    <section
      class="rounded-[26px] border border-border-base bg-background-base/88 p-4 shadow-[0_20px_50px_-36px_color-mix(in_srgb,var(--surface-brand-base)_40%,transparent)] backdrop-blur-xl"
      style={{ animation: "contactFadeUp 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-3 py-1 text-10-medium uppercase tracking-[0.14em] text-text-weak">
            <Icon name="user-plus" size="small" />
            New contact
          </div>
          <div class="mt-2 text-16-semibold text-text-strong">Add a Holos friend</div>
          <p class="mt-1 text-12-regular text-text-weak max-w-lg">
            Paste an agent ID to preview the profile and send a request without leaving this panel.
          </p>
        </div>
        <button
          type="button"
          class="flex items-center justify-center size-8 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-icon-base"
          onClick={handleClose}
        >
          <Icon name="x" size="small" />
        </button>
      </div>

      <div class="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <label class="flex flex-col gap-2 min-w-0">
          <span class="text-11-medium uppercase tracking-[0.14em] text-text-subtle">Agent ID</span>
          <div class="flex items-center gap-2 rounded-2xl bg-surface-inset-base/60 px-3 py-2 ring-1 ring-border-base/40 transition-shadow focus-within:ring-text-interactive-base/50">
            <Icon name="message-square" size="small" class="text-icon-weak shrink-0" />
            <input
              type="text"
              class="min-w-0 flex-1 bg-transparent text-13-regular text-text-base font-mono outline-none placeholder:text-text-weakest"
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
          </div>
        </label>

        <button
          type="button"
          class="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-surface-inset-base/70 px-4 text-12-medium text-text-base transition-colors hover:bg-surface-inset-base disabled:opacity-40"
          disabled={!agentId().trim() || lookupLoading()}
          onClick={handleLookup}
        >
          <Icon name="search" size="small" />
          {lookupLoading() ? "Searching..." : "Preview"}
        </button>
      </div>

      <Show when={preview()}>
        {(p) => (
          <div class="mt-4 rounded-[22px] border border-border-base/70 bg-surface-raised-stronger-non-alpha p-3.5">
            <div class="flex items-start gap-3">
              <Avatar
                fallback={p().name || "?"}
                size="small"
                class="size-10 rounded-2xl overflow-hidden ring-1 ring-border-base/60 shadow-sm"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <div class="truncate text-13-medium text-text-strong">{p().name}</div>
                  <span class="inline-flex items-center rounded-full bg-surface-inset-base/70 px-2.5 py-1 text-10-medium text-text-weak">
                    Ready to request
                  </span>
                </div>
                <Show when={p().bio}>
                  <div class="mt-2 text-12-regular text-text-weak leading-5">{p().bio}</div>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <div class="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/8 px-3 py-2.5 text-12-regular text-text-diff-delete-base">
          {error()}
        </div>
      </Show>

      <div class="mt-4 flex items-center justify-end gap-2 border-t border-border-base/60 pt-4">
        <button
          type="button"
          class="inline-flex items-center justify-center rounded-full bg-surface-inset-base/70 px-4 py-2 text-12-medium text-text-weak transition-colors hover:bg-surface-inset-base hover:text-text-base"
          onClick={handleClose}
        >
          Cancel
        </button>
        <button
          type="button"
          class="inline-flex items-center justify-center gap-2 rounded-full bg-surface-interactive-base px-4 py-2 text-12-medium text-text-on-interactive-base transition-colors hover:bg-surface-interactive-base-hover disabled:opacity-40"
          disabled={!agentId().trim() || loading()}
          onClick={handleSend}
        >
          <Icon name="user-plus" size="small" />
          {loading() ? "Sending..." : "Send Request"}
        </button>
      </div>
    </section>
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
  const onlineCount = createMemo(() => Object.values(presence() ?? {}).filter((value) => value === "online").length)

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
      <div class="flex flex-col gap-4 pb-2">
        <section class="rounded-[26px] border border-border-base bg-background-base/88 p-4 shadow-[0_20px_50px_-36px_color-mix(in_srgb,var(--surface-brand-base)_40%,transparent)] backdrop-blur-xl">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-3 py-1 text-10-medium uppercase tracking-[0.14em] text-text-weak">
                <Icon name="users" size="small" />
                Holos network
              </div>
              <div class="mt-2 text-16-semibold text-text-strong">Contacts</div>
              <p class="mt-1 text-12-regular text-text-weak max-w-lg">
                Keep your active Holos relationships, pending invites, and conversation shortcuts in one place.
              </p>
            </div>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-full border border-border-base bg-background-base/86 px-3 py-1.5 text-11-medium text-text-weak shadow-sm backdrop-blur-xl transition-all hover:bg-background-base hover:text-text-base active:scale-[0.98]"
              onClick={() => setShowAddFriend((v) => !v)}
            >
              <Icon name={showAddFriend() ? "x" : "user-plus"} size="small" />
              {showAddFriend() ? "Close" : "Add friend"}
            </button>
          </div>

          <div class="mt-4 grid grid-cols-3 gap-3">
            <SummaryMetric label="Contacts" value={String((contacts() ?? []).length)} strong />
            <SummaryMetric label="Online" value={String(onlineCount())} />
            <SummaryMetric label="Requests" value={String(totalRequestCount())} />
          </div>
        </section>

        <Show when={showAddFriend()}>
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
      </div>
    </Show>
  )
}
