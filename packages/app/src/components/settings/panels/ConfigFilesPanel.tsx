import { For, Show } from "solid-js"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { useLingui } from "@lingui/solid"
import { SettingsPage, SettingsPathRow, SettingsSection } from "../components/SettingsPrimitives"

const configuredStatus = { id: "settings.configFiles.configured", message: "Configured" }
const emptyStatus = { id: "settings.configFiles.empty", message: "Empty" }
const noDomainsLabel = { id: "settings.configFiles.noDomains", message: "No config domains found" }
const configSourceTitle = { id: "settings.configFiles.source", message: "Configuration source" }

function ownedKeysSummary(count: number) {
  return {
    id: "settings.configFiles.ownedKeys",
    message: "{count, plural, one {# owned key} other {# owned keys}}",
    values: { count },
  }
}

export function ConfigFilesPanel(props: {
  domains: ConfigDomainSummary[]
  openingDomain?: string
  onOpenDomain?: (domain: ConfigDomainSummary["id"]) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title="Config Files" description="Canonical config domains and their backing files.">
      <SettingsSection>
        <For each={props.domains}>
          {(domain) => (
            <SettingsPathRow
              label={domain.filename}
              path={domain.path}
              status={domainStatus(domain, _)}
              ownedKeys={domain.ownedKeys}
              mergePolicy={domain.mergePolicy}
              onOpen={props.onOpenDomain ? () => props.onOpenDomain?.(domain.id) : undefined}
              opening={props.openingDomain === domain.id}
            />
          )}
        </For>
        <Show when={props.domains.length === 0}>
          <div class="ds-empty-state">{_(noDomainsLabel)}</div>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}

export function ConfigReferencePanel(props: {
  title: string
  description: string
  domains: ConfigDomainSummary[]
  openingDomain?: string
  onOpenDomain?: (domain: ConfigDomainSummary["id"]) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={props.title} description={props.description}>
      <SettingsSection title={_(configSourceTitle)}>
        <For each={props.domains}>
          {(domain) => (
            <SettingsPathRow
              label={domain.label}
              path={domain.path}
              description={_(ownedKeysSummary(domain.ownedKeys.length))}
              status={domainStatus(domain, _)}
              ownedKeys={domain.ownedKeys}
              mergePolicy={domain.mergePolicy}
              onOpen={props.onOpenDomain ? () => props.onOpenDomain?.(domain.id) : undefined}
              opening={props.openingDomain === domain.id}
            />
          )}
        </For>
      </SettingsSection>
    </SettingsPage>
  )
}

function domainStatus(domain: ConfigDomainSummary, _: ReturnType<typeof useLingui>["_"]) {
  return Object.keys(domain.config ?? {}).length ? _(configuredStatus) : _(emptyStatus)
}
