import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpEntry } from "../types"
import { McpCard } from "../components/McpCard"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

const emptyTitle = { id: "settings.mcp.empty.title", message: "No MCP servers yet" }
const emptyCopy = { id: "settings.mcp.empty.copy", message: "Add a server when a workflow needs external tools." }

export function McpPanel(props: {
  entries: McpEntry[]
  onAdd: () => void
  onChange: (index: number, field: string, value: string | boolean) => void
  onRemove: (index: number) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage
      title="MCP"
      description="Connect local or remote tool servers that Synergy can use during sessions."
      actions={
        <Button
          type="button"
          variant="secondary"
          size="small"
          icon={getSemanticIcon("action.add")}
          onClick={props.onAdd}
        >
          Add server
        </Button>
      }
    >
      <SettingsSection
        title="Servers"
        description="Each server adds tools or prompts from a trusted local command or remote endpoint."
      >
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
    </SettingsPage>
  )
}
