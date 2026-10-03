import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { createSignal, onCleanup, Show } from "solid-js"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { nextProviderAccountName, type ProviderSetupDrafts } from "@/components/provider/provider-setup-drafts"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { createProviderAccountCommand, saveProviderAccount } from "./provider-account-operations"
import type { ProviderConnectionSummary } from "./ProvidersPanel"

export function ProviderAdditionalAccountSetup(props: {
  source: ProviderConnectionSummary
  summaries: ProviderConnectionSummary[]
  drafts: ProviderSetupDrafts
  onCancel: () => void
  onComplete: (providerID: string) => void
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const key = `additional:${props.source.id}`
  const draft = props.drafts.get(key)
  const [busy, setBusy] = createSignal(false)
  let active = true
  onCleanup(() => {
    active = false
  })
  const automaticName = () =>
    nextProviderAccountName(
      props.summaries.filter((item) => item.profileID === props.source.profileID).map((item) => item.name),
      (number) => _({ id: "settings.providers.account.numbered", message: "Account {number}", values: { number } }),
    )
  const command = createProviderAccountCommand(
    async () => {
      if (draft.targetID) {
        const connection = globalSync.data.provider.connections[draft.targetID]
        if (connection) return connection
        await globalSync.refreshProviders()
        const refreshed = globalSync.data.provider.connections[draft.targetID]
        if (refreshed) return refreshed
        throw new Error("Provider account could not be loaded")
      }
      const connection = await saveProviderAccount(globalSDK.client.provider.connection, {
        mode: "create",
        id: draft.id,
        profileID: props.source.profileID,
        name: draft.name.trim() || automaticName(),
        ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
        enabled: true,
      })
      if (active) props.drafts.update(key, { targetID: connection.id, name: connection.name })
      return connection
    },
    async () => {
      if (active) await globalSync.refreshProviders()
    },
    async () => {
      await globalSync.refreshProviders()
      const connection = globalSync.data.provider.connections[draft.id]
      if (connection?.profileID !== props.source.profileID) return
      if (active) props.drafts.update(key, { targetID: connection.id, name: connection.name })
      return connection
    },
  )
  return (
    <section
      class="providers-account-setup"
      aria-label={_({ id: "settings.providers.account.connectAnother", message: "Connect another account" })}
    >
      <div class="providers-setup-heading">
        <h2 class="provider-flow-heading">
          {_({ id: "settings.providers.account.connectAnother", message: "Connect another account" })}
        </h2>
        <Button type="button" variant="ghost" size="small" onClick={props.onCancel}>
          {_({ id: "settings.providers.account.cancel", message: "Cancel" })}
        </Button>
      </div>
      <p class="providers-connect-copy">
        {_({
          id: "settings.providers.account.connectAnother.description",
          message:
            "Give this account an optional remark, then choose how to connect. Interrupted connections can be continued from your account list.",
        })}
      </p>
      <TextField
        autofocus
        label={_({ id: "settings.providers.account.remark", message: "Account remark (optional)" })}
        placeholder={automaticName()}
        value={draft.name}
        disabled={busy() || Boolean(draft.targetID)}
        maxLength={80}
        onChange={(name) => props.drafts.update(key, { name })}
      />
      <Show when={draft.targetID && !draft.credentialsSaved}>
        <p class="providers-connect-copy" role="status">
          {_({
            id: "settings.providers.account.finishSetup",
            message: "Account added. Finish connecting below, or continue later from your account list.",
          })}
        </p>
      </Show>
      <ProviderConnectionFlow
        providerID={props.source.id}
        providerName={props.source.profile?.displayName ?? props.source.name}
        iconID={props.source.profileID}
        compact
        skipAutoAdvance
        connectedOverride={false}
        draft={draft}
        onDraftChange={(value) => props.drafts.update(key, value)}
        prepareConnection={async () => {
          setBusy(true)
          try {
            return (await command.run()).id
          } finally {
            if (active) setBusy(false)
          }
        }}
        apiOptions={
          <details class="providers-advanced">
            <summary>{_({ id: "settings.providers.account.advanced", message: "Advanced settings" })}</summary>
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
              disabled={busy() || Boolean(draft.targetID)}
              onChange={(endpoint) => props.drafts.update(key, { endpoint })}
            />
          </details>
        }
        onComplete={() => {
          const id = draft.targetID
          if (!id) return
          props.drafts.remove(key)
          props.onComplete(id)
        }}
      />
    </section>
  )
}
