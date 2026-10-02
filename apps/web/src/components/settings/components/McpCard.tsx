import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpStatus } from "@ericsanchezok/synergy-sdk/client"
import { mcpStatusCopy, mcpStatusError } from "@/components/mcp/status-presentation"
import type { McpEntry } from "../types"

const newServerLabel = { id: "settings.mcp.card.newServer", message: "New server" }
const localTypeLabel = { id: "settings.mcp.card.type.local", message: "Local command" }
const remoteTypeLabel = { id: "settings.mcp.card.type.remote", message: "Remote endpoint" }
const commandNotSet = { id: "settings.mcp.card.commandNotSet", message: "Command not set" }
const urlNotSet = { id: "settings.mcp.card.urlNotSet", message: "URL not set" }
const pausedLabel = { id: "settings.mcp.card.paused", message: "Paused" }

export function McpCard(props: {
  entry: McpEntry
  /** Live connection status for this server, when the supervisor knows it. */
  status?: McpStatus
  unsaved?: boolean
  onChange: (field: string, value: string | boolean) => void
  onRemove: () => void
  onEdit: () => void
  index?: number
}) {
  const { _ } = useLingui()
  const name = createMemo(() => props.entry.key.trim() || _(newServerLabel))
  const typeLabel = createMemo(() => (props.entry.type === "local" ? _(localTypeLabel) : _(remoteTypeLabel)))
  const destination = createMemo(() => {
    if (props.entry.type === "local") return props.entry.command.trim() || _(commandNotSet)
    return props.entry.url.trim() || _(urlNotSet)
  })
  // The switch expresses configuration intent, so a paused server never claims
  // a connection state; an enabled one reports its real status instead of a
  // bare "Enabled" that hid "switched on but not connected".
  const stateCopy = createMemo(() => mcpStatusCopy(props.status, _))
  const stateError = createMemo(() => mcpStatusError(props.status))
  const incomplete = () =>
    !props.entry.key.trim() || !(props.entry.type === "local" ? props.entry.command.trim() : props.entry.url.trim())
  const stateLabel = createMemo(() =>
    incomplete()
      ? _({ id: "settings.mcp.card.incomplete", message: "Incomplete configuration" })
      : props.unsaved
        ? _({ id: "settings.mcp.card.unsaved", message: "Unsaved" })
        : props.entry.enabled
          ? stateCopy().label
          : _(pausedLabel),
  )
  const stateTone = createMemo(() =>
    !incomplete() && !props.unsaved && props.entry.enabled ? stateCopy().tone : "neutral",
  )

  return (
    <section class="settings-mcp-card">
      <div class="settings-mcp-card-header">
        <button
          type="button"
          class="settings-mcp-summary"
          data-mcp-entry-index={props.index}
          aria-label={_({
            id: "settings.mcp.card.configure.named",
            message: "Configure {name}",
            values: { name: name() },
          })}
          onClick={props.onEdit}
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
          <Icon name={getSemanticIcon("navigation.expand")} size="small" />
        </button>

        <div class="settings-mcp-actions">
          <span class="settings-mcp-state" data-tone={stateTone()} title={stateError()}>
            {stateLabel()}
          </span>
          <Switch checked={props.entry.enabled} hideLabel onChange={(value) => props.onChange("enabled", value)}>
            {_({ id: "settings.mcp.card.enable.named", message: "Enable {name} server", values: { name: name() } })}
          </Switch>
          <IconButton
            type="button"
            icon={getSemanticIcon("action.remove")}
            variant="ghost"
            aria-label={_({
              id: "settings.mcp.card.remove.named",
              message: "Remove {name} server",
              values: { name: name() },
            })}
            onClick={props.onRemove}
          />
        </div>
      </div>

      <Show when={!incomplete() && !props.unsaved && props.entry.enabled && stateError()}>
        <p class="settings-mcp-card-error">{stateError()}</p>
      </Show>
    </section>
  )
}
