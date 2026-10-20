import { useLingui } from "@lingui/solid"
import type { ProviderConnection } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { providerNeedsAction } from "@/components/provider/provider-auth-presentation"
import type { ProviderSetupDrafts } from "@/components/provider/provider-setup-drafts"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { createProviderAccountCommand, saveProviderAccount } from "./provider-account-operations"
import type { ProviderConnectionSummary } from "./ProvidersPanel"

export function ProviderAccountEditor(props: {
  connection: ProviderConnectionSummary
  allowEndpoint: boolean
  drafts: ProviderSetupDrafts
  onSaved: () => Promise<void>
  onCancel: () => void
  registerCloseGuard: (guard: (() => Promise<boolean>) | undefined) => void
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm({ class: "settings-control-scope" })

  return (
    <Show keyed when={props.connection.id}>
      {(providerID) => {
        const editKey = `edit:${providerID}`
        const credentialsKey = `existing:${providerID}`
        const serviceName = () =>
          props.connection.profile?.displayName ?? props.connection.profile?.name ?? props.connection.profileID
        function toAccountFields(connection: ProviderConnection) {
          return {
            name:
              connection.name === serviceName() || connection.name === props.connection.profile?.name
                ? ""
                : connection.name,
            endpoint: connection.endpoint ?? "",
            enabled: connection.enabled,
          }
        }
        const draft = props.drafts.get(editKey, toAccountFields(props.connection))
        const baseline = () => draft.baseline!
        const credentialsDraft = () => props.drafts.peek(credentialsKey)
        const needsCredentials = () => !props.connection.connected || providerNeedsAction(props.connection.health)
        const [authEditing, setAuthEditing] = createSignal(needsCredentials() || Boolean(credentialsDraft()))
        const busy = () => Boolean(draft.pending)
        const [confirming, setConfirming] = createSignal(false)
        const [error, setError] = createSignal<string>()
        const persisted = () => Boolean(draft.savedConnection)
        const locked = () => busy() || confirming() || persisted()
        const hasAccountChanges = () => props.drafts.dirty(editKey)
        const hasCredentialChanges = () => props.drafts.dirty(credentialsKey)
        const serverURL = globalSDK.url
        let alive = true
        let registered = false
        let closeApproved = false
        const active = () => alive && globalSDK.url === serverURL && props.connection.id === providerID
        const ownsDraft = () => globalSDK.url === serverURL && props.drafts.peek(editKey) === draft

        createEffect(
          on(
            [() => props.connection.connected, () => props.connection.health?.status],
            () => {
              if (needsCredentials()) setAuthEditing(true)
            },
            { defer: true },
          ),
        )

        async function confirmDiscard(hasChanges: boolean) {
          if (!active() || busy() || confirming()) return false
          if (!hasChanges) return true
          setConfirming(true)
          try {
            const discard = await confirm.ask({
              title: { id: "confirm.discardSettings.title", message: "Discard unsaved changes?" },
              description: {
                id: "settings.providers.account.discard.description",
                message: "Your account changes have not been saved.",
              },
              confirmLabel: { id: "confirm.discardSettings.confirm", message: "Discard" },
              cancelLabel: { id: "settings.providers.account.keepEditing", message: "Keep editing" },
              tone: "warning",
            })
            return active() && discard
          } finally {
            if (active()) setConfirming(false)
          }
        }

        async function closeGuard() {
          if (!active()) return false
          if (closeApproved) return true
          if (!(await confirmDiscard((!persisted() && hasAccountChanges()) || hasCredentialChanges()))) return false
          if (!active()) return false
          closeApproved = true
          setAuthEditing(false)
          props.drafts.remove(editKey)
          props.drafts.remove(credentialsKey)
          return true
        }

        onMount(() => {
          props.registerCloseGuard(closeGuard)
          registered = true
        })
        onCleanup(() => {
          alive = false
          if (registered) props.registerCloseGuard(undefined)
        })

        async function cancelCredentials() {
          if (!(await confirmDiscard(hasCredentialChanges())) || !active()) return
          setAuthEditing(false)
          props.drafts.remove(credentialsKey)
        }

        function createSaveCommand() {
          return createProviderAccountCommand(
            async () => {
              if (draft.savedConnection) return draft.savedConnection
              const connection = await saveProviderAccount(globalSDK.client.provider.connection, {
                mode: "update",
                providerID,
                ...(draft.name !== baseline().name ? { name: draft.name.trim() || serviceName() } : {}),
                ...(draft.endpoint !== baseline().endpoint ? { endpoint: draft.endpoint.trim() || null } : {}),
                ...(draft.enabled !== baseline().enabled ? { enabled: draft.enabled } : {}),
              })
              if (ownsDraft()) props.drafts.update(editKey, { savedConnection: connection })
              return connection
            },
            async () => {
              if (active()) await props.onSaved()
            },
          )
        }
        let command = createSaveCommand()

        async function submit(event: SubmitEvent) {
          event.preventDefault()
          if (!active() || closeApproved || busy() || confirming()) return
          if (!persisted() && !hasAccountChanges()) return
          props.drafts.update(editKey, { pending: true })
          setError(undefined)
          try {
            const connection = await command.run()
            if (!active()) return
            const fields = toAccountFields(connection)
            props.drafts.update(editKey, { ...fields, baseline: fields, savedConnection: undefined })
            command = createSaveCommand()
            showToast({
              type: "success",
              title: _({ id: "settings.providers.account.saved", message: "Provider account updated" }),
            })
          } catch (cause) {
            if (active()) setError(requestErrorMessage(cause))
          } finally {
            if (ownsDraft()) props.drafts.update(editKey, { pending: false })
          }
        }

        return (
          <section class="provider-account-editor">
            <form onSubmit={submit}>
              <Show when={error() || persisted()}>
                <p class="settings-request-error" role={error() ? "alert" : "status"}>
                  <Show when={persisted()}>
                    {_({
                      id: "settings.providers.account.savedRefreshFailed",
                      message: "Account changes saved. Refresh the connection to update this view.",
                    })}{" "}
                  </Show>
                  {error()}
                </p>
              </Show>
              <div class="provider-account-editor-fields">
                <TextField
                  autofocus
                  label={_({ id: "settings.providers.account.remark", message: "Account remark (optional)" })}
                  maxLength={80}
                  placeholder={serviceName()}
                  value={draft.name}
                  disabled={locked()}
                  onChange={(name) => props.drafts.update(editKey, { name })}
                />
                <Show when={props.allowEndpoint || props.connection.endpoint || baseline().endpoint}>
                  <details class="providers-advanced">
                    <summary>
                      <Icon name={getSemanticIcon("navigation.expand")} size="small" />
                      {_({ id: "settings.providers.account.advanced", message: "Advanced settings" })}
                    </summary>
                    <TextField
                      label={_({ id: "settings.providers.account.endpoint", message: "API endpoint" })}
                      description={_({
                        id: "settings.providers.account.endpoint.description",
                        message: "Optional. Leave empty to use the provider default.",
                      })}
                      placeholder={_({
                        id: "settings.providers.account.endpoint.placeholder",
                        message: "https://api.example.com/v1",
                      })}
                      value={draft.endpoint}
                      disabled={locked()}
                      onChange={(endpoint) => props.drafts.update(editKey, { endpoint })}
                    />
                  </details>
                </Show>
                <Switch
                  checked={draft.enabled ?? baseline().enabled}
                  disabled={locked()}
                  onChange={(enabled) => props.drafts.update(editKey, { enabled })}
                >
                  {_({ id: "settings.providers.account.enabled", message: "Enabled" })}
                </Switch>
              </div>
              <div class="provider-account-editor-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="large"
                  disabled={busy() || confirming()}
                  onClick={props.onCancel}
                >
                  {_({ id: "settings.providers.account.cancel", message: "Cancel" })}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="large"
                  disabled={busy() || confirming() || (!persisted() && !hasAccountChanges())}
                >
                  {persisted()
                    ? _({ id: "settings.providers.account.retryRefresh", message: "Refresh connection" })
                    : busy()
                      ? _({ id: "settings.providers.account.saving", message: "Saving..." })
                      : _({ id: "settings.providers.account.save", message: "Save changes" })}
                </Button>
              </div>
            </form>
            <div class="providers-connect-section" inert={locked()} aria-busy={busy() || undefined}>
              <div class="providers-credentials-heading">
                <h3 class="provider-flow-heading">
                  {_({ id: "settings.providers.account.credentials", message: "Credentials" })}
                </h3>
                <Show when={authEditing() && props.connection.health?.recovery !== "update_environment"}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={locked()}
                    onClick={() => void cancelCredentials()}
                  >
                    {_({ id: "settings.providers.account.cancel", message: "Cancel" })}
                  </Button>
                </Show>
              </div>
              <Show
                when={props.connection.health?.recovery !== "update_environment"}
                fallback={
                  <p class="providers-connect-copy">
                    {_({
                      id: "settings.providers.updateEnvRecovery",
                      message:
                        "Update the server environment, restart Synergy, then refresh this page. Environment values are never overwritten by Settings.",
                    })}
                  </p>
                }
              >
                <Show
                  when={authEditing()}
                  fallback={
                    <Button type="button" variant="secondary" disabled={locked()} onClick={() => setAuthEditing(true)}>
                      {needsCredentials()
                        ? _({ id: "settings.providers.connectAction", message: "Connect" })
                        : _({ id: "settings.providers.updateCredentials", message: "Update credentials" })}
                    </Button>
                  }
                >
                  <ProviderConnectionFlow
                    providerID={providerID}
                    providerName={props.connection.name}
                    iconID={props.connection.profileID}
                    intent={providerNeedsAction(props.connection.health) ? "recover" : "connect"}
                    compact
                    connectedOverride={false}
                    draft={props.drafts.get(credentialsKey)}
                    onDraftChange={(fields) => {
                      if (active()) props.drafts.update(credentialsKey, fields)
                    }}
                    prepareConnection={async () => {
                      if (!active()) throw new DOMException("Connection view closed", "AbortError")
                      props.drafts.update(credentialsKey, { credentialsStarted: true })
                      return providerID
                    }}
                    onComplete={() => {
                      if (!active()) return
                      setAuthEditing(false)
                      props.drafts.remove(credentialsKey)
                    }}
                  />
                </Show>
              </Show>
            </div>
          </section>
        )
      }}
    </Show>
  )
}
