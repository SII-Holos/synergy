import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { BuiltinMcpDraft, McpEntry } from "../types"
import { McpCard } from "../components/McpCard"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

const emptyTitle = { id: "settings.mcp.empty.title", message: "No MCP servers yet" }
const emptyCopy = { id: "settings.mcp.empty.copy", message: "Add a server when a workflow needs external tools." }
const pageTitle = { id: "settings.mcp.page.title", message: "MCP" }
const pageDescription = {
  id: "settings.mcp.page.description",
  message: "Connect local or remote tool servers that Synergy can use during sessions.",
}
const addServerLabel = { id: "settings.mcp.addServer", message: "Add server" }
const sectionTitle = { id: "settings.mcp.section.title", message: "Servers" }
const sectionDescription = {
  id: "settings.mcp.section.description",
  message: "Each server adds tools or prompts from a trusted local command or remote endpoint.",
}
const builtinsSectionTitle = { id: "settings.mcp.builtins.section.title", message: "Built-in servers" }
const builtinsSectionDescription = {
  id: "settings.mcp.builtins.section.description",
  message: "Shipped with Synergy and usable without an API key. Turning one off disables its tools.",
}
const builtinBadgeLabel = { id: "settings.mcp.builtins.badge", message: "Built-in" }
const builtinStatusConnected = { id: "settings.mcp.builtins.status.connected", message: "Connected" }
const builtinStatusDisabled = { id: "settings.mcp.builtins.status.disabled", message: "Off" }
const builtinStatusOther = { id: "settings.mcp.builtins.status.other", message: "Unavailable" }
const apiKeyLabel = { id: "settings.mcp.builtins.apiKey.label", message: "API key" }
const apiKeyDescription = {
  id: "settings.mcp.builtins.apiKey.description",
  message: "Optional. Sent as a Bearer token to raise rate limits beyond the anonymous quota.",
}
const apiKeyPlaceholder = { id: "settings.mcp.builtins.apiKey.placeholder", message: "Paste key to raise rate limits" }
const apiKeyConfiguredLabel = { id: "settings.mcp.builtins.apiKey.configured", message: "Key set" }
const apiKeyClearLabel = { id: "settings.mcp.builtins.apiKey.clear", message: "Clear stored key" }
const apiKeyClearPendingLabel = {
  id: "settings.mcp.builtins.apiKey.clearPending",
  message: "Key will be removed on save",
}
const apiKeyClearUndoLabel = { id: "settings.mcp.builtins.apiKey.clearUndo", message: "Keep stored key" }

export function McpPanel(props: {
  entries: McpEntry[]
  builtins?: BuiltinMcpDraft[]
  onAdd: () => void
  onChange: (index: number, field: string, value: string | boolean) => void
  onRemove: (index: number) => void
  onBuiltinToggle?: (name: string, value: boolean) => void
  onBuiltinApiKeyChange?: (name: string, value: string) => void
  onBuiltinClearKey?: (name: string, cleared: boolean) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage
      title={_(pageTitle)}
      description={_(pageDescription)}
      actions={
        <Button
          type="button"
          variant="secondary"
          size="small"
          icon={getSemanticIcon("action.add")}
          onClick={props.onAdd}
        >
          {_(addServerLabel)}
        </Button>
      }
    >
      <SettingsSection title={_(sectionTitle)} description={_(sectionDescription)}>
        <Show
          when={props.entries.length > 0}
          fallback={
            <div class="settings-integration-empty">
              <Icon name={getSemanticIcon("mcp.main")} size="normal" />
              <div>
                <div class="settings-integration-empty-title">{_(emptyTitle)}</div>
                <div class="settings-integration-empty-copy">{_(emptyCopy)}</div>
              </div>
            </div>
          }
        >
          <div class="settings-mcp-list">
            <For each={props.entries}>
              {(entry, index) => (
                <McpCard
                  entry={entry}
                  onChange={(field, value) => props.onChange(index(), field, value)}
                  onRemove={() => props.onRemove(index())}
                />
              )}
            </For>
          </div>
        </Show>
      </SettingsSection>

      <Show when={(props.builtins ?? []).length > 0}>
        <SettingsSection title={_(builtinsSectionTitle)} description={_(builtinsSectionDescription)}>
          <div class="settings-mcp-list">
            <For each={props.builtins ?? []}>
              {(builtin) => {
                const displayName = () => builtin.name.charAt(0).toUpperCase() + builtin.name.slice(1)
                const keyPendingClear = () => builtin.clearApiKey && builtin.keyConfigured
                return (
                  <section class="settings-mcp-card">
                    <div class="settings-mcp-card-header">
                      <span class="settings-mcp-summary">
                        <span class="settings-mcp-icon">
                          <Icon name={getSemanticIcon("mcp.main")} size="small" />
                        </span>
                        <span class="settings-mcp-summary-copy">
                          <span class="settings-mcp-title-row">
                            <span class="settings-mcp-title truncate">{displayName()}</span>
                            <span class="settings-mcp-badge">{_(builtinBadgeLabel)}</span>
                          </span>
                          <span class="settings-mcp-subtitle truncate">{builtin.url}</span>
                        </span>
                      </span>
                      <div class="settings-mcp-actions">
                        <span class="settings-mcp-state" classList={{ "settings-mcp-state-paused": !builtin.toggle }}>
                          {builtin.status.status === "connected"
                            ? _(builtinStatusConnected)
                            : builtin.status.status === "disabled"
                              ? _(builtinStatusDisabled)
                              : _(builtinStatusOther)}
                        </span>
                        <Show when={props.onBuiltinToggle}>
                          <Switch
                            checked={builtin.toggle}
                            hideLabel
                            onChange={(value) => props.onBuiltinToggle?.(builtin.name, value)}
                          >
                            {`${displayName()} built-in server`}
                          </Switch>
                        </Show>
                      </div>
                    </div>
                    <div class="settings-mcp-builtin-key">
                      <TextField
                        type="password"
                        autocomplete="off"
                        label={`${_(apiKeyLabel)} — ${displayName()}`}
                        hideLabel
                        description={_(apiKeyDescription)}
                        placeholder={
                          keyPendingClear()
                            ? _(apiKeyClearPendingLabel)
                            : builtin.keyConfigured
                              ? `${_(apiKeyConfiguredLabel)} — ${_(apiKeyPlaceholder)}`
                              : _(apiKeyPlaceholder)
                        }
                        value={builtin.apiKeyDraft}
                        onChange={(value) => props.onBuiltinApiKeyChange?.(builtin.name, String(value))}
                      />
                      <Show when={builtin.keyConfigured && props.onBuiltinClearKey && !builtin.apiKeyDraft}>
                        <IconButton
                          type="button"
                          variant="ghost"
                          icon={getSemanticIcon(keyPendingClear() ? "action.add" : "action.remove")}
                          aria-label={keyPendingClear() ? _(apiKeyClearUndoLabel) : _(apiKeyClearLabel)}
                          onClick={() => props.onBuiltinClearKey?.(builtin.name, !builtin.clearApiKey)}
                        />
                      </Show>
                    </div>
                  </section>
                )
              }}
            </For>
          </div>
        </SettingsSection>
      </Show>
    </SettingsPage>
  )
}
