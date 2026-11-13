import { createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import type { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { organizationMemberMessages as messages } from "./member-messages"
import { organizationWorkspaceMessages as workspace } from "./workspace-messages"
import "./account.css"
import { OrganizationApiTokens, organizationApiTokenMessages } from "./api-tokens"
import { OrganizationAccountDevices } from "./account-devices"
import { organizationDeviceMessages } from "./account-device-messages"

const invitationStates = {
  open: messages.invitationOpen,
  consumed: messages.invitationConsumed,
  revoked: messages.invitationRevoked,
  expired: messages.invitationExpired,
  invalidated: messages.invitationInvalidated,
}

export function OrganizationAccount() {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const confirm = useConfirm()
  const view = space.current()!
  const api = space.client()!
  const account = space.connection()!.account
  const options = { throwOnError: true, signal: view.signal } as const
  const [state, setState] = createStore({ invitations: [] as Identity.Invite[] })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [tokensOpened, setTokensOpened] = createSignal(false)
  const [devicesOpened, setDevicesOpened] = createSignal(false)
  const current = () => !view.signal.aborted
  async function load(more = false) {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgInvites.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
      if (!current()) return
      setState("invitations", reconcile(more ? [...state.invitations, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
    } catch (error) {
      if (current()) setError(error)
    } finally {
      if (current()) setLoading(false)
    }
  }
  function revoke(invite: Identity.Invite) {
    confirm.show({
      title: messages.revoke,
      description: messages.revokeHint,
      confirmLabel: messages.revoke,
      tone: "warning",
      async onConfirm() {
        if (busy()) return
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.orgInvites.revoke(
            { inviteID: invite.inviteID, orgInviteRevoke: { expectedRevision: invite.revision } },
            options,
          )
          if (current()) setState("invitations", (item) => item.inviteID === invite.inviteID, reconcile(result.data))
        } catch (error) {
          if (current()) setError(error)
        } finally {
          if (current()) setBusy(false)
        }
      },
    })
  }
  function leave() {
    confirm.show({
      title: messages.leave,
      description: messages.leaveHint,
      confirmLabel: messages.leave,
      tone: "warning",
      async onConfirm() {
        if (busy()) return
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.orgAuth.session(options)
          if (!current()) return
          if (result.data.account.accountID !== account.accountID || result.data.account.orgID !== account.orgID)
            throw { code: "PERMISSION_DENIED" }
          await api.orgOrganization.leave({ orgLeave: { expectedRevision: result.data.account.revision } }, options)
          if (!current()) return
          try {
            await space.signOut(view.key)
          } finally {
            space.personal()
          }
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
      ...messages.expires,
      values: {
        date: new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(time),
      },
    })
  onMount(() => void load())
  return (
    <section class="organization-account-view">
      <div class="organization-page-heading">
        <div>
          <h2>{_(messages.account)}</h2>
          <p>
            {account.displayName} · {account.loginName}
          </p>
        </div>
      </div>
      <WorkspaceError error={error()} retry={() => void load()} />
      <section class="organization-editor">
        <h3>{_(messages.invitations)}</h3>
        <p>{_(messages.invitationsHint)}</p>
        <Show when={loading()}>
          <p role="status">{_(workspace.loading)}</p>
        </Show>
        <Show when={!loading() && !state.invitations.length}>
          <p>{_(messages.invitationsEmpty)}</p>
        </Show>
        <ul class="organization-member-list">
          <For each={state.invitations}>
            {(invite) => (
              <li>
                <div class="organization-member-identity">
                  <strong>{_(invite.role === "admin" ? workspace.admin : workspace.member)}</strong>
                  <span>{expiry(invite.expiresAt)}</span>
                  <span>{_({ ...messages.invitationIdentity, values: { id: invite.inviteID } })}</span>
                  <Show when={invite.createdBy !== account.accountID}>
                    <span>{_({ ...messages.issuedBy, values: { id: invite.createdBy } })}</span>
                  </Show>
                </div>
                <span role="status">{_(invitationStates[invite.state])}</span>
                <Show when={invite.state !== "consumed" && invite.state !== "revoked"}>
                  <Button variant="ghost" disabled={busy()} onClick={() => revoke(invite)}>
                    {_(messages.revoke)}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={cursor()}>
          <Button disabled={loading()} onClick={() => void load(true)}>
            {_(workspace.more)}
          </Button>
        </Show>
      </section>
      <details class="organization-device-disclosure" onToggle={(event) => setDevicesOpened(event.currentTarget.open)}>
        <summary>
          <h3>{_(organizationDeviceMessages.title)}</h3>
        </summary>
        <Show when={devicesOpened()}>
          <OrganizationAccountDevices />
        </Show>
      </details>
      <details
        class="organization-api-token-disclosure"
        onToggle={(event) => {
          if (event.currentTarget.open) setTokensOpened(true)
        }}
      >
        <summary>
          <h3>{_(organizationApiTokenMessages.title)}</h3>
        </summary>
        <Show when={tokensOpened()}>
          <OrganizationApiTokens />
        </Show>
      </details>
      <section class="organization-editor">
        <h3>{_(messages.membership)}</h3>
        <p>{_(messages.leaveHint)}</p>
        <Button variant="ghost" disabled={busy()} onClick={leave}>
          {_(messages.leave)}
        </Button>
      </section>
    </section>
  )
}
