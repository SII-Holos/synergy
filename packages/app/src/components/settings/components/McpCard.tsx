import { createMemo, createSignal, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpEntry } from "../types"
import { SegmentPill } from "./SegmentPill"

export function McpCard(props: {
  entry: McpEntry
  onChange: (field: string, value: string | boolean) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = createSignal(!props.entry.key)
  const name = createMemo(() => props.entry.key.trim() || "New server")
  const typeLabel = createMemo(() => (props.entry.type === "local" ? "Local command" : "Remote endpoint"))
  const destination = createMemo(() => {
    if (props.entry.type === "local") return props.entry.command.trim() || "Command not set"
    return props.entry.url.trim() || "URL not set"
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
            <Icon name={getSemanticIcon("settings.mcp")} size="small" />
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
            {props.entry.enabled ? "Enabled" : "Paused"}
          </span>
          <Switch checked={props.entry.enabled} hideLabel onChange={(value) => props.onChange("enabled", value)}>
            {`${name()} server`}
          </Switch>
          <IconButton type="button" icon={getSemanticIcon("action.remove")} variant="ghost" onClick={props.onRemove} />
          <button
            type="button"
            class="settings-mcp-expand"
            aria-label={expanded() ? "Collapse server details" : "Expand server details"}
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
        <div class="settings-mcp-card-body">
          <div class="settings-integration-form-grid settings-integration-form-grid-two">
            <TextField
              type="text"
              label="Server name"
              placeholder="filesystem"
              description="Used in menus, logs, and saved configuration."
              value={props.entry.key}
              onChange={(value) => props.onChange("key", value)}
            />
            <div class="settings-integration-field">
              <span class="settings-integration-field-label">Connection type</span>
              <SegmentPill
                value={props.entry.type}
                options={[
                  { value: "local", label: "Local" },
                  { value: "remote", label: "Remote" },
                ]}
                onChange={(value) => props.onChange("type", value)}
              />
              <span class="settings-integration-field-description">
                {props.entry.type === "local"
                  ? "Starts a command on this machine."
                  : "Connects to an HTTP or SSE endpoint."}
              </span>
            </div>
          </div>

          <Show when={props.entry.type === "local"}>
            <TextField
              type="text"
              label="Start command"
              placeholder="npx -y @modelcontextprotocol/server-filesystem C:\\Projects"
              description="Command and arguments Synergy runs when this server is needed."
              value={props.entry.command}
              onChange={(value) => props.onChange("command", value)}
            />
            <TextField
              type="text"
              multiline
              label="Environment"
              placeholder={"KEY=value\nANOTHER=value"}
              description="Optional variables passed only to this server process."
              value={props.entry.environment}
              onChange={(value) => props.onChange("environment", value)}
            />
          </Show>

          <Show when={props.entry.type === "remote"}>
            <TextField
              type="text"
              label="Server URL"
              placeholder="https://mcp.example.com/sse"
              description="HTTP or SSE endpoint for the remote server."
              value={props.entry.url}
              onChange={(value) => props.onChange("url", value)}
            />
            <TextField
              type="text"
              multiline
              label="Headers"
              placeholder={"Authorization: Bearer token\nX-Custom: value"}
              description="Optional request headers, one per line."
              value={props.entry.headers}
              onChange={(value) => props.onChange("headers", value)}
            />
          </Show>

          <TextField
            type="text"
            label="Startup timeout"
            placeholder="30000"
            description="Milliseconds to wait before treating the server as unavailable."
            value={props.entry.timeout}
            onChange={(value) => props.onChange("timeout", value)}
          />
        </div>
      </Show>
    </section>
  )
}
