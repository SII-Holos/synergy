import { createResource, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { Config, ConfigDomainSummary, Scope } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { getScopeLabel } from "@/utils/scope"
import { SettingsAdvanced, SettingsPage, SettingsPathRow, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingsSettingRow"

export function LanguageToolsPanel(props: {
  kind: "formatter" | "lsp"
  title: string
  description: string
  config?: Config
  domains: ConfigDomainSummary[]
  scopes: Scope[]
  openingDomain?: string
  onOpenDomain?: (domain: ConfigDomainSummary["id"]) => void
}) {
  const { _ } = useLingui()
  const sdk = useGlobalSDK()
  const [scopeID, setScopeID] = createSignal("")
  const [status, { refetch }] = createResource(
    () => scopeID() || undefined,
    async (id) => {
      if (props.kind === "formatter") {
        const response = await sdk.client.formatter.status({ scopeID: id }, { throwOnError: true })
        return (response.data ?? []).map((item) => ({
          name: item.name,
          detail: item.extensions.join(", "),
          state: item.enabled
            ? _({ id: "settings.languageTools.enabled", message: "Enabled" })
            : _({ id: "settings.languageTools.disabled", message: "Disabled" }),
        }))
      }
      const response = await sdk.client.lsp.status({ scopeID: id }, { throwOnError: true })
      return (response.data ?? []).map((item) => ({
        name: item.name,
        detail: item.root,
        state:
          item.status === "connected"
            ? _({ id: "settings.languageTools.running", message: "Running" })
            : _({ id: "settings.languageTools.failed", message: "Failed" }),
      }))
    },
  )
  const config = () => props.config?.[props.kind]
  const configured = () =>
    config() === false
      ? _({ id: "settings.languageTools.disabled", message: "Disabled" })
      : Object.keys(config() ?? {}).length
        ? _({ id: "settings.languageTools.custom", message: "Custom configuration" })
        : _({ id: "settings.languageTools.default", message: "Default configuration" })
  const projects = () => props.scopes.filter((scope) => scope.type === "project" && scope.local)
  return (
    <SettingsPage title={props.title} description={props.description}>
      <SettingsSection
        title={_({ id: "settings.languageTools.configuration", message: "Effective global configuration" })}
      >
        <p class="settings-row-description">{configured()}</p>
        <For each={Object.entries(config() || {})}>
          {([name, entry]) => (
            <SettingRow
              title={name}
              description={entry.extensions?.join(", ")}
              stateLabel={
                entry.disabled
                  ? _({ id: "settings.languageTools.disabled", message: "Disabled" })
                  : _({ id: "settings.languageTools.enabled", message: "Enabled" })
              }
              trailing={<span />}
            />
          )}
        </For>
      </SettingsSection>
      <SettingsSection title={_({ id: "settings.languageTools.status", message: "Project status" })}>
        <SettingRow
          title={_({ id: "settings.languageTools.project", message: "Project" })}
          description={_({
            id: "settings.languageTools.scope",
            message:
              "Runtime status belongs to the selected project. Checking status does not start a language server.",
          })}
          trailing={
            <MenuField
              value={scopeID()}
              ariaLabel={_({ id: "settings.languageTools.project", message: "Project" })}
              options={[
                { value: "", label: _({ id: "settings.languageTools.selectProject", message: "Select a project" }) },
                ...projects().map((scope) => ({
                  value: scope.id,
                  label: getScopeLabel(scope, scope.local?.directory),
                })),
              ]}
              onChange={setScopeID}
            />
          }
        />
        <Show when={scopeID()}>
          <Show
            when={!status.error}
            fallback={
              <div class="settings-request-error" role="alert">
                <span>
                  {_({
                    id: "settings.languageTools.statusUnavailable",
                    message: "Project status could not be loaded.",
                  })}
                </span>
                <Button type="button" variant="ghost" onClick={() => void refetch()}>
                  {_({ id: "settings.languageTools.retry", message: "Retry" })}
                </Button>
              </div>
            }
          >
            <Show
              when={!status.loading}
              fallback={
                <p class="settings-row-description">
                  {_({ id: "settings.languageTools.loading", message: "Reading project status…" })}
                </p>
              }
            >
              <Show
                when={status()?.length}
                fallback={
                  <p class="settings-row-description">
                    {_({
                      id: "settings.languageTools.notStarted",
                      message: "No active servers or available formatters were reported for this project.",
                    })}
                  </p>
                }
              >
                <For each={status()}>
                  {(item) => (
                    <SettingRow
                      title={item.name}
                      description={item.detail}
                      stateLabel={item.state}
                      trailing={<span />}
                    />
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </Show>
      </SettingsSection>
      <SettingsAdvanced id="source" title={_({ id: "settings.languageTools.source", message: "Configuration file" })}>
        <For each={props.domains.filter((domain) => domain.ownedKeys.includes(props.kind))}>
          {(domain) => (
            <SettingsPathRow
              compact
              label={domain.filename}
              path={domain.path}
              ownedKeys={[props.kind]}
              mergePolicy={domain.mergePolicy}
              onOpen={props.onOpenDomain ? () => props.onOpenDomain?.(domain.id) : undefined}
              opening={props.openingDomain === domain.id}
            />
          )}
        </For>
      </SettingsAdvanced>
    </SettingsPage>
  )
}
