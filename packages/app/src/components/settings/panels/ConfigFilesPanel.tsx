import { For, Show } from "solid-js"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { SettingsPage, SettingsPathRow, SettingsSection } from "../components/SettingsPrimitives"

export function ConfigFilesPanel(props: {
  domains: ConfigDomainSummary[]
  openingDomain?: string
  onCopyPath: (path: string) => void
  onOpenDomain: (domain: ConfigDomainSummary["id"]) => void
}) {
  return (
    <SettingsPage title="Config Files" description="Canonical config domains and their backing files.">
      <SettingsSection>
        <For each={props.domains}>
          {(domain) => (
            <SettingsPathRow
              label={domain.filename}
              path={domain.path}
              status={domainStatus(domain)}
              ownedKeys={domain.ownedKeys}
              mergePolicy={domain.mergePolicy}
              onCopy={() => props.onCopyPath(domain.path)}
              onOpen={() => props.onOpenDomain(domain.id)}
              opening={props.openingDomain === domain.id}
            />
          )}
        </For>
        <Show when={props.domains.length === 0}>
          <div class="ds-empty-state">No config domains found</div>
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
  onCopyPath: (path: string) => void
  onOpenDomain: (domain: ConfigDomainSummary["id"]) => void
}) {
  return (
    <SettingsPage title={props.title} description={props.description}>
      <SettingsSection title="Configuration source">
        <For each={props.domains}>
          {(domain) => (
            <SettingsPathRow
              label={domain.label}
              path={domain.path}
              description={summary(domain)}
              status={domainStatus(domain)}
              ownedKeys={domain.ownedKeys}
              mergePolicy={domain.mergePolicy}
              onCopy={() => props.onCopyPath(domain.path)}
              onOpen={() => props.onOpenDomain(domain.id)}
              opening={props.openingDomain === domain.id}
            />
          )}
        </For>
      </SettingsSection>
    </SettingsPage>
  )
}

function domainStatus(domain: ConfigDomainSummary) {
  return Object.keys(domain.config ?? {}).length ? "Configured" : "Empty"
}

function summary(domain: ConfigDomainSummary) {
  return `${domain.ownedKeys.length} owned key${domain.ownedKeys.length === 1 ? "" : "s"}`
}
