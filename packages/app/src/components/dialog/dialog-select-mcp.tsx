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
import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
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

function statusCopy(
  status: McpStatus | undefined,
  _: (id: string, values?: Record<string, unknown>) => string,
): McpStatusCopy {
  switch (status?.status) {
    case "connected":
      return {
        label: _(dialog.mcpStatusConnected.id),
        description: _(dialog.mcpStatusConnectedDesc.id),
        tone: "success",
      }
    case "starting":
      return {
        label: _(dialog.mcpStatusStarting.id),
        description: _(dialog.mcpStatusStartingDesc.id),
        tone: "progress",
      }
    case "connecting":
      return {
        label: _(dialog.mcpStatusConnecting.id),
        description: _(dialog.mcpStatusConnectingDesc.id),
        tone: "progress",
      }
    case "listing_tools":
      return {
        label: _(dialog.mcpStatusLoadingTools.id),
        description: _(dialog.mcpStatusLoadingToolsDesc.id),
        tone: "progress",
      }
    case "reconnecting":
      return {
        label: _(dialog.mcpStatusReconnecting.id),
        description: _(dialog.mcpStatusReconnectingDesc.id, {
          attempt: status.attempt,
          maxAttempts: status.maxAttempts,
        }),
        tone: "progress",
      }
    case "failed":
      return { label: _(dialog.mcpStatusFailed.id), description: _(dialog.mcpStatusFailedDesc.id), tone: "danger" }
    case "needs_auth":
      return {
        label: _(dialog.mcpStatusNeedsAuth.id),
        description: _(dialog.mcpStatusNeedsAuthDesc.id),
        tone: "warning",
      }
    case "needs_client_registration":
      return {
        label: _(dialog.mcpStatusRegistration.id),
        description: _(dialog.mcpStatusRegistrationDesc.id),
        tone: "warning",
      }
    case "stopping":
      return {
        label: _(dialog.mcpStatusStopping.id),
        description: _(dialog.mcpStatusStoppingDesc.id),
        tone: "progress",
      }
    case "disabled":
      return { label: _(dialog.mcpStatusDisabled.id), description: _(dialog.mcpStatusDisabledDesc.id), tone: "neutral" }
    case "uninitialized":
    default:
      return { label: _(dialog.mcpStatusReady.id), description: _(dialog.mcpStatusReadyDesc.id), tone: "neutral" }
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
  const { _ } = useLingui()
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
      const copy = statusCopy(item.status, (id) => id)
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
          <span>{_(dialog.mcps)}</span>
        </div>
      }
      description={
        <div class="mcp-dialog-description">
          <span>{_(dialog.mcpsDesc)}</span>
          <span class="mcp-dialog-summary">
            {_(dialog.mcpConnectedCount.id, { enabled: enabledCount(), total: totalCount() })}
          </span>
        </div>
      }
    >
      <div class="mcp-dialog-body">
        <Show when={totalCount() > 0}>
          <div class="mcp-dialog-stats" aria-label={_(dialog.mcpConnectionSummaryAria)}>
            <div class="mcp-stat">
              <span class="mcp-stat-value">{enabledCount()}</span>
              <span class="mcp-stat-label">{_(dialog.mcpConnected)}</span>
            </div>
            <div class="mcp-stat">
              <span class="mcp-stat-value">{totalCount() - enabledCount()}</span>
              <span class="mcp-stat-label">{_(dialog.mcpInactive)}</span>
            </div>
            <div class="mcp-stat" classList={{ "mcp-stat-attention": attentionCount() > 0 }}>
              <span class="mcp-stat-value">{attentionCount()}</span>
              <span class="mcp-stat-label">{_(dialog.mcpNeedsAttention)}</span>
            </div>
          </div>
        </Show>

        <div class="mcp-search-shell">
          <Icon name={getSemanticIcon("action.search")} size="small" class="mcp-search-icon" />
          <TextField
            variant="ghost"
            label={_(dialog.searchMcpServers)}
            hideLabel
            value={state.filter}
            placeholder={_(dialog.searchMcpServers)}
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
              aria-label={_(dialog.clearMcpSearch)}
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
              <div class="mcp-empty-title">{totalCount() === 0 ? _(dialog.noMcpServers) : _(dialog.noMcpMatches)}</div>
              <div class="mcp-empty-copy">
                {totalCount() === 0 ? _(dialog.noMcpServersDesc) : _(dialog.noMcpMatchesDesc)}
              </div>
            </div>
          }
        >
          <div class="mcp-server-list" role="list">
            <For each={filteredItems()}>
              {(item) => {
                const liveStatus = () => sync.data.mcp[item.name] ?? item.status
                const copy = () => statusCopy(liveStatus(), _)
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
                      aria-label={
                        enabled()
                          ? _(dialog.mcpDisconnectAria.id, { name: item.name })
                          : _(dialog.mcpConnectAria.id, { name: item.name })
                      }
                      onClick={() => void toggle(item.name)}
                    >
                      <span class="mcp-status-dot" aria-hidden="true" />
                      <span class="mcp-server-copy">
                        <span class="mcp-server-name">{item.name}</span>
                        <span class="mcp-server-description" title={error() ?? copy().description}>
                          {error() ?? copy().description}
                        </span>
                      </span>
                      <span class="mcp-status-badge">{loading() ? _(dialog.mcpUpdating) : copy().label}</span>
                    </button>
                    <Switch checked={enabled()} disabled={disabled()} hideLabel onChange={() => void toggle(item.name)}>
                      {enabled()
                        ? _(dialog.mcpDisconnectAria.id, { name: item.name })
                        : _(dialog.mcpConnectAria.id, { name: item.name })}
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
