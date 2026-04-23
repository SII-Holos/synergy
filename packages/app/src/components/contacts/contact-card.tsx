import { For, Show, createSignal } from "solid-js"
import type { Contact } from "@ericsanchezok/synergy-sdk"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { DropdownMenu } from "@ericsanchezok/synergy-ui/dropdown-menu"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Panel } from "@/components/panel"

const MAX_TURNS_PRESETS = [3, 5, 10, 20, 50] as const

function presenceLabel(status?: string) {
  if (status === "online") return "Online"
  if (status === "offline") return "Offline"
  return "Contact"
}

export function FriendsSection(props: {
  contacts: Contact[]
  loading: boolean
  search: string
  onSearch: (value: string) => void
  onRemove: (id: string) => void
  onNavigate: (contact: Contact) => void
  onUpdateConfig: (id: string, config: Partial<NonNullable<Contact["config"]>>) => void
  presence: () => Record<string, string>
  requestCount?: number
}) {
  return (
    <div class="mt-5 flex flex-col gap-3">
      <div class="flex items-center gap-2 px-1">
        <span class="text-12-medium text-text-weak">Friends</span>
        <Show when={props.contacts.length > 0}>
          <span class="inline-flex items-center justify-center rounded-full bg-surface-inset-base/70 px-2 py-0.5 text-10-medium text-text-base">
            {props.contacts.length}
          </span>
        </Show>
        <Show when={(props.requestCount ?? 0) > 0}>
          <span class="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-2.5 py-1 text-10-medium text-text-weak">
            <Icon name="user-plus" size="small" />
            {props.requestCount} request{props.requestCount === 1 ? "" : "s"}
          </span>
        </Show>
        <div class="flex-1" />
      </div>

      <Show when={props.contacts.length > 3 || props.search}>
        <div class="rounded-[1rem] bg-surface-raised-base/92 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
          <Panel.Search value={props.search} onInput={props.onSearch} placeholder="Search contacts..." />
        </div>
      </Show>

      <Show when={!props.loading} fallback={<Panel.Loading />}>
        <Show
          when={props.contacts.length > 0}
          fallback={
            <Panel.Empty
              icon="users"
              title={props.search ? "No contacts match" : "No contacts yet"}
              description={props.search ? undefined : "Contacts you add will appear here"}
            />
          }
        >
          <div class="grid grid-cols-2 gap-3">
            <For each={props.contacts}>
              {(contact, i) => (
                <ContactCard
                  contact={contact}
                  onRemove={() => props.onRemove(contact.id)}
                  onNavigate={() => props.onNavigate(contact)}
                  onUpdateConfig={(config) => props.onUpdateConfig(contact.id, config)}
                  delay={i() * 40}
                  presence={props.presence()}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function ContactCard(props: {
  contact: Contact
  onRemove: () => void
  onNavigate: () => void
  onUpdateConfig: (config: Partial<NonNullable<Contact["config"]>>) => void
  delay: number
  presence: Record<string, string>
}) {
  const status = () => props.presence[props.contact.holosId ?? ""]
  const isBlocked = () => props.contact.config?.blocked ?? false
  const autoReply = () => props.contact.config?.autoReply ?? false
  const autoInitiate = () => props.contact.config?.autoInitiate ?? false
  const maxAutoTurns = () => props.contact.config?.maxAutoTurns ?? 10

  const [menuOpen, setMenuOpen] = createSignal(false)

  return (
    <div
      class="group relative flex flex-col overflow-hidden rounded-[1.15rem] bg-surface-raised-base/92 p-4 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04),0_14px_30px_-24px_color-mix(in_srgb,var(--surface-brand-base)_18%,transparent)] transition-all duration-200 break-inside-avoid cursor-pointer hover:-translate-y-0.5 hover:bg-surface-raised-base hover:shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04),0_18px_36px_-22px_color-mix(in_srgb,var(--surface-brand-base)_24%,transparent)] active:scale-[0.995]"
      style={{
        animation: "contactFadeUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) backwards",
        "animation-delay": `${props.delay}ms`,
      }}
      role="button"
      tabindex="0"
      onClick={() => {
        if (!menuOpen()) props.onNavigate()
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !menuOpen()) {
          e.preventDefault()
          props.onNavigate()
        }
      }}
    >
      <div class="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-surface-brand-base/8 to-transparent" />

      <div class="relative flex items-start gap-3">
        <div class="relative shrink-0">
          <Avatar
            fallback={props.contact.name || "?"}
            size="small"
            class="size-10 rounded-2xl overflow-hidden ring-1 ring-border-base/60 shadow-sm"
          />
          <Show when={status() === "online" || status() === "offline"}>
            <div
              class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background-base"
              classList={{
                "bg-icon-success-base": status() === "online",
                "bg-border-strong": status() === "offline",
              }}
            />
          </Show>
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate text-13-medium text-text-strong">{props.contact.name}</div>
              <div class="mt-1 flex flex-wrap items-center gap-1.5">
                <span
                  class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-10-medium"
                  classList={{
                    "bg-emerald-500/12 text-icon-success-base": status() === "online",
                    "bg-surface-inset-base/70 text-text-weak ring-1 ring-inset ring-border-base/45":
                      status() !== "online",
                  }}
                >
                  <span
                    class="size-1.5 rounded-full"
                    classList={{
                      "bg-icon-success-base": status() === "online",
                      "bg-text-subtle": status() !== "online",
                    }}
                  />
                  {presenceLabel(status())}
                </span>
                <Show when={props.contact.holosId}>
                  <span class="inline-flex max-w-full items-center rounded-full bg-surface-inset-base/70 px-2.5 py-1 font-mono text-[10px] text-text-subtle ring-1 ring-inset ring-border-base/45">
                    {(props.contact.holosId ?? "").slice(0, 8)}…
                  </span>
                </Show>
              </div>
            </div>

            <DropdownMenu onOpenChange={setMenuOpen}>
              <DropdownMenu.Trigger
                class="flex items-center justify-center size-8 rounded-full border border-border-base/70 bg-surface-raised-stronger-non-alpha text-icon-weak shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-icon-base"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                <Icon name="ellipsis" size="small" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="min-w-48" onClick={(e: MouseEvent) => e.stopPropagation()}>
                  <DropdownMenu.Item onSelect={props.onNavigate}>
                    <Icon name="message-circle" size="small" class="mr-2" />
                    <DropdownMenu.ItemLabel>Open chat</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <Show when={props.contact.holosId}>
                    <DropdownMenu.Item
                      onSelect={() => {
                        navigator.clipboard.writeText(props.contact.holosId ?? "")
                        showToast({ title: "ID copied" })
                      }}
                    >
                      <Icon name="copy" size="small" class="mr-2" />
                      <DropdownMenu.ItemLabel>Copy ID</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </Show>

                  <DropdownMenu.Separator />

                  <DropdownMenu.Group>
                    <DropdownMenu.GroupLabel>Settings</DropdownMenu.GroupLabel>
                    <ConfigCheckbox
                      checked={autoReply()}
                      onChange={(v) => props.onUpdateConfig({ autoReply: v })}
                      label="Auto Reply"
                    />
                    <ConfigCheckbox
                      checked={autoInitiate()}
                      onChange={(v) => props.onUpdateConfig({ autoInitiate: v })}
                      label="Auto-initiate"
                    />
                    <ConfigCheckbox
                      checked={isBlocked()}
                      onChange={(v) => props.onUpdateConfig({ blocked: v })}
                      label="Blocked"
                      danger
                    />

                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger>
                        <Icon name="repeat" size="small" class="mr-2" />
                        <span class="flex-1">
                          Max turns
                          <span class="ml-1.5 text-text-weakest">{maxAutoTurns()}</span>
                        </span>
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent>
                          <DropdownMenu.RadioGroup
                            value={String(maxAutoTurns())}
                            onChange={(v) => props.onUpdateConfig({ maxAutoTurns: Number(v) })}
                          >
                            <For each={[...MAX_TURNS_PRESETS]}>
                              {(n) => (
                                <DropdownMenu.RadioItem value={String(n)}>
                                  <DropdownMenu.ItemIndicator forceMount>
                                    <div class="size-3.5 mr-1.5 flex items-center justify-center">
                                      <Show when={maxAutoTurns() === n}>
                                        <Icon name="check" size="small" />
                                      </Show>
                                    </div>
                                  </DropdownMenu.ItemIndicator>
                                  <DropdownMenu.ItemLabel>{n} turns</DropdownMenu.ItemLabel>
                                </DropdownMenu.RadioItem>
                              )}
                            </For>
                          </DropdownMenu.RadioGroup>
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                  </DropdownMenu.Group>

                  <DropdownMenu.Separator />

                  <DropdownMenu.Item
                    danger
                    onSelect={() => {
                      if (confirm(`Remove ${props.contact.name} from contacts?`)) props.onRemove()
                    }}
                  >
                    <Icon name="trash-2" size="small" class="mr-2" />
                    <DropdownMenu.ItemLabel>Remove contact</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </div>

          <div class="mt-3 rounded-2xl bg-surface-inset-base/55 px-3 py-2.5 min-h-[4.5rem]">
            <div class="text-11-regular text-text-weak leading-5 line-clamp-3">
              {props.contact.bio || <span class="italic text-text-subtle">No bio added yet</span>}
            </div>
          </div>

          <div class="mt-3 flex flex-wrap gap-1.5">
            <Show when={autoReply()}>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-inset-base/70 px-2.5 py-1 text-10-medium text-text-base">
                <Icon name="message-circle" size="small" />
                Auto reply
              </span>
            </Show>
            <Show when={autoInitiate()}>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-inset-base/70 px-2.5 py-1 text-10-medium text-text-base">
                <Icon name="sparkles" size="small" />
                Auto-initiate
              </span>
            </Show>
            <Show when={isBlocked()}>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-rose-500/9 px-2.5 py-1 text-10-medium text-icon-critical-base ring-1 ring-inset ring-rose-400/15">
                <Icon name="x" size="small" />
                Blocked
              </span>
            </Show>
            <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-raised-stronger-non-alpha px-2.5 py-1 text-10-medium text-text-weak">
              <Icon name="repeat" size="small" />
              {maxAutoTurns()} turns
            </span>
          </div>
        </div>
      </div>

      <div class="relative mt-4 flex items-center justify-between gap-2 border-t border-border-base/60 pt-3 text-11-medium">
        <span class="inline-flex items-center gap-1.5 text-text-weak transition-colors group-hover:text-text-base">
          <Icon name="message-circle" size="small" />
          Open conversation
        </span>
        <span class="inline-flex items-center justify-center size-7 rounded-full bg-surface-inset-base/70 text-icon-weak ring-1 ring-inset ring-border-base/45 transition-all group-hover:bg-surface-raised-base-hover group-hover:text-icon-base">
          <Icon name="chevron-right" size="small" />
        </span>
      </div>
    </div>
  )
}

function ConfigCheckbox(props: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  danger?: boolean
}) {
  return (
    <DropdownMenu.CheckboxItem checked={props.checked} onChange={props.onChange}>
      <DropdownMenu.ItemIndicator forceMount>
        <div class="size-3.5 mr-1.5 flex items-center justify-center">
          <Show when={props.checked}>
            <Icon name="check" size="small" class={props.danger ? "text-icon-critical-base" : undefined} />
          </Show>
        </div>
      </DropdownMenu.ItemIndicator>
      <DropdownMenu.ItemLabel class={props.danger ? "text-icon-critical-base" : undefined}>
        {props.label}
      </DropdownMenu.ItemLabel>
    </DropdownMenu.CheckboxItem>
  )
}
