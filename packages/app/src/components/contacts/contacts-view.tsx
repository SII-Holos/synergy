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
import { FriendsSection } from "./contact-card"
import type { Contact } from "@ericsanchezok/synergy-sdk"

function SummaryMetric(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div class="rounded-[1rem] bg-surface-raised-base/92 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">{props.label}</div>
      <div
        class={`mt-1 text-16-semibold tabular-nums tracking-tight ${props.strong ? "text-text-strong" : "text-text-base"}`}
      >
        {props.value}
      </div>
    </div>
  )
}

export function ContactsView(props: { onRefresh: () => void | Promise<void>; refreshing: boolean }) {
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const auth = useAuth()
  const navigate = useNavigate()
  const panel = usePanel()

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
        <Panel.Empty icon="users" title="Sign in to see contacts" description="Connect to Holos to manage contacts" />
      }
    >
      <div class="flex flex-col gap-4 pb-2">
        <section class="rounded-[1.15rem] bg-surface-inset-base/42 p-3 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
          <div class="rounded-[1rem] bg-surface-raised-base/92 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="inline-flex items-center gap-1.5 rounded-full border border-border-base/60 bg-surface-raised-stronger-non-alpha px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">
                  <Icon name="users" size="small" />
                  Holos network
                </div>
                <div class="mt-3 text-14-semibold tracking-tight text-text-strong">Contacts</div>
                <p class="mt-1.5 max-w-xl text-12-regular leading-5 text-text-weak">
                  Keep your active Holos relationships, pending invites, and conversation shortcuts in one place.
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2 self-start">
                <button
                  type="button"
                  class="inline-flex size-8 items-center justify-center rounded-full border border-border-base/60 bg-surface-raised-stronger-non-alpha text-text-weak transition-all hover:bg-surface-raised-base-hover hover:text-text-base active:scale-[0.98] disabled:opacity-60"
                  disabled={props.refreshing}
                  onClick={() => void props.onRefresh()}
                  title={props.refreshing ? "Refreshing contacts" : "Refresh contacts"}
                >
                  <Icon name="refresh-ccw" size="small" />
                </button>
              </div>
            </div>

            <div class="mt-4 grid grid-cols-2 gap-3">
              <SummaryMetric label="Contacts" value={String((contacts() ?? []).length)} strong />
              <SummaryMetric label="Online" value={String(onlineCount())} />
            </div>
          </div>
        </section>

        <FriendsSection
          contacts={filteredContacts()}
          loading={!holos.loaded}
          search={search()}
          onSearch={setSearch}
          onRemove={handleRemoveContact}
          onNavigate={handleNavigateToContact}
          presence={() => presence() ?? {}}
        />
      </div>
    </Show>
  )
}
