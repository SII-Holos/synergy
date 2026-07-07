import { Component, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { McpStatus } from "@ericsanchezok/synergy-sdk/client"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import "./dialog-select-mcp.css"

type McpItem = {
  name: string
  status: McpStatus
}

type McpStatusTone = "success" | "progress" | "warning" | "danger" | "neutral"

type McpStatusCopy = {
  label: string
  description: string
  tone: McpStatusTone
}

function statusCopy(status: McpStatus | undefined): McpStatusCopy {
  switch (status?.status) {
    case "connected":
      return { label: "Connected", description: "Available to agent tools", tone: "success" }
    case "starting":
      return { label: "Starting", description: "Starting the server process", tone: "progress" }
    case "connecting":
      return { label: "Connecting", description: "Opening the MCP connection", tone: "progress" }
    case "listing_tools":
      return { label: "Loading tools", description: "Reading tools, prompts, and resources", tone: "progress" }
    case "reconnecting":
      return {
        label: "Reconnecting",
        description: `Retry ${status.attempt} of ${status.maxAttempts}`,
        tone: "progress",
      }
    case "failed":
      return { label: "Failed", description: "Connection failed", tone: "danger" }
    case "needs_auth":
      return { label: "Needs auth", description: "Authentication is required", tone: "warning" }
    case "needs_client_registration":
      return { label: "Registration", description: "Client registration is required", tone: "warning" }
    case "stopping":
      return { label: "Stopping", description: "Disconnecting from the server", tone: "progress" }
    case "disabled":
      return { label: "Disabled", description: "Not connected for this session", tone: "neutral" }
    case "uninitialized":
    default:
      return { label: "Ready", description: "Ready to connect", tone: "neutral" }
  }
}

function statusError(status: McpStatus | undefined): string | undefined {
  if (status?.status === "failed") return status.error
  if (status?.status === "needs_client_registration") return status.error
  return undefined
}

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const [state, setState] = createStore({
    filter: "",
    loading: null as string | null,
  })

  const items = createMemo(() =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name, status]) => ({ name, status }) satisfies McpItem)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = async (name: string) => {
    if (state.loading) return
    setState("loading", name)
    try {
      const status = sync.data.mcp[name]
      if (status?.status === "connected") {
        await sdk.client.mcp.disconnect({ name })
      } else {
        await sdk.client.mcp.connect({ name })
      }
      const result = await sdk.client.mcp.status()
      if (result.data) sync.set("mcp", result.data)
    } finally {
      setState("loading", null)
    }
  }

  const enabledCount = createMemo(() => items().filter((i) => i.status.status === "connected").length)
  const totalCount = createMemo(() => items().length)
  const attentionCount = createMemo(
    () =>
      items().filter((i) => {
        const status = i.status.status
        return status === "failed" || status === "needs_auth" || status === "needs_client_registration"
      }).length,
  )
  const filteredItems = createMemo(() => {
    const query = state.filter.trim().toLowerCase()
    if (!query) return items()
    return items().filter((item) => {
      const copy = statusCopy(item.status)
      const error = statusError(item.status)
      return [item.name, item.status.status, copy.label, copy.description, error ?? ""].some((value) =>
        value.toLowerCase().includes(query),
      )
    })
  })

  return (
    <Dialog
      class="mcp-select-dialog"
      title={
        <div class="mcp-dialog-title">
          <span class="mcp-dialog-icon" aria-hidden="true">
            <Icon name={getSemanticIcon("mcp.main")} size="small" />
          </span>
          <span>MCPs</span>
        </div>
      }
      description={
        <div class="mcp-dialog-description">
          <span>Connect or pause MCP servers for this session.</span>
          <span class="mcp-dialog-summary">
            {enabledCount()} of {totalCount()} connected
          </span>
        </div>
      }
    >
      <div class="mcp-dialog-body">
        <Show when={totalCount() > 0}>
          <div class="mcp-dialog-stats" aria-label="MCP connection summary">
            <div class="mcp-stat">
              <span class="mcp-stat-value">{enabledCount()}</span>
              <span class="mcp-stat-label">Connected</span>
            </div>
            <div class="mcp-stat">
              <span class="mcp-stat-value">{totalCount() - enabledCount()}</span>
              <span class="mcp-stat-label">Inactive</span>
            </div>
            <div class="mcp-stat" classList={{ "mcp-stat-attention": attentionCount() > 0 }}>
              <span class="mcp-stat-value">{attentionCount()}</span>
              <span class="mcp-stat-label">Needs attention</span>
            </div>
          </div>
        </Show>

        <div class="mcp-search-shell">
          <Icon name={getSemanticIcon("action.search")} size="small" class="mcp-search-icon" />
          <TextField
            variant="ghost"
            label="Search MCP servers"
            hideLabel
            value={state.filter}
            placeholder="Search servers"
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            onChange={(value) => setState("filter", value)}
          />
          <Show when={state.filter}>
            <button
              type="button"
              class="mcp-search-clear"
              aria-label="Clear MCP search"
              onClick={() => setState("filter", "")}
            >
              <Icon name={getSemanticIcon("action.close")} size="small" />
            </button>
          </Show>
        </div>

        <Show
          when={filteredItems().length > 0}
          fallback={
            <div class="mcp-empty-state">
              <span class="mcp-empty-icon" aria-hidden="true">
                <Icon name={getSemanticIcon(totalCount() === 0 ? "mcp.main" : "action.search")} size="normal" />
              </span>
              <div class="mcp-empty-title">{totalCount() === 0 ? "No MCP servers configured" : "No matches"}</div>
              <div class="mcp-empty-copy">
                {totalCount() === 0
                  ? "Configured MCP servers will appear here when this session can use them."
                  : "Try a server name, status, or error detail."}
              </div>
            </div>
          }
        >
          <div class="mcp-server-list" role="list">
            <For each={filteredItems()}>
              {(item) => {
                const liveStatus = () => sync.data.mcp[item.name] ?? item.status
                const copy = () => statusCopy(liveStatus())
                const error = () => statusError(liveStatus())
                const enabled = () => liveStatus().status === "connected"
                const loading = () => state.loading === item.name
                const disabled = () => Boolean(state.loading)
                return (
                  <div class="mcp-server-row" data-status={copy().tone} data-disabled={disabled()} role="listitem">
                    <button
                      type="button"
                      class="mcp-server-main"
                      disabled={disabled()}
                      aria-label={`${enabled() ? "Disconnect" : "Connect"} ${item.name}`}
                      onClick={() => void toggle(item.name)}
                    >
                      <span class="mcp-status-dot" aria-hidden="true" />
                      <span class="mcp-server-copy">
                        <span class="mcp-server-name">{item.name}</span>
                        <span class="mcp-server-description" title={error() ?? copy().description}>
                          {error() ?? copy().description}
                        </span>
                      </span>
                      <span class="mcp-status-badge">{loading() ? "Updating" : copy().label}</span>
                    </button>
                    <Switch checked={enabled()} disabled={disabled()} hideLabel onChange={() => void toggle(item.name)}>
                      {enabled() ? `Disconnect ${item.name}` : `Connect ${item.name}`}
                    </Switch>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
