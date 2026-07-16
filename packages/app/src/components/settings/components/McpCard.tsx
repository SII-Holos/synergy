import { createMemo, createSignal, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpEntry } from "../types"
import { SegmentPill } from "./SegmentPill"
import { SettingsSubsection } from "./SettingsPrimitives"
import { SettingRow } from "./SettingRow"

const newServerLabel = { id: "settings.mcp.card.newServer", message: "New server" }
const localTypeLabel = { id: "settings.mcp.card.type.local", message: "Local command" }
const remoteTypeLabel = { id: "settings.mcp.card.type.remote", message: "Remote endpoint" }
const commandNotSet = { id: "settings.mcp.card.commandNotSet", message: "Command not set" }
const urlNotSet = { id: "settings.mcp.card.urlNotSet", message: "URL not set" }
const enabledLabel = { id: "settings.mcp.card.enabled", message: "Enabled" }
const pausedLabel = { id: "settings.mcp.card.paused", message: "Paused" }
const collapseLabel = { id: "settings.mcp.card.collapse", message: "Collapse server details" }
const expandLabel = { id: "settings.mcp.card.expand", message: "Expand server details" }
const serverNameLabel = { id: "settings.mcp.card.serverName", message: "Server name" }
const serverNamePlaceholder = { id: "settings.mcp.card.serverName.placeholder", message: "filesystem" }
const serverNameDesc = {
  id: "settings.mcp.card.serverName.description",
  message: "Used in menus, logs, and saved configuration.",
}
const connectionTypeTitle = { id: "settings.mcp.card.connectionType", message: "Connection type" }
const localCmdDesc = { id: "settings.mcp.card.local.description", message: "Starts a command on this machine." }
const remoteUrlDesc = { id: "settings.mcp.card.remote.description", message: "Connects to an HTTP or SSE endpoint." }
const startCommandLabel = { id: "settings.mcp.card.startCommand", message: "Start command" }
const startCommandDesc = {
  id: "settings.mcp.card.startCommand.description",
  message: "Command and arguments Synergy runs when this server is needed.",
}
const envLabel = { id: "settings.mcp.card.env", message: "Environment" }
const envDesc = {
  id: "settings.mcp.card.env.description",
  message: "Optional variables passed only to this server process.",
}
const serverUrlLabel = { id: "settings.mcp.card.serverUrl", message: "Server URL" }
const serverUrlDesc = {
  id: "settings.mcp.card.serverUrl.description",
  message: "HTTP or SSE endpoint for the remote server.",
}
const headersLabel = { id: "settings.mcp.card.headers", message: "Headers" }
const headersDesc = { id: "settings.mcp.card.headers.description", message: "Optional request headers, one per line." }
const startupTimeoutLabel = { id: "settings.mcp.card.startupTimeout", message: "Startup timeout" }
const startupTimeoutDesc = {
  id: "settings.mcp.card.startupTimeout.description",
  message: "Milliseconds to wait before treating the server as unavailable.",
}

export function McpCard(props: {
  entry: McpEntry
  onChange: (field: string, value: string | boolean) => void
  onRemove: () => void
}) {
  const { _ } = useLingui()
  const [expanded, setExpanded] = createSignal(!props.entry.key)
  const name = createMemo(() => props.entry.key.trim() || _(newServerLabel))
  const typeLabel = createMemo(() => (props.entry.type === "local" ? _(localTypeLabel) : _(remoteTypeLabel)))
  const destination = createMemo(() => {
    if (props.entry.type === "local") return props.entry.command.trim() || _(commandNotSet)
    return props.entry.url.trim() || _(urlNotSet)
  })

  return (
    <section class="settings-mcp-card">
      <div class="settings-mcp-card-header">
        <button
          type="button"
          class="settings-mcp-summary"
          aria-expanded={expanded()}
          onClick={() => setExpanded((value) => !value)}
        >
          <span class="settings-mcp-icon">
            <Icon name={getSemanticIcon("mcp.main")} size="small" />
          </span>
          <span class="settings-mcp-summary-copy">
            <span class="settings-mcp-title-row">
              <span class="settings-mcp-title truncate">{name()}</span>
              <span class="settings-mcp-badge">{typeLabel()}</span>
            </span>
            <span class="settings-mcp-subtitle truncate">{destination()}</span>
          </span>
        </button>

        <div class="settings-mcp-actions">
          <span class="settings-mcp-state" classList={{ "settings-mcp-state-paused": !props.entry.enabled }}>
            {props.entry.enabled ? _(enabledLabel) : _(pausedLabel)}
          </span>
          <Switch checked={props.entry.enabled} hideLabel onChange={(value) => props.onChange("enabled", value)}>
            {`${name()} server`}
          </Switch>
          <IconButton type="button" icon={getSemanticIcon("action.remove")} variant="ghost" onClick={props.onRemove} />
          <button
            type="button"
            class="settings-mcp-expand"
            aria-label={expanded() ? _(collapseLabel) : _(expandLabel)}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon
              name={getSemanticIcon("navigation.collapse")}
              size="small"
              classList={{ "settings-mcp-expand-icon-open": expanded() }}
            />
          </button>
        </div>
      </div>

      <Show when={expanded()}>
        <SettingsSubsection>
          <TextField
            type="text"
            label={_(serverNameLabel)}
            placeholder={_(serverNamePlaceholder)}
            description={_(serverNameDesc)}
            value={props.entry.key}
            onChange={(value) => props.onChange("key", value)}
          />

          <SettingRow
            title={_(connectionTypeTitle)}
            description={props.entry.type === "local" ? _(localCmdDesc) : _(remoteUrlDesc)}
            trailing={
              <SegmentPill
                value={props.entry.type}
                options={[
                  { value: "local", label: "Local" },
                  { value: "remote", label: "Remote" },
                ]}
                onChange={(value) => props.onChange("type", value)}
              />
            }
          />

          <Show when={props.entry.type === "local"}>
            <TextField
              type="text"
              label={_(startCommandLabel)}
              placeholder="npx -y @modelcontextprotocol/server-filesystem C:\\Projects"
              description={_(startCommandDesc)}
              value={props.entry.command}
              onChange={(value) => props.onChange("command", value)}
            />
            <TextField
              type="text"
              multiline
              label={_(envLabel)}
              placeholder={"KEY=value\nANOTHER=value"}
              description={_(envDesc)}
              value={props.entry.environment}
              onChange={(value) => props.onChange("environment", value)}
            />
          </Show>

          <Show when={props.entry.type === "remote"}>
            <TextField
              type="text"
              label={_(serverUrlLabel)}
              placeholder="https://mcp.example.com/sse"
              description={_(serverUrlDesc)}
              value={props.entry.url}
              onChange={(value) => props.onChange("url", value)}
            />
            <TextField
              type="text"
              multiline
              label={_(headersLabel)}
              placeholder={"Authorization: Bearer token\nX-Custom: value"}
              description={_(headersDesc)}
              value={props.entry.headers}
              onChange={(value) => props.onChange("headers", value)}
            />
          </Show>

          <TextField
            type="text"
            label={_(startupTimeoutLabel)}
            placeholder="30000"
            description={_(startupTimeoutDesc)}
            value={props.entry.timeout}
            onChange={(value) => props.onChange("timeout", value)}
          />
        </SettingsSubsection>
      </Show>
    </section>
  )
}
