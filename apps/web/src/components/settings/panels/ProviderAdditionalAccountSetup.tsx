import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { createSignal, onCleanup } from "solid-js"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { nextProviderAccountName, type ProviderSetupDrafts } from "@/components/provider/provider-setup-drafts"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { createProviderAccountCommand, saveProviderAccount } from "./provider-account-operations"
import type { ProviderConnectionSummary } from "./ProvidersPanel"

export function ProviderAccountSetup(props: {
  source: ProviderConnectionSummary
  summaries: ProviderConnectionSummary[]
  additional: boolean
  drafts: ProviderSetupDrafts
  onComplete: (providerID: string) => void
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const key = `setup:${props.source.id}`
  const additional = props.additional
  const serviceName = () => props.source.profile?.displayName ?? props.source.profile?.name ?? props.source.name
  const draft = props.drafts.get(key, {
    name: !additional && props.source.name !== serviceName() ? props.source.name : "",
    endpoint: !additional ? (props.source.endpoint ?? "") : "",
  })
  const [busy, setBusy] = createSignal(false)
  let active = true
  onCleanup(() => {
    active = false
  })
  const automaticName = () =>
    additional
      ? nextProviderAccountName(
          props.summaries.filter((item) => item.profileID === props.source.profileID).map((item) => item.name),
          (number) => _({ id: "settings.providers.account.numbered", message: "Account {number}", values: { number } }),
        )
      : serviceName()
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
      const name = draft.name.trim() || automaticName()
      const endpoint = draft.endpoint.trim()
      const connection = additional
        ? await saveProviderAccount(globalSDK.client.provider.connection, {
            mode: "create",
            id: draft.id,
            profileID: props.source.profileID,
            name,
            ...(endpoint ? { endpoint } : {}),
            enabled: true,
          })
        : name !== props.source.name || endpoint !== (props.source.endpoint ?? "")
          ? await saveProviderAccount(globalSDK.client.provider.connection, {
              mode: "update",
              providerID: props.source.id,
              ...(name !== props.source.name ? { name } : {}),
              ...(endpoint !== (props.source.endpoint ?? "") ? { endpoint: endpoint || null } : {}),
            })
          : props.source
      if (active) props.drafts.update(key, { targetID: connection.id, name: connection.name })
      return connection
    },
    async () => {
      if (active && additional) await globalSync.refreshProviders()
    },
    async () => {
      if (!additional) return
      await globalSync.refreshProviders()
      const connection = globalSync.data.provider.connections[draft.id]
      if (connection?.profileID !== props.source.profileID) return
      if (active) props.drafts.update(key, { targetID: connection.id, name: connection.name })
      return connection
    },
  )
  return (
    <section class="providers-account-setup">
      <TextField
        autofocus
        label={_({ id: "settings.providers.account.remark", message: "Account remark (optional)" })}
        placeholder={automaticName()}
        value={draft.name}
        disabled={busy() || Boolean(draft.targetID)}
        maxLength={80}
        onChange={(name) => props.drafts.update(key, { name })}
      />
      <ProviderConnectionFlow
        providerID={props.source.id}
        providerName={props.source.profile?.displayName ?? props.source.name}
        iconID={props.source.profileID}
        compact
        skipAutoAdvance={additional && globalSync.data.provider_auth[props.source.id]?.[0]?.type !== "api"}
        connectedOverride={false}
        draft={draft}
        onDraftChange={(value) => props.drafts.update(key, value)}
        prepareConnection={async () => {
          setBusy(true)
          props.drafts.update(key, { credentialsStarted: true })
          try {
            return (await command.run()).id
          } finally {
            if (active) setBusy(false)
          }
        }}
        apiOptions={
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
