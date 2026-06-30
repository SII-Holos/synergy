import { createSignal, For, Show } from "solid-js"
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
  const [expanded, setExpanded] = createSignal(true)

  return (
    <div class="ds-mcp-card">
      <div class="ds-mcp-card-header" onClick={() => setExpanded((value) => !value)}>
        <div class="flex items-center gap-2 min-w-0">
          <div class="ds-mcp-dot" classList={{ "ds-mcp-dot-active": props.entry.enabled }} />
          <span class="settings-mcp-title truncate">{props.entry.key || "New Server"}</span>
          <span class="ds-mcp-badge">{props.entry.type === "local" ? "stdio" : "http"}</span>
        </div>
        <div class="flex items-center gap-1">
          <div onClick={(event) => event.stopPropagation()}>
            <Switch checked={props.entry.enabled} onChange={(value) => props.onChange("enabled", value)} />
          </div>
          <IconButton
            icon={getSemanticIcon("action.close")}
            variant="ghost"
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              props.onRemove()
            }}
          />
          <Icon
            name={getSemanticIcon("navigation.collapse")}
            size="small"
            class={`text-text-weak transition-transform duration-200 ${expanded() ? "rotate-180" : ""}`}
          />
        </div>
      </div>
      <Show when={expanded()}>
        <div class="ds-mcp-card-body">
          <TextField
            type="text"
            label="Server Name"
            placeholder="e.g. my-mcp-server"
            description="Unique identifier for this MCP server"
            value={props.entry.key}
            onChange={(value) => props.onChange("key", value)}
          />
          <SegmentPill
            value={props.entry.type}
            options={[
              { value: "local", label: "Local (stdio)" },
              { value: "remote", label: "Remote (HTTP)" },
            ]}
            onChange={(value) => props.onChange("type", value)}
          />
          <Show when={props.entry.type === "local"}>
            <TextField
              type="text"
              label="Command"
              placeholder="e.g. npx -y @modelcontextprotocol/server-filesystem /path"
              description="Command and arguments to start the MCP server"
              value={props.entry.command}
              onChange={(value) => props.onChange("command", value)}
            />
            <TextField
              type="text"
              multiline
              label="Environment"
              placeholder={"KEY=value\nANOTHER=value"}
              description="Environment variables (one per line, KEY=value)"
              value={props.entry.environment}
              onChange={(value) => props.onChange("environment", value)}
            />
          </Show>
          <Show when={props.entry.type === "remote"}>
            <TextField
              type="text"
              label="URL"
              placeholder="https://mcp.example.com/sse"
              description="URL of the remote MCP server"
              value={props.entry.url}
              onChange={(value) => props.onChange("url", value)}
            />
            <TextField
              type="text"
              multiline
              label="Headers"
              placeholder={"Authorization: Bearer token\nX-Custom: value"}
              description="HTTP headers (one per line, Key: value)"
              value={props.entry.headers}
              onChange={(value) => props.onChange("headers", value)}
            />
          </Show>
          <TextField
            type="text"
            label="Timeout"
            placeholder="30000 (ms, default)"
            description="Connection timeout in milliseconds"
            value={props.entry.timeout}
            onChange={(value) => props.onChange("timeout", value)}
          />
        </div>
      </Show>
    </div>
  )
}
