import { createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import type { OrgAccount } from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { organizationWorkspaceMessages as messages } from "./workspace-messages"
import { organizationMemberMessages as memberMessages } from "./member-messages"

export function OrganizationMembers() {
  const space = useSpace()
  const { _, i18n } = useLingui()
  const confirm = useConfirm()
  const view = space.current()!
  const api = space.client()!
  const options = { throwOnError: true, signal: view.signal } as const
  const [state, setState] = createStore({ accounts: [] as OrgAccount[] })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [inviting, setInviting] = createSignal(false)
  const [role, setRole] = createSignal<"admin" | "member">("member")
  const [invite, setInvite] = createSignal<string>()
  const [inviteExpiry, setInviteExpiry] = createSignal<number>()
  const [reset, setReset] = createSignal<{ name: string; url: string; expiresAt: number }>()
  const current = () => !view.signal.aborted
  async function load(more = false) {
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgAccounts.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
      if (!current()) return
      setState("accounts", reconcile(more ? [...state.accounts, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
    } catch (error) {
      if (current()) setError(error)
    } finally {
      if (current()) setLoading(false)
    }
  }
  async function change(account: OrgAccount, change: { role?: "admin" | "member"; state?: "removed" }) {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgAccounts.update(
        { accountID: account.accountID, orgAccountChange: { expectedRevision: account.revision, ...change } },
        options,
      )
      if (current()) setState("accounts", (entry) => entry.accountID === account.accountID, reconcile(result.data))
    } catch (error) {
      if (current()) setError(error)
    } finally {
      if (current()) setBusy(false)
    }
  }
  function remove(account: OrgAccount) {
    confirm.show({
      title: messages.removeMember,
      description: messages.removeHint,
      confirmLabel: messages.removeMember,
      tone: "warning",
      onConfirm: () => change(account, { state: "removed" }),
    })
  }
  function transfer(account: OrgAccount) {
    if (space.connection()?.account.role !== "owner") return
    confirm.show({
      title: messages.transferOwner,
      description: messages.transferHint,
      confirmLabel: messages.transferOwner,
      tone: "warning",
      async onConfirm() {
        setBusy(true)
        setError(undefined)
        try {
          const organization = await api.orgOrganization.get(options)
          if (!current()) return
          await api.orgOrganization.transferOwner(
            {
              orgTransferOwner: {
                accountID: account.accountID,
                expectedRevision: organization.data.revision,
                targetRevision: account.revision,
              },
            },
            options,
          )
          if (current()) await load()
        } catch (error) {
          if (current()) setError(error)
        } finally {
          if (current()) setBusy(false)
        }
      },
    })
  }
  async function createInvite() {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgInvites.create({ orgInviteCreate: { role: role() } }, options)
      if (!current()) return
      const url = new URL("/organization.html", space.connection()!.issuer)
      url.hash = `invite=${encodeURIComponent(result.data.token)}`
      setInvite(url.href)
      setInviteExpiry(result.data.expiresAt)
    } catch (error) {
      if (current()) setError(error)
    } finally {
      if (current()) setBusy(false)
    }
  }
  function createReset(account: OrgAccount) {
    confirm.show({
      title: memberMessages.resetTitle,
      description: memberMessages.resetHint,
      confirmLabel: memberMessages.createReset,
      tone: "warning",
      async onConfirm() {
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.orgAccounts.reset(
            { accountID: account.accountID, orgResetCreate: { expectedRevision: account.revision } },
            options,
          )
          if (!current()) return
          const url = new URL("/organization.html", space.connection()!.issuer)
          url.hash = `reset=${encodeURIComponent(result.data.token)}`
          setReset({ name: account.displayName, url: url.href, expiresAt: result.data.expiresAt })
        } catch (error) {
          if (current()) setError(error)
        } finally {
          if (current()) setBusy(false)
        }
      },
    })
  }
  const expiry = (time: number) =>
    _({
      ...memberMessages.expires,
      values: {
        date: new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(time),
      },
    })
  onMount(() => void load())
  return (
    <section class="organization-members-view">
      <div class="organization-page-heading">
        <h2>{_(messages.members)}</h2>
        <Button
          size="large"
          variant="primary"
          onClick={() => {
            setInviting(true)
            setInvite(undefined)
          }}
        >
          {_(messages.invite)}
        </Button>
      </div>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={reset()}>
        {(link) => (
          <section class="organization-editor">
            <h3>{_({ ...memberMessages.resetFor, values: { name: link().name } })}</h3>
            <TextField label={_(memberMessages.resetLink)} value={link().url} readOnly copyable />
            <p>{_(memberMessages.sharePrivately)}</p>
            <p>{expiry(link().expiresAt)}</p>
            <Button onClick={() => setReset(undefined)}>{_(memberMessages.done)}</Button>
          </section>
        )}
      </Show>
      <Show when={inviting()}>
        <div class="organization-editor">
          <Show
            when={invite()}
            fallback={
              <>
                <label>{_(messages.inviteRole)}</label>
                <MenuField
                  ariaLabel={_(messages.inviteRole)}
                  value={role()}
                  onChange={setRole}
                  options={[
                    { value: "member", label: _(messages.member) },
                    { value: "admin", label: _(messages.admin) },
                  ]}
                />
                <div class="organization-actions">
                  <Button size="large" variant="primary" disabled={busy()} onClick={() => void createInvite()}>
                    {_(messages.invite)}
                  </Button>
                  <Button size="large" variant="ghost" onClick={() => setInviting(false)}>
                    {_(messages.cancel)}
                  </Button>
                </div>
              </>
            }
          >
            {(url) => (
              <>
                <TextField label={_(messages.inviteLink)} value={url()} readOnly copyable />
                <p>{_(messages.inviteHint)}</p>
                <Show when={inviteExpiry()}>{(time) => <p>{expiry(time())}</p>}</Show>
                <Button
                  onClick={() => {
                    setInvite(undefined)
                    setInviting(false)
                  }}
                >
                  {_(messages.cancel)}
                </Button>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={loading()}>
        <p role="status">{_(messages.loading)}</p>
      </Show>
      <ul class="organization-member-list">
        <For each={state.accounts}>
          {(account) => (
            <li>
              <span class="organization-member-avatar" aria-hidden="true">
                {Array.from(account.displayName)[0]}
              </span>
              <div class="organization-member-identity">
                <strong>{account.displayName}</strong>
                <span>{account.loginName}</span>
              </div>
              <Show when={account.state === "active"} fallback={<span>{_(messages.removed)}</span>}>
                <Show when={account.role !== "owner" || space.connection()?.account.role === "owner"}>
                  <Button variant="ghost" disabled={busy()} onClick={() => createReset(account)}>
                    {_(memberMessages.reset)}
                  </Button>
                </Show>
                <Show when={account.role !== "owner"} fallback={<span>{_(messages.owner)}</span>}>
                  <MenuField
                    ariaLabel={`${_(messages.role)}: ${account.displayName}`}
                    value={account.role as "admin" | "member"}
                    disabled={busy()}
                    closeOnChange={false}
                    onChange={(role) => void change(account, { role })}
                    options={[
                      { value: "member", label: _(messages.member) },
                      { value: "admin", label: _(messages.admin) },
                    ]}
                  />
                  <Button variant="ghost" disabled={busy()} onClick={() => remove(account)}>
                    {_(messages.removeMember)}
                  </Button>
                  <Show when={space.connection()?.account.role === "owner"}>
                    <Button variant="ghost" disabled={busy()} onClick={() => transfer(account)}>
                      {_(messages.transferOwner)}
                    </Button>
                  </Show>
                </Show>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={cursor()}>
        <Button disabled={loading()} onClick={() => void load(true)}>
          {_(messages.more)}
        </Button>
      </Show>
    </section>
  )
}
